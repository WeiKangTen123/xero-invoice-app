const express      = require('express');
const router       = express.Router();
const jwt          = require('jsonwebtoken');
const { requireAuth, jwtSecret } = require('../middleware/auth-middleware');
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
  'paymentReference',
]);

// 'posted' is included so a correction can be edited and re-posted — re-posting an
// already-posted invoice updates the existing Xero bill in place (see
// queue/processor.js submitDraftInvoice) rather than creating a duplicate.
const EDITABLE_STATUSES    = new Set(['pending', 'review-needed', 'error', 'reviewed', 'posted']);
const SUBMITTABLE_STATUSES = new Set(['pending', 'review-needed', 'error', 'reviewed', 'posted']);

// ── GET /api/invoices ─────────────────────────────────────────────────────────
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
        if (!['ACCPAY', 'ACCREC'].includes(v)) {
          return res.status(400).json({ error: '"invoiceType" must be "ACCPAY" or "ACCREC"' });
        }
        patch[k] = v;
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

    const LOCKED = new Set(['posted', 'duplicate']);
    if (LOCKED.has(inv.status)) {
      return res.status(409).json({ error: `Cannot change status of a "${inv.status}" invoice` });
    }

    const updated = await invoiceStore.forUser(req.user.id).update(req.params.id, { status });
    res.json({ success: true, invoice: updated });
  } catch (err) { next(err); }
});

// ── POST /api/invoices/submit-all ────────────────────────────────────────────
// Bulk-submit all pending invoices that were never sent to Xero.
// Useful after a server restart that killed the in-memory submission chain.
router.post('/submit-all', requireAuth, async (req, res) => {
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
});

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
