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
const { submitInvoiceToXero, postedDuplicateOf } = require('../utils/invoice-handler');
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

  const force = req.body?.force === true;
  const dup   = force ? null : postedDuplicateOf(invoiceStore.forUser(userId), inv);
  if (dup) {
    const label = [dup.vendorName, dup.invoiceNumber].filter(Boolean).join(' ') || 'a bill';
    return res.status(409).json({
      error: `This matches ${label}, which is already in Xero. Send it anyway only if it is a different bill.`,
      duplicateOf: dup.id,
    });
  }

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

  // Sequential with 1.5s gap — Xero allows 60 calls/minute; parallel floods cause 429.
  const count = pending.length;
  if (count) {
    (async () => {
      for (const id of pending) {
        // Checked again per invoice: the gaps add up, and the row may have
        // been sent, edited or deleted meanwhile. claimForSubmit would take a
        // posted row (that is how a correction goes), so only pending goes.
        if (store.getById(id)?.status !== 'pending') continue;
        try {
          await submitInvoiceToXero(userId, id);
        } catch (err) {
          logger.error('Bulk submit failed for invoice', { id, error: xeroErrMsg(err), userId });
        }
        await new Promise(r => setTimeout(r, 1500));
      }
      logger.info('Bulk Xero submission complete', { count, userId });
    })().catch(err => logger.error('Bulk submit IIFE crashed', { error: err.message, userId }));
  }

  logger.info('Bulk Xero submission started', { count, skipped, userId });
  res.json({ submitted: count, skipped });
}));

// ── DELETE /api/invoices/:id ──────────────────────────────────────────────────
// A row with a Xero ID is the only record here that the bill is in Xero.
// Deleting it left the bill in Xero and nothing to recognise it by, so the
// next scan of the same email posted it again. It goes from Xero first.
router.delete('/:id', requireAuth, asyncHandler(async (req, res, next) => {
  try {
    const store = invoiceStore.forUser(req.user.id);
    // Read the record BEFORE removing it — the receipt filename is the only way
    // to find the image, and it goes with the row.
    const record  = store.getById(req.params.id);
    if (record?.xeroInvoiceId) {
      return res.status(409).json({ error: 'This was posted to Xero. Void or delete it in Xero first.' });
    }
    if (record?.status === 'submitting') {
      return res.status(409).json({ error: 'This is being sent to Xero right now. Try again in a moment.' });
    }
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

module.exports = router;
