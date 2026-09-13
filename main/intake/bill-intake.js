// A bill that did not arrive by email: uploaded as a PDF, or several in a zip.
//
// The emailed-bill path already does everything needed — extract the text, ask
// the model, dedup, store the PDF, build the row — so an upload is presented to
// it as an email with one attachment and no body. Nothing about parsing is new
// here; what this module adds is the two ways the file arrives and the profile
// rule that an uploaded bill waits for a person and never auto-posts.
const { parseInvoice }   = require('../email/parser');
const { createHandler }  = require('../utils/invoice-handler');
const { readArchive }    = require('../claims/claim-archive');
const jobs               = require('../jobs');
const logger             = require('../utils/logger');

// Xero rejects attachments above 3MB; the receipt store enforces the same.
const MAX_PDF_BYTES = 3 * 1024 * 1024;

function looksLikePdf(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 4 && buffer.subarray(0, 4).toString('latin1') === '%PDF';
}

// One PDF → zero or more stored rows (a PDF can hold several bills, exactly as
// an email can). Returns what happened to each, never throws for a bad file.
async function intakeBillPdf(userId, { name, buffer }, handler = createHandler(userId)) {
  if (!looksLikePdf(buffer)) return { name, outcome: 'rejected', error: 'Not a PDF' };
  if (buffer.length > MAX_PDF_BYTES) {
    return { name, outcome: 'rejected', error: `${(buffer.length / 1048576).toFixed(1)}MB is over the 3MB Xero accepts for an attachment` };
  }

  const asEmail = {
    subject: name,
    date: new Date(),
    from: { text: '', value: [] },
    text: '',
    attachments: [{ filename: name, contentType: 'application/pdf', content: buffer }],
  };

  let parsed;
  try {
    parsed = await parseInvoice(asEmail, userId);
  } catch (err) {
    logger.warn('Uploaded bill could not be parsed', { userId, name, error: err.message });
    return { name, outcome: 'failed', error: err.message };
  }
  if (!parsed || !parsed.length) return { name, outcome: 'rejected', error: 'No invoice could be read from this PDF' };

  const records = [];
  for (const invoice of parsed) {
    // The parser types anything with a PDF as a bill already; what changes is
    // where it came from, which is what decides its status and whether it may
    // reach Xero on its own (intake/profiles.js: 'upload' never auto-posts).
    invoice.source = 'upload';
    invoice.invoiceType = 'ACCPAY';
    const result = await handler.onInvoiceEmail(invoice);
    records.push({
      id: result?.id || null,
      status: result?.status || null,
      duplicate: !!result?.duplicate,
      vendorName: invoice.vendorName, invoiceNumber: invoice.invoiceNumber, totalAmount: invoice.totalAmount,
    });
  }
  return { name, outcome: 'stored', records };
}

// ── Bill import as a background job ─────────────────────────────────────────
// A zip of thirty bills at a model call each is minutes of work, past any HTTP
// timeout — the same reason claim import runs as a job, on the same runner.
// Progress reuses the runner's existing counters: receiptsTotal is files to
// read, receiptsRead is files done, rowsTotal is rows created.
async function runBillImport({ userId, job, payload, deps }) {
  const handler = deps.handler || createHandler(userId);
  const files = [];
  for (const f of payload.pdfs || []) files.push({ name: f.name, buffer: f.buffer });
  for (const a of payload.archives || []) {
    const { entries, error } = await readArchive(a.buffer);
    if (error) { deps.onUpdate?.({ id: job.id, error: `${a.name}: ${error}` }); continue; }
    for (const e of entries) if (e.mime === 'application/pdf') files.push({ name: e.name, buffer: e.buffer });
  }

  const result = { created: [], duplicates: [], rejected: [], failed: [] };
  let done = 0;
  deps.onUpdate?.({ id: job.id, stage: 'reading receipts', receiptsTotal: files.length, receiptsRead: 0, rowsTotal: 0 });
  try {
    for (const file of files) {
      const r = await intakeBillPdf(userId, file, handler);
      if (r.outcome === 'stored') {
        for (const rec of r.records) (rec.duplicate ? result.duplicates : result.created).push({ file: file.name, ...rec });
      } else {
        result[r.outcome === 'rejected' ? 'rejected' : 'failed'].push({ file: file.name, error: r.error });
      }
      done += 1;
      deps.onUpdate?.({ id: job.id, receiptsRead: done, rowsTotal: result.created.length });
    }
    deps.onSettle({ id: job.id, stage: 'done', error: null, result, receiptsTotal: files.length, receiptsRead: done, rowsTotal: result.created.length });
  } catch (err) {
    logger.error('Bill import failed', { userId, jobId: job.id, error: err.message });
    deps.onSettle({ id: job.id, stage: 'failed', error: err.message, result, receiptsTotal: files.length, receiptsRead: done, rowsTotal: result.created.length });
  }
}

jobs.registerJobType('bill-import', { run: runBillImport, defaultDeps: () => ({}) });

module.exports = { intakeBillPdf, runBillImport, looksLikePdf, MAX_PDF_BYTES };
