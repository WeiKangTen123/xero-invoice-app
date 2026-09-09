const express      = require('express');
const router       = express.Router();
const { requireAuth } = require('../middleware/auth-middleware');
const invoiceStore = require('../utils/invoice-store');
const receiptStore = require('../utils/receipt-store');
const claimImport  = require('../claims/claim-import');
const { parseReceiptImage } = require('../utils/receipt-parser');
const { suggestCategories } = require('../claims/claim-categories');
const logger       = require('../utils/logger');

// Importing a batch expense claim: a zip of receipts plus the claim form.
//
// Every route here is a READ of the user's own upload plus writes to the LOCAL
// store. Nothing reaches Xero.

// Uploads arrive as base64 JSON, same as single receipts — express.json is
// already mounted at 10mb and this needs no new dependency. A claim archive is
// larger than one receipt, so the cap is checked explicitly.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function decodeBase64(data) {
  if (typeof data !== 'string' || !data) return null;
  const raw = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw.replace(/\s/g, ''))) return null;
  const buf = Buffer.from(raw, 'base64');
  return buf.length ? buf : null;
}

// Turns one matched claim line into a local record. Injected into the job so the
// job itself stays testable without a database.
async function createClaimRecord({ userId, groupId, row, receipt, match, category, categorySuggested, store }) {
  const id = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
  let storedName = null;
  let mime = null;

  if (receipt && receipt.buffer) {
    try {
      mime = receipt.mime;
      storedName = await store(userId, id, receipt.buffer, receipt.mime);
    } catch (err) {
      // A receipt that will not store is not a reason to lose the claim line.
      logger.warn('Claim receipt could not be stored', { userId, id, error: err.message });
    }
  }

  return invoiceStore.forUser(userId).add({
    id,
    status: 'review-needed',
    invoiceType: 'EXPENSE',
    source: 'claim',
    // The claimant's own figures are what is recorded. The receipt read is
    // evidence, and a disagreement is reported rather than silently preferred.
    vendorName:  (receipt && receipt.merchant) || null,
    invoiceDate: row.date || null,
    currency:    row.currency || (receipt && receipt.currency) || null,
    totalAmount: row.amount ?? null,
    description: [row.description, category ? `[${category}]` : null].filter(Boolean).join(' ').slice(0, 200) || null,
    receiptFile: storedName,
    receiptMime: mime,
    receiptGroup: groupId,
    processedAt: new Date().toISOString(),
    receivedAt:  new Date().toISOString(),
    // A discrepancy is recorded on the row so it survives the job expiring.
    errorMsg: match && match.discrepancy
      ? `Claimed ${match.discrepancy.claimed} but the receipt says ${match.discrepancy.onReceipt}`
      : (receipt ? null : 'No receipt found for this claim line'),
  });
}

// POST /api/claims/import  { archives: [{name,data}], forms: [{name,data}], label }
router.post('/import', requireAuth, async (req, res) => {
  try {
    const { archives = [], forms = [], label } = req.body || {};
    if (!Array.isArray(archives) || !Array.isArray(forms) || (!archives.length && !forms.length)) {
      return res.status(400).json({ error: 'Attach at least a claim archive or a claim form' });
    }

    const decode = list => {
      const out = [];
      for (const f of list) {
        const buffer = decodeBase64(f && f.data);
        if (!buffer) return { error: `${(f && f.name) || 'a file'} could not be read` };
        out.push({ name: f.name || 'file', buffer });
      }
      return { out };
    };

    const a = decode(archives); if (a.error) return res.status(400).json({ error: a.error });
    const f = decode(forms);    if (f.error) return res.status(400).json({ error: f.error });

    const bytes = [...a.out, ...f.out].reduce((s, x) => s + x.buffer.length, 0);
    if (bytes > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: `That is ${(bytes / 1048576).toFixed(1)}MB; the limit is ${MAX_UPLOAD_BYTES / 1048576}MB.` });
    }

    const job = claimImport.startImport(
      { userId: req.user.id, archives: a.out, forms: f.out, label: label || 'Expense claim' },
      {
        parseReceipt: parseReceiptImage,
        storeReceipt: (userId, id, buffer, mime) => receiptStore.forUser(userId).save(id, buffer, mime),
        createRecord: createClaimRecord,
        suggest: (userId, matches, categories) => suggestCategories(userId, matches, categories),
      },
    );

    logger.info('Claim import started', { userId: req.user.id, jobId: job.id, archives: a.out.length, forms: f.out.length });
    // 202: accepted and running. The client polls; closing the tab is fine.
    res.status(202).json({ jobId: job.id, stage: job.stage });
  } catch (err) {
    logger.error('Claim import could not start', { userId: req.user.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/claims/import/:jobId — progress, then the reconciliation
router.get('/import/:jobId', requireAuth, (req, res) => {
  const job = claimImport.getJob(req.params.jobId, req.user.id);
  if (!job) return res.status(404).json({ error: 'Import not found — it may have expired' });
  res.json({
    id: job.id, label: job.label, stage: job.stage,
    receiptsTotal: job.receiptsTotal, receiptsRead: job.receiptsRead, rowsTotal: job.rowsTotal,
    error: job.error, result: job.result,
    startedAt: new Date(job.startedAt).toISOString(),
  });
});

// DELETE /api/claims/import/:jobId — stop a run in progress
router.delete('/import/:jobId', requireAuth, (req, res) => {
  const job = claimImport.cancel(req.params.jobId, req.user.id);
  if (!job) return res.status(404).json({ error: 'Import not found' });
  res.json({ stage: job.stage });
});

// DELETE /api/claims/group/:groupId — undo a whole import.
// An import that went wrong should not need twenty-seven deletions.
router.delete('/group/:groupId', requireAuth, (req, res) => {
  const store = invoiceStore.forUser(req.user.id);
  const members = store.getReceiptGroup(req.params.groupId);
  if (!members.length) return res.status(404).json({ error: 'Nothing found for that import' });

  let files = 0;
  for (const rec of members) {
    store.remove(rec.id);
    // Siblings can share a file; it goes only when nothing references it.
    if (rec.receiptFile && store.countByReceiptFile(rec.receiptFile) === 0) {
      if (receiptStore.forUser(req.user.id).remove(rec.receiptFile)) files++;
    }
  }
  logger.info('Claim import undone', { userId: req.user.id, groupId: req.params.groupId, removed: members.length, files });
  res.json({ removed: members.length });
});

module.exports = router;
module.exports._createClaimRecord = createClaimRecord;
