const claimQueue      = require('./claim-queue');
const claimImport     = require('./claim-import');
const receiptStore    = require('../utils/receipt-store');
const { parseReceiptBatch } = require('../utils/receipt-parser');
const { suggestCategories } = require('./claim-categories');
const logger          = require('../utils/logger');

const POLL_MS = 5000;

// Per-user worker state
const _workers = new Map();

function _getWorker(userId) {
  if (!_workers.has(userId)) {
    _workers.set(userId, { deps: null, pollId: null, running: false, busy: false });
  }
  return _workers.get(userId);
}

function _defaultDeps(userId) {
  const claimsRoute = require('../routes/claims');
  return {
    parseReceipts: (uid, images) => parseReceiptBatch(uid, images),
    storeReceipt: (uid, id, buffer, mime) => receiptStore.forUser(uid).save(id, buffer, mime),
    createRecord: (params) => claimsRoute._createClaimRecord(params),
    suggest: (uid, matches, categories) => suggestCategories(uid, matches, categories),
  };
}

async function _processNext(userId) {
  const w = _getWorker(userId);
  if (!w.running || w.busy) return;

  // 1. Poison check: if an interrupted job exceeded max attempts, fail it so it cannot loop
  const poisoned = claimQueue.getPoisoned(userId);
  for (const p of poisoned) {
    logger.error(`[claim-worker:${userId}] Job ${p.id} poison threshold reached (${p.attempts} attempts) — setting aside`, { jobId: p.id });
    claimQueue.markFailed(userId, p.id, 'Import failed repeatedly and was stopped to protect system stability');
  }

  // 2. Fetch pending jobs
  const pending = claimQueue.getPending(userId);
  if (!pending.length) return;

  w.busy = true;
  const job = pending[0];

  try {
    logger.info(`[claim-worker:${userId}] Starting job ${job.id} (attempt ${job.attempts + 1})`, { jobId: job.id, label: job.label });
    claimQueue.markRunning(userId, job.id);

    // Read payload buffers back from disk
    const { archives, forms } = claimQueue.readPayload(userId, job);

    const baseDeps = w.deps || _defaultDeps(userId);

    const deps = {
      ...baseDeps,
      onUpdate: (patch) => {
        try {
          claimQueue.save(userId, patch);
        } catch (err) {
          logger.warn(`[claim-worker:${userId}] Could not persist progress patch`, { jobId: job.id, error: err.message });
        }
      },
      onSettle: (settledJob) => {
        try {
          claimQueue.save(userId, {
            id: settledJob.id,
            stage: settledJob.stage,
            error: settledJob.error,
            result: settledJob.result,
            receiptsTotal: settledJob.receiptsTotal,
            receiptsRead: settledJob.receiptsRead,
            rowsTotal: settledJob.rowsTotal,
          });
        } catch (err) {
          logger.warn(`[claim-worker:${userId}] Could not persist final settled state`, { jobId: job.id, error: err.message });
        } finally {
          w.busy = false;
          const remaining = claimQueue.getPending(userId);
          if (remaining.length > 0) setImmediate(() => _safeProcessNext(userId));
        }
      },
    };

    claimImport.startImport(
      { userId, archives, forms, label: job.label, id: job.id },
      deps
    );
  } catch (err) {
    logger.error(`[claim-worker:${userId}] Job ${job.id} failed to launch`, { error: err.message });
    claimQueue.markFailed(userId, job.id, err.message);
    w.busy = false;
    const remaining = claimQueue.getPending(userId);
    if (remaining.length > 0) setImmediate(() => _safeProcessNext(userId));
  }
}

function _safeProcessNext(userId) {
  _processNext(userId).catch(err => {
    logger.error(`[claim-worker:${userId}] Unexpected worker error`, { error: err.message });
  });
}

// Start worker for a user
function startWorker(userId, customDeps = null) {
  const w = _getWorker(userId);
  if (customDeps) w.deps = customDeps;
  if (w.running) return;
  w.running = true;
  logger.info(`[claim-worker:${userId}] Worker started`);

  setImmediate(() => _safeProcessNext(userId));

  w.pollId = setInterval(() => {
    claimQueue.sweep(userId);
    _safeProcessNext(userId);
  }, POLL_MS);
}

// Stop worker for a user
function stopWorker(userId) {
  const w = _workers.get(userId);
  if (!w) return;
  if (w.pollId) clearInterval(w.pollId);
  w.running = false;
  w.pollId  = null;
  _workers.delete(userId);
}

// Trigger immediate check
function kickWorker(userId) {
  setImmediate(() => _safeProcessNext(userId));
}

// Recover pending jobs across all users on server boot
async function recoverPendingJobs(makeDeps = null) {
  const userIds = claimQueue.getAllUserIds();
  for (const userId of userIds) {
    claimQueue.sweep(userId);
    const pending = claimQueue.getPending(userId);
    if (!pending.length) continue;
    logger.info(`[claim-worker] Recovering ${pending.length} pending claim job(s)`, { userId });
    const deps = makeDeps ? await makeDeps(userId) : null;
    startWorker(userId, deps);
  }
}

function _reset() {
  for (const [userId, w] of _workers) {
    if (w.pollId) clearInterval(w.pollId);
  }
  _workers.clear();
}

module.exports = {
  startWorker,
  stopWorker,
  kickWorker,
  recoverPendingJobs,
  _processNext,
  _safeProcessNext,
  _reset,
};
