const express      = require('express');
const router       = express.Router();
const jwt          = require('jsonwebtoken');
const { requireAuth, jwtSecret } = require('../middleware/auth-middleware');
const asyncHandler = require('../middleware/async-handler');
const invoiceStore = require('../utils/invoice-store');
const pdfStore     = require('../utils/pdf-store');
const receiptStore = require('../utils/receipt-store');
const emailQueue   = require('../queue/email-queue');
const emailWorker  = require('../queue/email-worker');
const { submitInvoiceToXero } = require('../utils/invoice-handler');
const { xeroErrMsg }  = require('../xero/xero-utils');
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

function _decodeBase64(data) {
  if (typeof data !== 'string' || !data) return null;
  const raw = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw.replace(/\s/g, ''))) return null;
  const buf = Buffer.from(raw, 'base64');
  return buf.length ? buf : null;
}

// POST /api/invoices  { name, data (base64 PDF) }
// One uploaded bill. Stored as review-needed; never sent to Xero on its own.
router.post('/', requireAuth, async (req, res) => {
  const { name, data } = req.body || {};
  const buffer = _decodeBase64(data);
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
});

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
      const buffer = _decodeBase64(f && f.data);
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

router.get('/', requireAuth, (req, res) => {
  const invoices = invoiceStore.forUser(req.user.id).getAll().map(inv => ({
    id:            inv.id,
    status:        inv.status,
    hasPdf:        inv.hasPdf,
    pdfFilename:   inv.pdfFilename,
    vendorName:    inv.vendorName,
    invoiceNumber: inv.invoiceNumber,
    invoiceDate:   inv.invoiceDate,
    dueDate:       inv.dueDate,
    totalAmount:   inv.totalAmount,
    currency:      inv.currency,
    invoiceType:   inv.invoiceType,
    source:        inv.source,
    sourceEmail:   inv.sourceEmail,
    processedAt:   inv.processedAt,
    submittedAt:   inv.submittedAt,
    xeroInvoiceId: inv.xeroInvoiceId,
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
  }));
  res.json({ invoices });
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
  } else {
    const bearerToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!bearerToken) return res.status(401).json({ error: 'Authentication required' });
    try {
      const payload = jwt.verify(bearerToken, jwtSecret());
      userId = payload.id;
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
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
router.patch('/:id', requireAuth, async (req, res, next) => {
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
});

// ── POST /api/invoices/:id/submit ─────────────────────────────────────────────
// Manually submit (or re-submit) an invoice to Xero.
// Safe to call multiple times — already-posted invoices return early without
// creating a duplicate in Xero.
router.post('/:id/submit', requireAuth, async (req, res) => {
  const { id } = req.params;
  const userId  = req.user.id;

  const inv = invoiceStore.forUser(userId).getById(id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });

  if (!SUBMITTABLE_STATUSES.has(inv.status)) {
    return res.status(409).json({
      error:  `Invoice with status "${inv.status}" cannot be submitted`,
      status: inv.status,
    });
  }

  if (!inv.totalAmount || inv.totalAmount === 0) {
    return res.status(422).json({
      error: 'Invoice has no amount — edit the invoice fields before submitting',
    });
  }

  // Fire submission in background — return 202 immediately so the UI doesn't hang.
  // claimForSubmit inside submitInvoiceToXero atomically sets status → 'submitting'
  // and prevents double-posting if the same invoice is in flight elsewhere.
  submitInvoiceToXero(userId, id).then(xeroInvoiceId => {
    logger.info('Manual Xero submission completed', { id, xeroInvoiceId: xeroInvoiceId || 'queued', by: req.user.email });
  }).catch(err => {
    const errMsg = xeroErrMsg(err);
    logger.error('Manual Xero submission failed', { id, error: errMsg, userId });
    invoiceStore.forUser(userId).update(id, { status: 'error', errorMsg: errMsg });
  });
  res.status(202).json({ success: true, status: 'submitting' });
});

// ── POST /api/invoices/:id/report ─────────────────────────────────────────────
router.post('/:id/report', requireAuth, async (req, res, next) => {
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
});

// ── PATCH /api/invoices/:id/status ───────────────────────────────────────────
// Manual status transitions for the review workflow.
// posted and duplicate are locked — their status is authoritative and must not
// be downgraded through this endpoint.
router.patch('/:id/status', requireAuth, async (req, res, next) => {
  try {
    const { status } = req.body;
    const allowed = ['pending', 'reviewed', 'reported', 'review-needed'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Allowed: ${allowed.join(', ')}` });
    }

    const inv = invoiceStore.forUser(req.user.id).getById(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    const LOCKED = new Set(['posted']);
    if (LOCKED.has(inv.status)) {
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
});

// ── POST /api/invoices/batch-status ──────────────────────────────────────────
// Batch update status for a list of invoice IDs (e.g. approving all verified claims in a batch).
router.post('/batch-status', requireAuth, async (req, res, next) => {
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
      if (inv && !LOCKED.has(inv.status)) {
        await store.update(id, { status });
        updatedCount++;
      }
    }
    res.json({ success: true, count: updatedCount });
  } catch (err) { next(err); }
});

// ── POST /api/invoices/submit-all ────────────────────────────────────────────
// Bulk-submit all pending invoices that were never sent to Xero.
// Useful after a server restart that killed the in-memory submission chain.
router.post('/submit-all', requireAuth, asyncHandler(async (req, res) => {
  const userId  = req.user.id;
  const store   = invoiceStore.forUser(userId);
  const pending = store.getAll().filter(i => i.status === 'pending');

  if (!pending.length) return res.json({ submitted: 0, message: 'No pending invoices' });

  // Sequential with 1.5s gap — Xero allows 60 calls/minute; parallel floods cause 429.
  const count = pending.length;
  (async () => {
    for (const inv of pending) {
      try {
        await submitInvoiceToXero(userId, inv.id);
      } catch (err) {
        logger.error('Bulk submit failed for invoice', { id: inv.id, error: xeroErrMsg(err), userId });
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    logger.info('Bulk Xero submission complete', { count, userId });
  })().catch(err => logger.error('Bulk submit IIFE crashed', { error: err.message, userId }));

  logger.info('Bulk Xero submission started', { count, userId });
  res.json({ submitted: count, message: `Submitting ${count} invoice(s) to Xero` });
}));

// ── DELETE /api/invoices/:id ──────────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const store = invoiceStore.forUser(req.user.id);
    // Read the record BEFORE removing it — the receipt filename is the only way
    // to find the image, and it goes with the row.
    const record  = store.getById(req.params.id);
    const removed = await store.remove(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Invoice not found' });

    pdfStore.forUser(req.user.id).remove(req.params.id);

    // Expense claims carry a photograph, and this route knew nothing about it —
    // so every deleted receipt left its image on disk forever. Split siblings
    // SHARE one file, so it may only go once the last row using it has gone.
    if (record?.receiptFile && store.countByReceiptFile(record.receiptFile) === 0) {
      receiptStore.forUser(req.user.id).remove(record.receiptFile);
    }

    logger.info('Invoice deleted', { id: req.params.id, by: req.user.email });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── DELETE /api/invoices ──────────────────────────────────────────────────────
router.delete('/', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    emailWorker.stopWorker(userId);
    emailQueue.clearAll(userId);
    await invoiceStore.forUser(userId).clear();
    pdfStore.forUser(userId).clearAll();
    receiptStore.forUser(userId).clearAll();   // receipts were left behind here too
    logger.info('Invoice cache cleared (invoices + PDFs + receipts + email queue)', { by: req.user.email });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Exposed so the chat assistant validates proposed edits against the exact same
// whitelist this route enforces — one source of truth, no risk of drift.
router.EDITABLE_FIELDS = EDITABLE_FIELDS;

module.exports = router;
