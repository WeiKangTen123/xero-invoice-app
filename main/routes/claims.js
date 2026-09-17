const express      = require('express');
const router       = express.Router();
const { decodeBase64 } = require('../utils/base64');
const { requireAuth } = require('../middleware/auth-middleware');
const invoiceStore = require('../utils/invoice-store');
const receiptStore = require('../utils/receipt-store');
const claimImport  = require('../claims/claim-import');
const claimQueue   = require('../claims/claim-queue');
const claimWorker  = require('../claims/claim-worker');
const { parseReceiptBatch } = require('../utils/receipt-parser');
const { suggestCategories } = require('../claims/claim-categories');
const logger       = require('../utils/logger');

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
const { createClaimRecord } = require('../claims/claim-record');

// POST /api/claims/import  { archives: [{name,data}], forms: [{name,data}], label }
router.post('/import', requireAuth, async (req, res) => {
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
});

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
