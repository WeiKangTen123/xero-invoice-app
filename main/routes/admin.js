const express      = require('express');
const router       = express.Router();
const { requireAdmin } = require('../middleware/auth-middleware');
const { getAllUsers, createUser, updateUserRole, deleteUser, readUsers, getSetupStatus } = require('../utils/users');
const invoiceStore     = require('../utils/invoice-store');
const settingsStore    = require('../utils/settings-store');
const processState     = require('../utils/process-state');
const emailQueue       = require('../queue/email-queue');
const watcherRegistry  = require('../email/watcher-registry');
const tokenCache       = require('../utils/token-cache');
const db               = require('../db');
const logger       = require('../utils/logger');

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
  const fs    = require('fs');
  const users = readUsers();

  let dbSizeKb = null;
  try {
    if (db.path !== ':memory:') dbSizeKb = Math.round(fs.statSync(db.path).size / 1024);
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
      redisConfigured: !!process.env.REDIS_URL,
      totalUsers:      users.length,
      totalInvoices,
    },
    users: userStats,
  });
});

module.exports = router;
