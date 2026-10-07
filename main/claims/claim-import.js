const crypto = require('crypto');
const logger = require('../utils/logger');
const { openArchive, SIZE_LIMIT_REASON, MAX_TOTAL_BYTES } = require('./claim-archive');
const { fitToLimit }     = require('../utils/receipt-store');
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

// No pacing here. utils/gemini-client.js already holds every caller to the
// quota (a 15-a-minute sliding window per user), and a second, blind sleep
// on top of it only made a large claim take four seconds longer per read.
// Kept as a knob (deps.waitMs) so a test can still slow the loop down.
const READ_INTERVAL_MS = 0;
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

// One archive entry's bytes, ready to read and store: shrunk under Xero's
// attachment limit where that is possible, with the reason when it is not.
// Called once to read the receipt and again to store it, so no entry's bytes
// have to be held between the two (see step 3).
async function _load(entry, fit) {
  const raw = entry.buffer || await entry.read();
  const fitted = await fit(raw, entry.mime);
  return { buffer: fitted.buffer, mime: fitted.mime || entry.mime, shrunk: !!fitted.shrunk, fileProblem: fitted.reason || null };
}

const _fileName = file => (file ? String(file).split('/').pop() : 'a receipt');

// Why a claim needs a person's eye beyond the duplicate and discrepancy notes
// claim-record already writes. These were worked out and then thrown away:
// the matcher's `weak` flag and a category the model chose were never stored,
// so a receipt paired on a near date alone looked exactly as settled as one
// that agreed on everything. Returned as one sentence for the record, and
// listed in the job result so the import summary can say it too.
//
// A file that cannot be attached is said here only when there are no bytes to
// hand over; otherwise _storeFor below says it, through the store error that
// claim-record already writes onto the row.
function _reviewReason({ match, category, categorySuggested, receipt }) {
  const parts = [];
  if (match && match.weak) {
    parts.push(`this receipt was paired with claim line ${match.row.no} on ${match.reasons.join(' and ') || 'little evidence'} only — check it is the right receipt`);
  }
  if (categorySuggested && category) {
    parts.push(`the category "${category}" was suggested, not chosen by the claimant — confirm it`);
  }
  if (receipt && receipt.fileProblem && !receipt.buffer) {
    parts.push(`${_fileName(receipt.file)} was not attached: ${receipt.fileProblem}`);
  }
  // The reader's own doubts, e.g. a second receipt it found in the same photo
  // (utils/receipt-parser.js) — dropped silently before.
  if (receipt && receipt.reviewReason) parts.push(receipt.reviewReason);
  return parts.length ? parts.join('; ') : null;
}

// The store a record is created with. A receipt already known not to fit is
// refused up front, in words a person can act on: receipt-store would refuse
// it anyway, as "Receipt is 6291456 bytes; the limit is 3145728", and
// claim-record puts the store's error on the row. The claim is created either
// way; only the attachment is missing, and the row says why.
function _storeFor(receipt, store) {
  if (!receipt || !receipt.fileProblem) return store;
  return async () => { throw new Error(receipt.fileProblem); };
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
          waitMs = READ_INTERVAL_MS, batch = BATCH_SIZE,
          fitReceipt = fitToLimit, maxArchiveBytes } = deps;

  // ── 1. Unpack ────────────────────────────────────────────────────────────
  // Listed, not extracted: each entry carries a reader, and its bytes are
  // pulled only for the batch being read and again for the moment it is
  // stored. A hundred 15MB photos used to sit in memory together for the
  // whole job.
  _stage(job, 'unpacking');
  const entries = [];
  const skipped = [];
  for (const archive of archives) {
    const r = await openArchive(archive.buffer, maxArchiveBytes ? { maxTotalBytes: maxArchiveBytes } : undefined);
    for (const e of r.entries) entries.push({ ...e, archive: archive.name });
    for (const s of r.skipped) skipped.push({ ...s, archive: archive.name });
    if (r.error) skipped.push({ name: archive.name, reason: r.error });
  }
  // The archive reader stops at its own limits and records the rest as
  // skipped, so entries alone never show that anything was left behind.
  // Importing the part that fitted and dropping the remainder silently is the
  // worst outcome available, so either limit refuses the whole import.
  if (skipped.some(s => s.reason === SIZE_LIMIT_REASON)) {
    return _update(job, {
      stage: 'failed',
      error: `This archive unpacks to more than ${Math.round((maxArchiveBytes || MAX_TOTAL_BYTES) / 1048576)}MB of files, which is more than one claim should hold. Split it and import each part.`,
    });
  }
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

    // One at a time, so at most one photo is being decoded and re-encoded at
    // once. An entry that cannot be extracted is reported as skipped, as it
    // was when the archive was unpacked whole.
    const loaded = [];
    for (const e of slice) {
      try { loaded.push(await _load(e, fitReceipt)); }
      catch (err) {
        logger.warn('Claim archive entry could not be read', { jobId: job.id, name: e.name, error: err.message });
        skipped.push({ name: e.name, archive: e.archive, reason: 'could not be read' });
        loaded.push(null);
      }
    }
    const readable = slice.map((e, i) => ({ e, l: loaded[i] })).filter(x => x.l);

    let parsed = [];
    if (readable.length) {
      try {
        parsed = await parseReceipts(job.userId, readable.map(x => ({ buffer: x.l.buffer, mime: x.l.mime })));
      } catch (err) {
        // A whole batch failing must not lose the receipts in it.
        logger.warn('Claim receipt batch unreadable', { jobId: job.id, size: readable.length, error: err.message });
        parsed = new Array(readable.length).fill(null);
      }
    }

    readable.forEach(({ e, l }, i) => {
      const r = parsed && parsed[i];
      // A receipt that cannot be read still takes part: it is stored, and it is
      // reported as unreadable rather than silently dropped.
      //
      // No buffer is kept here, only the way back to it. Matching needs the
      // figures, not the pixels, and the bytes are fetched again when the
      // record is created.
      reads.push({ ...(r || { merchant: null, date: null, time: null, category: null, total: null, currency: null, description: null }),
                   file: e.name, mime: l.mime, readable: !!r, shrunk: l.shrunk, fileProblem: l.fileProblem,
                   load: () => _load(e, fitReceipt) });
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
  const needsReview = [];
  const note = (rec, { reviewReason = null, rowNo = null, file = null } = {}) => {
    if (!rec) return;
    created.push(rec.id);
    if (rec.status === 'duplicate') duplicates.push({ id: rec.id, of: rec.duplicateOf, why: rec.errorMsg });
    else if (rec.errorMsg && /^Possible duplicate/.test(rec.errorMsg)) suspected.push({ id: rec.id, why: rec.errorMsg });
    if (reviewReason) needsReview.push({ id: rec.id, rowNo, file, reason: reviewReason });
  };

  // The receipt with its bytes, for the moment it is stored and then let go.
  // Fetched again rather than kept from the read, so only one receipt's bytes
  // are held while records are written. A failure here cannot lose the claim
  // line: it is created without the file, and says so.
  const withBytes = async receipt => {
    if (!receipt) return null;
    const { load, ...rest } = receipt;
    if (!load) return rest;
    try {
      const l = await load();
      return { ...rest, buffer: l.buffer, mime: l.mime };
    } catch (err) {
      logger.warn('Claim receipt could not be re-read for storing', { jobId: job.id, file: receipt.file, error: err.message });
      return { ...rest, fileProblem: rest.fileProblem || 'it could not be extracted from the archive a second time' };
    }
  };

  for (const m of matched.matches) {
    const suggestion = suggestions.find(s => s.rowNo === m.row.no) || null;
    const category = m.row.category || (suggestion && suggestion.category) || null;
    const categorySuggested = !m.row.category && !!suggestion;
    const receipt = await withBytes(m.receipt);
    // Passed to createRecord for claim-record to store on the row (the review
    // screen shows it as "Please check: ..."), and kept in the result below.
    const reviewReason = _reviewReason({ match: m, category, categorySuggested, receipt });
    const rec = await createRecord({
      userId: job.userId, groupId,
      row: m.row, receipt, match: m,
      category, categorySuggested, reviewReason,
      store: _storeFor(receipt, storeReceipt),
    });
    note(rec, { reviewReason, rowNo: m.row.no, file: m.receipt.file });
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
  for (const read of matched.unmatchedReceipts) {
    const receipt = await withBytes(read);
    const reviewReason = _reviewReason({ receipt });
    const rec = await createRecord({
      userId: job.userId, groupId,
      // Synthesised from what the model read, so the record carries the figures
      // it found rather than being blank.
      row: {
        no: null,
        date: receipt.date || null,
        description: receipt.description || receipt.merchant || (receipt.file ? receipt.file.split('/').pop() : null),
        currency: receipt.currency || null,
        amount: receipt.total ?? null,
        category: receipt.category || null,
      },
      receipt, match: null, category: receipt.category || null, reviewReason, store: _storeFor(receipt, storeReceipt),
    });
    note(rec, { reviewReason, file: read.file });
  }

  const notStored = reads.filter(r => r.fileProblem).map(r => ({ file: r.file, reason: r.fileProblem }));
  return _update(job, {
    stage: 'done',
    result: {
      groupId,
      created,
      summary: {
        ...matched.summary,
        total: created.length || matched.summary.total,
        unreadable: reads.filter(r => !r.readable).length,
        skippedFiles: skipped.length,
        // Split on purpose: `duplicates` were marked and need no action,
        // `suspected` are the ones a person still has to settle.
        duplicates: duplicates.length,
        suspectedDuplicates: suspected.length,
        needsReview: needsReview.length,
        shrunk: reads.filter(r => r.shrunk).length,
        notStored: notStored.length,
      },
      discrepancies: matched.matches.filter(m => m.discrepancy).map(m => ({
        rowNo: m.row.no, date: m.row.date, description: m.row.description, ...m.discrepancy,
      })),
      missingReceipts: matched.unmatchedRows.map(r => ({ rowNo: r.no, date: r.date, description: r.description, amount: r.amount })),
      extraReceipts: matched.unmatchedReceipts.map(r => ({ file: r.file, merchant: r.merchant, total: r.total, date: r.date })),
      unreadable: reads.filter(r => !r.readable).map(r => ({ file: r.file })),
      duplicates,
      suspectedDuplicates: suspected,
      // Claims created with a reason to look again: a weak pairing, a
      // suggested category, a receipt too large to attach.
      needsReview,
      // Receipts that could not be brought under Xero's 3MB limit. Their
      // claims exist; the file is what is missing.
      notStored,
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
