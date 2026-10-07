// Keeps idle Xero OAuth connections alive.
//
// A Xero refresh token lapses after 60 days without being used, and the app
// only refreshes when someone uses it — so an account nobody opened for two
// months (a holiday, a quiet season, mail paused) found its connection dead
// and had to go through Xero's consent screen again. Once a day this refreshes
// every OAuth connection that has not been refreshed for STALE_AFTER_MS, which
// keeps it far inside the 60 days.
//
// Only active accounts (users.isActive): a disabled account's connection is
// left to lapse, like everything else done in the background for it. Only
// OAuth: a Custom Connection has no refresh token to keep alive. A connection
// already known to need reconnecting is skipped — a refresh cannot fix it.
//
// One account at a time, and never throws: a failure for one account is
// logged and the run moves on, and nothing escapes to the timer (index.js
// treats an unhandled rejection as fatal).
//
//   require('./jobs/xero-keepalive').start();   // from main/index.js, once at boot
const logger = require('../utils/logger');

const DAY_MS          = 24 * 60 * 60 * 1000;
const STALE_AFTER_MS  = 7 * DAY_MS;
// The first run waits until boot has settled (mail watchers resuming, the boot
// retry of unsent invoices) rather than adding Xero calls to that.
const FIRST_RUN_DELAY_MS = 10 * 60 * 1000;

let _firstTimer = null;
let _dailyTimer = null;
let _running    = null;

// When this connection's token was last refreshed, as a timestamp, or null
// when nothing says (a connection made before refreshes were recorded).
function _lastRefreshedAt(health, config) {
  const t = Date.parse((health && health.lastRefreshedAt) || config.XERO_OAUTH_CONNECTED_AT || '');
  return Number.isFinite(t) ? t : null;
}

async function _run(now) {
  const summary = { checked: 0, refreshed: 0, skipped: 0, failed: 0 };
  let users, tokenCache, oauth, xeroErrMsg;
  try {
    users      = require('../utils/users');
    tokenCache = require('../utils/token-cache');
    oauth      = require('../xero/oauth');
    ({ xeroErrMsg } = require('../xero/xero-utils'));
  } catch (err) {
    logger.error('Xero keep-alive could not start its run', { error: err.message });
    return summary;
  }

  let accounts = [];
  try {
    accounts = users.getAllUsers() || [];
  } catch (err) {
    logger.error('Xero keep-alive could not list accounts', { error: err.message });
    return summary;
  }

  for (const account of accounts) {
    const userId = account && account.id;
    if (!userId) continue;
    try {
      if (!users.isActive(userId)) continue;
      const config = users.getUserConfig(userId) || {};
      if (config.XERO_CONNECTION_TYPE !== 'oauth' || !config.XERO_OAUTH_REFRESH_TOKEN) continue;
      summary.checked++;

      const health = tokenCache.getHealth(userId) || {};
      if (health.needsReconnect) { summary.skipped++; continue; }

      const last = _lastRefreshedAt(health, config);
      if (last !== null && now - last < STALE_AFTER_MS) { summary.skipped++; continue; }

      // reconnect, not a bare refresh: the new access token goes into the
      // cache for every organisation, and organisations removed on Xero's
      // side drop out (token-cache pruneTenants). The refresh itself is shared
      // with any other in flight for this user (xero/oauth.js), so this can
      // never redeem a token another request is redeeming.
      await oauth.reconnect(userId);
      summary.refreshed++;
      logger.info('Xero keep-alive refreshed an idle connection', { userId });
    } catch (err) {
      summary.failed++;
      let error;
      try { error = xeroErrMsg(err); } catch (_) { error = err && err.message; }
      logger.warn('Xero keep-alive could not refresh a connection', { userId, error });
    }
  }

  logger.info('Xero keep-alive run finished', summary);
  return summary;
}

/**
 * One pass over every account. Resolves with { checked, refreshed, skipped,
 * failed }; never rejects. A call while a pass is running gets that pass.
 */
function runOnce({ now = Date.now() } = {}) {
  if (!_running) {
    _running = _run(now)
      .catch(err => {
        logger.error('Xero keep-alive run failed', { error: err && err.message });
        return { checked: 0, refreshed: 0, skipped: 0, failed: 0 };
      })
      .finally(() => { _running = null; });
  }
  return _running;
}

// Starts the daily schedule. Safe to call more than once. The timers are
// unref'd so they never keep the process alive on shutdown.
function start() {
  if (_dailyTimer) return;
  _firstTimer = setTimeout(() => { _firstTimer = null; runOnce(); }, FIRST_RUN_DELAY_MS);
  _dailyTimer = setInterval(() => { runOnce(); }, DAY_MS);
  if (typeof _firstTimer.unref === 'function') _firstTimer.unref();
  if (typeof _dailyTimer.unref === 'function') _dailyTimer.unref();
  logger.info('Xero keep-alive scheduled', { everyHours: 24, staleAfterDays: STALE_AFTER_MS / DAY_MS });
}

function stop() {
  if (_firstTimer) clearTimeout(_firstTimer);
  if (_dailyTimer) clearInterval(_dailyTimer);
  _firstTimer = null;
  _dailyTimer = null;
}

module.exports = { start, stop, runOnce, STALE_AFTER_MS, FIRST_RUN_DELAY_MS, DAY_MS };
