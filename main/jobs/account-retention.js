// Retention, once a day. The audit history (two years), the sign-in records
// (90 days) and the sessions holding the same addresses (30 days) were pruned
// only at boot (index.js), so on a server that stayed up those limits meant
// "since the last restart". The data folders of deleted accounts
// (utils/account-cleanup.js) are swept at boot too, and again here, for a
// folder a late job wrote back after its account went. Invite and reset
// links used or run out more than 30 days ago go here too
// (utils/auth-tokens.js#prune).
//
// No first run of its own: index.js does both at boot, before anything adds
// to the tables or reads the folders, and this keeps them so from then on.
//
// Never throws, and nothing escapes to the timer (index.js treats an
// unhandled rejection as fatal): each part that fails is a warning, the other
// still runs, and the next day tries again.
//
//   require('./jobs/account-retention').start();   // from main/index.js, once at boot
const logger = require('../utils/logger');

const DAY_MS = 24 * 60 * 60 * 1000;

let _dailyTimer = null;

/**
 * One pass: prune the old events and sessions and the old links, then sweep
 * the folders. Answers { events, links, folders }, each as its own function
 * answers it (events null when the prune could not run, links null when
 * theirs could not). Never throws.
 */
function runOnce({ now = Date.now() } = {}) {
  const summary = { events: null, links: null, folders: { removed: [], kept: [] } };
  try {
    summary.events = require('../utils/audit-log').pruneOldEvents({ now });
  } catch (err) {
    logger.warn('Daily prune of old events and sessions failed', { error: (err && err.message) || String(err) });
  }
  try {
    summary.links = require('../utils/auth-tokens').prune({ now });
    if (summary.links) logger.info('Old invite and reset links pruned', { links: summary.links });
  } catch (err) {
    logger.warn('Daily prune of old invite and reset links failed', { error: (err && err.message) || String(err) });
  }
  try {
    summary.folders = require('../utils/account-cleanup').sweepOrphanFolders();
  } catch (err) {
    logger.warn('Daily sweep for the data folders of deleted accounts failed', { error: (err && err.message) || String(err) });
  }
  return summary;
}

// Starts the daily schedule. Safe to call more than once. The timer is
// unref'd so it never keeps the process alive on shutdown. Answers whether
// this call started it.
function start() {
  if (_dailyTimer) return false;
  _dailyTimer = setInterval(() => { runOnce(); }, DAY_MS);
  if (typeof _dailyTimer.unref === 'function') _dailyTimer.unref();
  logger.info('Daily retention scheduled', { everyHours: 24 });
  return true;
}

function stop() {
  if (_dailyTimer) clearInterval(_dailyTimer);
  _dailyTimer = null;
}

module.exports = { start, stop, runOnce, DAY_MS };
