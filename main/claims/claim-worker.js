const claimQueue      = require('./claim-queue');
const claimImport     = require('./claim-import');
const receiptStore    = require('../utils/receipt-store');
const { parseReceiptBatch } = require('../utils/receipt-parser');
const { suggestCategories } = require('./claim-categories');
const users           = require('../utils/users');
const logger          = require('../utils/logger');
const { runAsSystem } = require('../utils/audit-context');

const POLL_MS = 5000;

// Per-user worker state
const _workers = new Map();

function _getWorker(userId) {
  if (!_workers.has(userId)) {
    _workers.set(userId, { deps: null, pollId: null, running: false, busy: false });
  }
  return _workers.get(userId);
}

// ── Job types ───────────────────────────────────────────────────────────────
// The worker runs whatever is registered here, keyed by job.type. Each type
// supplies `run({ userId, job, payload, deps })`, which must eventually call
// deps.onSettle, and `defaultDeps(userId)` for when the caller passes none.
// Claim import is the first type; bill and invoice import register their own
// from their own modules, so this file does not have to know about them.
const _types = new Map();
function registerJobType(type, { run, defaultDeps = () => ({}) } = {}) {
  if (typeof run !== 'function') throw new Error(`Job type "${type}" needs a run function`);
  _types.set(type, { run, defaultDeps });
}
function _handlerFor(job) {
  // Jobs written before types existed are all claim imports.
  return _types.get(job.type || 'claim-import') || null;
}

registerJobType('claim-import', {
  defaultDeps(userId) {
    const { createClaimRecord } = require('./claim-record');
    return {
      parseReceipts: (uid, images) => parseReceiptBatch(uid, images),
      storeReceipt: (uid, id, buffer, mime) => receiptStore.forUser(uid).save(id, buffer, mime),
      createRecord: (params) => createClaimRecord(params),
      suggest: (uid, matches, categories) => suggestCategories(uid, matches, categories),
    };
  },
  run({ userId, job, payload, deps }) {
    return claimImport.startImport(
      { userId, archives: payload.archives, forms: payload.forms, label: job.label, id: job.id },
      deps
    );
  },
});

// Whether this account's jobs may run. Disabling an account stops its worker
// (routes/admin.js), but a tick already scheduled, a kick or boot recovery can
// still get here, and an import that ran would create records for a disabled
// account. A lookup that throws is not taken as a refusal: the job reads and
// writes the same database, so it fails there instead.
function _accountActive(userId) {
  try { return users.isActive(userId); } catch (_) { return true; }
}

async function _processNext(userId) {
  const w = _getWorker(userId);
  if (!w.running || w.busy) return;

  // Checked before anything is touched, so the account's jobs stay exactly as
  // they were — queued, attempts unspent — for if it is enabled again.
  if (!_accountActive(userId)) {
    logger.info(`[claim-worker:${userId}] Account is disabled or deleted — worker stopped, jobs left queued`);
    stopWorker(userId);
    return;
  }

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
        const handler = _handlerFor(job);
    if (!handler) {
      // Set aside with a reason rather than retried three times into poison.
      claimQueue.markFailed(userId, job.id, `No handler is registered for job type "${job.type}"`);
      w.busy = false;
      if (claimQueue.getPending(userId).length > 0) setImmediate(() => _safeProcessNext(userId));
      return;
    }
    claimQueue.markRunning(userId, job.id);
    // Read payload buffers back from disk
    const payload = claimQueue.readPayload(userId, job);
    const baseDeps = w.deps || handler.defaultDeps(userId);

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

        handler.run({ userId, job, payload, deps });
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

// Start worker for a user. As the system: an import started from a request
// would otherwise carry that request's person into every record the worker
// writes from then on, the next person's jobs included (utils/audit-context.js).
function startWorker(userId, customDeps = null) {
  return runAsSystem(() => _startWorker(userId, customDeps));
}

function _startWorker(userId, customDeps) {
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
  runAsSystem(() => setImmediate(() => _safeProcessNext(userId)));
}

// Recover pending jobs across all users on server boot
async function recoverPendingJobs(makeDeps = null) {
  const userIds = claimQueue.getAllUserIds();
  for (const userId of userIds) {
    // A restart must not undo a disable; the jobs wait for the account.
    if (!_accountActive(userId)) {
      logger.info(`[claim-worker] Recovery skipped — account is disabled or deleted`, { userId });
      continue;
    }
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
  registerJobType,
  startWorker,
  stopWorker,
  kickWorker,
  recoverPendingJobs,
  _processNext,
  _safeProcessNext,
  _reset,
};
