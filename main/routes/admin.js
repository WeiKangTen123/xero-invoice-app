const express      = require('express');
const router       = express.Router();
const fs           = require('fs');
const path         = require('path');
const { requireAdmin } = require('../middleware/auth-middleware');
const asyncHandler     = require('../middleware/async-handler');
const {
  getAllUsers, createUser, updateUserRole, deleteUser, readUsers, findById, getSetupStatus, isOnline,
  passwordProblem, shortPasswordAllowed, setPassword, invalidateSessions, setDisabled, unlockAccount, getUserDefaults, isKnownTimezone,
  getUserConfig, saveUserConfig, getImapSettings, getGeminiKeys, addGeminiKey,
} = require('../utils/users');
const invoiceStore     = require('../utils/invoice-store');
const settingsStore    = require('../utils/settings-store');
const processState     = require('../utils/process-state');
const emailQueue       = require('../queue/email-queue');
const emailWorker      = require('../queue/email-worker');
const claimWorker      = require('../claims/claim-worker');
const watcherRegistry  = require('../email/watcher-registry');
const tokenCache       = require('../utils/token-cache');
const sessions         = require('../utils/sessions');
const db               = require('../db');
const logger       = require('../utils/logger');
const auditLog     = require('../utils/audit-log');

// Every change made here goes in admin_events (utils/audit-log.js): who did
// it, to which account, and the facts, never a password. Written after the
// change succeeds; a failure to write it is a warning, not a failed request.
function recordAdmin(req, target, action, details = null) {
  auditLog.recordAdminEvent({
    actor:  { id: req.user.id, email: req.user.email },
    target: target ? { id: target.id, email: target.email } : null,
    action, details,
  });
}

// LOGS_DIR override lets tests point at a throwaway directory instead of the
// real logs/ folder a dev server may be actively writing to (see db/index.js
// for the same DB_PATH pattern).
const LOGS_DIR = process.env.LOGS_DIR || path.join(__dirname, '../../logs');
// Only the currently-active file per stream — never the rotated logs/*N.log
// backups, which can grow large over a server's lifetime and aren't meant
// to be read live.
const LOG_FILES = { combined: 'combined.log', error: 'error.log' };

// GET /api/admin/users — every account, with its lockout and temporary-
// password state (users.js#sanitize: failedLogins, lockedUntil, lockCount,
// lastLockedAt, mustChangePassword, tempPasswordExpiresAt, lastLoginAt,
// passwordChangedAt).
router.get('/users', requireAdmin, (_req, res) => {
  res.json({ users: getAllUsers() });
});

// ── Copying the admin's own settings onto a new account ──────────────────────
// What each group of `copyFrom` carries over. Never a Xero credential or
// token: the new account connects its own Xero, or, as a demo account, none.
const COPY_GROUPS = ['llm', 'defaults', 'mailbox'];
const DEFAULT_KEYS = [
  'DEFAULT_ACCOUNT_CODE', 'DEFAULT_CURRENCY', 'ZERO_TAX_RATE', 'CLAIM_PAYEE_NAME',
  'MILEAGE_RATE', 'MILEAGE_ACCOUNT_CODE', 'PER_DIEM_RATE', 'PER_DIEM_ACCOUNT_CODE', 'TIMEZONE',
];
const MAILBOX_FILTER_REQUIRED = 'A sender filter is required when the mailbox is copied: two accounts watching one '
  + 'mailbox must watch different senders, because the watcher marks an email it has processed as read, '
  + 'so whichever account reads a message first takes it from the other.';

// The groups asked for, as { llm, defaults, mailbox } of booleans. Anything
// that is not an object, or a key that is not a group, asks for nothing.
function _copyGroups(copyFrom) {
  const asked = copyFrom && typeof copyFrom === 'object' ? copyFrom : {};
  return Object.fromEntries(COPY_GROUPS.map(g => [g, asked[g] === true]));
}

// Copies the chosen groups of `fromId`'s settings onto `toId`, and returns
// the groups that had something to copy. The mailbox goes over as the
// settings the watcher resolves for the source account (users.getImapSettings)
// rather than as typed: a box the admin left blank is filled from the
// admin's own sign-in address, and copied blank it would be filled from the
// new account's, which is a different mailbox. The sender filter is the new
// account's own, never the source's (see MAILBOX_FILTER_REQUIRED).
function _copySettings(fromId, toId, groups, mailboxFilterFrom) {
  const source = getUserConfig(fromId);
  const patch  = {};
  const copied = [];

  if (groups.llm) {
    // The legacy single key and every key of the multi-key list (Setup's
    // LLM keys card, users.getGeminiKeys), each under its own label.
    let any = false;
    if (source.Gemini_API_KEY) { patch.Gemini_API_KEY = source.Gemini_API_KEY; any = true; }
    for (const key of getGeminiKeys(fromId)) { addGeminiKey(toId, key.apiKey, key.label); any = true; }
    if (any) copied.push('llm');
  }
  if (groups.defaults) {
    let any = false;
    for (const key of DEFAULT_KEYS) {
      if (source[key] === undefined || source[key] === null || source[key] === '') continue;
      patch[key] = source[key]; any = true;
    }
    if (any) copied.push('defaults');
  }
  if (groups.mailbox) {
    const resolved = getImapSettings(fromId, source);
    const values = {
      IMAP_HOST: resolved.host, IMAP_PORT: resolved.port, IMAP_USER: resolved.user, IMAP_PASS: resolved.password,
      IMAP_POLL_INTERVAL_MS: source.IMAP_POLL_INTERVAL_MS, IMAP_LOOKBACK_DAYS: source.IMAP_LOOKBACK_DAYS,
    };
    let any = false;
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined || value === null || value === '') continue;
      patch[key] = String(value); any = true;
    }
    patch.IMAP_FILTER_FROM = String(mailboxFilterFrom).trim();
    if (any) copied.push('mailbox');
  }

  if (Object.keys(patch).length) saveUserConfig(toId, patch);
  return copied;
}

// POST /api/admin/users — create new user. The password an admin types is
// temporary: it must be replaced at the first sign-in and dies after a day,
// so the admin never ends up knowing a password someone is actually using.
//
// Body: { email, password, role, demo, copyFrom: { llm, defaults, mailbox },
// mailboxFilterFrom }. `demo` makes a demo account, which runs against the
// generated Demo Company instead of Xero (users.js isDemoUser). `copyFrom`
// names which groups of the creating admin's own settings to copy onto the
// new account (see _copySettings): the LLM keys, the posting defaults, the
// mailbox — which needs `mailboxFilterFrom`, the sender the new account
// watches for. Answers { success, user, copied }, `copied` being the groups
// that had something to copy. The audit event records `demo` and `copied`,
// never a value.
router.post('/users', requireAdmin, asyncHandler(async (req, res) => {
  try {
    const { email, password, role, demo, copyFrom, mailboxFilterFrom } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    if (demo !== undefined && typeof demo !== 'boolean') {
      return res.status(400).json({ error: 'demo must be true or false' });
    }
    // A demo account's password is the admin's to choose and keep: shorter
    // (users.js DEMO_PASSWORD_MIN_LENGTH) and permanent, since it is typed in
    // front of people and guards sample data. Any other account's is
    // temporary, replaced at the first sign-in — an admin's too, even one
    // made on sample data: it can switch to real Xero and manage every
    // account (users.js shortPasswordAllowed).
    const isDemo  = demo === true;
    const newRole = role === 'admin' ? 'admin' : 'user';
    const short   = shortPasswordAllowed({ is_demo: isDemo, role: newRole });
    const problem = passwordProblem(password, email, { demo: short });
    if (problem) return res.status(400).json({ error: problem });
    const groups = _copyGroups(copyFrom);
    if (groups.mailbox && !String(mailboxFilterFrom ?? '').trim()) {
      return res.status(400).json({ error: MAILBOX_FILTER_REQUIRED });
    }
    const user   = await createUser(email, password, newRole, { temporary: !short, demo: isDemo });
    const copied = _copySettings(req.user.id, user.id, groups, mailboxFilterFrom);
    recordAdmin(req, user, 'user.create', { role: user.role, demo: user.demo, copied });
    logger.info('Admin created user', { email, role: user.role, demo: user.demo, copied, by: req.user.email });
    res.status(201).json({ success: true, user, copied });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// DELETE /api/admin/users/:id
router.delete('/users/:id', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    if (id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    const target = findById(id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (lastActiveAdmin(target)) {
      return res.status(400).json({ error: 'Cannot delete the last admin account' });
    }
    // Stopped before anything is removed. Nothing used to be: the watcher kept
    // polling for the deleted account, its next mail recreated the folder just
    // removed, and the workers carried on with the account's queued jobs.
    const watcherStopped = stopAutomation(id);
    deleteUser(id);
    // The rows cascade in the database; the files (receipts, PDFs, queues)
    // do not. users.js had said this route removed them — it never did.
    try {
      fs.rmSync(require('../utils/paths').userDir(id), { recursive: true, force: true });
    } catch (err) {
      logger.warn("Could not remove the deleted user's files", { id, error: err.message });
    }
    // The email is copied into the event: the account it names is gone.
    recordAdmin(req, target, 'user.delete', { role: target.role, watcherStopped });
    logger.info('Admin deleted user', { id, watcherStopped, by: req.user.email });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Account controls ─────────────────────────────────────────────────────────
// Ends every session of an account an admin has just signed out, reset or
// disabled (utils/sessions.js), saying why and which admin. Their tokens are
// already refused by the cutoff the change moved (users.js); this is so the
// sessions say they ended, and why, rather than stay in the list until they
// run out. A failure is a warning: the account is signed out either way.
function endSessionsOf(req, target, reason) {
  try {
    return sessions.endAllSessions(target.id, reason, { endedBy: req.user.id });
  } catch (err) {
    logger.warn('Could not end the sessions of an account', { email: target.email, reason, error: err.message });
    return 0;
  }
}

// Admins who could not sign in do not count towards "is anyone left to undo
// this": a disabled admin is no safeguard.
function activeAdmins() {
  return readUsers().filter(u => u.role === 'admin' && !u.disabled_at);
}

// Would deleting, demoting or disabling this account leave nobody who can sign
// in as an admin? Never, while the actor is an active admin acting on someone
// else; kept as the guard for when that rule changes.
function lastActiveAdmin(target) {
  return target.role === 'admin' && !activeAdmins().some(a => a.id !== target.id);
}

// The account a /users/:id/* control acts on. Acting on yourself is refused:
// an admin who demotes, disables or signs out their own account has nobody
// left to undo it, and your own password has its own route
// (POST /api/auth/change-password) that asks for the current one first.
function findTarget(req, res, selfError) {
  const target = findById(req.params.id);
  if (!target) { res.status(404).json({ error: 'User not found' }); return null; }
  if (target.id === req.user.id) { res.status(400).json({ error: selfError }); return null; }
  return target;
}

// Mirrors POST /api/process/stop for another user's watcher. Returns whether a
// connection was up, for the response and the log.
//
// stop() is called whatever isRunning() says. isRunning() means "a connection
// exists", and a watcher waiting out a reconnect backoff has none — so the
// stop was skipped and the pending reconnect brought the watcher back, for an
// account that had just been disabled. stop() is safe to repeat and is what
// cancels that timer.
function stopWatcher(userId) {
  const wasRunning = watcherRegistry.isRunning(userId);
  watcherRegistry.stop(userId);
  try { processState.forUser(userId).notifyStopped(); } catch (_) {}
  return wasRunning;
}

// Everything that works for an account in the background: the mailbox
// watcher, the worker that turns queued mail into invoices (and posts them to
// Xero when auto-submit is on) and the import job worker. Disabling stopped
// only the watcher, so mail already queued still posted. The account's
// auto-submit setting is left alone: it is the user's choice, and is still
// theirs if the account is enabled again. The workers also refuse a disabled
// account themselves, for a tick already scheduled when this runs.
function stopAutomation(userId) {
  const wasRunning = stopWatcher(userId);
  emailWorker.stopWorker(userId);
  claimWorker.stopWorker(userId);
  return wasRunning;
}

// PATCH /api/admin/users/:id/role — promote or demote. updateUserRole existed in
// users.js from the start and nothing called it, so making a second admin took
// a SQL statement on the server.
router.patch('/users/:id/role', requireAdmin, (req, res) => {
  const { role } = req.body;
  if (role !== 'admin' && role !== 'user') {
    return res.status(400).json({ error: "Role must be 'admin' or 'user'" });
  }
  const target = findTarget(req, res, 'You cannot change your own role');
  if (!target) return;
  if (role === 'user' && lastActiveAdmin(target)) {
    return res.status(400).json({ error: 'Cannot demote the last admin account' });
  }
  const user = updateUserRole(target.id, role);
  recordAdmin(req, target, 'user.role', { from: target.role, to: role });
  logger.info('Admin changed user role', { email: target.email, role, by: req.user.email });
  res.json({ success: true, user });
});

// PATCH /api/admin/users/:id/password — set a new password for an account.
// Passwords are bcrypt hashes: there is nothing to view, only replace. The
// account's other sessions are signed out by the same cutoff a self-service
// change uses (users.js#setPassword). The password set here is temporary, as
// on Add user: replaced at the next sign-in, dead after a day — except for a
// demo account that is not an admin, whose password is the admin's to choose
// and keep (see Add user). A reset also unlocks the account: the person
// asking for one is often the one locked out.
router.patch('/users/:id/password', requireAdmin, asyncHandler(async (req, res) => {
  try {
    const target = findTarget(req, res, 'Change your own password from the Account page');
    if (!target) return;
    await setPassword(target.id, req.body.password, { temporary: !shortPasswordAllowed(target) });
    endSessionsOf(req, target, 'password_changed');
    // That it was reset, and by whom. Never the password.
    recordAdmin(req, target, 'user.password_reset');
    logger.info('Admin reset user password', { email: target.email, by: req.user.email });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// POST /api/admin/users/:id/unlock — ends a sign-in lockout early and clears
// the failed count behind it (users.js#unlockAccount). Allowed on your own
// account: an admin locked out of this one is signed in on another, and
// nothing about an unlock needs a second admin to undo.
router.post('/users/:id/unlock', requireAdmin, (req, res) => {
  const target = findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const user = unlockAccount(target.id);
  recordAdmin(req, target, 'login.unlocked');
  logger.info('Admin unlocked user', { email: target.email, by: req.user.email });
  res.json({ success: true, user });
});

// POST /api/admin/users/:id/sign-out — every token this account holds is
// refused from now on. For a lost laptop or a shared password: the account is
// otherwise untouched and they can sign straight back in.
router.post('/users/:id/sign-out', requireAdmin, (req, res) => {
  const target = findTarget(req, res, 'Use Sign out for your own session');
  if (!target) return;
  invalidateSessions(target.id);
  endSessionsOf(req, target, 'signed_out_everywhere');
  recordAdmin(req, target, 'user.sign_out');
  logger.info('Admin signed user out everywhere', { email: target.email, by: req.user.email });
  res.json({ success: true });
});

// POST /api/admin/users/:id/sessions/:sid/revoke — ends one session of an
// account (utils/sessions.js): for one device lost or left signed in, without
// signing the person out everywhere else. Its tokens are refused from the next
// request (auth-middleware.js). Allowed on your own account's other sessions,
// as signing out a forgotten laptop is; not on the session making the
// request, which is ended with Sign out, the one that also stops the watcher
// and the phone links. A sid that is not one of this account's is a 404, the
// same as an unknown one, so the route cannot be used to ask about another
// account's sessions. One already ended is left as it ended.
router.post('/users/:id/sessions/:sid/revoke', requireAdmin, (req, res) => {
  const target = findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const session = sessions.getSession(req.params.sid);
  if (!session || session.userId !== String(target.id)) return res.status(404).json({ error: 'Session not found' });
  if (req.user.sid && session.sid === req.user.sid) {
    return res.status(400).json({ error: 'Use Sign out to end this session' });
  }
  if (sessions.endSession(session.sid, 'revoked', req.user.id)) {
    recordAdmin(req, target, 'session.revoke', { sid: session.sid });
    logger.info('Admin ended a session', { email: target.email, by: req.user.email });
  }
  res.json({ success: true });
});

// PATCH /api/admin/users/:id/disabled — { disabled: true | false }. The
// reversible alternative to delete: sign-in and existing tokens are refused
// and the watcher and workers are stopped, but invoices, receipts, queued mail
// and credentials stay for when the account is enabled again. Enabling starts
// nothing; the user starts their watcher again from the dashboard.
router.patch('/users/:id/disabled', requireAdmin, (req, res) => {
  const { disabled } = req.body;
  if (typeof disabled !== 'boolean') {
    return res.status(400).json({ error: 'disabled must be true or false' });
  }
  const target = findTarget(req, res, 'You cannot disable your own account');
  if (!target) return;
  if (disabled && lastActiveAdmin(target)) {
    return res.status(400).json({ error: 'Cannot disable the last admin account' });
  }
  const user = setDisabled(target.id, disabled);
  if (disabled) endSessionsOf(req, target, 'disabled');
  const watcherStopped = disabled ? stopAutomation(target.id) : false;
  recordAdmin(req, target, disabled ? 'user.disable' : 'user.enable', disabled ? { watcherStopped } : null);
  logger.info(disabled ? 'Admin disabled user' : 'Admin enabled user', { email: target.email, watcherStopped, by: req.user.email });
  res.json({ success: true, user });
});

// PATCH /api/admin/users/:id/auto-process — { autoProcess: false }. A kill
// switch only: an admin can stop an account posting to a live Xero, but
// turning it on stays that user's own decision (routes/process.js).
router.patch('/users/:id/auto-process', requireAdmin, (req, res) => {
  if (req.body.autoProcess !== false) {
    return res.status(400).json({ error: 'Admins can only turn auto-submit off; the user turns it on' });
  }
  const target = findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  settingsStore.forUser(target.id).set({ autoProcess: false });
  recordAdmin(req, target, 'user.auto_process_off');
  logger.info('Admin turned auto-submit off', { email: target.email, by: req.user.email });
  res.json({ success: true, autoProcess: false });
});

// POST /api/admin/users/:id/watcher/stop — stop an account's mailbox watcher,
// for a mailbox that is stuck, misconfigured or hammering IMAP. Starting one
// needs that account's credentials to be complete and stays with its owner.
router.post('/users/:id/watcher/stop', requireAdmin, (req, res) => {
  const target = findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const wasRunning = stopWatcher(target.id);
  recordAdmin(req, target, 'user.watcher_stop', { wasRunning });
  logger.info('Admin stopped mailbox watcher', { email: target.email, wasRunning, by: req.user.email });
  res.json({ success: true, wasRunning });
});

// GET /api/admin/reports — all invoices needing human attention across all users.
// Includes user-flagged reports (status: reported), system-flagged parsing
// failures that could not be auto-submitted to Xero (status: review-needed),
// and rows in Xero with a report newer than their last resolution — those keep
// status 'posted' (see invoice-store getFlagged).
router.get('/reports', requireAdmin, (_req, res) => {
  const allUsers = readUsers();
  const reports  = allUsers.flatMap(u =>
    invoiceStore.forUser(u.id).getFlagged().map(inv => ({
      ...inv,
      _ownerEmail: u.email,
      _ownerId:    u.id,
    }))
  );
  res.json({ reports });
});

// PATCH /api/admin/reports/:userId/:invoiceId/resolve
// Records who resolved it and when. A row in Xero is, and stays, 'posted':
// setting it to 'reviewed' hid it from the duplicate checks and the same bill
// could be posted again. (A row reported under the old rule, 'reported' with a
// Xero ID, goes back to 'posted' here.) A row mid-send keeps its status; the
// send decides it.
router.patch('/reports/:userId/:invoiceId/resolve', requireAdmin, asyncHandler(async (req, res, next) => {
  try {
    const { userId, invoiceId } = req.params;
    const store = invoiceStore.forUser(userId);
    const inv   = store.getById(invoiceId);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    const patch = { resolvedBy: req.user.email, resolvedAt: new Date().toISOString() };
    if (inv.status !== 'submitting') patch.status = inv.xeroInvoiceId ? 'posted' : 'reviewed';
    // The record's own history gets "Report resolved" from the store, as the
    // admin; this is the admin's side of it.
    await store.update(invoiceId, patch);
    const owner = findById(userId);
    recordAdmin(req, owner ? owner : { id: userId, email: null }, 'report.resolve', {
      invoiceId, vendorName: inv.vendorName || null,
      invoiceNumber: inv.invoiceNumber && inv.invoiceNumber !== '—' ? inv.invoiceNumber : null,
      status: patch.status || inv.status,
    });
    logger.info('Report resolved', { invoiceId, userId, status: patch.status || inv.status, by: req.user.email });
    res.json({ success: true });
  } catch (err) { next(err); }
}));

// GET /api/admin/events — what admins have done, newest first, for the
// Activity tab. Filters, all optional: userId (the account acted on), action
// (one of the keys in `actions`), from and to (a day, YYYY-MM-DD, read as UTC,
// or an ISO instant; from inclusive, to inclusive of its whole day when a
// day), before (the nextBefore of the last page) and limit (1-200).
// Responds { events: [{ id, at, actorId, actorEmail, targetUserId,
// targetEmail, action, summary, details }], nextBefore, actions: { key: label } }.
function _instant(value, { endOfDay = false } = {}) {
  if (value === undefined || value === '') return { value: null };
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(`${s}T00:00:00.000Z`);
    if (!Number.isFinite(t)) return { error: true };
    return { value: new Date(endOfDay ? t + 24 * 60 * 60 * 1000 : t).toISOString() };
  }
  const t = Date.parse(s);
  return Number.isFinite(t) && /^\d{4}-\d{2}-\d{2}T/.test(s) ? { value: new Date(t).toISOString() } : { error: true };
}

router.get('/events', requireAdmin, (req, res) => {
  const { userId, action, before, limit } = req.query;
  const from = _instant(req.query.from);
  const to   = _instant(req.query.to, { endOfDay: true });
  if (from.error || to.error) return res.status(400).json({ error: 'from and to must be dates (YYYY-MM-DD) or ISO times' });
  if (action && !Object.prototype.hasOwnProperty.call(auditLog.ADMIN_ACTIONS, action)) {
    return res.status(400).json({ error: 'Unknown action' });
  }
  if (before !== undefined && !/^\d+$/.test(String(before))) return res.status(400).json({ error: 'before must be an event id' });
  if (limit !== undefined && !/^\d+$/.test(String(limit))) return res.status(400).json({ error: 'limit must be a whole number' });
  const page = auditLog.listAdminEvents({
    targetUserId: userId ? String(userId) : null, action: action || null,
    from: from.value, to: to.value, before: before || null, limit: limit || auditLog.PAGE_MAX,
  });
  res.json({ ...page, actions: auditLog.ADMIN_ACTIONS });
});

// GET /api/admin/monitoring — per-user activity + backend health, for the Admin Monitoring tab.
router.get('/monitoring', requireAdmin, (_req, res) => {
  const users = readUsers();

  let dbSizeKb = null;
  try {
    if (db.path !== ':memory:') dbSizeKb = Math.round(fs.statSync(db.path).size / 1024);
  } catch (_) {}

  // Total bytes under logs/ — includes rotated backups, so a runaway pre-rotation
  // log (this app once had 500MB+ files before maxsize/maxFiles was added) is
  // visible here even though /logs itself only ever reads the active file.
  let logsSizeMb = null;
  try {
    const total = fs.readdirSync(LOGS_DIR).reduce((sum, f) => {
      try { return sum + fs.statSync(path.join(LOGS_DIR, f)).size; } catch { return sum; }
    }, 0);
    logsSizeMb = Math.round(total / 1024 / 1024);
  } catch (_) {}

  const mem = process.memoryUsage();
  let totalInvoices = 0;

  // When each account last took in a document, from the records themselves,
  // in one query for every account. It was the in-memory value process-state
  // keeps, which every restart cleared, so after a deploy the column read
  // "—" for everyone however busy they had been.
  const lastProcessed = new Map(
    db.prepare('SELECT user_id, MAX(processed_at) AS at FROM invoices GROUP BY user_id').all()
      .map(r => [String(r.user_id), r.at]),
  );

  const userStats = users.map(u => {
    const invoices = invoiceStore.forUser(u.id).getAll();
    totalInvoices += invoices.length;
    const byStatus = status => invoices.filter(i => i.status === status).length;
    const setup     = getSetupStatus(u.id);
    const tenants   = tokenCache.getPersistedTenants(u.id);

    return {
      id:             u.id,
      email:          u.email,
      role:           u.role,
      disabled:       !!u.disabled_at,
      demo:           !!u.is_demo,
      watcherRunning: watcherRegistry.isRunning(u.id),
      autoProcess:    settingsStore.forUser(u.id).get('autoProcess'),
      queue:          emailQueue.getStats(u.id),
      invoices: {
        pending:      byStatus('pending'),
        submitting:   byStatus('submitting'),
        posted:       byStatus('posted'),
        error:        byStatus('error'),
        reviewNeeded: byStatus('review-needed'),
      },
      lastActivity:   lastProcessed.get(String(u.id)) || null,
      xeroConnected:  tenants.length > 0,
      imapConfigured: setup.imap.configured,
      // Real browser presence (an authenticated request landed recently) — distinct
      // from lastActivity above, which is the email pipeline's own activity and says
      // nothing about whether anyone is actually looking at the app right now.
      lastSeenAt:     u.last_seen_at || null,
      online:         isOnline(u.last_seen_at),
    };
  });

  res.json({
    system: {
      uptimeSeconds:   Math.round(process.uptime()),
      nodeVersion:     process.version,
      memory: {
        rssMb:      Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      },
      dbSizeKb,
      logsSizeMb,
      totalUsers:      users.length,
      totalInvoices,
    },
    users: userStats,
  });
});

// GET /api/admin/stats/daily — invoice volume by day, for the Monitoring chart.
// Derived entirely from invoices.processed_at, which every invoice already has —
// no separate metrics-tracking table needed for this one. Optional ?userId= scopes
// it to one user (used by the admin's per-user drill-down); omitted, it's every
// user combined. Always returns one entry per day in the range, zero-filled, so the
// chart's x-axis doesn't skip days with no activity.
//
// Days are calendar days in ?tz= (an IANA zone such as Asia/Singapore), or in
// the viewing admin's own account timezone without one, and the answer names
// the zone it used: { days, timeZone }. They were UTC days, so in Singapore
// everything processed before 8am was drawn on the day before.
router.get('/stats/daily', requireAdmin, (req, res) => {
  const days   = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
  const userId = (req.query.userId || '').trim();
  const asked  = String(req.query.tz || '').trim();
  if (asked && !isKnownTimezone(asked)) return res.status(400).json({ error: 'tz must be a timezone such as Asia/Singapore' });
  const timeZone = asked || getUserDefaults(req.user.id).timezone;

  // Calendar arithmetic on the day itself, so a daylight-saving change cannot
  // skip or repeat a day.
  const fmt   = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayOf = at => {
    const p = Object.fromEntries(fmt.formatToParts(at).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  };
  const [y, m, d] = dayOf(new Date()).split('-').map(Number);
  const keys = [];
  for (let i = days - 1; i >= 0; i--) keys.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));

  // Every record that could fall on one of those days: from 14 hours before
  // the first of them in UTC, the furthest any zone is ahead. Each is then
  // placed on its day in the zone, and anything outside the range dropped.
  const from   = new Date(Date.UTC(y, m - 1, d - (days - 1)) - 14 * 3600 * 1000).toISOString();
  const params = [from];
  let sql = 'SELECT processed_at AS at, status FROM invoices WHERE julianday(processed_at) >= julianday(?)';
  if (userId) { sql += ' AND user_id = ?'; params.push(userId); }

  const byDay = new Map(keys.map(day => [day, { day, posted: 0, error: 0, pending: 0, other: 0 }]));
  for (const r of db.prepare(sql).all(...params)) {
    const at = new Date(r.at);
    if (Number.isNaN(at.getTime())) continue;
    const bucket = byDay.get(dayOf(at));
    if (!bucket) continue;
    if (r.status === 'posted')                                  bucket.posted++;
    else if (r.status === 'error')                               bucket.error++;
    else if (r.status === 'pending' || r.status === 'submitting') bucket.pending++;
    else                                                          bucket.other++;
  }

  res.json({ days: keys.map(day => byDay.get(day)), timeZone });
});

// GET /api/admin/logs — tail the active combined/error log for on-call debugging
// without needing SSH access to the server. Only reads the currently-active file
// (see LOG_FILES above); filters are applied before the tail so "last 200" means
// the last 200 matching entries, not 200 raw lines that then get filtered down.
router.get('/logs', requireAdmin, (req, res) => {
  const fileKey  = LOG_FILES[req.query.file] ? req.query.file : 'combined';
  const filePath = path.join(LOGS_DIR, LOG_FILES[fileKey]);
  const lines    = Math.min(Math.max(parseInt(req.query.lines, 10) || 200, 1), 1000);
  const userId   = (req.query.userId || '').trim();
  const q        = (req.query.q || '').trim().toLowerCase();

  let raw = '';
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (_) { /* not created yet */ }

  const entries = raw.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return { level: 'info', message: line, timestamp: null }; }
  });

  const filtered = entries.filter(e => {
    if (userId && !JSON.stringify(e).includes(userId)) return false;
    if (q && !JSON.stringify(e).toLowerCase().includes(q)) return false;
    return true;
  });

  res.json({ file: fileKey, entries: filtered.slice(-lines) });
});

module.exports = router;
