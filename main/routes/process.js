const express          = require('express');
const rateLimit        = require('express-rate-limit');
const router           = express.Router();
const { requireAuth }  = require('../middleware/auth-middleware');
const watcherRegistry  = require('../email/watcher-registry');
const emailWorker      = require('../queue/email-worker');
const emailQueue       = require('../queue/email-queue');
const { createHandler } = require('../utils/invoice-handler');
const users            = require('../utils/users');
const { getUserConfig, getSetupStatus } = users;
const invoiceStore     = require('../utils/invoice-store');
const settingsStore    = require('../utils/settings-store');
const tokenCache       = require('../utils/token-cache');
const processState     = require('../utils/process-state');
const idleSweeper      = require('../email/idle-sweeper');
const logger           = require('../utils/logger');

// Gap between watchers resumed at boot. Every mailbox reconnecting in the same
// instant is a burst of TLS handshakes and logins from one address, which is
// what providers throttle, and every first scan then hits the queue together.
const RESUME_STAGGER_MS = 2000;

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
      state.syncCount(invoiceStore.forUser(userId).count());
    }

    const running  = watcherRegistry.isRunning(userId);
    const setup    = getSetupStatus(userId);
    const queue    = emailQueue.getStats(userId);
    // One GROUP BY. This poll runs every few seconds per open dashboard, and
    // it used to load every invoice with its line items and reports to count.
    const byStatus = invoiceStore.forUser(userId).countByStatus();
    const xero     = {
      pending:    byStatus.pending    || 0,
      submitting: byStatus.submitting || 0,
      posted:     byStatus.posted     || 0,
      error:      byStatus.error      || 0,
    };
    res.json({
      ...state.getStatus(running),
      setupRequired: !setup.ready,
      missingConfig: setup.missingConfig,
      queue,
      xero,
      // Why the watcher is or is not watching (see watcher-registry getStatus):
      // `running` alone cannot tell a refused password from a backoff or Stop.
      watcher: watcherRegistry.getStatus(userId),
    });
  } catch (err) { next(err); }
});

// The parts of setup a watcher cannot run without. The LLM key is optional.
function _missingForWatcher(userId) {
  const setup = getSetupStatus(userId);
  return setup.ready ? [] : setup.missingConfig.filter(s => s !== 'llm');
}

// Starts this account's watcher and the worker behind it. Shared by Start and
// by resumeWatchers, so a resumed watcher is built exactly like a clicked one.
function _startWatcher(userId, loginEmail) {
  const config  = getUserConfig(userId);
  const handler = createHandler(userId);
  // Whatever the user left blank is worked out from their address.
  watcherRegistry.start(userId, config, handler.onInvoiceEmail, { loginEmail });
  emailWorker.startWorker(userId, handler.onInvoiceEmail);
  processState.forUser(userId).notifyStarted();
}

// Saved so a restart can put the watcher back (resumeWatchers). A failure to
// save does not undo a start that worked; it only means a restart leaves this
// mailbox off, as every restart used to.
function _rememberStarted(userId) {
  try { settingsStore.forUser(userId).setWatcherEnabled(true); } catch (err) {
    logger.warn('Could not record that the watcher was started', { userId, error: err.message });
  }
}

// Why this account's watcher should not be resumed now, or null if it should.
function _resumeBlocker(userId, now) {
  const user = users.findById(userId);
  if (!user || !users.isActive(userId)) return 'account disabled or deleted';
  if (!settingsStore.forUser(userId).watcherEnabled()) return 'switched off';
  if (watcherRegistry.isRunning(userId)) return 'already running';
  const missing = _missingForWatcher(userId);
  if (missing.length) return `setup incomplete (${missing.join(', ')})`;
  // An account the idle sweeper would stop is left stopped. The sweep pauses
  // a watcher whose owner has been away past the cutoff and leaves it switched
  // on; resuming it here would undo the sweep on every deploy, only for the
  // next sweep to stop it again. Once its owner is seen again, the next boot
  // resumes it, or they press Start.
  if (idleSweeper._idleUserIds([userId], { [userId]: user.last_seen_at }, now).length) return 'owner idle';
  return null;
}

// Restarts, at boot, every mailbox watcher whose owner left it on: an active
// account with watcher_enabled set and the setup a watcher needs. Before this
// a watcher only ever started from the Start button, so every deploy or crash
// restart switched off every mailbox until each user came back and pressed it.
//
// Staggered by `staggerMs` so they do not all connect at once. Each account is
// checked when its turn comes, not up front, so one stopped, disabled or
// started by hand during the stagger is respected. Never rejects; resolves to
// the ids it started. Called once at boot, by main/index.js through
// watcher-registry.resumeWatchers(), after the server is up.
async function resumeWatchers({ staggerMs = RESUME_STAGGER_MS } = {}) {
  let candidates;
  try { candidates = settingsStore.watcherEnabledUserIds(); } catch (err) {
    logger.error('Watcher resume: could not read which mailboxes were switched on', { error: err.message });
    return [];
  }
  const started = [];
  for (const userId of candidates) {
    if (started.length && staggerMs > 0) await new Promise(r => setTimeout(r, staggerMs));
    try {
      const blocker = _resumeBlocker(userId, Date.now());
      if (blocker) {
        logger.info('Watcher resume: skipped', { userId, why: blocker });
        continue;
      }
      _startWatcher(userId, users.findById(userId).email);
      started.push(userId);
      logger.info('Watcher resumed after restart', { userId });
    } catch (err) {
      logger.error('Watcher resume: could not start', { userId, error: err.message });
    }
  }
  if (candidates.length) logger.info(`Watcher resume: ${started.length} of ${candidates.length} switched-on mailbox(es) started`);
  return started;
}

// POST /api/process/start
router.post('/start', requireAuth, (req, res, next) => {
  try {
    const userId = req.user.id;
    if (watcherRegistry.isRunning(userId)) {
      _rememberStarted(userId);
      return res.json({ success: true, message: 'Already running' });
    }

    const sections = _missingForWatcher(userId);
    if (sections.length > 0) {
      return res.status(400).json({
        error: `Setup incomplete — configure ${sections.join(' and ')} before starting`,
        missingConfig: sections,
      });
    }

    _startWatcher(userId, req.user.email);
    _rememberStarted(userId);
    logger.info('Email watcher started', { by: req.user.email, userId });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/process/stop
// A plain stop() is a person's choice, so it also clears the saved setting and
// a restart leaves this mailbox off (watcher-registry STOP_REASONS).
router.post('/stop', requireAuth, (req, res, next) => {
  try {
    const userId = req.user.id;
    watcherRegistry.stop(userId);
    processState.forUser(userId).notifyStopped();
    logger.info('Email watcher stopped', { by: req.user.email, userId });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// The settings this route reads and writes, and nothing else the store holds.
function _settingsView(s) {
  const { autoProcess, defaultTenantId, recurringAccounts, notRecurringAccounts } = s;
  return { autoProcess, defaultTenantId, recurringAccounts, notRecurringAccounts };
}

// Revenue account labels marked recurring or not recurring (see
// settings-store). Bounded so one request cannot store an unbounded row; 200
// is far more revenue accounts than any organisation reports, and 200
// characters is longer than Xero allows an account name.
const MAX_MARKED_ACCOUNTS = 200;
const MAX_LABEL_LENGTH    = 200;
function _labelList(value) {
  if (value === null) return [];   // null clears, as it does for defaultTenantId
  if (!Array.isArray(value) || value.length > MAX_MARKED_ACCOUNTS) return undefined;
  if (value.some(v => typeof v !== 'string' || v.length > MAX_LABEL_LENGTH)) return undefined;
  return value;
}

// GET /api/process/settings → { autoProcess, defaultTenantId, recurringAccounts, notRecurringAccounts }
// defaultTenantId is the Xero company a new document is sent to when more than
// one is connected (queue/processor.js); null when none has been chosen.
// The two lists are the Revenue tab's recurring marks; empty when none.
router.get('/settings', requireAuth, (req, res) => {
  res.json(_settingsView(settingsStore.forUser(req.user.id).get()));
});

// PATCH /api/process/settings  { autoProcess?, defaultTenantId?, recurringAccounts?, notRecurringAccounts? }
// defaultTenantId must be one of this account's connected companies, or null
// or '' to clear it. Anything else is refused rather than stored: an unknown
// id would quietly fall through to "choose a company" on every send.
// recurringAccounts and notRecurringAccounts are each an array of at most 200
// account labels, or null to clear; a label may not be in both.
router.patch('/settings', requireAuth, (req, res) => {
  const body  = req.body || {};
  const patch = {};
  for (const field of ['recurringAccounts', 'notRecurringAccounts']) {
    if (!(field in body)) continue;
    const list = _labelList(body[field]);
    if (list === undefined) {
      return res.status(400).json({ error: `${field} must be a list of at most ${MAX_MARKED_ACCOUNTS} account names` });
    }
    patch[field] = list;
  }
  if (patch.recurringAccounts && patch.notRecurringAccounts) {
    const key = s => s.trim().replace(/\s+/g, ' ').toLowerCase();
    const rec = new Set(patch.recurringAccounts.map(key));
    if (patch.notRecurringAccounts.some(l => rec.has(key(l)))) {
      return res.status(400).json({ error: 'An account cannot be marked both recurring and not recurring' });
    }
  }
  if ('autoProcess' in body) patch.autoProcess = Boolean(body.autoProcess);
  if ('defaultTenantId' in body) {
    const value = body.defaultTenantId;
    if (value === null || value === '') {
      patch.defaultTenantId = null;
    } else {
      const connected = tokenCache.getPersistedTenants(req.user.id);
      if (typeof value !== 'string' || !connected.some(t => String(t.tenantId) === value)) {
        return res.status(400).json({ error: 'Choose one of the connected Xero companies' });
      }
      patch.defaultTenantId = value;
    }
  }
  let saved;
  try {
    saved = settingsStore.forUser(req.user.id).set(patch);
  } catch (err) {
    // The marks' column is added by a migration; until it has run they cannot
    // be kept, and nothing in the request was saved (the store writes it all
    // or none of it).
    if (err instanceof settingsStore.RecurringUnavailableError) {
      logger.warn('Settings not saved: recurring marks column missing', { by: req.user.email });
      return res.status(503).json({ error: 'Recurring account marks are not available yet. Try again after the next update.' });
    }
    throw err;
  }
  logger.info('Settings updated', { patch, by: req.user.email });
  res.json(_settingsView(saved));
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
module.exports.resumeWatchers = resumeWatchers;
module.exports.RESUME_STAGGER_MS = RESUME_STAGGER_MS;
