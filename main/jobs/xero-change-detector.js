// Looks, once a minute, for anything that changed in Xero for the companies
// of every active account, so the reports on screen refresh themselves
// (xero/change-detector.js does the looking and decides which companies are
// due: one someone is watching every two minutes, any other every fifteen).
//
// Only active accounts (users.isActive): nothing is done in the background
// for a disabled one. One account, and one company, at a time, so this
// never adds more than two calls to Xero's per-minute allowance at once.
//
// Never throws: a failure for one account is logged and the tick moves on,
// and nothing escapes to the timer (index.js treats an unhandled rejection
// as fatal). A tick that is still running when the next is due is not
// doubled: the next gets the running one.
//
//   require('./jobs/xero-change-detector').start();   // from main/index.js, once at boot
const logger = require('../utils/logger');

const TICK_MS = 60 * 1000;

const EMPTY = () => ({ accounts: 0, companies: 0, polled: 0, changed: 0, notLive: 0, failed: 0 });

let _timer   = null;
let _running = null;

async function _run(now) {
  const summary = EMPTY();
  let users, tokenCache, detector;
  try {
    users      = require('../utils/users');
    tokenCache = require('../utils/token-cache');
    detector   = require('../xero/change-detector');
  } catch (err) {
    logger.error('Xero change detector could not start its tick', { error: err.message });
    return summary;
  }

  let accounts = [];
  try {
    accounts = users.getAllUsers() || [];
  } catch (err) {
    logger.error('Xero change detector could not list accounts', { error: err.message });
    return summary;
  }

  for (const account of accounts) {
    const userId = account && account.id;
    if (!userId) continue;
    try {
      if (!users.isActive(userId)) continue;
      summary.accounts++;
      // The companies on file, not a fresh list from Xero: listing them
      // would be a call of its own, every minute.
      for (const t of tokenCache.getPersistedTenants(userId) || []) {
        const tenantId = t && t.tenantId;
        if (!tenantId) continue;
        summary.companies++;
        if (!detector.due(userId, tenantId, now())) continue;
        const r = (await detector.pollTenant(userId, tenantId, { now })) || {};
        summary.polled++;
        if (r.changed) summary.changed++;
        if (r.live === false) summary.notLive++;
      }
    } catch (err) {
      summary.failed++;
      logger.warn('Xero change detector failed for an account', { userId, error: err && err.message });
    }
  }

  // A tick a minute would be the busiest line in the log; the detector logs
  // the change itself ("Xero change detected"), which is the line worth having.
  if (summary.polled || summary.failed) logger.debug('Xero change detector tick finished', summary);
  return summary;
}

/**
 * One tick over every active account. Resolves with { accounts, companies,
 * polled, changed, notLive, failed }; never rejects. A call while a tick is
 * running gets that tick.
 */
function runOnce({ now = () => new Date() } = {}) {
  if (!_running) {
    _running = _run(now)
      .catch(err => {
        logger.error('Xero change detector tick failed', { error: err && err.message });
        return EMPTY();
      })
      .finally(() => { _running = null; });
  }
  return _running;
}

// Starts the schedule. Safe to call more than once. The timer is unref'd so
// it never keeps the process alive on shutdown. The first tick is a minute
// after boot: by then the token cache has warmed for anyone signed in, and
// a company nobody is watching waits its fifteen minutes anyway.
function start() {
  if (_timer) return;
  _timer = setInterval(() => { runOnce(); }, TICK_MS);
  if (typeof _timer.unref === 'function') _timer.unref();
  logger.info('Xero change detector scheduled', { everySeconds: TICK_MS / 1000 });
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = { start, stop, runOnce, TICK_MS };
