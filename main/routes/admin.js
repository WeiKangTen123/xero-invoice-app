const express      = require('express');
const router       = express.Router();
const fs           = require('fs');
const path         = require('path');
const { requireAdmin } = require('../middleware/auth-middleware');
const { getAllUsers, createUser, updateUserRole, deleteUser, readUsers, getSetupStatus, isOnline } = require('../utils/users');
const invoiceStore     = require('../utils/invoice-store');
const settingsStore    = require('../utils/settings-store');
const processState     = require('../utils/process-state');
const emailQueue       = require('../queue/email-queue');
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
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const user = await createUser(email, password, role === 'admin' ? 'admin' : 'user');
    logger.info('Admin created user', { email, role: user.role, by: req.user.email });
    res.status(201).json({ success: true, user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/admin/users/:id — promote or demote a user's role
router.patch('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { id }   = req.params;
    const { role } = req.body;

    if (!['admin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Role must be "admin" or "user"' });
    }

    const users  = readUsers();
    const target = users.find(u => u.id === id);
    if (!target) return res.status(404).json({ error: 'User not found' });

    if (id === req.user.id && role !== 'admin') {
      return res.status(400).json({ error: 'Cannot demote your own account' });
    }
    if (target.role === 'admin' && role === 'user') {
      const adminCount = users.filter(u => u.role === 'admin').length;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot demote the last admin account' });
      }
    }

    const updated = await updateUserRole(id, role);
    logger.info('Admin updated user role', { id, newRole: role, by: req.user.email });
    res.json({ success: true, user: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    if (id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    const users  = readUsers();
    const admins = users.filter(u => u.role === 'admin');
    const target = users.find(u => u.id === id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin' && admins.length <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last admin account' });
    }
    deleteUser(id);
    logger.info('Admin deleted user', { id, by: req.user.email });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
      redisConfigured: !!process.env.REDIS_URL,
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
