const logger   = require('../utils/logger');
const registry = require('./watcher-registry');
const db       = require('../db');

// Stops mailbox watchers belonging to accounts nobody has touched in a long time.
//
// This is a backstop, not a leash. Logging out stops your own watcher
// immediately (routes/auth.js), and that covers the ordinary "I'm done for the
// day" case. This exists for the session that is simply abandoned — a closed
// laptop, a forgotten browser tab — where nothing else would ever stop it.
//
// The window is deliberately long. A watcher that stops after an hour is not an
// automation: bills arrive overnight and at weekends, and the whole point is
// that they get collected without anyone watching. Eight hours is past any
// normal working gap but well short of "running forever unattended".
const IDLE_MS  = 8 * 60 * 60 * 1000;
const SWEEP_MS = 15 * 60 * 1000;

// Pure. Which of the running watchers belong to accounts idle past the cutoff.
//
// A missing last_seen is left ALONE rather than swept. Stopping a watcher is
// disruptive and silent; an absent timestamp means we don't know, and "don't
// know" is not evidence of being idle.
function _idleUserIds(runningIds, lastSeenById, now, idleMs = IDLE_MS) {
  return runningIds.filter(id => {
    const seen = lastSeenById[id];
    if (!seen) return false;
    const t = new Date(seen).getTime();
    return Number.isFinite(t) && (now - t) > idleMs;
  });
}

function _lastSeenMap() {
  const out = {};
  for (const r of db.prepare('SELECT id, last_seen_at FROM users').all()) out[r.id] = r.last_seen_at;
  return out;
}

function sweepOnce(now = Date.now()) {
  let runningIds;
  try {
    runningIds = db.prepare('SELECT id FROM users').all()
      .map(r => r.id).filter(id => registry.isRunning(id));
  } catch (err) {
    logger.warn('Idle sweep: could not list users', { error: err.message });
    return { checked: 0, stopped: [] };
  }
  if (!runningIds.length) return { checked: 0, stopped: [] };

  const stopped = [];
  for (const id of _idleUserIds(runningIds, _lastSeenMap(), now)) {
    try {
      registry.stop(id);
      stopped.push(id);
      logger.info('Idle sweep: stopped mailbox watcher — account inactive', {
        userId: id, idleHours: IDLE_MS / 3600000,
      });
    } catch (err) {
      logger.warn('Idle sweep: failed to stop watcher', { userId: id, error: err.message });
    }
  }
  return { checked: runningIds.length, stopped };
}

function start() {
  const timer = setInterval(() => {
    try { sweepOnce(); } catch (err) { logger.error('Idle sweep failed', { error: err.message }); }
  }, SWEEP_MS);
  timer.unref(); // never hold the process open just to run a sweep
  logger.info('Idle watcher sweeper started', { idleHours: IDLE_MS / 3600000, sweepMinutes: SWEEP_MS / 60000 });
  return timer;
}

module.exports = { start, sweepOnce, _idleUserIds, IDLE_MS, SWEEP_MS };
