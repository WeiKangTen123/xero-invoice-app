const fs   = require('fs');
const path = require('path');

// Claim imports, on disk.
//
// An import is minutes of work: unzip, then a throttled model call for every
// five receipts. Holding that in memory alone had two failures waiting in it.
//
//   1. A restart loses it. `pm2 restart`, a deploy, an out-of-memory kill — the
//      user's twenty-seven receipts are gone with no record they were ever
//      submitted, and the only sign is a progress bar that stops moving.
//
//   2. Nothing bounds it. Ten people importing at once, or one person clicking
//      Import ten times, is ten simultaneous unzips of up to 25MB plus ten
//      concurrent model conversations. That is how a box falls over.
//
// So a job is written to disk before anything starts, the payload beside it, and
// claim-worker takes them one at a time within a fixed budget. The same shape as
// queue/email-queue.js — .que files, oldest-first, recovered on boot — because
// the failure being defended against is identical and one pattern is easier to
// reason about than two.
//
// The one difference: an email job is DELETED when it succeeds, because its
// output is an invoice row. A claim job's output includes a reconciliation the
// user still has to read, so a finished job stays on disk until the sweep takes
// it. Only the payload — the megabytes — goes immediately.

const BASE_DIR = path.join(__dirname, '../data/users');

// Terminal stages. Anything else is either waiting or was interrupted.
const TERMINAL = new Set(['done', 'failed', 'cancelled']);

// Three attempts, then the job is poison and stays failed.
//
// This matters more here than in the email queue. If an import can crash the
// process, an unbounded retry means the box boots, picks the job up, dies, and
// boots again — the crash loop the queue was supposed to prevent, caused by the
// queue. Three tries and it is set aside with its last error.
const MAX_ATTEMPTS = 3;

// How many imports one user may have waiting. Beyond this the answer is no,
// with a reason — far better than accepting work that will never be reached.
const MAX_QUEUED_PER_USER = 10;

// A finished job stays readable for an hour, which is long enough to read the
// reconciliation and long past the point anyone is still looking.
const JOB_TTL_MS = 60 * 60 * 1000;

function _dir(userId)          { return path.join(BASE_DIR, String(userId), 'claim-queue'); }
// .que rather than .json so nodemon never watches these, whatever its config.
function _file(userId, jobId)  { return path.join(_dir(userId), `${jobId}.que`); }
function _blob(userId, ref)    { return path.join(_dir(userId), ref); }

function _read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Written to a temporary file and renamed, so a crash mid-write cannot leave a
// half-written job that fails to parse on the next boot. rename is atomic
// within a directory on every filesystem this runs on.
function _write(userId, job) {
  const file = _file(userId, job.id);
  const tmp  = `${file}.tmp`;
  fs.mkdirSync(_dir(userId), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
  fs.renameSync(tmp, file);
  return job;
}

function _all(userId) {
  const dir = _dir(userId);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.que'))
      .map(f => _read(path.join(dir, f)))
      .filter(Boolean);
  } catch { return []; }
}

// Writes the payload and the job. Returns { job } or { error } — a full queue is
// a normal answer, not an exception.
function enqueue(userId, { archives = [], forms = [], label = 'Expense claim', id }) {
  const waiting = _all(userId).filter(j => !TERMINAL.has(j.stage)).length;
  if (waiting >= MAX_QUEUED_PER_USER) {
    return { error: `You already have ${waiting} imports queued. Wait for those to finish before starting another.` };
  }

  const jobId = id || `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  fs.mkdirSync(_dir(userId), { recursive: true });

  // The buffers go to disk before the job does. A job whose payload is missing
  // is worse than no job at all.
  const write = (list, prefix) => list.map((f, i) => {
    const ref = `${jobId}-${prefix}${i}.bin`;
    fs.writeFileSync(_blob(userId, ref), f.buffer);
    return { name: f.name || `${prefix}${i}`, ref };
  });

  const job = {
    id: jobId,
    userId: String(userId),
    label,
    stage: 'queued',
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    receiptsTotal: 0,
    receiptsRead: 0,
    rowsTotal: 0,
    error: null,
    result: null,
    payload: { archives: write(archives, 'a'), forms: write(forms, 'f') },
  };

  return { job: _write(userId, job) };
}

// Reads the payload back as buffers. A missing blob is reported rather than
// silently importing fewer files than were uploaded.
function readPayload(userId, job) {
  const load = list => list.map(f => {
    const p = _blob(userId, f.ref);
    if (!fs.existsSync(p)) throw new Error(`${f.name} is no longer on disk — the import cannot be retried`);
    return { name: f.name, buffer: fs.readFileSync(p) };
  });
  return { archives: load(job.payload?.archives || []), forms: load(job.payload?.forms || []) };
}

function _dropPayload(userId, job) {
  for (const f of [...(job.payload?.archives || []), ...(job.payload?.forms || [])]) {
    try { fs.unlinkSync(_blob(userId, f.ref)); } catch {}
  }
  job.payload = { archives: [], forms: [] };
}

function get(userId, jobId) {
  const job = _read(_file(userId, jobId));
  // A job belongs to the user who started it and nobody else. The path already
  // scopes it, but an id containing a traversal must not reach the filesystem.
  if (!job || job.userId !== String(userId)) return null;
  return job;
}

function list(userId) {
  return _all(userId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// Waiting, or interrupted mid-flight by a restart. Oldest first: an import
// submitted before yours should not be overtaken.
function getPending(userId) {
  return _all(userId)
    .filter(j => !TERMINAL.has(j.stage) && j.attempts < MAX_ATTEMPTS)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

// Interrupted jobs that have already used their attempts. Marked failed on the
// next boot rather than retried, so a job that kills the process cannot loop.
function getPoisoned(userId) {
  return _all(userId).filter(j => !TERMINAL.has(j.stage) && j.attempts >= MAX_ATTEMPTS);
}

function getAllUserIds() {
  if (!fs.existsSync(BASE_DIR)) return [];
  try {
    return fs.readdirSync(BASE_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(BASE_DIR, d.name, 'claim-queue')))
      .map(d => d.name);
  } catch { return []; }
}

// Records progress from the running engine. Only the fields worth surviving a
// restart — the buffers and callbacks stay in memory where they belong.
function save(userId, patch) {
  const job = get(userId, patch.id);
  if (!job) return null;
  for (const k of ['stage', 'receiptsTotal', 'receiptsRead', 'rowsTotal', 'error', 'result', 'label']) {
    if (patch[k] !== undefined) job[k] = patch[k];
  }
  job.updatedAt = new Date().toISOString();
  if (TERMINAL.has(job.stage)) _dropPayload(userId, job);
  return _write(userId, job);
}

function markRunning(userId, jobId) {
  const job = get(userId, jobId);
  if (!job) return null;
  job.attempts++;
  job.stage = 'unpacking';
  job.updatedAt = new Date().toISOString();
  return _write(userId, job);
}

function markFailed(userId, jobId, error) {
  const job = get(userId, jobId);
  if (!job) return null;
  job.stage = 'failed';
  job.error = String(error);
  job.updatedAt = new Date().toISOString();
  _dropPayload(userId, job);
  return _write(userId, job);
}

// A cancel that lands before the worker picks the job up must still stick, so it
// is written here rather than only signalled to a running engine.
function markCancelled(userId, jobId) {
  const job = get(userId, jobId);
  if (!job || TERMINAL.has(job.stage)) return job;
  job.stage = 'cancelled';
  job.updatedAt = new Date().toISOString();
  _dropPayload(userId, job);
  return _write(userId, job);
}

// Removes finished jobs past their TTL, and any blob left behind by one.
function sweep(userId) {
  const dir = _dir(userId);
  if (!fs.existsSync(dir)) return 0;
  const now = Date.now();
  const live = new Set();
  let removed = 0;

  for (const job of _all(userId)) {
    const age = now - Date.parse(job.updatedAt || job.createdAt || 0);
    if (TERMINAL.has(job.stage) && age > JOB_TTL_MS) {
      try { fs.unlinkSync(_file(userId, job.id)); removed++; } catch {}
    } else {
      live.add(job.id);
    }
  }

  // A blob whose job is gone is unreachable. It would otherwise sit there
  // holding megabytes for the life of the disk.
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.bin')) continue;
      const owner = f.slice(0, f.lastIndexOf('-'));
      if (!live.has(owner)) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
    }
  } catch {}

  return removed;
}

function clearAll(userId) {
  const dir = _dir(userId);
  if (!fs.existsSync(dir)) return;
  try { for (const f of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, f)); } catch {} } } catch {}
}

module.exports = {
  enqueue, readPayload, get, list, getPending, getPoisoned, getAllUserIds,
  save, markRunning, markFailed, markCancelled, sweep, clearAll,
  TERMINAL, MAX_ATTEMPTS, MAX_QUEUED_PER_USER, JOB_TTL_MS,
};
