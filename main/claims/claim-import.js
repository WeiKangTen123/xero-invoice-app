const crypto = require('crypto');
const logger = require('../utils/logger');
const { readArchive }    = require('./claim-archive');
const { parseClaimForm } = require('./claim-form');
const { matchClaims }    = require('./claim-matcher');
const { suggestCategories } = require('./claim-categories');

// Importing a batch claim: unzip, read the form, read every receipt, match.
//
// This runs as a BACKGROUND JOB, not inside a request. Twenty-seven receipts at
// roughly a second and a half each, throttled to stay inside the per-minute
// model quota, is two to three minutes — far past any HTTP timeout, and closing
// the tab must not kill it.
//
// Nothing here writes to Xero. The output is local records for a person to
// review, plus a reconciliation showing which lines need their attention.

// Gemini's free tier allows roughly fifteen requests a minute. Four seconds
// between reads keeps a large claim inside that without the caller having to
// think about it.
const READ_INTERVAL_MS = 4000;
const MAX_RECEIPTS = 100;
const JOB_TTL_MS = 60 * 60 * 1000;   // an hour is long enough to read the result

const _jobs = new Map();   // jobId -> job

function _sweep() {
  const now = Date.now();
  for (const [id, job] of _jobs) if (now - job.updatedAt > JOB_TTL_MS) _jobs.delete(id);
}

function getJob(jobId, userId) {
  _sweep();
  const job = _jobs.get(jobId);
  // A job belongs to the user who started it and nobody else.
  if (!job || job.userId !== String(userId)) return null;
  return job;
}

function listJobs(userId) {
  _sweep();
  return [..._jobs.values()].filter(j => j.userId === String(userId)).sort((a, b) => b.startedAt - a.startedAt);
}

function _update(job, patch) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  return job;
}

// Stages exist so the UI can say WHICH part is slow. One bar sitting at 60% for
// two minutes looks stuck; "reading receipts 18/27" does not.
function _stage(job, stage, detail = {}) {
  job.stage = stage;
  Object.assign(job, detail);
  job.updatedAt = Date.now();
  logger.info('Claim import stage', { jobId: job.id, userId: job.userId, stage, ...detail });
}

// Starts an import and returns immediately with the job id.
//
// `deps` is injected so the whole flow can be tested without a model or a
// database: everything slow or stateful arrives through it.
function startImport({ userId, archives = [], forms = [], label = 'Expense claim' }, deps) {
  const job = {
    id: crypto.randomBytes(9).toString('hex'),
    userId: String(userId),
    label,
    stage: 'queued',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    receiptsTotal: 0,
    receiptsRead: 0,
    rowsTotal: 0,
    error: null,
    result: null,
    cancelled: false,
  };
  _jobs.set(job.id, job);

  // Deliberately not awaited: the caller gets an id and polls.
  _run(job, { archives, forms }, deps).catch(err => {
    logger.error('Claim import failed', { jobId: job.id, error: err.message });
    _update(job, { stage: 'failed', error: err.message });
  });

  return job;
}

async function _run(job, { archives, forms }, deps) {
  const { parseReceipt, storeReceipt, createRecord, suggest, waitMs = READ_INTERVAL_MS } = deps;

  // ── 1. Unpack ────────────────────────────────────────────────────────────
  _stage(job, 'unpacking');
  const entries = [];
  const skipped = [];
  for (const archive of archives) {
    const r = await readArchive(archive.buffer);
    for (const e of r.entries) entries.push({ ...e, archive: archive.name });
    for (const s of r.skipped) skipped.push({ ...s, archive: archive.name });
    if (r.error) skipped.push({ name: archive.name, reason: r.error });
  }
  // readArchive stops extracting at its own limit and records the rest as
  // skipped, so entries.length can never exceed it. Checking that alone meant a
  // 150-receipt archive would import 100 and drop 50 silently — which is the
  // worst outcome available. Refuse the whole import instead.
  const truncated = skipped.filter(s => /limit reached/i.test(s.reason || ''));
  if (truncated.length) {
    return _update(job, {
      stage: 'failed',
      error: `This archive holds more than ${MAX_RECEIPTS} receipts, which is more than one claim should hold. Split it and import each part.`,
    });
  }
  _stage(job, 'unpacked', { receiptsTotal: entries.length });

  // ── 2. Read the claim form ───────────────────────────────────────────────
  _stage(job, 'reading form');
  let rows = [];
  let categories = [];
  const formErrors = [];
  for (const form of forms) {
    const parsed = await parseClaimForm(form.buffer);
    if (parsed.error) formErrors.push(`${form.name}: ${parsed.error}`);
    rows = rows.concat(parsed.rows.map(r => ({ ...r, form: form.name })));
    categories = categories.concat(parsed.categories);
  }
  _stage(job, 'form read', { rowsTotal: rows.length });

  // ── 3. Read every receipt ────────────────────────────────────────────────
  // The slow phase, and the only one worth a progress bar.
  _stage(job, 'reading receipts');
  const reads = [];
  for (let i = 0; i < entries.length; i++) {
    if (job.cancelled) return _update(job, { stage: 'cancelled' });
    const e = entries[i];
    try {
      const parsed = await parseReceipt(job.userId, e.buffer, e.mime);
      const first = parsed && parsed.receipts && parsed.receipts[0];
      // A receipt that cannot be read still takes part: it is stored, and it is
      // reported as unreadable rather than silently dropped.
      reads.push({ ...(first || { merchant: null, date: null, total: null, currency: null }),
                   file: e.name, mime: e.mime, buffer: e.buffer, readable: !!first });
    } catch (err) {
      logger.warn('Claim receipt unreadable', { jobId: job.id, file: e.name, error: err.message });
      reads.push({ merchant: null, date: null, total: null, currency: null, file: e.name, mime: e.mime, buffer: e.buffer, readable: false });
    }
    _update(job, { receiptsRead: i + 1 });
    // Throttled to stay inside the model's per-minute quota. Skipped after the
    // last one so a single-receipt claim is not made to wait for nothing.
    if (i < entries.length - 1 && waitMs) await new Promise(r => setTimeout(r, waitMs));
  }

  // ── 4. Match ─────────────────────────────────────────────────────────────
  _stage(job, 'matching');
  const matched = matchClaims(rows, reads);

  // ── 5. Suggest the categories the claimant left blank ────────────────────
  _stage(job, 'categorising');
  let suggestions = [];
  if (suggest && categories.length) {
    try { suggestions = await suggest(job.userId, matched.matches, categories); }
    catch (err) { logger.warn('Category suggestion unavailable', { jobId: job.id, error: err.message }); }
  }

  // ── 6. Create the records ────────────────────────────────────────────────
  _stage(job, 'saving');
  const groupId = job.id;
  const created = [];
  for (const m of matched.matches) {
    const suggestion = suggestions.find(s => s.rowNo === m.row.no) || null;
    const rec = await createRecord({
      userId: job.userId, groupId,
      row: m.row, receipt: m.receipt, match: m,
      category: m.row.category || (suggestion && suggestion.category) || null,
      categorySuggested: !m.row.category && !!suggestion,
      store: storeReceipt,
    });
    if (rec) created.push(rec.id);
  }
  // Claim lines with no receipt still become records — they are part of the
  // claim and somebody has to resolve them.
  for (const row of matched.unmatchedRows) {
    const rec = await createRecord({ userId: job.userId, groupId, row, receipt: null, match: null, category: row.category || null, store: storeReceipt });
    if (rec) created.push(rec.id);
  }

  return _update(job, {
    stage: 'done',
    result: {
      groupId,
      created,
      summary: { ...matched.summary, unreadable: reads.filter(r => !r.readable).length, skippedFiles: skipped.length },
      discrepancies: matched.matches.filter(m => m.discrepancy).map(m => ({
        rowNo: m.row.no, date: m.row.date, description: m.row.description, ...m.discrepancy,
      })),
      missingReceipts: matched.unmatchedRows.map(r => ({ rowNo: r.no, date: r.date, description: r.description, amount: r.amount })),
      extraReceipts: matched.unmatchedReceipts.map(r => ({ file: r.file, merchant: r.merchant, total: r.total, date: r.date })),
      unreadable: reads.filter(r => !r.readable).map(r => ({ file: r.file })),
      skipped,
      formErrors,
      categoriesSuggested: suggestions.length,
    },
  });
}

function cancel(jobId, userId) {
  const job = getJob(jobId, userId);
  if (!job) return null;
  job.cancelled = true;
  return _update(job, { stage: job.stage === 'done' ? 'done' : 'cancelling' });
}

function _reset() { _jobs.clear(); }

module.exports = { startImport, getJob, listJobs, cancel, READ_INTERVAL_MS, MAX_RECEIPTS, _reset };
