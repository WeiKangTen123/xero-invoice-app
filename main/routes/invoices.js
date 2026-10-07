const express      = require('express');
const router       = express.Router();
const { decodeBase64 } = require('../utils/base64');
const jwt          = require('jsonwebtoken');
const { requireAuth, sessionUser, jwtSecret } = require('../middleware/auth-middleware');
const asyncHandler = require('../middleware/async-handler');
const { isActive }  = require('../utils/users');
const invoiceStore = require('../utils/invoice-store');
const pdfStore     = require('../utils/pdf-store');
const receiptStore = require('../utils/receipt-store');
const emailQueue   = require('../queue/email-queue');
const emailWorker  = require('../queue/email-worker');
const { submitInvoiceToXero, postedDuplicateOf, bankDetailsChange } = require('../utils/invoice-handler');
const { xeroErrMsg, getRateLimitBudget } = require('../xero/xero-utils');
const statusSync   = require('../xero/status-sync');
const logger       = require('../utils/logger');

// PDF access tokens are short-lived and scoped to one invoice + one user.
// They exist only because browsers cannot send Authorization headers on direct
// navigation requests (new tab, iframe src, embed src).
const PDF_TOKEN_TTL = '5m';

function issuePdfToken(userId, invoiceId) {
  return jwt.sign({ userId, invoiceId, purpose: 'pdf' }, jwtSecret(), { expiresIn: PDF_TOKEN_TTL });
}

function verifyPdfToken(token, invoiceId) {
  const payload = jwt.verify(token, jwtSecret());
  if (payload.purpose !== 'pdf' || payload.invoiceId !== invoiceId) {
    throw new Error('Token scope mismatch');
  }
  return payload.userId;
}

// Fields a user may correct before or instead of re-submitting to Xero.
// Excludes system-managed fields (id, status, xeroInvoiceId, processedAt, etc.).
const EDITABLE_FIELDS = new Set([
  'vendorName', 'contactName', 'contactEmail', 'contactAddress',
  'invoiceNumber', 'invoiceDate', 'dueDate',
  'totalAmount', 'subTotal', 'taxAmount', 'currency',
  'invoiceType', 'description', 'lineItems', 'accountCode',
  'paymentReference', 'errorMsg',
]);

// 'posted' is included so a correction can be edited and re-posted — re-posting an
// already-posted invoice updates the existing Xero bill in place (see
// queue/processor.js submitDraftInvoice) rather than creating a duplicate.
const EDITABLE_STATUSES    = new Set(['pending', 'review-needed', 'error', 'reviewed', 'posted']);
const SUBMITTABLE_STATUSES = new Set(['pending', 'review-needed', 'error', 'reviewed', 'posted']);

// ── GET /api/invoices ─────────────────────────────────────────────────────────
// ── Adding bills by hand ─────────────────────────────────────────────────────
// Everything above this comment arrives by email. These are the two ways a
// bill gets in without one: a single PDF, or a batch as a background job.
// Declared before the /:id routes so "/import" is never read as an id.
const billIntake    = require('../intake/bill-intake');
const invoiceIntake = require('../intake/invoice-intake');
const jobs          = require('../jobs');
const IMPORT_TYPES  = new Set(['bill-import', 'invoice-import']);


// POST /api/invoices  { name, data (base64 PDF) }
// One uploaded bill. Stored as review-needed; never sent to Xero on its own.
router.post('/', requireAuth, asyncHandler(async (req, res) => {
  const { name, data } = req.body || {};
  const buffer = decodeBase64(data);
  if (!buffer) return res.status(400).json({ error: `${name || 'The file'} came through empty or unreadable. Try attaching it again.` });
  if (!billIntake.looksLikePdf(buffer)) return res.status(400).json({ error: `${name || 'The file'} is not a PDF. Bills are added as PDF files.` });
  if (buffer.length > billIntake.MAX_PDF_BYTES) {
    return res.status(413).json({ error: `That is ${(buffer.length / 1048576).toFixed(1)}MB; Xero accepts at most 3MB for an attachment.` });
  }
  try {
    const r = await billIntake.intakeBillPdf(req.user.id, { name: name || 'bill.pdf', buffer });
    if (r.outcome !== 'stored') return res.status(422).json({ error: r.error });
    const dup = r.records.find(x => x.duplicate);
    if (dup && r.records.every(x => x.duplicate)) {
      return res.status(409).json({ error: 'This bill is already in the system', duplicateOf: dup.id, records: r.records });
    }
    const store = invoiceStore.forUser(req.user.id);
    res.status(201).json({ records: r.records, invoices: r.records.map(x => store.getById(x.id)).filter(Boolean) });
  } catch (err) {
    logger.error('Bill upload failed', { userId: req.user.id, error: err.message });
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
}));

// POST /api/invoices/compose  { contactName, contactEmail, contactAddress, invoiceNumber,
//   invoiceDate, dueDate | termsDays, currency, lineItems: [{ description, unitAmount, discountRate, taxPercent }], description }
// An invoice typed in. No file, no model: validated, checked against what is
// already stored, and kept for review. Never sent to Xero on its own.
router.post('/compose', requireAuth, (req, res) => {
  try {
    const r = invoiceIntake.intakeInvoice(req.user.id, req.body || {}, { source: 'form' });
    if (r.errors) return res.status(400).json({ error: r.errors[0].error, errors: r.errors });
    if (r.duplicate) return res.status(409).json({ error: `An invoice with ${r.reason} is already in the system`, duplicateOf: r.id });
    res.status(201).json({ id: r.id, status: r.status, invoice: invoiceStore.forUser(req.user.id).getById(r.id) });
  } catch (err) {
    logger.error('Invoice compose failed', { userId: req.user.id, error: err.message });
    res.status(500).json({ error: err.message || 'Could not save the invoice' });
  }
});

// POST /api/invoices/import
//   bills:    { pdfs: [{name, data}], archives: [{name, data}], label }
//   invoices: { sheets: [{name, data}], label }   (.xlsx or .csv, one row per line item)
// Several bills, as a background job — a PDF each is a model call, and a
// batch of thirty is minutes, far past what a request can hold open.
router.post('/import', requireAuth, (req, res) => {
  const { pdfs = [], archives = [], sheets = [], label } = req.body || {};
  if (!Array.isArray(pdfs) || !Array.isArray(archives) || !Array.isArray(sheets)) {
    return res.status(400).json({ error: 'Attachments must be lists' });
  }
  const isInvoiceImport = sheets.length > 0;
  if (isInvoiceImport && (pdfs.length || archives.length)) {
    return res.status(400).json({ error: 'Import bills (PDFs) and invoices (a spreadsheet) separately' });
  }
  if (!pdfs.length && !archives.length && !sheets.length) {
    return res.status(400).json({ error: 'Attach at least one PDF or a zip of PDFs, or a spreadsheet of invoices' });
  }
  const decode = (list, kind) => {
    const out = [];
    for (const f of list) {
      const buffer = decodeBase64(f && f.data);
      if (!buffer) return { error: `${(f && f.name) || 'a file'} came through empty or unreadable. Try attaching it again.` };
      if (kind === 'pdf' && !billIntake.looksLikePdf(buffer)) return { error: `${f.name || 'a file'} is not a PDF.` };
      out.push({ name: f.name || `${kind}-${out.length + 1}`, buffer });
    }
    return { out };
  };
  const p = decode(pdfs, 'pdf');      if (p.error) return res.status(400).json({ error: p.error });
  const a = decode(archives, 'zip');  if (a.error) return res.status(400).json({ error: a.error });
  const sh = decode(sheets, 'sheet'); if (sh.error) return res.status(400).json({ error: sh.error });
  const bytes = [...p.out, ...a.out, ...sh.out].reduce((s, f) => s + f.buffer.length, 0);
  if (bytes > 7 * 1024 * 1024) return res.status(413).json({ error: `That is ${(bytes / 1048576).toFixed(1)}MB; the limit for one import is 7MB.` });

  const enq = isInvoiceImport
    ? jobs.enqueue(req.user.id, { type: 'invoice-import', label: label || sh.out[0].name || 'Invoice import', payload: { sheets: sh.out } })
    : jobs.enqueue(req.user.id, { type: 'bill-import',    label: label || (p.out[0] || a.out[0]).name || 'Bill import', payload: { pdfs: p.out, archives: a.out } });
  if (enq.error) return res.status(429).json({ error: enq.error });
  jobs.startWorker(req.user.id);
  jobs.kickWorker(req.user.id);
  res.status(202).json({ jobId: enq.job.id, stage: enq.job.stage });
});

const _jobView = j => ({
  id: j.id, type: j.type, label: j.label, stage: j.stage,
  filesTotal: j.receiptsTotal, filesRead: j.receiptsRead, rowsTotal: j.rowsTotal,
  error: j.error, result: j.result, startedAt: j.startedAt || j.createdAt,
});

router.get('/import/active', requireAuth, (req, res) => {
  const active = jobs.getPending(req.user.id).find(j => IMPORT_TYPES.has(j.type));
  res.json({ job: active ? _jobView(active) : null });
});

router.get('/import/:jobId', requireAuth, (req, res) => {
  const job = jobs.get(req.user.id, req.params.jobId);
  if (!job || !IMPORT_TYPES.has(job.type)) return res.status(404).json({ error: 'Import not found — it may have expired' });
  res.json(_jobView(job));
});

router.delete('/import/:jobId', requireAuth, (req, res) => {
  const job = jobs.markCancelled(req.user.id, req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Import not found' });
  res.json({ stage: job.stage });
});

// ── POST /api/invoices/sync-xero-status ──────────────────────────────────────
// "Refresh from Xero": reads back now, for the signed-in account, what became
// of everything it posted (approved, paid, voided...) instead of waiting for
// the 3-hourly job. Responds { checked, updated, failedTenants }. Read-only on
// the Xero side.
//
// At most one run a minute per account. Each run spends Xero calls from the
// same daily allowance posting needs, and a button pressed repeatedly would
// spend them on answers that cannot have changed. Counted from when a run
// starts, so pressing again while one is running is refused too.
const STATUS_SYNC_COOLDOWN_MS = 60_000;
const _statusSyncStartedAt = new Map(); // userId -> ms
router.post('/sync-xero-status', requireAuth, asyncHandler(async (req, res) => {
  const userId = String(req.user.id);
  const now    = Date.now();
  const last   = _statusSyncStartedAt.get(userId);
  if (last !== undefined && now - last < STATUS_SYNC_COOLDOWN_MS) {
    const wait = Math.max(1, Math.ceil((STATUS_SYNC_COOLDOWN_MS - (now - last)) / 1000));
    res.set('Retry-After', String(wait));
    return res.status(429).json({
      error: `Statuses were refreshed from Xero less than a minute ago. Try again in ${wait} second${wait === 1 ? '' : 's'}.`,
      retryAfter: wait,
    });
  }
  _statusSyncStartedAt.set(userId, now);
  const { checked, updated, failedTenants } = await statusSync.syncUser(userId);
  logger.info('Xero statuses refreshed by hand', { userId, checked, updated, failedTenants });
  res.json({ checked, updated, failedTenants });
}));

// One row of the list. The same fields whichever form of the list is asked for,
// so the Invoices page and the Automation page's recent table render alike.
const _listRow = inv => ({
  id:            inv.id,
  status:        inv.status,
  hasPdf:        inv.hasPdf,
  pdfFilename:   inv.pdfFilename,
  vendorName:    inv.vendorName,
  invoiceNumber: inv.invoiceNumber,
  invoiceDate:   inv.invoiceDate,
  dueDate:       inv.dueDate,
  totalAmount:   inv.totalAmount,
  // The list's CSV export carries the split and the account code, so a
  // bookkeeper can reconcile the export without opening every record.
  subTotal:      inv.subTotal,
  taxAmount:     inv.taxAmount,
  accountCode:   inv.accountCode,
  currency:      inv.currency,
  invoiceType:   inv.invoiceType,
  source:        inv.source,
  sourceEmail:   inv.sourceEmail,
  processedAt:   inv.processedAt,
  submittedAt:   inv.submittedAt,
  xeroInvoiceId: inv.xeroInvoiceId,
  // The connected Xero company that xeroInvoiceId is in.
  xeroTenantId:  inv.xeroTenantId,
  errorMsg:      inv.errorMsg,
  // The Invoices page reads these to tell a claim from a bill, to group a
  // split photo or an import, and to show a suspected duplicate; they were
  // left out of the list and the page showed every claim as "PDF/Email".
  receivedAt:    inv.receivedAt,
  receiptFile:   inv.receiptFile,
  receiptGroup:  inv.receiptGroup,
  receiptPage:   inv.receiptPage,
  duplicateOf:   inv.duplicateOf,
  description:   inv.description,
  reportCount:   (inv.reports || []).length,
  // What Xero says about it now, as last read back (xero/status-sync.js):
  // status, amounts in dollars, the day it was paid in full, and when Xero
  // last confirmed them. All null until the first check.
  xeroStatus:     inv.xeroStatus,
  xeroAmountDue:  inv.xeroAmountDue,
  xeroAmountPaid: inv.xeroAmountPaid,
  xeroPaidOn:     inv.xeroPaidOn,
  xeroSyncedAt:   inv.xeroSyncedAt,
});

// GET /api/invoices            → { invoices }         every invoice, newest first
// GET /api/invoices?recent=N   → { invoices, total }  the newest N (1–100), and
//                                                     how many there are in all
// The Automation page shows ten rows and polls every 15 seconds. Loading every
// invoice with its line items and reports to throw all but ten away was the
// heaviest request the page made, and it grew with every bill received; the
// recent form reads only the rows it returns, plus a COUNT for the subtitle.
const RECENT_MAX = 100;
router.get('/', requireAuth, (req, res) => {
  const store = invoiceStore.forUser(req.user.id);
  if (req.query.recent !== undefined) {
    const n = Number(req.query.recent);
    if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: 'recent must be a whole number of at least 1' });
    return res.json({ invoices: store.getRecent(Math.min(n, RECENT_MAX)).map(_listRow), total: store.count() });
  }
  res.json({ invoices: store.getAll().map(_listRow) });
});

// ── GET /api/invoices/:id ─────────────────────────────────────────────────────
router.get('/:id', requireAuth, (req, res) => {
  const inv = invoiceStore.forUser(req.user.id).getById(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  const { pdfBuffer, ...safe } = inv;
  void pdfBuffer;
  res.json({ invoice: safe });
});

// ── GET /api/invoices/:id/pdf-url ─────────────────────────────────────────────
// Returns a short-lived signed URL the browser can open directly without needing
// to send a custom Authorization header (browsers cannot do that on navigation).
// The frontend calls this endpoint first (with Bearer JWT), then opens the URL.
router.get('/:id/pdf-url', requireAuth, (req, res) => {
  const inv = invoiceStore.forUser(req.user.id).getById(req.params.id);
  if (!inv)        return res.status(404).json({ error: 'Invoice not found' });
  if (!inv.hasPdf) return res.status(404).json({ error: 'No PDF attached to this invoice' });

  // Verify the physical file exists before issuing a token — avoids the browser
  // receiving a JSON error inside an iframe with no actionable feedback.
  if (!pdfStore.forUser(req.user.id).exists(req.params.id)) {
    return res.status(404).json({ error: 'PDF file not found — it may have been deleted from storage' });
  }

  const token = issuePdfToken(req.user.id, req.params.id);
  res.json({ url: `/api/invoices/${req.params.id}/pdf?token=${token}`, expiresIn: PDF_TOKEN_TTL });
});

// ── GET /api/invoices/:id/pdf ─────────────────────────────────────────────────
// Serves the PDF binary. Accepts two auth forms:
//   1. Authorization: Bearer <jwt>  — for programmatic / API access
//   2. ?token=<pdf-token>           — for browser direct navigation (new tab, iframe)
router.get('/:id/pdf', (req, res, next) => {
  const { id }     = req.params;
  const queryToken = req.query.token;
  let   userId;

  if (queryToken) {
    try {
      userId = verifyPdfToken(queryToken, id);
    } catch {
      return res.status(401).json({ error: 'PDF link has expired — request a new one' });
    }
    // A link lives five minutes; one minted just before the account was
    // disabled or deleted must not outlast that.
    if (!isActive(userId)) {
      return res.status(401).json({ error: 'PDF link has expired — request a new one' });
    }
  } else {
    // The same checks requireAuth makes. This used to be a bare jwt.verify,
    // which still served PDFs to a disabled account and to a token that a
    // password reset or "sign out everywhere" had revoked.
    const bearerToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const session = sessionUser(bearerToken);
    if (session.error) return res.status(401).json({ error: session.error });
    userId = session.user.id;
  }

  const pdfPath = pdfStore.forUser(userId).getPath(id);
  if (!pdfPath) return res.status(404).json({ error: 'PDF not found' });

  const inv     = invoiceStore.forUser(userId).getById(id);
  const rawName = inv?.pdfFilename || `invoice-${id}.pdf`;

  // Content-Disposition filename has two constraints:
  //   filename="..."  must be ASCII-only (Node.js rejects bytes > 0x7f in headers)
  //   filename*=UTF-8''... uses percent-encoding so any UTF-8 name is safe (RFC 5987)
  // We send both: legacy clients use the ASCII fallback, modern browsers use filename*.
  const asciiFallback = rawName
    .replace(/[^\x20-\x7e]/g, '')  // strip non-ASCII (curly quotes, etc.)
    .replace(/"/g, "'")            // ASCII double-quotes → single-quotes
    .trim() || `invoice-${id}.pdf`;
  const encodedName = encodeURIComponent(rawName.replace(/["\r\n]/g, "'"));

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`);

  res.sendFile(pdfPath, (err) => {
    if (!err) return;
    logger.error('Failed to serve PDF', { id, userId, error: err.message });
    if (!res.headersSent) next(err);
  });
});

// ── PATCH /api/invoices/:id ───────────────────────────────────────────────────
// Correct LLM-extracted fields before or instead of submitting to Xero.
// Blocked on already-posted and auto-deduplicated invoices.
router.patch('/:id', requireAuth, asyncHandler(async (req, res, next) => {
  try {
    const inv = invoiceStore.forUser(req.user.id).getById(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    if (!EDITABLE_STATUSES.has(inv.status)) {
      return res.status(409).json({ error: `Invoice with status "${inv.status}" cannot be edited` });
    }

    const patch = {};
    for (const [k, v] of Object.entries(req.body)) {
      if (!EDITABLE_FIELDS.has(k)) continue;

      if (k === 'totalAmount' || k === 'subTotal' || k === 'taxAmount') {
        const n = parseFloat(v);
        if (isNaN(n) || n < 0) return res.status(400).json({ error: `"${k}" must be a non-negative number` });
        patch[k] = n;
      } else if (k === 'lineItems') {
        if (!Array.isArray(v)) return res.status(400).json({ error: '"lineItems" must be an array' });
        patch[k] = v;
      } else if (k === 'invoiceType') {
        if (!['ACCPAY', 'ACCREC', 'EXPENSE'].includes(v)) {
          return res.status(400).json({ error: '"invoiceType" must be "ACCPAY", "ACCREC", or "EXPENSE"' });
        }
        patch[k] = v;
      } else if (k === 'errorMsg') {
        patch[k] = v ? String(v) : null;
      } else if (k === 'currency') {
        if (typeof v !== 'string' || v.trim().length !== 3) {
          return res.status(400).json({ error: '"currency" must be a 3-letter ISO code' });
        }
        patch[k] = v.trim().toUpperCase();
      } else {
        patch[k] = typeof v === 'string' ? v.trim() : v;
      }
    }

    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'No recognised editable fields provided' });
    }

    const updated = await invoiceStore.forUser(req.user.id).update(req.params.id, patch);
    logger.info('Invoice fields corrected', { id: req.params.id, fields: Object.keys(patch), by: req.user.email });
    res.json({ success: true, invoice: updated });
  } catch (err) { next(err); }
}));

// ── Whether a record may be sent ─────────────────────────────────────────────
// The checks a send passes before it reaches submitInvoiceToXero, which then
// checks for a duplicate again and claims the row (claimForSubmit) so nothing
// else sends it at the same moment. The Submit button and Send to Xero on a
// selection both go through here, so one can never be looser than the other.
// Null when it may go. Otherwise both forms of the answer: what the single
// route replies ({ code, error, extra }) and what a row in a bulk result says
// ({ outcome, message }, with skipped when there is nothing left to do).
function submitRefusal(store, inv, { force = false } = {}) {
  if (!SUBMITTABLE_STATUSES.has(inv.status)) {
    const why = inv.status === 'duplicate'
      ? { outcome: 'Marked as a duplicate', message: 'Open it and confirm it is a different bill before sending it.' }
      : inv.status === 'reported'
        ? { outcome: 'Reported as a problem', message: 'Open it and settle the report before sending it.' }
        : inv.status === 'submitting'
          ? { outcome: 'Already being sent to Xero', message: '', skipped: true }
          : { outcome: `Cannot be sent while it is ${inv.status}`, message: '' };
    return { code: 409, error: `Invoice with status "${inv.status}" cannot be submitted`, extra: { status: inv.status }, ...why };
  }

  if (!inv.totalAmount || inv.totalAmount === 0) {
    return {
      code: 422, error: 'Invoice has no amount — edit the invoice fields before submitting', extra: {},
      outcome: 'Needs review first', message: 'No amount was read. Open it and fill in the figures.',
    };
  }

  // A correction goes to Xero as an update, which Xero refuses once the bill
  // has left DRAFT there. Refused here, with the reason, rather than sent to
  // fail and leave Xero's error on the row. Only a status already read back
  // counts: one not known yet is sent as before.
  const locked = statusSync.repostRefusal(inv);
  if (locked) {
    return {
      code: 409, error: `${locked}. If that has changed, refresh from Xero first.`, extra: { xeroStatus: inv.xeroStatus },
      outcome: locked, message: 'Nothing was sent. If that has changed, refresh from Xero first.', skipped: true,
    };
  }

  const dup = force ? null : postedDuplicateOf(store, inv);
  if (dup) {
    const label = [dup.vendorName, dup.invoiceNumber].filter(Boolean).join(' ') || 'a bill';
    return {
      code: 409, error: `This matches ${label}, which is already in Xero. Send it anyway only if it is a different bill.`,
      extra: { duplicateOf: dup.id },
      outcome: 'Matches a bill already in Xero',
      message: `This matches ${label}, which is already in Xero. If it is a different bill, open it and send it from there.`,
    };
  }
  return null;
}

// ── POST /api/invoices/:id/submit ─────────────────────────────────────────────
// Manually submit (or re-submit) an invoice to Xero.
// Safe to call multiple times — already-posted invoices return early without
// creating a duplicate in Xero.
//
// Body { force: true } sends it even though it matches another bill already in
// Xero. Without it that match is a 409, answered now rather than found in the
// background, so the person who pressed Submit sees why nothing was sent.
router.post('/:id/submit', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId  = req.user.id;

  const inv = invoiceStore.forUser(userId).getById(id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });

  const force   = req.body?.force === true;
  const refusal = submitRefusal(invoiceStore.forUser(userId), inv, { force });
  if (refusal) return res.status(refusal.code).json({ error: refusal.error, ...refusal.extra });

  // Fire submission in background — return 202 immediately so the UI doesn't hang.
  // claimForSubmit inside submitInvoiceToXero atomically sets status → 'submitting'
  // and prevents double-posting if the same invoice is in flight elsewhere.
  // submitInvoiceToXero records any failure on the row itself; this used to
  // write 'error' over it as well, which took a posted row off 'posted'.
  submitInvoiceToXero(userId, id, { allowDuplicate: force }).then(xeroInvoiceId => {
    logger.info('Manual Xero submission completed', { id, xeroInvoiceId: xeroInvoiceId || 'queued', by: req.user.email });
  }).catch(err => {
    logger.error('Manual Xero submission failed', { id, error: xeroErrMsg(err), userId });
  });
  res.status(202).json({ success: true, status: 'submitting' });
}));

// ── POST /api/invoices/:id/report ─────────────────────────────────────────────
router.post('/:id/report', requireAuth, asyncHandler(async (req, res, next) => {
  try {
    const { note } = req.body;
    if (!note || !note.trim()) {
      return res.status(400).json({ error: 'Please describe the issue' });
    }
    const updated = await invoiceStore.forUser(req.user.id).addReport(req.params.id, {
      note:      note.trim(),
      userEmail: req.user.email,
      userId:    req.user.id,
    });
    if (!updated) return res.status(404).json({ error: 'Invoice not found' });
    logger.info('Invoice issue reported', { id: req.params.id, by: req.user.email });
    res.json({ success: true });
  } catch (err) { next(err); }
}));

// ── PATCH /api/invoices/:id/status ───────────────────────────────────────────
// Manual status transitions for the review workflow.
// posted and duplicate are locked — their status is authoritative and must not
// be downgraded through this endpoint. So is any row holding a Xero ID,
// whatever its status: it is in Xero.
router.patch('/:id/status', requireAuth, asyncHandler(async (req, res, next) => {
  try {
    const { status } = req.body;
    const allowed = ['pending', 'reviewed', 'reported', 'review-needed'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Allowed: ${allowed.join(', ')}` });
    }

    const inv = invoiceStore.forUser(req.user.id).getById(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    const LOCKED = new Set(['posted']);
    if (LOCKED.has(inv.status) || inv.xeroInvoiceId) {
      return res.status(409).json({ error: `Cannot change status of a "${inv.status}" invoice` });
    }
    if (inv.status === 'duplicate' && !req.body.force) {
      return res.status(409).json({ error: 'This invoice is marked as a duplicate. Confirm to keep it anyway.' });
    }

    const patch = { status };
    if (inv.status === 'duplicate' || req.body.force || req.body.clearDuplicate) {
      patch.duplicateOf = null;
      if (inv.errorMsg && /duplicate/i.test(inv.errorMsg)) {
        patch.errorMsg = null;
      }
    }

    const updated = await invoiceStore.forUser(req.user.id).update(req.params.id, patch);
    res.json({ success: true, invoice: updated });
  } catch (err) { next(err); }
}));

// ── POST /api/invoices/batch-status ──────────────────────────────────────────
// Batch update status for a list of invoice IDs (e.g. approving all verified claims in a batch).
router.post('/batch-status', requireAuth, asyncHandler(async (req, res, next) => {
  try {
    const { ids, status } = req.body;
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: 'ids array required' });
    }
    const allowed = ['pending', 'reviewed', 'reported', 'review-needed'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Allowed: ${allowed.join(', ')}` });
    }

    const store = invoiceStore.forUser(req.user.id);
    const LOCKED = new Set(['posted', 'duplicate']);
    let updatedCount = 0;
    for (const id of ids) {
      const inv = store.getById(id);
      if (inv && !LOCKED.has(inv.status) && !inv.xeroInvoiceId) {
        await store.update(id, { status });
        updatedCount++;
      }
    }
    res.json({ success: true, count: updatedCount });
  } catch (err) { next(err); }
}));

// ── Sending several, one at a time ───────────────────────────────────────────
// Xero allows an organisation 60 calls a minute, and one send is several calls
// (the contact, the invoice, its attachment). Everything sent from the list,
// Submit all and Send to Xero on a selection, goes through one queue per
// account, so two hundred rows go one after another rather than as a burst,
// and two bulk sends never run side by side. Each send is the ordinary one,
// submitInvoiceToXero: its duplicate check, its claim on the row, its choice
// of company and its retry of a 429 all apply.
//
// The queue is in memory. A restart forgets what was waiting, and those rows
// stay as they were (pending or reviewed), never half-sent: a row is only
// claimed when its own turn comes.
//
// Spacing: at least gapMs between the end of one send and the start of the
// next, as the automatic path has always done. On top of that, when Xero's
// last answer for that company said fewer than minuteHeadroom calls are left
// this minute, the next send waits until that minute has turned over, rather
// than walking into a 429 and waiting inside it.
const sendPacing = { gapMs: 1500, minuteHeadroom: 10 };
const _sendQueues = new Map(); // userId -> { tail, waiting: Set<id>, nextAt }

function _sendQueue(userId) {
  const key = String(userId);
  let q = _sendQueues.get(key);
  if (!q) {
    q = { tail: Promise.resolve(), waiting: new Set(), nextAt: 0 };
    _sendQueues.set(key, q);
  }
  return q;
}

// Disabled while its rows waited: nothing more is posted for the account. A
// failed lookup lets the send through, as invoice-handler's accountMayPost
// does: the store writes around it would fail the same way.
function _accountMayPost(userId) {
  try { return isActive(userId); } catch (_) { return true; }
}

// When the next send may start, after one that went to tenantId.
function _nextSendAt(tenantId, now = Date.now()) {
  let at = now + sendPacing.gapMs;
  const budget = tenantId ? getRateLimitBudget(tenantId) : null;
  if (budget && budget.minuteRemaining !== null && budget.minuteRemaining < sendPacing.minuteHeadroom) {
    const seen = Date.parse(budget.updatedAt);
    if (Number.isFinite(seen)) at = Math.max(at, seen + 60_000);
  }
  return at;
}

// Puts one row at the back of the account's queue. stillSendable is asked
// when its turn comes, and returns why it should no longer go (or null).
function queueSend(userId, id, stillSendable) {
  const q = _sendQueue(userId);
  q.waiting.add(id);
  q.tail = q.tail.then(async () => {
    const wait = q.nextAt - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    q.waiting.delete(id);
    if (!_accountMayPost(userId)) {
      logger.info('Account disabled while its sends waited — not sent', { id, userId });
      return;
    }
    const why = stillSendable();
    if (why) {
      logger.info('No longer sendable when its turn in the send queue came — skipped', { id, why, userId });
      return;
    }
    try {
      await submitInvoiceToXero(userId, id);
    } catch (err) {
      // submitInvoiceToXero has written the failure on the row already.
      logger.error('Queued Xero submission failed', { id, error: xeroErrMsg(err), userId });
    } finally {
      q.nextAt = _nextSendAt(invoiceStore.forUser(userId).getById(id)?.xeroTenantId);
    }
  }).catch(err => logger.error('Send queue step crashed', { id, error: err?.message || String(err), userId }));
  return q.tail;
}

// ── POST /api/invoices/submit-all ────────────────────────────────────────────
// Bulk-submit the pending invoices the person is looking at.
// Body { ids: string[] }, required and non-empty. Only ids that belong to this
// user and are still 'pending' are sent; the rest are counted as skipped.
// Responds { submitted, skipped }.
//
// This used to send every pending record of every kind (bills, invoices,
// claims) while the banner that offered it counted only the open tab, so one
// click posted documents nobody had looked at.
router.post('/submit-all', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const ids    = req.body?.ids;
  if (!Array.isArray(ids) || !ids.length || !ids.every(id => typeof id === 'string' && id)) {
    return res.status(400).json({ error: 'ids must be a non-empty list of invoice ids' });
  }

  const store   = invoiceStore.forUser(userId);
  const unique  = [...new Set(ids)];
  const pending = unique.filter(id => store.getById(id)?.status === 'pending');
  const skipped = unique.length - pending.length;

  // One after another through the account's send queue (queueSend, above),
  // the same one Send to Xero on a selection uses, so the two never post side
  // by side. Checked again per invoice when its turn comes: the gaps add up,
  // and the row may have been sent, edited or deleted meanwhile.
  // claimForSubmit would take a posted row (that is how a correction goes),
  // so only pending goes.
  const count = pending.length;
  for (const id of pending) {
    queueSend(userId, id, () => (store.getById(id)?.status === 'pending' ? null : 'no longer pending'));
  }

  logger.info('Bulk Xero submission started', { count, skipped, userId });
  res.json({ submitted: count, skipped });
}));

// ── Deleting ──────────────────────────────────────────────────────────────────
// A row with a Xero ID is the only record here that the bill is in Xero.
// Deleting it left the bill in Xero and nothing to recognise it by, so the
// next scan of the same email posted it again. It goes from Xero first. A row
// mid-send is about to get one. Null when the row may go; otherwise the single
// route's error and a bulk result's outcome.
function deleteRefusal(record) {
  if (record.xeroInvoiceId) {
    return { error: 'This was posted to Xero. Void or delete it in Xero first.', outcome: 'Kept: already in Xero', message: 'Void or delete it in Xero first.' };
  }
  if (record.status === 'submitting') {
    return { error: 'This is being sent to Xero right now. Try again in a moment.', outcome: 'Kept: being sent to Xero right now', message: 'Try again in a moment.' };
  }
  return null;
}

// Removes the row and the files that were only its. Called straight after
// deleteRefusal with no await between, so the row cannot start a send in the
// gap. The record is read BEFORE removing it: the receipt filename is the only
// way to find the image, and it goes with the row.
async function removeWithFiles(userId, store, record) {
  const removed = await store.remove(record.id);
  if (!removed) return false;

  pdfStore.forUser(userId).remove(record.id);

  // Expense claims carry a photograph, and this route knew nothing about it —
  // so every deleted receipt left its image on disk forever. Split siblings
  // SHARE one file, so it may only go once the last row using it has gone.
  if (record.receiptFile && store.countByReceiptFile(record.receiptFile) === 0) {
    receiptStore.forUser(userId).remove(record.receiptFile);
  }
  return true;
}

// ── DELETE /api/invoices/:id ──────────────────────────────────────────────────
router.delete('/:id', requireAuth, asyncHandler(async (req, res, next) => {
  try {
    const store  = invoiceStore.forUser(req.user.id);
    const record = store.getById(req.params.id);
    if (!record) return res.status(404).json({ error: 'Invoice not found' });
    const refusal = deleteRefusal(record);
    if (refusal) return res.status(409).json({ error: refusal.error });
    if (!(await removeWithFiles(req.user.id, store, record))) return res.status(404).json({ error: 'Invoice not found' });

    logger.info('Invoice deleted', { id: req.params.id, by: req.user.email });
    res.json({ success: true });
  } catch (err) { next(err); }
}));

// ── Actions on a selection ───────────────────────────────────────────────────
// POST /api/invoices/bulk/review   { ids }   Mark reviewed
// POST /api/invoices/bulk/send     { ids }   Send to Xero
// POST /api/invoices/bulk/delete   { ids }   Delete
//
// One request per action, at most BULK_MAX ids (400 above that, or for a list
// that is not one). Each id is settled on its own and answered in the order
// asked, once per id:
//   { action, results: [{ id, ok, skipped, outcome, message }], summary: { done, skipped, failed } }
// ok      the row is where the action meant it to be: done now, or already so
//         (skipped: true, nothing changed). The page counts these.
// !ok     not done, and something needs a person (review it, wait, void it in
//         Xero). The page lists these by row and keeps them selected.
// outcome what happened, in a bookkeeper's words; message the detail or what
//         to do next ('' when there is nothing to add).
//
// The single-record routes answered a selection one request per row; a
// refusal there hid which rows had gone, and two hundred requests at once is
// its own burst. These apply the same rules as those routes, row by row.
const BULK_MAX = 200;

function _bulkIds(body) {
  const ids = body?.ids;
  if (!Array.isArray(ids) || !ids.length || !ids.every(id => typeof id === 'string' && id)) {
    return { error: 'ids must be a non-empty list of record ids' };
  }
  if (ids.length > BULK_MAX) {
    return { error: `At most ${BULK_MAX} records at a time; this asked for ${ids.length}. Select fewer and try again.` };
  }
  return { ids: [...new Set(ids)] };
}

const _done    = (id, outcome, message = '') => ({ id, ok: true,  skipped: false, outcome, message });
const _skipped = (id, outcome, message = '') => ({ id, ok: true,  skipped: true,  outcome, message });
const _failed  = (id, outcome, message = '') => ({ id, ok: false, skipped: false, outcome, message });
const _notFound = id => _failed(id, 'Not found', 'It may have been deleted already.');

// Lets other requests run between two rows. The duplicate check reads every
// record already in Xero, and better-sqlite3 is synchronous: on an account
// with 3,000 of them, 200 checks back to back held this one process, and
// every other user's request, for about seven seconds. Awaited at the top of
// each row, so that row's checks and its write still happen together, with
// nothing able to change the row in between.
const _breathe = () => new Promise(resolve => setImmediate(resolve));

function _bulkReply(res, action, results, userId) {
  const summary = {
    done:    results.filter(r => r.ok && !r.skipped).length,
    skipped: results.filter(r => r.ok && r.skipped).length,
    failed:  results.filter(r => !r.ok).length,
  };
  logger.info('Bulk action on a selection', { action, userId, ...summary });
  res.json({ action, results, summary });
}

// Mark reviewed: what PATCH /:id/status allows, one row at a time, with two
// more refusals. A row with no amount cannot be posted, so calling it ready
// to post would be wrong. And a bill whose bank details differ from the
// supplier's last one is held so a person reads that warning; ticking it in a
// list of fifty is not reading it, and reviewed is one click from Xero.
function _reviewCheck(store, inv, id) {
  if (!inv) return _notFound(id);
  if (inv.status === 'reviewed') return _skipped(id, 'Already reviewed');
  if (inv.xeroInvoiceId || inv.status === 'posted') return _skipped(id, 'Already in Xero');
  if (inv.status === 'submitting') return _skipped(id, 'Being sent to Xero right now');
  if (inv.status === 'duplicate') {
    return _failed(id, 'Marked as a duplicate', 'Open it and confirm it is a different bill, then mark it reviewed.');
  }
  if (!inv.totalAmount) return _failed(id, 'Needs review first', 'No amount was read. Open it and fill in the figures.');
  const bank = bankDetailsChange(store, inv);
  if (bank) return _failed(id, 'Needs review first', bank);
  return null;
}

router.post('/bulk/review', requireAuth, asyncHandler(async (req, res) => {
  const { ids, error } = _bulkIds(req.body);
  if (error) return res.status(400).json({ error });
  const store   = invoiceStore.forUser(req.user.id);
  const results = [];
  for (const id of ids) {
    await _breathe();
    const refused = _reviewCheck(store, store.getById(id), id);
    if (refused) { results.push(refused); continue; }
    // No await between the checks above and this write, so the row cannot
    // have started a send in between.
    await store.update(id, { status: 'reviewed' });
    results.push(_done(id, 'Marked reviewed'));
  }
  _bulkReply(res, 'review', results, req.user.id);
}));

// Send to Xero: the Submit button's checks (submitRefusal), and two that are
// only for a selection. A row held for review goes to Xero only after a
// person has opened it: it is held for a reason (no number read, changed bank
// details, an interrupted send), and the reason is the message. A row already
// in Xero is not sent again: from a list that would overwrite each Xero draft
// with whatever is stored here, edits made in Xero included, so a correction
// is sent from its own page. No force either: sending a likely duplicate is a
// decision about one bill at a time.
function _sendCheck(store, inv, id, { queued = false, atTurn = false } = {}) {
  if (!inv) return _notFound(id);
  if (queued) return _skipped(id, 'Already queued for Xero');
  if (inv.status === 'submitting') return _skipped(id, 'Already being sent to Xero');
  if (inv.xeroInvoiceId || inv.status === 'posted') {
    const locked = statusSync.repostRefusal(inv);
    return locked
      ? _skipped(id, locked, 'Nothing was sent. If that has changed, refresh from Xero first.')
      : _skipped(id, 'Already in Xero', 'Not sent again. To send a correction, open it and re-post it.');
  }
  if (inv.status === 'review-needed') {
    return _failed(id, 'Needs review first', inv.errorMsg || 'Open it, check the figures and mark it reviewed.');
  }
  // At its turn in the queue the duplicate check is left to
  // submitInvoiceToXero, which marks the row a duplicate where a person will
  // see it (two copies of one bill in the same selection meet there), rather
  // than skipping it here without a word on the row.
  const refusal = submitRefusal(store, inv, { force: atTurn });
  if (refusal) return refusal.skipped ? _skipped(id, refusal.outcome, refusal.message) : _failed(id, refusal.outcome, refusal.message);
  return null;
}

router.post('/bulk/send', requireAuth, asyncHandler(async (req, res) => {
  const { ids, error } = _bulkIds(req.body);
  if (error) return res.status(400).json({ error });
  const userId  = req.user.id;
  const store   = invoiceStore.forUser(userId);
  const waiting = _sendQueue(userId).waiting;
  const results = [];
  for (const id of ids) {
    await _breathe();
    const refused = _sendCheck(store, store.getById(id), id, { queued: waiting.has(id) });
    if (refused) { results.push(refused); continue; }
    // Asked again when its turn comes: by then it may have been edited back
    // to review, sent from its own page, approved in Xero or deleted.
    queueSend(userId, id, () => _sendCheck(store, store.getById(id), id, { atTurn: true })?.outcome || null);
    results.push(_done(id, 'Queued for Xero', 'Sent one at a time; the list updates as each one lands.'));
  }
  _bulkReply(res, 'send', results, userId);
}));

// Delete: the single delete's rules, row by row. A row already gone counts as
// done, since gone is what was asked for.
router.post('/bulk/delete', requireAuth, asyncHandler(async (req, res) => {
  const { ids, error } = _bulkIds(req.body);
  if (error) return res.status(400).json({ error });
  const userId  = req.user.id;
  const store   = invoiceStore.forUser(userId);
  const results = [];
  for (const id of ids) {
    const record = store.getById(id);
    if (!record) { results.push(_skipped(id, 'Already deleted')); continue; }
    const refusal = deleteRefusal(record);
    if (refusal) { results.push(_failed(id, refusal.outcome, refusal.message)); continue; }
    const removed = await removeWithFiles(userId, store, record);
    results.push(removed ? _done(id, 'Deleted') : _skipped(id, 'Already deleted'));
  }
  _bulkReply(res, 'delete', results, userId);
}));

// ── DELETE /api/invoices ──────────────────────────────────────────────────────
// "Clear all". Removes every record that exists only here; keeps every one
// with a Xero ID (and any mid-send), for the reason the single delete refuses
// them. Responds { success, removed, kept, message }.
router.delete('/', requireAuth, asyncHandler(async (req, res, next) => {
  try {
    const userId = req.user.id;
    emailWorker.stopWorker(userId);
    emailQueue.clearAll(userId);
    const store = invoiceStore.forUser(userId);
    const { removed, kept } = await store.clear();
    if (!kept) {
      // Nothing left: sweep the folders whole, which also takes any file an
      // earlier failure orphaned.
      pdfStore.forUser(userId).clearAll();
      receiptStore.forUser(userId).clearAll();   // receipts were left behind here too
    } else {
      // The kept rows' PDFs and receipts must stay with them, so only the
      // removed rows' files go. Split siblings share one receipt file; it goes
      // once nothing kept still points at it.
      const pdfs = pdfStore.forUser(userId);
      for (const r of removed) pdfs.remove(r.id);
      for (const file of new Set(removed.map(r => r.receiptFile).filter(Boolean))) {
        if (store.countByReceiptFile(file) === 0) receiptStore.forUser(userId).remove(file);
      }
    }
    const message = kept
      ? `Cleared ${removed.length}. Kept ${kept} that ${kept === 1 ? 'is' : 'are'} in Xero or being sent to it.`
      : `Cleared ${removed.length}.`;
    logger.info('Invoice cache cleared (invoices + files + email queue)', { removed: removed.length, kept, by: req.user.email });
    res.json({ success: true, removed: removed.length, kept, message });
  } catch (err) { next(err); }
}));

// Exposed so the chat assistant validates proposed edits against the exact same
// whitelist this route enforces — one source of truth, no risk of drift.
router.EDITABLE_FIELDS = EDITABLE_FIELDS;

// For tests: the spacing between queued sends (a real gap makes a suite of
// them take minutes), and a promise that settles once everything queued for
// an account so far has been sent or skipped.
router.sendPacing    = sendPacing;
router.whenSendsIdle = userId => _sendQueue(userId).tail;

module.exports = router;
