const emailQueue       = require('./email-queue');
const { parseInvoice } = require('../email/parser');
const users            = require('../utils/users');
const logger           = require('../utils/logger');

const POLL_MS = 5000; // idle poll interval — catches jobs that land while worker is between ticks

// Per-user worker state
const _workers = new Map();

// Jobs this process is running right now, as `${userId}:${jobId}`. A job keeps
// status 'processing' on disk while it runs, which getPending also returns so
// that a job abandoned by a crash is picked up again. The per-worker busy flag
// does not cover a worker stopped and started while a job was mid-run (a
// watcher restart builds a new one), and that worker would claim the same job
// again: run it twice and spend an attempt doing so.
const _inFlight = new Set();
const _key = (userId, jobId) => `${userId}:${jobId}`;

// The next job to run: oldest first, past any retry delay, not already running
// here. A job waiting out its delay no longer holds up the ones behind it.
function _nextDue(userId, jobs) {
  const now = Date.now();
  return jobs.find(j => emailQueue.isDue(j, now) && !_inFlight.has(_key(userId, j.id))) || null;
}

function _getWorker(userId) {
  if (!_workers.has(userId)) {
    _workers.set(userId, { onInvoice: null, pollId: null, running: false, busy: false });
  }
  return _workers.get(userId);
}

// Whether this account's queued mail may be worked on. Disabling an account
// stops its worker (routes/admin.js), but a tick already scheduled, a kick
// from a watcher mid-fetch or boot recovery can still get here, and a job that
// ran would store invoices and post them to a disabled account's Xero. A
// lookup that throws is not taken as a refusal: parsing and storing read the
// same database, so the job fails there and is retried.
function _accountActive(userId) {
  try { return users.isActive(userId); } catch (_) { return true; }
}

// Leaves the account's jobs on disk, untouched, for if it is enabled again.
function _holdForInactiveAccount(userId, queued) {
  logger.info(`[email-worker:${userId}] Account is disabled or deleted — worker stopped, ${queued} job(s) left queued`);
  stopWorker(userId);
}

async function _processNext(userId) {
  const w = _getWorker(userId);
  if (!w.running || w.busy) return;

  const jobs = emailQueue.getPending(userId);
  if (!jobs.length) return;
  if (!_accountActive(userId)) return _holdForInactiveAccount(userId, jobs.length);
  const next = _nextDue(userId, jobs);
  if (!next) return;   // everything left is waiting out a retry delay; the poll comes back

  w.busy = true;
  let job   = null;
  let chain = true;
  try {
    // The attempt is on disk before the work starts, so a job that takes the
    // process down with it has used one (see email-queue markProcessing).
    try {
      job = emailQueue.markProcessing(userId, next.id);
    } catch (err) {
      // Not run uncounted. Not chained either: the job is still due, and an
      // immediate retry against a disk that refuses writes would spin.
      logger.error(`[email-worker:${userId}] Could not record the attempt for job ${next.id}; not running it`, { error: err.message });
      chain = false;
      return;
    }
    if (!job) return;   // gone, or out of attempts and now kept as dead
    _inFlight.add(_key(userId, job.id));
    logger.info(`[email-worker:${userId}] Processing job ${job.id} (attempt ${job.attempts}/${emailQueue.MAX_ATTEMPTS})`, { subject: job.email?.subject });

    const email    = emailQueue.reconstructEmail(userId, job);
    const invoices = await parseInvoice(email, userId);

    // Parsing is seconds of LLM calls, the likeliest moment for a disable to
    // land, and everything after it stores and submits. The job is left as
    // 'processing', which getPending still returns, so nothing is lost.
    if (!_accountActive(userId)) return _holdForInactiveAccount(userId, jobs.length);

    if (invoices?.length) {
      for (const invoice of invoices) await w.onInvoice(invoice);
      logger.info(`[email-worker:${userId}] Job ${job.id} complete — ${invoices.length} invoice(s) stored`);
    } else {
      logger.warn(`[email-worker:${userId}] Job ${job.id} produced no invoices`, {
        subject: job.email?.subject,
        from:    job.email?.from,
      });
    }

    emailQueue.markDone(userId, job.id);
  } catch (err) {
    logger.error(`[email-worker:${userId}] Job ${job.id} failed`, { error: err.message });
    emailQueue.markFailed(userId, job.id, err.message);
  } finally {
    if (job) _inFlight.delete(_key(userId, job.id));
    w.busy = false;
    // Chain into the next due job immediately instead of waiting for the poll
    // interval. Only a due one: a job waiting out its retry delay would
    // otherwise be chained to over and over until the delay ran out.
    if (chain && _nextDue(userId, emailQueue.getPending(userId))) setImmediate(() => _safeProcessNext(userId));
  }
}

function _safeProcessNext(userId) {
  _processNext(userId).catch(err =>
    logger.error(`[email-worker:${userId}] Unexpected worker error`, { error: err.message })
  );
}

// Start the worker for a user (idempotent — safe to call multiple times).
// `onInvoice` is the invoice-handler callback that saves + optionally Xero-submits.
function startWorker(userId, onInvoice) {
  const w = _getWorker(userId);
  w.onInvoice = onInvoice; // always refresh callback (e.g. watcher restart)
  if (w.running) return;
  w.running = true;
  logger.info(`[email-worker:${userId}] Worker started`);

  // Drain any backlog immediately (handles recovery after a server restart)
  setImmediate(() => _safeProcessNext(userId));

  // Periodic poll to catch jobs that arrive while the worker is idle
  w.pollId = setInterval(() => _safeProcessNext(userId), POLL_MS);
}

// Stop the worker for a user (called before clearing the queue so no job runs after wipe).
function stopWorker(userId) {
  const w = _workers.get(userId);
  if (!w) return;
  if (w.pollId) clearInterval(w.pollId);
  w.running = false;
  w.pollId  = null;
  _workers.delete(userId);
}

// Notify the worker that a new job was just enqueued — triggers immediate processing.
// Called by the IMAP watcher after enqueue() so jobs don't wait for the next poll tick.
function kickWorker(userId) {
  setImmediate(() => _safeProcessNext(userId));
}

// Recover pending jobs across all users on server startup.
// `makeOnInvoice(userId)` should return the onInvoice callback for a given user.
async function recoverPendingJobs(makeOnInvoice) {
  const userIds = emailQueue.getAllUserIds();
  for (const userId of userIds) {
    const pending = emailQueue.getPending(userId);
    if (!pending.length) continue;
    // A restart must not undo a disable: the jobs stay queued for if the
    // account is enabled again, and no worker or handler is built for it.
    if (!_accountActive(userId)) {
      logger.info(`[email-worker] Recovery skipped — account is disabled or deleted`, { userId, pending: pending.length });
      continue;
    }
    logger.info(`[email-worker] Recovering ${pending.length} pending job(s)`, { userId });
    try {
      const onInvoice = await makeOnInvoice(userId);
      startWorker(userId, onInvoice);
    } catch (err) {
      logger.error(`[email-worker] Failed to start recovery worker`, { userId, error: err.message });
    }
  }
}

module.exports = { startWorker, stopWorker, kickWorker, recoverPendingJobs };
