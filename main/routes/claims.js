const express      = require('express');
const router       = express.Router();
const { decodeBase64 } = require('../utils/base64');
const { requireAuth } = require('../middleware/auth-middleware');
const asyncHandler = require('../middleware/async-handler');
const invoiceStore = require('../utils/invoice-store');
const receiptStore = require('../utils/receipt-store');
const claimImport  = require('../claims/claim-import');
const claimQueue   = require('../claims/claim-queue');
const claimWorker  = require('../claims/claim-worker');
const { parseReceiptBatch } = require('../utils/receipt-parser');
const { suggestCategories } = require('../claims/claim-categories');
const users        = require('../utils/users');
const { newId }    = require('../utils/ids');
const { profileFor } = require('../intake/profiles');
const logger       = require('../utils/logger');
const { withMarker } = require('../utils/audit-context');

// Importing a batch expense claim: a zip of receipts plus the claim form.
//
// Every route here is a READ of the user's own upload plus writes to the LOCAL
// store. Nothing reaches Xero.

// Uploads arrive as base64 JSON, same as single receipts — express.json is
// already mounted at 10mb and this needs no new dependency. A claim archive is
// larger than one receipt, so the cap is checked explicitly.
// What can actually get here, not what we would like to allow.
//
// Three limits sit in front of this and only the smallest one matters:
//   nginx  client_max_body_size  10M   (sites-available/xero-app)
//   express.json limit           10mb  (main/index.js)
//   this                                <- must be the smallest of the three
//
// Files arrive base64-encoded inside JSON, which inflates them by 4/3, so a
// 10MB body carries at most ~7.5MB of actual files. This was 25MB, which would
// have needed a 33MB body — unreachable, so the friendly message below never
// fired and users got nginx's raw HTML error page instead.
//
// 7MB leaves room for the JSON envelope and keeps the rejection ours: anything
// larger than this but still under nginx's gate is answered by the 413 below,
// which says what the limit is. Raising it means raising all three together.
const MAX_UPLOAD_BYTES = 7 * 1024 * 1024;


// The claim record itself is built in claims/claim-record.js, one builder
// for every path; the import job receives it as a dependency.
const { createClaimRecord, claimNumber } = require('../claims/claim-record');

// POST /api/claims/import  { archives: [{name,data}], forms: [{name,data}], label }
router.post('/import', requireAuth, asyncHandler(async (req, res) => {
  try {
    const { archives = [], forms = [], label } = req.body || {};
    if (!Array.isArray(archives) || !Array.isArray(forms) || (!archives.length && !forms.length)) {
      logger.warn('Claim import rejected', { userId: req.user.id, reason: 'nothing sendable was attached' });
      return res.status(400).json({ error: 'Attach at least a claim archive or a claim form' });
    }

    // "could not be read" said nothing about what to do next. The two causes
    // need different actions from the user, and the server can tell them apart:
    // an empty payload means the browser got nothing from the file (a cloud file
    // that was never downloaded locally is the usual reason), while a payload
    // that will not decode means it arrived damaged.
    const decode = list => {
      const out = [];
      for (const f of list) {
        const name = (f && f.name) || 'a file';
        const data = f && f.data;
        if (typeof data !== 'string' || !data) {
          return { error: `${name} came through empty. If it lives in iCloud Drive or a network folder, open it once so it downloads, then try again.` };
        }
        const buffer = decodeBase64(data);
        if (!buffer) return { error: `${name} arrived damaged and could not be decoded. Try attaching it again.` };
        out.push({ name: f.name || 'file', buffer });
      }
      return { out };
    };

    // Logged as well as returned. A rejected import previously left nothing
    // behind but a status code and a byte count in the access log, which is not
    // enough to tell afterwards which file failed or why — the request body is
    // never logged, and by the time anyone asks, the attempt is gone.
    const reject = (why) => {
      logger.warn('Claim import rejected', {
        userId: req.user.id, reason: why,
        archives: archives.map(x => (x && x.name) || '(unnamed)'),
        forms:    forms.map(x => (x && x.name) || '(unnamed)'),
      });
      return res.status(400).json({ error: why });
    };

    const a = decode(archives); if (a.error) return reject(a.error);
    const f = decode(forms);    if (f.error) return reject(f.error);

    const bytes = [...a.out, ...f.out].reduce((s, x) => s + x.buffer.length, 0);
    if (bytes > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: `That is ${(bytes / 1048576).toFixed(1)}MB; the limit is ${MAX_UPLOAD_BYTES / 1048576}MB.` });
    }

    const enq = claimQueue.enqueue(req.user.id, {
      archives: a.out,
      forms: f.out,
      label: label || 'Expense claim',
    });
    if (enq.error) {
      return res.status(429).json({ error: enq.error });
    }
    const job = enq.job;

    claimWorker.startWorker(req.user.id, {
      parseReceipts: (userId, images) => parseReceiptBatch(userId, images),
      storeReceipt: (userId, id, buffer, mime) => receiptStore.forUser(userId).save(id, buffer, mime),
      createRecord: createClaimRecord,
      suggest: (userId, matches, categories) => suggestCategories(userId, matches, categories),
    });
    claimWorker.kickWorker(req.user.id);

    logger.info('Claim import enqueued', { userId: req.user.id, jobId: job.id, archives: a.out.length, forms: f.out.length });
    // 202: accepted and running. The client polls; closing the tab is fine.
    res.status(202).json({ jobId: job.id, stage: job.stage });
  } catch (err) {
    logger.error('Claim import could not start', { userId: req.user.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
}));

// GET /api/claims/active — returns any currently in-flight or queued claim import
router.get('/active', requireAuth, (req, res) => {
  const memJobs = claimImport.listJobs(req.user.id);
  const activeMem = memJobs.find(j => !['done', 'failed', 'cancelled'].includes(j.stage));
  if (activeMem) {
    return res.json({
      job: {
        id: activeMem.id,
        label: activeMem.label,
        stage: activeMem.stage,
        receiptsTotal: activeMem.receiptsTotal,
        receiptsRead: activeMem.receiptsRead,
        rowsTotal: activeMem.rowsTotal,
      }
    });
  }

  const diskJobs = claimQueue.getPending(req.user.id);
  if (diskJobs.length > 0) {
    const dj = diskJobs[0];
    return res.json({
      job: {
        id: dj.id,
        label: dj.label,
        stage: dj.stage,
        receiptsTotal: dj.receiptsTotal,
        receiptsRead: dj.receiptsRead,
        rowsTotal: dj.rowsTotal,
      }
    });
  }

  res.json({ job: null });
});

// GET /api/claims/import/:jobId — progress, then the reconciliation
router.get('/import/:jobId', requireAuth, (req, res) => {
  const memJob = claimImport.getJob(req.params.jobId, req.user.id);
  const diskJob = claimQueue.get(req.user.id, req.params.jobId);
  const job = memJob || diskJob;
  if (!job) return res.status(404).json({ error: 'Import not found — it may have expired' });
  const startedAt = job.startedAt ? new Date(job.startedAt).toISOString() : (job.createdAt || new Date().toISOString());
  res.json({
    id: job.id, label: job.label, stage: job.stage,
    receiptsTotal: job.receiptsTotal, receiptsRead: job.receiptsRead, rowsTotal: job.rowsTotal,
    error: job.error, result: job.result,
    startedAt,
  });
});

// DELETE /api/claims/import/:jobId — stop a run in progress
router.delete('/import/:jobId', requireAuth, (req, res) => {
  const memJob = claimImport.cancel(req.params.jobId, req.user.id);
  const diskJob = claimQueue.markCancelled(req.user.id, req.params.jobId);
  if (!memJob && !diskJob) return res.status(404).json({ error: 'Import not found' });
  res.json({ stage: (memJob && memJob.stage) || (diskJob && diskJob.stage) || 'cancelled' });
});

// DELETE /api/claims/group/:groupId — undo a whole import.
// An import that went wrong should not need twenty-seven deletions.
router.delete('/group/:groupId', requireAuth, (req, res) => {
  const store = invoiceStore.forUser(req.user.id);
  const members = store.getReceiptGroup(req.params.groupId);
  if (!members.length) return res.status(404).json({ error: 'Nothing found for that import' });

  // A claim already in Xero, or on its way there, stays: deleting the local row
  // would lose its Xero ID and a re-import would post it a second time. The
  // same rule as deleting a single record (routes/invoices.js).
  const inXero = r => !!r.xeroInvoiceId || r.status === 'submitting';
  const keep   = members.filter(inXero);
  const drop   = members.filter(r => !inXero(r));

  let files = 0;
  // Each claim's history says it went with the rest of its import.
  withMarker({ bulk: 'undo-import' }, () => {
    for (const rec of drop) {
      store.remove(rec.id);
      // Siblings can share a file; it goes only when nothing references it.
      if (rec.receiptFile && store.countByReceiptFile(rec.receiptFile) === 0) {
        if (receiptStore.forUser(req.user.id).remove(rec.receiptFile)) files++;
      }
    }
  });
  logger.info('Claim import undone', { userId: req.user.id, groupId: req.params.groupId, removed: drop.length, kept: keep.length, files });
  res.json({
    removed: drop.length,
    kept:    keep.length,
    ...(keep.length ? { message: `${keep.length} claim${keep.length === 1 ? ' was' : 's were'} already sent to Xero and kept.` } : {}),
  });
});

// ── Claims with no receipt: mileage and per diem ─────────────────────────────
// A drive or a day away has no receipt to photograph. The claim is typed in
// and priced here, from the rate set in Setup: quantity x rate, to the cent.
// An amount the browser sends is never read. The rate is copied onto the
// claim, so a later change in Setup does not reprice a claim already made,
// and an edit prices the new quantity at the rate the claim was made at.
//
// Nothing here reaches Xero either. The claim is posted later through the
// same path as a receipt claim (xero/invoices.js), which knows there is no
// file to attach and that the claimant, not a shop, is owed.

const ALLOWANCES = {
  mileage:  { label: 'Mileage',  unit: 'km'  },
  per_diem: { label: 'Per diem', unit: 'day' },
};
// A slipped digit, not a long trip: one way, so a return trip is twice this.
const MAX_KM      = 5000;
const MAX_DAYS    = 366;
// Each typed place and purpose is kept short enough that the line built from
// them stays readable and the claim's reference fits Xero's limit.
const MAX_PLACE     = 80;
const MAX_PURPOSE   = 120;
const MAX_REFERENCE = 250;
// The statuses the generic editor allows (routes/invoices.js EDITABLE_STATUSES):
// a claim being sent, marked duplicate or reported is not edited here either.
const EDITABLE_STATUSES = new Set(['pending', 'review-needed', 'error', 'reviewed', 'posted']);
// Xero's own limit: an account code is up to ten letters and digits.
const ACCOUNT_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,9}$/;

function _isoDate(value) {
  const s = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}
const _dayNumber = s => Math.round(Date.parse(`${s}T00:00:00Z`) / 86400000);
const _addDays   = (s, n) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const _given     = v => v !== undefined && v !== null && String(v).trim() !== '';

// A typed number in tenths of a unit (42.5 km -> 425), so every sum below is
// in whole numbers. undefined when it is not a number at all, NaN when it has
// more than one decimal place.
function _tenths(value) {
  if (typeof value === 'boolean' || !_given(value)) return undefined;
  const n = Number(String(value).trim());
  if (!Number.isFinite(n)) return undefined;
  const t = Math.round(n * 10);
  return Math.abs(n * 10 - t) < 1e-6 ? t : NaN;
}

function _text(value, label, max, field, errors) {
  const s = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!s) errors.push({ field, error: `${label} is required` });
  else if (s.length > max) errors.push({ field, error: `${label} must be at most ${max} characters` });
  return s;
}

// What the form says, checked: { errors } or { input } where input is the
// day the claim is dated, the quantity in tenths, and the details to keep.
function readAllowanceInput(kind, body = {}) {
  const errors = [];
  if (kind === 'mileage') {
    const date = _isoDate(body.date);
    if (!date) errors.push({ field: 'date', error: 'Date must be a date (YYYY-MM-DD)' });
    const from    = _text(body.from, 'From', MAX_PLACE, 'from', errors);
    const to      = _text(body.to, 'To', MAX_PLACE, 'to', errors);
    const purpose = _text(body.purpose, 'Purpose', MAX_PURPOSE, 'purpose', errors);
    const km = _tenths(body.distanceKm);
    if (!(km > 0)) errors.push({ field: 'distanceKm', error: 'Distance must be a number of km above 0, with at most one decimal place' });
    else if (km > MAX_KM * 10) errors.push({ field: 'distanceKm', error: `Distance must be at most ${MAX_KM.toLocaleString('en-US')} km one way` });
    // Only a real yes doubles the distance; the text "false" from a form is not one.
    const returnTrip = body.returnTrip === true || body.returnTrip === 'true';
    if (errors.length) return { errors };
    return { input: {
      date, quantityTenths: km * (returnTrip ? 2 : 1),
      details: { from, to, purpose, distanceKm: km / 10, returnTrip },
    } };
  }

  // Per diem: a start date, then an end date, a number of days, or both. Days
  // go in half-day steps (a travel day is often paid at half). With both, the
  // days may not be more than the dates hold; with only days, the end date is
  // the day the last (part) day falls on.
  const startDate = _isoDate(body.startDate);
  if (!startDate) errors.push({ field: 'startDate', error: 'Start date must be a date (YYYY-MM-DD)' });
  let endDate = _given(body.endDate) ? _isoDate(body.endDate) : null;
  if (_given(body.endDate) && !endDate) errors.push({ field: 'endDate', error: 'End date must be a date (YYYY-MM-DD)' });
  let days = _given(body.days) ? _tenths(body.days) : null;
  if (days !== null && !(days > 0 && days % 5 === 0)) {
    errors.push({ field: 'days', error: 'Days must be above 0, in steps of half a day' });
    days = undefined;
  } else if (days > MAX_DAYS * 10) {
    errors.push({ field: 'days', error: `Days must be at most ${MAX_DAYS}` });
    days = undefined;
  }
  if (startDate && endDate) {
    const span = _dayNumber(endDate) - _dayNumber(startDate) + 1;
    if (span < 1) errors.push({ field: 'endDate', error: 'End date is before the start date' });
    else if (span > MAX_DAYS) errors.push({ field: 'endDate', error: `A per diem claim covers at most ${MAX_DAYS} days` });
    else if (days === null) days = span * 10;
    else if (days > span * 10) {
      errors.push({ field: 'days', error: `${startDate} to ${endDate} is ${span} day${span === 1 ? '' : 's'}, fewer than the ${days / 10} claimed` });
    }
  } else if (startDate && !_given(body.endDate)) {
    if (days === null) errors.push({ field: 'endDate', error: 'Give an end date or the number of days' });
    else if (days > 0) endDate = _addDays(startDate, Math.ceil(days / 10) - 1);
  }
  const destination = _text(body.destination, 'Destination', MAX_PLACE, 'destination', errors);
  const purpose     = _text(body.purpose, 'Purpose', MAX_PURPOSE, 'purpose', errors);
  if (errors.length) return { errors };
  return { input: { date: startDate, quantityTenths: days, details: { destination, purpose, endDate } } };
}

// quantity x rate in cents, in whole numbers: tenths of a unit times
// ten-thousandths of the money (a rate has at most four places) is in
// hundred-thousandths, a thousand of which make a cent. Half a cent rounds up.
// In floats 3.5 x 0.45 is 1.5749999..., and that half cent went down.
function priceCents(quantityTenths, rate) {
  const rate4 = Math.round(Number(rate) * 10000);
  return Math.floor((quantityTenths * rate4 + 500) / 1000);
}

// The line Xero shows, saying what was claimed and how it was priced:
//   Mileage 2026-10-03: Office → Client A (site visit), 42.0 km × 0.60
//   Per diem 2026-10-01 to 2026-10-03, Kuala Lumpur (conference), 3 days × 80.00
function allowanceLine(kind, { date, details }, quantity, rate) {
  const rateText = users.formatRate(rate);
  if (kind === 'mileage') {
    return `Mileage ${date}: ${details.from} → ${details.to}${details.returnTrip ? ' and back' : ''} `
      + `(${details.purpose}), ${quantity.toFixed(1)} km × ${rateText}`;
  }
  const span = details.endDate && details.endDate !== date ? ` to ${details.endDate}` : '';
  return `Per diem ${date}${span}, ${details.destination} (${details.purpose}), `
    + `${quantity} ${quantity === 1 ? 'day' : 'days'} × ${rateText}`;
}

// Everything on the claim that follows from what was typed and the rate: the
// date, the quantity, the amount (no tax: an allowance carries none, so the
// zero-tax rule applies when it is posted), its one line and the description.
// The new claim and an edit both come through here, so they agree.
function pricedFields(kind, input, rate) {
  const cents = priceCents(input.quantityTenths, rate);
  if (!(cents > 0)) return { error: 'That comes to less than a cent. Check the distance or days.' };
  const quantity = input.quantityTenths / 10;
  const amount   = cents / 100;
  const line     = allowanceLine(kind, input, quantity, rate);
  return { fields: {
    invoiceDate:   input.date,
    dueDate:       input.date,
    claimQuantity: quantity,
    claimDetails:  input.details,
    totalAmount:   amount,
    subTotal:      amount,
    taxAmount:     0,
    lineItems:     [{ description: line, unitAmount: amount }],
    // Sent to Xero as the reference, which has a length limit; the line keeps
    // the whole text.
    description:   line.length > MAX_REFERENCE ? `${line.slice(0, MAX_REFERENCE - 1)}…` : line,
  } };
}

// Shown in the review page's duplicate banner, which looks for the word
// "duplicate". A warning only: the claim is kept and stays editable.
function duplicateNote(kind, match) {
  const what = kind === 'mileage' ? 'date, distance, route and purpose' : 'dates, days, destination and purpose';
  return `Possible duplicate of ${match.invoiceNumber || match.id} — another ${ALLOWANCES[kind].label.toLowerCase()} `
    + `claim with the same ${what}. Check before approving.`;
}

const _payeeSet = userId => !!String(users.getUserConfig(userId).CLAIM_PAYEE_NAME || '').trim();

// GET /api/claims/allowance/settings — which kinds are on, and at what rate,
// so the claims tab offers only those; and whether a payee is set, since
// without one there is nobody in Xero to owe the claim to.
router.get('/allowance/settings', requireAuth, (req, res) => {
  const s = users.getAllowanceSettings(req.user.id);
  const view = kind => ({ enabled: s[kind].rate !== null, rate: s[kind].rate, accountCode: s[kind].accountCode, unit: ALLOWANCES[kind].unit });
  res.json({ currency: s.currency, payeeSet: _payeeSet(req.user.id), mileage: view('mileage'), per_diem: view('per_diem') });
});

// POST /api/claims/allowance
//   mileage:  { kind: 'mileage', date, from, to, purpose, distanceKm, returnTrip }
//   per diem: { kind: 'per_diem', startDate, endDate?, days?, destination, purpose }
// → 201 { claim, duplicate? }. Kept for review like anything typed by hand.
router.post('/allowance', requireAuth, (req, res) => {
  const userId = req.user.id;
  try {
    const body = req.body || {};
    const kind = body.kind;
    if (!Object.prototype.hasOwnProperty.call(ALLOWANCES, kind)) {
      return res.status(400).json({ error: 'kind must be "mileage" or "per_diem"' });
    }

    const settings = users.getAllowanceSettings(userId);
    const rate = settings[kind].rate;
    if (rate === null) {
      return res.status(409).json({ error: `${ALLOWANCES[kind].label} claims are off. Set a rate in Setup under Mileage and allowances first.` });
    }

    const read = readAllowanceInput(kind, body);
    if (read.errors) return res.status(400).json({ error: read.errors[0].error, errors: read.errors });
    const priced = pricedFields(kind, read.input, rate);
    if (priced.error) return res.status(400).json({ error: priced.error });

    const store = invoiceStore.forUser(userId);
    const dup = store.findAllowanceDuplicate({
      kind, date: read.input.date, quantity: priced.fields.claimQuantity, details: read.input.details,
    });
    const id  = newId();
    const now = new Date().toISOString();
    const claim = store.add({
      id,
      // Where anything typed in by hand starts: waiting for its review, as
      // POST /api/invoices/compose does through the same profile rule.
      status:        profileFor('EXPENSE').initialStatus('form'),
      invoiceType:   'EXPENSE',
      source:        'form',
      invoiceNumber: claimNumber({ id }),
      currency:      settings.currency,
      accountCode:   settings[kind].accountCode,
      // No shop: the claimant is owed, and xero/invoices.js names them.
      vendorName:    null,
      ...priced.fields,
      claimKind:     kind,
      claimRate:     rate,
      claimUnit:     ALLOWANCES[kind].unit,
      duplicateOf:   dup ? dup.id : null,
      errorMsg:      dup ? duplicateNote(kind, dup) : null,
      processedAt:   now,
      receivedAt:    now,
    });

    logger.info('Allowance claim added', { userId, id, kind, quantity: claim.claimQuantity, rate, amount: claim.totalAmount, duplicateOf: dup ? dup.id : null });
    res.status(201).json({ claim, ...(dup ? { duplicate: { id: dup.id, invoiceNumber: dup.invoiceNumber } } : {}) });
  } catch (err) {
    logger.error('Allowance claim could not be added', { userId, error: err.message });
    res.status(500).json({ error: err.message || 'Could not add the claim' });
  }
});

// PATCH /api/claims/allowance/:id — every field adding one takes, plus an
// optional accountCode. The amount is worked out again, from the new quantity
// at the rate the claim was made at; an amount sent here is not read.
router.patch('/allowance/:id', requireAuth, (req, res) => {
  const userId = req.user.id;
  try {
    const store  = invoiceStore.forUser(userId);
    const record = store.getById(req.params.id);
    if (!record) return res.status(404).json({ error: 'Claim not found' });
    const kind = record.claimKind;
    if (!Object.prototype.hasOwnProperty.call(ALLOWANCES, kind)) {
      return res.status(400).json({ error: 'This is not a mileage or per diem claim' });
    }
    if (!EDITABLE_STATUSES.has(record.status)) {
      return res.status(409).json({ error: `A claim with status "${record.status}" cannot be edited` });
    }
    if (!(Number(record.claimRate) > 0)) {
      return res.status(409).json({ error: 'This claim has no rate recorded, so it cannot be priced again' });
    }

    const body = req.body || {};
    const read = readAllowanceInput(kind, body);
    if (read.errors) return res.status(400).json({ error: read.errors[0].error, errors: read.errors });
    const priced = pricedFields(kind, read.input, record.claimRate);
    if (priced.error) return res.status(400).json({ error: priced.error });

    const patch = { ...priced.fields };
    if (_given(body.accountCode)) {
      const code = String(body.accountCode).trim();
      if (!ACCOUNT_CODE.test(code)) {
        return res.status(400).json({ error: 'Account must be a Xero account code (up to 10 letters and digits)' });
      }
      patch.accountCode = code;
    }

    // Checked again: after the edit the claim may match another, or no longer
    // match. A note this check left is replaced or cleared; any other note
    // (a failed send, say) stays.
    const dup = store.findAllowanceDuplicate({
      kind, date: read.input.date, quantity: priced.fields.claimQuantity, details: read.input.details, excludeId: record.id,
    });
    if (dup) {
      patch.duplicateOf = dup.id;
      patch.errorMsg    = duplicateNote(kind, dup);
    } else if (record.errorMsg && /^Possible duplicate of /.test(record.errorMsg)) {
      patch.duplicateOf = null;
      patch.errorMsg    = null;
    }

    const claim = store.update(record.id, patch);
    logger.info('Allowance claim edited', { userId, id: record.id, kind, quantity: claim.claimQuantity, amount: claim.totalAmount, by: req.user.email });
    res.json({ success: true, claim, ...(dup ? { duplicate: { id: dup.id, invoiceNumber: dup.invoiceNumber } } : {}) });
  } catch (err) {
    logger.error('Allowance claim could not be edited', { userId, id: req.params.id, error: err.message });
    res.status(500).json({ error: err.message || 'Could not save the claim' });
  }
});

module.exports = router;
module.exports._createClaimRecord = createClaimRecord;

