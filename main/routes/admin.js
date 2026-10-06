const express      = require('express');
const router       = express.Router();
const fs           = require('fs');
const path         = require('path');
const { requireAdmin } = require('../middleware/auth-middleware');
const {
  getAllUsers, createUser, updateUserRole, deleteUser, readUsers, findById, getSetupStatus, isOnline,
  passwordProblem, setPassword, invalidateSessions, setDisabled,
} = require('../utils/users');
const invoiceStore     = require('../utils/invoice-store');
const settingsStore    = require('../utils/settings-store');
const processState     = require('../utils/process-state');
const emailQueue       = require('../queue/email-queue');
const emailWorker      = require('../queue/email-worker');
const claimWorker      = require('../claims/claim-worker');
const watcherRegistry  = require('../email/watcher-registry');
const tokenCache       = require('../utils/token-cache');
const db               = require('../db');
const logger       = require('../utils/logger');

// LOGS_DIR override lets tests point at a throwaway directory instead of the
// real logs/ folder a dev server may be actively writing to (see db/index.js
// for the same DB_PATH pattern).
const LOGS_DIR = process.env.LOGS_DIR || path.join(__dirname, '../../logs');
// Only the currently-active file per stream — never the rotated logs/*N.log
// backups, which can grow large over a server's lifetime and aren't meant
// to be read live.
const LOG_FILES = { combined: 'combined.log', error: 'error.log' };

// GET /api/admin/users
router.get('/users', requireAdmin, (_req, res) => {
  res.json({ users: getAllUsers() });
});

// POST /api/admin/users — create new user
router.post('/users', requireAdmin, async (req, res) => {
  try {
    const { email, password, role } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });
    const user = await createUser(email, password, role === 'admin' ? 'admin' : 'user');
    logger.info('Admin created user', { email, role: user.role, by: req.user.email });
    res.status(201).json({ success: true, user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

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
    logger.info('Admin deleted user', { id, watcherStopped, by: req.user.email });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Account controls ─────────────────────────────────────────────────────────
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
  logger.info('Admin changed user role', { email: target.email, role, by: req.user.email });
  res.json({ success: true, user });
});

// PATCH /api/admin/users/:id/password — set a new password for an account.
// Passwords are bcrypt hashes: there is nothing to view, only replace. The
// account's other sessions are signed out by the same cutoff a self-service
// change uses (users.js#setPassword).
router.patch('/users/:id/password', requireAdmin, async (req, res) => {
  try {
    const target = findTarget(req, res, 'Change your own password from Setup');
    if (!target) return;
    await setPassword(target.id, req.body.password);
    logger.info('Admin reset user password', { email: target.email, by: req.user.email });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/admin/users/:id/sign-out — every token this account holds is
// refused from now on. For a lost laptop or a shared password: the account is
// otherwise untouched and they can sign straight back in.
router.post('/users/:id/sign-out', requireAdmin, (req, res) => {
  const target = findTarget(req, res, 'Use Sign out for your own session');
  if (!target) return;
  invalidateSessions(target.id);
  logger.info('Admin signed user out everywhere', { email: target.email, by: req.user.email });
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
  const watcherStopped = disabled ? stopAutomation(target.id) : false;
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
  logger.info('Admin stopped mailbox watcher', { email: target.email, wasRunning, by: req.user.email });
  res.json({ success: true, wasRunning });
});

// GET /api/admin/reports — all invoices needing human attention across all users.
// Includes user-flagged reports (status: reported) and system-flagged parsing
// failures that could not be auto-submitted to Xero (status: review-needed).
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
router.patch('/reports/:userId/:invoiceId/resolve', requireAdmin, async (req, res, next) => {
  try {
    const { userId, invoiceId } = req.params;
    const updated = await invoiceStore.forUser(userId).update(invoiceId, {
      status:     'reviewed',
      resolvedBy: req.user.email,
      resolvedAt: new Date().toISOString(),
    });
    if (!updated) return res.status(404).json({ error: 'Invoice not found' });
    logger.info('Report resolved', { invoiceId, userId, by: req.user.email });
    res.json({ success: true });
  } catch (err) { next(err); }
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
      lastActivity:   processState.forUser(u.id).getStatus(watcherRegistry.isRunning(u.id)).lastActivity,
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
router.get('/stats/daily', requireAdmin, (req, res) => {
  const days   = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
  const userId = (req.query.userId || '').trim();

  const params = [`-${days} days`];
  let sql = `
    SELECT date(processed_at) AS day, status, COUNT(*) AS count
    FROM invoices
    WHERE date(processed_at) >= date('now', ?)
  `;
  if (userId) { sql += ' AND user_id = ?'; params.push(userId); }
  sql += ' GROUP BY day, status ORDER BY day';

  const rows = db.prepare(sql).all(...params);

  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.day)) byDay.set(r.day, { day: r.day, posted: 0, error: 0, pending: 0, other: 0 });
    const bucket = byDay.get(r.day);
    if (r.status === 'posted')                                  bucket.posted += r.count;
    else if (r.status === 'error')                               bucket.error  += r.count;
    else if (r.status === 'pending' || r.status === 'submitting') bucket.pending += r.count;
    else                                                          bucket.other  += r.count;
  }

  // Zero-fill every day in the range, even ones with no rows at all.
  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d   = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push(byDay.get(key) || { day: key, posted: 0, error: 0, pending: 0, other: 0 });
  }

  res.json({ days: out });
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
