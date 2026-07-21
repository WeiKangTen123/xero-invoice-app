const emailQueue       = require('./email-queue');
const { parseInvoice } = require('../email/parser');
const logger           = require('../utils/logger');

const POLL_MS = 5000; // idle poll interval — catches jobs that land while worker is between ticks

// Per-user worker state
const _workers = new Map();

function _getWorker(userId) {
  if (!_workers.has(userId)) {
    _workers.set(userId, { onInvoice: null, pollId: null, running: false, busy: false });
  }
  return _workers.get(userId);
}

async function _processNext(userId) {
  const w = _getWorker(userId);
  if (!w.running || w.busy) return;

  const jobs = emailQueue.getPending(userId);
  if (!jobs.length) return;

  w.busy = true;
  const job = jobs[0];
  try {
    logger.info(`[email-worker:${userId}] Processing job ${job.id} (attempt ${job.attempts + 1})`, { subject: job.email?.subject });
    emailQueue.markProcessing(userId, job.id);

    const email    = emailQueue.reconstructEmail(userId, job);
    const invoices = await parseInvoice(email, userId);

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
    w.busy = false;
    // Chain into the next pending job immediately instead of waiting for the poll interval.
    const remaining = emailQueue.getPending(userId);
    if (remaining.length > 0) setImmediate(() => _safeProcessNext(userId));
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
