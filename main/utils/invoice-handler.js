const { enqueueInvoice }  = require('../queue/processor');
const { reconnectXero }   = require('../xero/reconnect');
const { xeroErrMsg }      = require('../xero/xero-utils');
const { notifyError }     = require('./notify');
const logger              = require('./logger');
const invoiceStore        = require('./invoice-store');
const pdfStore            = require('./pdf-store');
const settingsStore       = require('./settings-store');
const tokenCache          = require('./token-cache');
const processState        = require('./process-state');

const XERO_SUBMIT_DELAY_MS = 1500;

// Each user gets their own handler with a scoped Xero submission queue.
// One _xeroChain per user ensures sequential submission with a 1.5 s gap
// — staying well inside Xero's 60 calls/minute API limit.
function createHandler(userId) {
  const invStore      = invoiceStore.forUser(userId);
  const pdfStoreUser  = pdfStore.forUser(userId);
  const settingsUser  = settingsStore.forUser(userId);
  const procState     = processState.forUser(userId);

  let _xeroChain = Promise.resolve();

  function scheduleXeroSubmit(invoiceData, id) {
    _xeroChain = _xeroChain.then(async () => {
      await new Promise(r => setTimeout(r, XERO_SUBMIT_DELAY_MS));

      // Re-check for duplicates just before submitting — a concurrent scan may
      // have already posted this invoice while it was waiting in the queue.
      const dup = invStore.findPosted(
        invoiceData.vendorName || invoiceData.contactName,
        invoiceData.invoiceNumber,
        invoiceData.invoiceDate,
        invoiceData.totalAmount
      );
      if (dup) {
        logger.info('Duplicate detected before Xero submit — skipping', {
          id, duplicateOf: dup.id, xeroInvoiceId: dup.xeroInvoiceId, userId,
        });
        await invStore.update(id, { status: 'duplicate', duplicateOf: dup.id, xeroInvoiceId: dup.xeroInvoiceId });
        return;
      }

      try {
        const cache   = tokenCache.forUser(userId);
        const tenants = await cache.getAllTenants();
        if (!tenants.length) {
          logger.info('No cached Xero tenants — reconnecting', { userId });
          await reconnectXero(userId);
        }
        const xeroInvoiceId = await enqueueInvoice(userId, { ...invoiceData, _invoiceStoreId: id });
        if (xeroInvoiceId) {
          await invStore.update(id, { status: 'posted', xeroInvoiceId });
          logger.info('Invoice marked as posted', { id, xeroInvoiceId, userId });
        }
      } catch (err) {
        const errMsg = xeroErrMsg(err);
        logger.error('Failed to submit invoice to Xero', { id, error: errMsg, userId });
        await invStore.update(id, { status: 'error', errorMsg: errMsg });
        try {
          await notifyError({ context: 'Xero submit failed', error: errMsg, email: invoiceData.sourceEmail });
        } catch (_) {}
      }
    }).catch(err => {
      logger.error('Unexpected error in Xero submission chain', { error: err?.message || String(err), userId });
    });
  }

  async function onInvoiceEmail(invoiceData) {
    // Upfront dedup: skip if any non-error/duplicate record already exists for this invoice.
    // Catches re-scans after a server restart — emails are re-seen via IMAP but the invoice
    // was already stored as pending/posted/review-needed on the previous run.
    const existing = invStore.findStored(
      invoiceData.vendorName || invoiceData.contactName,
      invoiceData.invoiceNumber,
      invoiceData.invoiceDate,
      invoiceData.totalAmount
    );
    if (existing) {
      logger.info('Invoice already stored — skipping duplicate', {
        vendor:        invoiceData.vendorName,
        invoiceNumber: invoiceData.invoiceNumber,
        existingId:    existing.id,
        existingStatus: existing.status,
        userId,
      });
      return;
    }

    const id = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;

    // Save PDF to per-user storage
    let hasPdf = false;
    if (invoiceData.pdfBuffer) {
      try {
        pdfStoreUser.save(id, invoiceData.pdfBuffer);
        hasPdf = true;
        logger.info('PDF saved', { id, filename: invoiceData.pdfFilename, userId });
      } catch (err) {
        logger.warn('Failed to save PDF', { error: err.message, userId });
      }
    }

    // Build clean record (strip binary buffer before storing)
    const record = {
      id,
      status:           'pending',
      hasPdf,
      pdfFilename:      invoiceData.pdfFilename    || null,
      vendorName:       invoiceData.vendorName     || invoiceData.contactName || 'Unknown',
      contactName:      invoiceData.contactName    || invoiceData.vendorName  || '',
      contactEmail:     invoiceData.contactEmail   || '',
      contactAddress:   invoiceData.contactAddress || '',
      invoiceNumber:    invoiceData.invoiceNumber  || '—',
      invoiceDate:      invoiceData.invoiceDate    || null,
      dueDate:          invoiceData.dueDate        || null,
      totalAmount:      invoiceData.totalAmount    || 0,
      currency:         invoiceData.currency       || 'USD',
      invoiceType:      invoiceData.invoiceType    || 'ACCPAY',
      source:           invoiceData.source         || 'pdf',
      sourceEmail:      invoiceData.sourceEmail    || '',
      lineItems:        invoiceData.lineItems      || [],
      description:      invoiceData.description    || '',
      accountCode:      invoiceData.accountCode    || '',
      taxAmount:        invoiceData.taxAmount      || 0,
      subTotal:         invoiceData.subTotal       || 0,
      paymentReference: invoiceData.paymentReference || '',
      processedAt:      new Date().toISOString(),
      reports:          [],
    };

    await invStore.add(record);
    procState.addInvoice();

    // Reject zero-amount auto-numbered invoices — the LLM failed to extract useful data.
    // Store the record so the user can see it, but don't send a blank draft to Xero.
    const isAutoNum = !record.invoiceNumber ||
      record.invoiceNumber === '—' ||
      /^INV-\d{12,}$/.test(record.invoiceNumber);
    if (isAutoNum && (record.totalAmount || 0) === 0) {
      logger.warn('Invoice has no amount and no invoice number — skipping Xero submit', {
        id, vendor: record.vendorName, userId,
      });
      await invStore.update(id, { status: 'review-needed', errorMsg: 'Could not extract invoice number or amount from PDF' });
      return;
    }

    if (settingsUser.get('autoProcess')) {
      // Strip the binary PDF buffer before passing into the queue closure — the PDF
      // is already saved to disk and will be read back via pdfStore when attaching to Xero.
      // eslint-disable-next-line no-unused-vars
      const { pdfBuffer: _buf, ...invoiceDataClean } = invoiceData;
      scheduleXeroSubmit(invoiceDataClean, id);
      logger.info('Invoice queued for Xero submission', { id, vendor: record.vendorName, userId });
    } else {
      logger.info('Auto-process disabled — invoice stored for manual review', { id, userId });
    }
  }

  return { onInvoiceEmail };
}

// ── Manual / reusable Xero submission ────────────────────────────────────────
// Standalone function — not tied to the per-user rate-limiting chain inside
// createHandler. Suitable for UI-triggered one-shot submissions and retries.
// Can be called any number of times on the same invoice (idempotent guard below).
async function submitInvoiceToXero(userId, invoiceId) {
  const invStore = invoiceStore.forUser(userId);

  // Atomically claim the invoice for submission — prevents concurrent callers
  // (boot-time retry, manual submit, submit-all) from posting the same invoice twice.
  const claim = await invStore.claimForSubmit(invoiceId);
  if (!claim.claimed) {
    if (claim.reason === 'already submitting') return null;
    throw new Error('Invoice not found');
  }

  // Reconnect Xero if the token cache was cleared (e.g. server restart)
  const cache   = tokenCache.forUser(userId);
  const tenants = await cache.getAllTenants();
  if (!tenants.length) {
    logger.info('No cached Xero tenants — reconnecting before manual submit', { userId });
    await reconnectXero(userId);
  }

  const record = invStore.getById(invoiceId);
  // Pass _invoiceStoreId so createDraftInvoice can read the PDF from disk
  const invoiceData = { ...record, _invoiceStoreId: invoiceId };

  try {
    const xeroInvoiceId = await enqueueInvoice(userId, invoiceData);

    // xeroInvoiceId is null when Bull/Redis queue is active — status will be
    // updated by the queue processor once the job completes.
    const patch = xeroInvoiceId
      ? { status: 'posted', xeroInvoiceId, submittedAt: new Date().toISOString(), errorMsg: null }
      : { status: 'pending', errorMsg: null };

    await invStore.update(invoiceId, patch);
    logger.info('Invoice submitted to Xero', { invoiceId, xeroInvoiceId: xeroInvoiceId || 'queued', userId });
    return xeroInvoiceId;
  } catch (err) {
    const errMsg = xeroErrMsg(err);
    await invStore.update(invoiceId, { status: 'error', errorMsg: errMsg });
    throw err;
  }
}

module.exports = { createHandler, submitInvoiceToXero };
