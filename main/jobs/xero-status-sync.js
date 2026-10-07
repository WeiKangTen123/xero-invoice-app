// Reads back from Xero, every three hours, what became of the documents each
// account posted there: approved, paid, part-paid, voided or deleted
// (xero/status-sync.js does the reading). Without it the list only learns
// when someone presses "Refresh from Xero", and a bill paid last week still
// reads as a draft that can be re-posted.
//
// Only active accounts (users.isActive): nothing is done in the background
// for a disabled one. One account at a time, so this never adds more than one
// account's calls to Xero's per-minute allowance at once, and each account's
// own calls are few (a call per 50 open documents per company, with
// If-Modified-Since keeping the answers small).
//
// Never throws: a failure for one account is logged and the run moves on, and
// nothing escapes to the timer (index.js treats an unhandled rejection as
// fatal).
//
//   require('./jobs/xero-status-sync').start();   // from main/index.js, once at boot
const logger = require('../utils/logger');

const HOUR_MS  = 60 * 60 * 1000;
const EVERY_MS = 3 * HOUR_MS;
// The first run waits until boot has settled (mail watchers resuming, the boot
// retry of unsent invoices, the keep-alive's own first run at ten minutes)
// rather than adding Xero calls to those.
const FIRST_RUN_DELAY_MS = 15 * 60 * 1000;

const EMPTY = () => ({ accounts: 0, checked: 0, updated: 0, failedTenants: 0, failed: 0 });

let _firstTimer = null;
let _timer      = null;
let _running    = null;

async function _run() {
  const summary = EMPTY();
  let users, statusSync;
  try {
    users      = require('../utils/users');
    statusSync = require('../xero/status-sync');
  } catch (err) {
    logger.error('Xero status sync could not start its run', { error: err.message });
    return summary;
  }

  let accounts = [];
  try {
    accounts = users.getAllUsers() || [];
  } catch (err) {
    logger.error('Xero status sync could not list accounts', { error: err.message });
    return summary;
  }

  for (const account of accounts) {
    const userId = account && account.id;
    if (!userId) continue;
    try {
      if (!users.isActive(userId)) continue;
      summary.accounts++;
      const r = (await statusSync.syncUser(userId)) || {};
      summary.checked       += Number(r.checked) || 0;
      summary.updated       += Number(r.updated) || 0;
      summary.failedTenants += Number(r.failedTenants) || 0;
    } catch (err) {
      summary.failed++;
      logger.warn('Xero status sync failed for an account', { userId, error: err && err.message });
    }
  }

  logger.info('Xero status sync run finished', summary);
  return summary;
}

/**
 * One pass over every active account. Resolves with { accounts, checked,
 * updated, failedTenants, failed }; never rejects. A call while a pass is
 * running gets that pass.
 */
function runOnce() {
  if (!_running) {
    _running = _run()
      .catch(err => {
        logger.error('Xero status sync run failed', { error: err && err.message });
        return EMPTY();
      })
      .finally(() => { _running = null; });
  }
  return _running;
}

// Starts the schedule. Safe to call more than once. The timers are unref'd so
// they never keep the process alive on shutdown.
function start() {
  if (_timer) return;
  _firstTimer = setTimeout(() => { _firstTimer = null; runOnce(); }, FIRST_RUN_DELAY_MS);
  _timer      = setInterval(() => { runOnce(); }, EVERY_MS);
  if (typeof _firstTimer.unref === 'function') _firstTimer.unref();
  if (typeof _timer.unref === 'function') _timer.unref();
  logger.info('Xero status sync scheduled', { everyHours: EVERY_MS / HOUR_MS });
}

function stop() {
  if (_firstTimer) clearTimeout(_firstTimer);
  if (_timer) clearInterval(_timer);
  _firstTimer = null;
  _timer      = null;
}

module.exports = { start, stop, runOnce, EVERY_MS, FIRST_RUN_DELAY_MS };
