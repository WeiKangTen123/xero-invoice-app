const express      = require('express');
const router       = express.Router();
const fs           = require('fs');
const path         = require('path');
const { requireAdmin } = require('../middleware/auth-middleware');
const asyncHandler     = require('../middleware/async-handler');
const users            = require('../utils/users');
const {
  getAllUsers, updateUserRole, deleteUser, readUsers, findById, getSetupStatus, isOnline,
  passwordProblem, requirePasswordChange, setPassword, invalidateSessions, setDisabled, unlockAccount, getUserDefaults, isKnownTimezone,
  getUserConfig, saveUserConfig, getImapSettings, getGeminiKeys, addGeminiKey, setDemo,
} = users;
const invoiceStore     = require('../utils/invoice-store');
const settingsStore    = require('../utils/settings-store');
const processState     = require('../utils/process-state');
const emailQueue       = require('../queue/email-queue');
const claimQueue       = require('../claims/claim-queue');
const emailWorker      = require('../queue/email-worker');
const claimWorker      = require('../claims/claim-worker');
const watcherRegistry  = require('../email/watcher-registry');
const tokenCache       = require('../utils/token-cache');
const sessions         = require('../utils/sessions');
const db               = require('../db');
const authTokens       = require('../utils/auth-tokens');
const mailer           = require('../utils/mailer');
const mailTemplates    = require('../utils/mail-templates');
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
// passwordChangedAt) and, for an account still waiting on its invite,
// invited, inviteExpiresAt and inviteExpired.
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
// The watcher asks the mail server for messages FROM the filter, and the
// server matches it anywhere in the sender: 'gmail.com' would take (and mark
// read) nearly everything in the mailbox. So the filter is one whole address.
const MAILBOX_FILTER_ADDRESS = 'The sender filter must be one whole email address, such as bills@vendor.com: the mailbox '
  + 'search matches any sender that contains it, so a domain or part of an address would take almost every email.';
const OWN_FILTER_BLANK = 'Your own mailbox watcher has no sender filter, so it takes every email in the mailbox and would '
  + 'race the new account for the same mail. Set your own sender filter in Setup first, then copy the mailbox.';
// One address and nothing else: no spaces, no list, no display name, and a
// domain with a dot in it. Kept the same as ui/src/pages/admin/users.js.
const FULL_ADDRESS = /^[^\s@,;<>()"]+@[^\s@,;<>()".]+(?:\.[^\s@,;<>()".]+)+$/;

// The groups asked for, as { llm, defaults, mailbox } of booleans. Anything
// that is not an object, or a key that is not a group, asks for nothing.
function _copyGroups(copyFrom) {
  const asked = copyFrom && typeof copyFrom === 'object' ? copyFrom : {};
  return Object.fromEntries(COPY_GROUPS.map(g => [g, asked[g] === true]));
}

// Why the new account cannot watch the admin's mailbox for `filter`, or
// null. Every account already watching that mailbox (the same server and
// login, with a password to sign in with) must watch a different sender, the
// admin included: one with no filter takes every email, and since the
// server matches a filter anywhere in the sender, two filters where one
// contains the other (or the same one twice) take each other's mail. Nothing
// to say when the admin has no mailbox password, as nothing is copied then
// (_copySettings).
function _mailboxClash(fromId, filter) {
  const mailbox = getImapSettings(fromId);
  if (!mailbox.password) return null;
  const which  = s => `${String(s.host || '').toLowerCase()}|${String(s.user || '').toLowerCase()}`;
  const wanted = filter.toLowerCase();
  for (const row of readUsers()) {
    const own = String(row.id) === String(fromId);
    const s   = own ? mailbox : getImapSettings(row.id);
    if (!s.password || which(s) !== which(mailbox)) continue;
    const theirs = String(s.filterFrom || '').trim().toLowerCase();
    if (!theirs) {
      if (own) return OWN_FILTER_BLANK;
      return `${row.email} already watches this mailbox with no sender filter, so it takes every email in it and `
        + 'would race the new account for the same mail. Give that account a sender filter first.';
    }
    if (theirs.includes(wanted) || wanted.includes(theirs)) {
      return `${own ? 'Your own watcher' : row.email} already watches this mailbox for ${s.filterFrom}. The new account `
        + 'needs a sender of its own, one that neither contains nor is part of that one, or the two would race for the same mail.';
    }
  }
  return null;
}

// Copies the chosen groups of `fromId`'s settings onto `toId`, and returns
// the groups that had something to copy. The mailbox goes over as the
// settings the watcher resolves for the source account (users.getImapSettings)
// rather than as typed: a box the admin left blank is filled from the
// admin's own sign-in address, and copied blank it would be filled from the
// new account's, which is a different mailbox. The sender filter is the new
// account's own, never the source's (see MAILBOX_FILTER_REQUIRED). A mailbox
// with no password is not a mailbox to copy: the rest of it pinned the new
// account to the admin's address with no way to sign in, and was reported
// as copied.
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
  const resolved = groups.mailbox ? getImapSettings(fromId, source) : null;
  if (resolved && resolved.password) {
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

// ── Invite and reset links ───────────────────────────────────────────────────
// An admin no longer has to know anyone's password: a new account is invited
// by a single-use link, and a forgotten password replaced through one
// (utils/auth-tokens.js; the person uses it at /set-password, routes/auth.js).
// The link is emailed when the server can send mail (utils/mailer.js). When
// it cannot, or the mail fails, the answer carries the link instead, once,
// for the admin to hand over: it is never stored (only its hash is) and
// cannot be shown again; another is a new link, which kills this one.

// A link starts with this app's public address, never the request's Host
// header (mailer.js), so without one there is no link to make.
const NO_APP_URL = {
  error: "Links can't be made yet: set this app's web address (APP_BASE_URL) in Setup → Email first.",
  code:  'NO_APP_URL',
};

// A new link of this kind for the account, made by this admin: its raw token
// and when it stops working. Every earlier unused link of the kind dies.
function _issueLink(target, purpose, ttlMs, admin) {
  const now = Date.now();
  const raw = authTokens.issue(target.id, purpose, { ttlMs, createdBy: admin.id, now });
  return { raw, expiresAt: new Date(now + ttlMs).toISOString(), now };
}

// Emails the link when the server can. Answers what the admin is told:
// { emailed, link, expiresAt }, `link` only when it was not emailed, and
// `emailError` when a send was tried and failed (what the mail server said,
// never the password).
async function _deliverLink(target, purpose, issued, admin) {
  const link = mailer.linkFor(issued.raw);
  const { expiresAt, now } = issued;
  if (!mailer.isConfigured()) return { emailed: false, link, expiresAt };
  const mail = purpose === 'invite'
    ? mailTemplates.invite({ to: target.email, link, expiresAt, invitedBy: admin.email, now })
    : mailTemplates.reset({ to: target.email, link, expiresAt, requestedBy: admin.email, now });
  const sent = await mailer.send({ to: target.email, ...mail });
  return sent.sent ? { emailed: true, link: null, expiresAt } : { emailed: false, link, expiresAt, emailError: sent.error };
}

// POST /api/admin/users — create new user.
//
// Without `password`, the account is invited: it is made with no password
// (users.js INVITED_PASSWORD), cannot sign in, and a link to choose one is
// made, good for 7 days, and emailed when the server can send mail. Answers
// 201 { success, user, copied, invite: { emailed, link, expiresAt } }, with
// `link` only when it was not emailed (and `emailError` when the mail
// failed). A 409 NO_APP_URL when there is no public address to start a link
// with, before anything is made.
//
// With `password` (kept for older clients), the password an admin types is
// temporary: it must be replaced at the first sign-in and dies after a day,
// so the admin never ends up knowing a password someone is actually using.
// Answers { success, user, copied }.
//
// Body: { email, password?, role, demo, copyFrom: { llm, defaults, mailbox },
// mailboxFilterFrom }. `demo` makes a demo account, which runs against the
// generated Demo Company instead of Xero (users.js isDemoUser). `copyFrom`
// names which groups of the creating admin's own settings to copy onto the
// new account (see _copySettings): the LLM keys, the posting defaults, the
// mailbox — which needs `mailboxFilterFrom`, the one sender address the new
// account watches for (see _mailboxClash). `copied` is the groups that had
// something to copy. The audit event records `demo`, `copied`, and either
// that the account was invited (whether by email, and when the link expires)
// or that the password is temporary with when it expires, never a value.
//
// All or nothing: the account is made first (createUser commits it), so when
// the copy or the invite link then fails the account is deleted again and
// the answer is a 500. Left in place, it was an account with half its
// settings, and trying again said "already exists". A mail that fails is not
// a failure: the link is handed back instead.
router.post('/users', requireAdmin, asyncHandler(async (req, res) => {
  const { email, password, role, demo, copyFrom, mailboxFilterFrom } = req.body || {};
  const invite = password === undefined || password === null;
  // Strings, or nothing goes further: a number or an object for the email
  // reached createUser and came back as "email.toLowerCase is not a function".
  if (invite) {
    if (typeof email !== 'string' || !email.trim()) return res.status(400).json({ error: 'Email is required' });
  } else if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  if (typeof users.emailProblem === 'function') {
    const problem = users.emailProblem(email);
    if (problem) return res.status(400).json({ error: problem });
  }
  if (demo !== undefined && typeof demo !== 'boolean') {
    return res.status(400).json({ error: 'demo must be true or false' });
  }
  // As the role change below: an unknown role was quietly made a user.
  if (role !== undefined && role !== 'admin' && role !== 'user') {
    return res.status(400).json({ error: "Role must be 'admin' or 'user'" });
  }
  // Every account's first password is temporary, replaced at the first
  // sign-in, a demo account's too: the short permanent one demo accounts
  // were once allowed went (users.js passwordProblem).
  const isDemo  = demo === true;
  const newRole = role === 'admin' ? 'admin' : 'user';
  if (!invite) {
    const problem = passwordProblem(password, email);
    if (problem) return res.status(400).json({ error: problem });
  }
  const groups = _copyGroups(copyFrom);
  const filter = String(mailboxFilterFrom ?? '').trim();
  if (groups.mailbox) {
    if (!filter) return res.status(400).json({ error: MAILBOX_FILTER_REQUIRED });
    if (!FULL_ADDRESS.test(filter)) return res.status(400).json({ error: MAILBOX_FILTER_ADDRESS });
    const clash = _mailboxClash(req.user.id, filter);
    if (clash) return res.status(400).json({ error: clash });
  }
  if (invite && !mailer.appBaseUrl()) return res.status(409).json(NO_APP_URL);

  let user;
  try {
    user = invite
      ? await users.createUser(email, null, newRole, { invited: true, demo: isDemo })
      : await users.createUser(email, password, newRole, { temporary: true, demo: isDemo });
  } catch (err) {
    const refused = _createRefusal(err);
    if (refused) return res.status(refused.status).json(refused.body);
    logger.error('Admin could not create a user', { email, error: err.message, by: req.user.email });
    return res.status(500).json({ error: 'Could not create the account' });
  }

  let copied;
  try {
    copied = _copySettings(req.user.id, user.id, groups, filter);
  } catch (err) {
    logger.error('Could not copy settings onto a new account; the account was removed again', {
      email: user.email, error: err.message, by: req.user.email,
    });
    _undoCreate(user);
    return res.status(500).json({ error: 'Could not copy your settings to the new account, so it was not created. Try again.' });
  }

  if (!invite) {
    const expiresAt = user.tempPasswordExpiresAt || null;
    recordAdmin(req, user, 'user.create', { role: user.role, demo: user.demo, copied, temporary: true, expiresAt });
    logger.info('Admin created user', { email: user.email, role: user.role, demo: user.demo, copied, by: req.user.email });
    return res.status(201).json({ success: true, user, copied });
  }

  let issued;
  try {
    issued = _issueLink(user, 'invite', authTokens.INVITE_TTL_MS, req.user);
  } catch (err) {
    logger.error('Could not make the invite link for a new account; the account was removed again', {
      email: user.email, error: err.message, by: req.user.email,
    });
    _undoCreate(user);
    return res.status(500).json({ error: 'Could not make the invite link, so the account was not created. Try again.' });
  }
  const sent = await _deliverLink(user, 'invite', issued, req.user);
  recordAdmin(req, user, 'user.create', {
    role: user.role, demo: user.demo, copied, invited: true, emailed: sent.emailed, expiresAt: sent.expiresAt,
  });
  logger.info('Admin invited a new user', { email: user.email, role: user.role, demo: user.demo, copied, emailed: sent.emailed, by: req.user.email });
  res.status(201).json({ success: true, user: users.getUser(user.id) || user, copied, invite: sent });
}));

// Removes an account made moments ago whose setting up then failed.
function _undoCreate(user) {
  try { users.deleteUser(user.id); } catch (undoErr) {
    logger.error('Could not remove a half-made account', { id: user.id, email: user.email, error: undoErr.message });
  }
}

// What createUser's refusals answer (users.js): a malformed address is the
// admin's to fix (400), one already taken is a conflict (409). Anything else
// is ours, logged, and answered without its message. 'Email already exists'
// is how createUser said it before it carried a code.
function _createRefusal(err) {
  const code = err && err.code;
  if (code === 'EMAIL_INVALID') return { status: 400, body: { error: err.message, code } };
  if (code === 'EMAIL_EXISTS' || (err && err.message === 'Email already exists')) {
    return { status: 409, body: { error: 'An account with this email already exists', code: 'EMAIL_EXISTS' } };
  }
  if (code === 'REGISTRATION_CLOSED') return { status: 403, body: { error: err.message, code } };
  return null;
}

// ── An account's Xero connection, when the account goes ─────────────────────
// Deleting the rows forgot the refresh token here, but Xero still held the
// grant: the app stayed listed under that organisation's connected apps, with
// access to its books, until the token lapsed by itself. So it is revoked at
// Xero first, as Disconnect does (routes/xero-oauth.js), while the row it is
// read from still exists. Best effort: an unreachable Xero must not keep an
// admin from deleting an account, so a failure is a warning and the delete
// goes ahead. Answers whether Xero confirmed the revocation.
async function revokeXero(userId) {
  try {
    return await require('../xero/oauth').revokeRefreshToken(userId);
  } catch (err) {
    logger.warn("Could not revoke a deleted account's Xero connection; deleting it anyway", { userId, error: err.message });
    return false;
  }
}

// And what this process still holds for it once the rows are gone: access
// tokens and the organisation list in memory, the connection health (its row
// went with the account; the memory copy did not), and reports read from its
// organisations. Each part on its own: one failing does not keep the others.
function forgetXero(userId) {
  const parts = [
    ['token cache',       () => tokenCache.forUser(userId).clear()],
    ['connection health', () => tokenCache.clearHealth(userId)],
    ['report cache',      () => require('../xero/reports').clearCache(userId)],
  ];
  for (const [part, clear] of parts) {
    try { clear(); } catch (err) {
      logger.warn(`Could not clear a deleted account's Xero ${part}`, { userId, error: err.message });
    }
  }
}

// DELETE /api/admin/users/:id
router.delete('/users/:id', requireAdmin, asyncHandler(async (req, res) => {
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
    const xeroRevoked    = await revokeXero(id);
    // Another admin's delete may have finished while Xero was asked.
    if (!findById(id)) return res.status(404).json({ error: 'User not found' });
    deleteUser(id);
    // The rows cascade in the database; the files (receipts, PDFs, queues)
    // do not. users.js had said this route removed them — it never did. A
    // job finishing a moment later can still write the folder back; the
    // daily sweep removes it then (utils/account-cleanup.js).
    try {
      fs.rmSync(require('../utils/paths').userDir(id), { recursive: true, force: true });
    } catch (err) {
      logger.warn("Could not remove the deleted user's files", { id, error: err.message });
    }
    forgetXero(id);
    // The email is copied into the event: the account it names is gone.
    recordAdmin(req, target, 'user.delete', { role: target.role, watcherStopped, xeroRevoked });
    logger.info('Admin deleted user', { id, watcherStopped, xeroRevoked, by: req.user.email });
    res.json({ success: true });
  } catch (err) {
    logger.error('Admin could not delete a user', { id: req.params.id, error: err.message, by: req.user.email });
    res.status(500).json({ error: 'Could not delete the account' });
  }
}));

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

// ── Demoting an admin who is on sample data ─────────────────────────────────
// An admin may switch their own account to sample data and back
// (PUT /api/setup/data-source); only an admin may. Their own Xero connection
// waits underneath, unused, and the keep-alive (jobs/xero-keepalive.js) keeps
// it from lapsing only for an admin. Demoted as they were, they would be a
// demo user with no way back to it, and the connection would die unused
// after 60 days.
//
// So the demote switches them back to their own Xero, in the same request,
// and says so (switchedToXero in the answer and the audit event), rather
// than refusing: a refusal would leave the admin unable to remove admin from
// someone who cannot or will not sign in to switch first. Only when they have
// a Xero connection of their own on file (users.getSetupStatus's rule, less
// the demo account's stand-in). Without one there is nothing to go back to,
// and they stay on sample data like any demo account: a demo account made an
// admin for a while and then made a user again stays the demo account it
// was made as.
//
// The switch is refused while anything could be posted across it, as the
// data-source switch itself is (routes/setup.js): a watcher still on, or
// documents still queued, would post sample-data mail into the real books.
function _ownXeroOnFile(userId) {
  const config = getUserConfig(userId) || {};
  return !!(config.XERO_CLIENT_ID && config.XERO_CLIENT_SECRET) || config.XERO_CONNECTION_TYPE === 'oauth';
}

function _switchBusy(target) {
  const watching = watcherRegistry.isRunning(target.id) || settingsStore.forUser(target.id).watcherEnabled();
  if (watching) {
    return `${target.email} is on sample data, and removing admin switches them back to their own Xero. `
      + 'Stop their mailbox watcher first, so nothing is posted across the switch.';
  }
  const n = emailQueue.getPending(target.id).length + claimQueue.getPending(target.id).length;
  if (n > 0) {
    return `${target.email} is on sample data, and removing admin switches them back to their own Xero. `
      + `${n} ${n === 1 ? 'document is' : 'documents are'} still being processed; try again once they finish.`;
  }
  return null;
}

// PATCH /api/admin/users/:id/role — promote or demote. updateUserRole existed in
// users.js from the start and nothing called it, so making a second admin took
// a SQL statement on the server. Answers { success, user, switchedToXero }.
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
  // See "Demoting an admin who is on sample data" above.
  const switchedToXero = role === 'user' && target.role === 'admin' && !!target.is_demo && _ownXeroOnFile(target.id);
  if (switchedToXero) {
    const busy = _switchBusy(target);
    if (busy) return res.status(409).json({ error: busy, code: 'BUSY' });
  }
  // A demo account made an admin may still have the short password demo
  // accounts were once allowed, and as an admin it can switch to real Xero
  // and manage every account. It must choose a full one first: at once, since
  // the gate reads the row on every request, so a session already open as
  // the demo account gets nothing until it has.
  const newPassword = role === 'admin' && target.role !== 'admin' && !!target.is_demo;
  if (newPassword) requirePasswordChange(target.id);
  if (switchedToXero) {
    setDemo(target.id, false);
    // Reports cached for the account came from the Demo Company, as on the
    // switch itself; a failure is a warning, the switch has happened.
    try { require('../xero/reports').clearCache(target.id); } catch (err) {
      logger.warn('Could not clear cached reports after switching a demoted admin to Xero', { email: target.email, error: err.message });
    }
  }
  const user = updateUserRole(target.id, role);
  recordAdmin(req, target, 'user.role', {
    from: target.role, to: role,
    ...(newPassword ? { passwordChangeRequired: true } : {}),
    ...(switchedToXero ? { switchedToXero: true } : {}),
  });
  logger.info('Admin changed user role', { email: target.email, role, switchedToXero, by: req.user.email });
  res.json({ success: true, user, switchedToXero });
});

// PATCH /api/admin/users/:id/password — set a new password for an account.
// Passwords are bcrypt hashes: there is nothing to view, only replace. The
// account's other sessions are signed out by the same cutoff a self-service
// change uses (users.js#setPassword). The password set here is temporary, as
// on Add user: replaced at the next sign-in, dead after a day, for every
// account, demo or not. A reset also unlocks the account: the person asking
// for one is often the one locked out.
router.patch('/users/:id/password', requireAdmin, asyncHandler(async (req, res) => {
  try {
    const target = findTarget(req, res, 'Change your own password from the Account page');
    if (!target) return;
    await setPassword(target.id, req.body.password, { temporary: true });
    endSessionsOf(req, target, 'password_changed');
    // That it was reset, and by whom. Never the password.
    recordAdmin(req, target, 'user.password_reset');
    logger.info('Admin reset user password', { email: target.email, by: req.user.email });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// What the link routes below refuse, and why. An account that has chosen its
// password has no invite to send or revoke; one still waiting on its invite
// has no password to reset. A disabled account's link would not work
// (auth-tokens.js#peek), so none is made until it is enabled.
const NOT_INVITED = {
  error: 'This account has already set its password, so there is no invite. Send a password reset link instead.',
  code:  'NOT_INVITED',
};
const STILL_INVITED = {
  error: "This account hasn't accepted its invite yet, so it has no password to reset. Send a new invite instead.",
  code:  'INVITED',
};
const disabledRefusal = what => ({ error: `This account is disabled. Enable it first, then send ${what}.`, code: 'DISABLED' });

// POST /api/admin/users/:id/invite — a new invite for an account that has
// not accepted its last one (run out, lost, or revoked): good for 7 days,
// emailed when the server can send mail, and the old link stops working.
// Answers { invite: { emailed, link, expiresAt } }, `link` only when it was
// not emailed (and `emailError` when the mail failed). 409 for an account
// that has already chosen its password (NOT_INVITED) or is disabled, or when
// there is no public address for the link (NO_APP_URL).
router.post('/users/:id/invite', requireAdmin, asyncHandler(async (req, res) => {
  const target = findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!users.isInvited(target)) return res.status(409).json(NOT_INVITED);
  if (target.disabled_at) return res.status(409).json(disabledRefusal('the invite'));
  if (!mailer.appBaseUrl()) return res.status(409).json(NO_APP_URL);
  const invite = await _deliverLink(target, 'invite', _issueLink(target, 'invite', authTokens.INVITE_TTL_MS, req.user), req.user);
  recordAdmin(req, target, 'user.invite', { emailed: invite.emailed, expiresAt: invite.expiresAt });
  logger.info('Admin sent a new invite', { email: target.email, emailed: invite.emailed, by: req.user.email });
  res.json({ invite });
}));

// DELETE /api/admin/users/:id/invite — the account's invite link stops
// working, for one sent to the wrong person or no longer wanted. The account
// stays, still invited, with no way in until a new invite is sent (or it is
// deleted). Answers { success: true }; 409 for an account with a password.
router.delete('/users/:id/invite', requireAdmin, (req, res) => {
  const target = findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!users.isInvited(target)) return res.status(409).json(NOT_INVITED);
  const revoked = authTokens.revoke(target.id, 'invite');
  recordAdmin(req, target, 'user.invite_revoke', { revoked });
  logger.info('Admin revoked an invite', { email: target.email, revoked, by: req.user.email });
  res.json({ success: true });
});

// POST /api/admin/users/:id/reset-link — a link for the person to choose a
// new password themselves, good for 24 hours, emailed when the server can
// send mail: the way to help someone locked out without the admin ever
// knowing their password (PATCH /users/:id/password, a temporary password,
// stays for when there is no other way). Nothing changes until the link is
// used: the current password keeps working, and using it signs the account
// out everywhere and unlocks it (routes/auth.js set-password). Answers
// { reset: { emailed, link, expiresAt } } as the invite does. Not for your
// own account (400), one still waiting on its invite (409 INVITED), or a
// disabled one (409).
router.post('/users/:id/reset-link', requireAdmin, asyncHandler(async (req, res) => {
  const target = findTarget(req, res, 'Change your own password from the Account page');
  if (!target) return;
  if (users.isInvited(target)) return res.status(409).json(STILL_INVITED);
  if (target.disabled_at) return res.status(409).json(disabledRefusal('a reset link'));
  if (!mailer.appBaseUrl()) return res.status(409).json(NO_APP_URL);
  const reset = await _deliverLink(target, 'reset', _issueLink(target, 'reset', authTokens.ADMIN_RESET_TTL_MS, req.user), req.user);
  recordAdmin(req, target, 'user.reset_link', { emailed: reset.emailed, expiresAt: reset.expiresAt });
  logger.info('Admin sent a password reset link', { email: target.email, emailed: reset.emailed, by: req.user.email });
  res.json({ reset });
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
