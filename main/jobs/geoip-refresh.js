// Keeps the IP-location databases (utils/geoip.js) current: DB-IP publishes
// new ones monthly, and an address that has changed hands since reads as
// wherever its last owner was. Once shortly after boot, so a new server (or
// one whose files were removed) has them within minutes, then once a day;
// each time only a database that is missing or older than MAX_AGE_MS is
// fetched (scripts/update-geoip.js does the fetching), so a normal day costs
// two file reads and no download.
//
// Never throws, and a failure is a warning: without the databases the pages
// show no locations, and nothing else depends on them. The next day tries
// again.
//
// Never under the test suite: a run is a 60 MB download from DB-IP. start()
// does nothing there unless a test asks for it by name ({ force: true }).
//
//   require('./jobs/geoip-refresh').start();   // from main/index.js, once at boot
const logger = require('../utils/logger');

const DAY_MS     = 24 * 60 * 60 * 1000;
// A month's file, and a few days' grace for DB-IP publishing the next one.
const MAX_AGE_MS = 35 * DAY_MS;
// After the boot recoveries have started, and well before anyone is likely to
// open an account's sign-ins.
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;

let _firstTimer = null;
let _dailyTimer = null;
let _running    = null;

// The databases that need fetching: missing, or written more than MAX_AGE_MS
// before `now`.
function dueDatabases(now = Date.now()) {
  const dates = require('../utils/geoip').databaseDates();
  return Object.keys(dates).filter(kind => !dates[kind] || now - dates[kind].getTime() > MAX_AGE_MS);
}

async function _run(now) {
  const due = dueDatabases(now);
  if (!due.length) return { ran: false, updated: [], failed: [] };
  const { update } = require('../scripts/update-geoip');
  const { updated, failed } = await update({ now: new Date(now), kinds: due });
  if (updated.length) {
    logger.info('IP location databases updated', { databases: updated.map(u => `${u.kind} ${u.month}`) });
  }
  for (const f of failed) logger.warn('IP location database not updated', { database: f.kind, error: f.error });
  return { ran: true, updated, failed };
}

/**
 * One check, and a fetch of whatever is due. Resolves with { ran, updated,
 * failed }; never rejects. A call while one is running gets that one.
 */
function runOnce({ now = Date.now() } = {}) {
  if (!_running) {
    _running = _run(now)
      .catch(err => {
        logger.warn('IP location database refresh failed', { error: (err && err.message) || String(err) });
        return { ran: true, updated: [], failed: [] };
      })
      .finally(() => { _running = null; });
  }
  return _running;
}

// Starts the schedule: the first check FIRST_RUN_DELAY_MS after boot, then
// daily. Safe to call more than once. The timers are unref'd so they never
// keep the process alive on shutdown. Answers whether it was started.
function start({ force = false } = {}) {
  if (process.env.NODE_ENV === 'test' && !force) return false;
  if (_dailyTimer) return true;
  _firstTimer = setTimeout(() => { _firstTimer = null; runOnce(); }, FIRST_RUN_DELAY_MS);
  _dailyTimer = setInterval(() => { runOnce(); }, DAY_MS);
  if (typeof _firstTimer.unref === 'function') _firstTimer.unref();
  if (typeof _dailyTimer.unref === 'function') _dailyTimer.unref();
  logger.info('IP location database refresh scheduled', { everyHours: 24, maxAgeDays: MAX_AGE_MS / DAY_MS });
  return true;
}

function stop() {
  if (_firstTimer) clearTimeout(_firstTimer);
  if (_dailyTimer) clearInterval(_dailyTimer);
  _firstTimer = null;
  _dailyTimer = null;
}

module.exports = { start, stop, runOnce, dueDatabases, MAX_AGE_MS, FIRST_RUN_DELAY_MS, DAY_MS };
