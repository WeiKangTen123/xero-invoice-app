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
// How many receipts go into one model call.
//
// Measured on a real nine-receipt claim: batch sizes of 1, 3, 5 and 9 all
// returned 9/9 amounts correctly, and 3, 5 and 9 took the same wall time. So
// accuracy did not decide this — failure cost did.
//
// A batch whose reply cannot be attributed is discarded and re-read one at a
// time. At 9 that means one bad reply costs ten calls and the whole claim falls
// back; at 5 it costs six and the other half is already done. Five turns nine
// receipts into two calls, which is as few as is worth having.
//
// The evidence has a limit worth stating: those nine were homogeneous
// screenshots. A batch mixing a faint thermal roll, a PDF and an angled photo is
// a harder ask and has not been measured.
const BATCH_SIZE = 5;
const MAX_RECEIPTS = 100;
const JOB_TTL_MS = 60 * 60 * 1000;   // an hour is long enough to read the result

const _jobs = new Map();   // jobId -> job
// jobId -> a function called on every state change. This is how the durable
// queue mirrors progress to disk without the engine knowing a disk exists —
// kept out of the job object itself so nothing here has to think about what is
// safe to serialise.
const _hooks = new Map();

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

function _notify(job) {
  const hook = _hooks.get(job.id);
  if (!hook) return;
  // A failing mirror must never take the import down with it.
  try { hook(job); } catch (err) { logger.warn('Claim import progress not persisted', { jobId: job.id, error: err.message }); }
}

function _update(job, patch) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  _notify(job);
  return job;
}

// Stages exist so the UI can say WHICH part is slow. One bar sitting at 60% for
// two minutes looks stuck; "reading receipts 18/27" does not.
function _stage(job, stage, detail = {}) {
  job.stage = stage;
  Object.assign(job, detail);
  job.updatedAt = Date.now();
  _notify(job);
  logger.info('Claim import stage', { jobId: job.id, userId: job.userId, stage, ...detail });
}

// Starts an import and returns immediately with the job id.
//
// `deps` is injected so the whole flow can be tested without a model or a
// database: everything slow or stateful arrives through it.
// `id` lets the caller name the job — the durable queue passes the id it already
// wrote to disk so the two halves refer to the same thing.
function startImport({ userId, archives = [], forms = [], label = 'Expense claim', id }, deps) {
  const job = {
    id: id || crypto.randomBytes(9).toString('hex'),
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
  if (deps.onUpdate) _hooks.set(job.id, deps.onUpdate);

  // Deliberately not awaited: the caller gets an id and polls.
  _run(job, { archives, forms }, deps)
    .catch(err => {
      logger.error('Claim import failed', { jobId: job.id, error: err.message });
      _update(job, { stage: 'failed', error: err.message });
    })
    // onSettle runs after the final _update, so whatever released the slot sees
    // the finished job rather than the one before last.
    .then(() => {
      _hooks.delete(job.id);
      if (deps.onSettle) {
        try { deps.onSettle(job); } catch (err) { logger.warn('Claim import settle hook failed', { jobId: job.id, error: err.message }); }
      }
    });

  return job;
}

async function _run(job, { archives, forms }, deps) {
  const { parseReceipts, storeReceipt, createRecord, suggest,
          waitMs = READ_INTERVAL_MS, batch = BATCH_SIZE } = deps;

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
  //
  // Read in BATCHES: nine receipts one at a time is nine round trips, each
  // throttled to stay inside the per-minute quota. Four per call turns that into
  // three, and the parser falls back to reading singly whenever a batch reply
  // cannot be attributed image-for-image.
  _stage(job, 'reading receipts');
  const reads = [];
  const batchSize = Math.max(1, batch || 1);

  for (let start = 0; start < entries.length; start += batchSize) {
    if (job.cancelled) return _update(job, { stage: 'cancelled' });
    const slice = entries.slice(start, start + batchSize);

    let parsed;
    try {
      parsed = await parseReceipts(job.userId, slice.map(e => ({ buffer: e.buffer, mime: e.mime })));
    } catch (err) {
      // A whole batch failing must not lose the receipts in it.
      logger.warn('Claim receipt batch unreadable', { jobId: job.id, size: slice.length, error: err.message });
      parsed = new Array(slice.length).fill(null);
    }

    slice.forEach((e, i) => {
      const r = parsed && parsed[i];
      // A receipt that cannot be read still takes part: it is stored, and it is
      // reported as unreadable rather than silently dropped.
      reads.push({ ...(r || { merchant: null, date: null, total: null, currency: null }),
                   file: e.name, mime: e.mime, buffer: e.buffer, readable: !!r });
    });
    _update(job, { receiptsRead: Math.min(start + slice.length, entries.length) });

    // Throttled between BATCHES rather than between receipts — the quota counts
    // requests, and batching is what makes a large claim finish in a minute
    // instead of ten. Skipped after the last batch.
    if (start + batchSize < entries.length && waitMs) await new Promise(r => setTimeout(r, waitMs));
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
  // Duplicates are counted as they are created rather than re-queried, because
  // createRecord is the only place that knows what the store said.
  const duplicates = [];
  const suspected = [];
  const note = rec => {
    if (!rec) return;
    created.push(rec.id);
    if (rec.status === 'duplicate') duplicates.push({ id: rec.id, of: rec.duplicateOf, why: rec.errorMsg });
    else if (rec.errorMsg && /^Possible duplicate/.test(rec.errorMsg)) suspected.push({ id: rec.id, why: rec.errorMsg });
  };

  for (const m of matched.matches) {
    const suggestion = suggestions.find(s => s.rowNo === m.row.no) || null;
    const rec = await createRecord({
      userId: job.userId, groupId,
      row: m.row, receipt: m.receipt, match: m,
      category: m.row.category || (suggestion && suggestion.category) || null,
      categorySuggested: !m.row.category && !!suggestion,
      store: storeReceipt,
    });
    note(rec);
  }
  // Claim lines with no receipt still become records — they are part of the
  // claim and somebody has to resolve them.
  for (const row of matched.unmatchedRows) {
    const rec = await createRecord({ userId: job.userId, groupId, row, receipt: null, match: null, category: row.category || null, store: storeReceipt });
    note(rec);
  }

  // And a receipt with no claim line becomes one too. This was missing, and it
  // meant the commonest case of all produced NOTHING: a zip of nine receipts
  // with no spreadsheet matched nothing, so nothing was created, and the import
  // reported success having imported zero claims. A claim form is a convenience,
  // not a requirement — the receipts are the claim.
  for (const receipt of matched.unmatchedReceipts) {
    const rec = await createRecord({
      userId: job.userId, groupId,
      // Synthesised from what the model read, so the record carries the figures
      // it found rather than being blank.
      row: {
        no: null,
        date: receipt.date || null,
        description: receipt.merchant || (receipt.file ? receipt.file.split('/').pop() : null),
        currency: receipt.currency || null,
        amount: receipt.total ?? null,
        category: null,
      },
      receipt, match: null, category: null, store: storeReceipt,
    });
    note(rec);
  }

  return _update(job, {
    stage: 'done',
    result: {
      groupId,
      created,
      summary: {
        ...matched.summary,
        unreadable: reads.filter(r => !r.readable).length,
        skippedFiles: skipped.length,
        // Split on purpose: `duplicates` were marked and need no action,
        // `suspected` are the ones a person still has to settle.
        duplicates: duplicates.length,
        suspectedDuplicates: suspected.length,
      },
      discrepancies: matched.matches.filter(m => m.discrepancy).map(m => ({
        rowNo: m.row.no, date: m.row.date, description: m.row.description, ...m.discrepancy,
      })),
      missingReceipts: matched.unmatchedRows.map(r => ({ rowNo: r.no, date: r.date, description: r.description, amount: r.amount })),
      extraReceipts: matched.unmatchedReceipts.map(r => ({ file: r.file, merchant: r.merchant, total: r.total, date: r.date })),
      unreadable: reads.filter(r => !r.readable).map(r => ({ file: r.file })),
      duplicates,
      suspectedDuplicates: suspected,
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

function _reset() { _jobs.clear(); _hooks.clear(); }

module.exports = { startImport, getJob, listJobs, cancel, READ_INTERVAL_MS, BATCH_SIZE, MAX_RECEIPTS, _reset };
