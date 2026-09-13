// Background jobs: one persistent, per-user, one-at-a-time runner.
//
// The implementation lives in claims/claim-queue.js and claims/claim-worker.js,
// because that is where it was built and where the jobs already on users' disks
// are (main/data/users/<id>/claim-queue/). Renaming those files or that
// directory would strand every job written before the rename, for nothing but
// a tidier tree. So the runner keeps its address and this is its name.
//
// A job is a type, a label and a payload of named file lists, written to disk
// before anything runs; the worker takes a user's jobs oldest-first, retries an
// interrupted one up to MAX_ATTEMPTS and then sets it aside, and recovers what
// was pending on boot. Types register a handler; claim-import is the first.
//
//   const jobs = require('../jobs');
//   jobs.registerJobType('bill-import', { run, defaultDeps });
//   const { job, error } = jobs.enqueue(userId, { type: 'bill-import', label, payload: { pdfs } });
//   jobs.startWorker(userId); jobs.kickWorker(userId);
const queue  = require('../claims/claim-queue');
const worker = require('../claims/claim-worker');

module.exports = {
  // queue
  enqueue: queue.enqueue, readPayload: queue.readPayload, get: queue.get, list: queue.list,
  getPending: queue.getPending, save: queue.save, markFailed: queue.markFailed,
  markCancelled: queue.markCancelled, sweep: queue.sweep, clearAll: queue.clearAll,
  TERMINAL: queue.TERMINAL, MAX_ATTEMPTS: queue.MAX_ATTEMPTS, MAX_QUEUED_PER_USER: queue.MAX_QUEUED_PER_USER,
  // worker
  registerJobType: worker.registerJobType, startWorker: worker.startWorker, stopWorker: worker.stopWorker,
  kickWorker: worker.kickWorker, recoverPendingJobs: worker.recoverPendingJobs,
  _queue: queue, _worker: worker,
};
