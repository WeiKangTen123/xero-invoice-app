const express          = require('express');
const rateLimit        = require('express-rate-limit');
const router           = express.Router();
const { requireAuth }  = require('../middleware/auth-middleware');
const watcherRegistry  = require('../email/watcher-registry');
const emailWorker      = require('../queue/email-worker');
const emailQueue       = require('../queue/email-queue');
const { createHandler } = require('../utils/invoice-handler');
const { getUserConfig, getSetupStatus } = require('../utils/users');
const invoiceStore     = require('../utils/invoice-store');
const settingsStore    = require('../utils/settings-store');
const processState     = require('../utils/process-state');
const logger           = require('../utils/logger');

// Track which users have had their in-memory invoice count synced from disk.
// We sync once per server lifetime per user so the dashboard shows the real count
// after a restart, without reading the JSON file on every status poll.
const _synced = new Set();

// Rescan rate-limited to once per 30 s per user
const rescanLimiter = rateLimit({
  windowMs: 30 * 1000,
  max:      1,
  keyGenerator: req => `rescan:${req.user?.id || req.ip}`,
  message:  { error: 'Rescan already triggered — wait 30 seconds before rescanning again' },
  standardHeaders: true,
  legacyHeaders:   false,
});

// GET /api/process/status
router.get('/status', requireAuth, (req, res, next) => {
  try {
    const userId  = req.user.id;
    const state   = processState.forUser(userId);

    // Sync invoice count from disk once per server lifetime per user
    if (!_synced.has(userId)) {
      _synced.add(userId);
      state.syncCount(invoiceStore.forUser(userId).getAll().length);
    }

    const running  = watcherRegistry.isRunning(userId);
    const setup    = getSetupStatus(userId);
    const queue    = emailQueue.getStats(userId);
    const allInv   = invoiceStore.forUser(userId).getAll();
    const xero     = {
      pending:    allInv.filter(i => i.status === 'pending').length,
      submitting: allInv.filter(i => i.status === 'submitting').length,
      posted:     allInv.filter(i => i.status === 'posted').length,
      error:      allInv.filter(i => i.status === 'error').length,
    };
    res.json({
      ...state.getStatus(running),
      setupRequired: !setup.ready,
      missingConfig: setup.missingConfig,
      queue,
      xero,
    });
  } catch (err) { next(err); }
});

// POST /api/process/start
router.post('/start', requireAuth, (req, res, next) => {
  try {
    const userId = req.user.id;
    if (watcherRegistry.isRunning(userId)) {
      return res.json({ success: true, message: 'Already running' });
    }

    const setup = getSetupStatus(userId);
    if (!setup.ready) {
      const sections = setup.missingConfig.filter(s => s !== 'llm'); // llm is optional
      if (sections.length > 0) {
        return res.status(400).json({
          error: `Setup incomplete — configure ${sections.join(' and ')} before starting`,
          missingConfig: sections,
        });
      }
    }

    const config  = getUserConfig(userId);
    const handler = createHandler(userId);
    watcherRegistry.start(userId, config, handler.onInvoiceEmail);
    emailWorker.startWorker(userId, handler.onInvoiceEmail);
    processState.forUser(userId).notifyStarted();
    logger.info('Email watcher started', { by: req.user.email, userId });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/process/stop
router.post('/stop', requireAuth, (req, res, next) => {
  try {
    const userId = req.user.id;
    watcherRegistry.stop(userId);
    processState.forUser(userId).notifyStopped();
    logger.info('Email watcher stopped', { by: req.user.email, userId });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/process/settings
router.get('/settings', requireAuth, (req, res) => {
  res.json(settingsStore.forUser(req.user.id).get());
});

// PATCH /api/process/settings
router.patch('/settings', requireAuth, (req, res) => {
  const allowed = ['autoProcess'];
  const patch   = {};
  for (const k of allowed) {
    if (k in req.body) patch[k] = Boolean(req.body[k]);
  }
  const updated = settingsStore.forUser(req.user.id).set(patch);
  logger.info('Settings updated', { patch, by: req.user.email });
  res.json(updated);
});

// POST /api/process/rescan — trigger immediate IMAP scan for unread emails
router.post('/rescan', requireAuth, rescanLimiter, (req, res) => {
  const userId = req.user.id;
  if (!watcherRegistry.isRunning(userId)) {
    return res.status(400).json({ error: 'Watcher is not running — start it first' });
  }
  const ok = watcherRegistry.rescan(userId);
  if (!ok) return res.status(400).json({ error: 'Watcher is not connected yet' });
  logger.info('Manual rescan triggered', { by: req.user.email, userId });
  res.json({ success: true });
});

module.exports = router;
