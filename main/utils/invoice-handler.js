const { enqueueInvoice }  = require('../queue/processor');
const { getUserDefaults } = require('./users');
const { newId } = require('./ids');
const { reconnectXero }   = require('../xero/reconnect');
const { xeroErrMsg }      = require('../xero/xero-utils');
const { notifyError }     = require('./notify');
const { buildRecord } = require('../intake/record');
const { profileFor } = require('../intake/profiles');
const { normaliseDocument } = require('../intake/document');
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
// Why a stored bill must wait for a person instead of going to Xero. Null
// means nothing here objects. A zero total is held whatever the number says:
// the old guard only held "no number AND no amount", so a misread PDF whose
// number came from its filename could post a blank draft.
function holdReason(record) {
  const total = Number(record.totalAmount) || 0;
  if (total <= 0) return 'Could not read an amount from the PDF';
  const auto = !record.invoiceNumber || record.invoiceNumber === '—' || /^INV-\d{12,}$/.test(record.invoiceNumber);
  if (auto) return 'Could not read an invoice number from the PDF';
  return null;
}

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
      return { id: existing.id, status: existing.status, duplicate: true };
    }

    const id = newId();

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

    // The row is built by the shared intake builder; what this path adds is the
    // PDF it stored and the email it came from. Fields the parser already
    // decided are passed through as extras so the builder does not re-derive
    // them and this stays a pure refactor.
    const record = buildRecord({
      id,
      document:    normaliseDocument(invoiceData),
      invoiceType: invoiceData.invoiceType || 'ACCPAY',
      source:      invoiceData.source      || 'pdf',
      defaults:    { accountCode: invoiceData.accountCode || '', currency: invoiceData.currency || getUserDefaults(userId).currency },
      extras: {
        hasPdf,
        pdfFilename:   invoiceData.pdfFilename    || null,
        sourceEmail:   invoiceData.sourceEmail    || '',
        vendorName:    invoiceData.vendorName     || invoiceData.contactName || 'Unknown',
        contactName:   invoiceData.contactName    || invoiceData.vendorName  || '',
        contactEmail:  invoiceData.contactEmail   || '',
        contactAddress: invoiceData.contactAddress || '',
        invoiceNumber: invoiceData.invoiceNumber  || '—',
        invoiceDate:   invoiceData.invoiceDate    || null,
        dueDate:       invoiceData.dueDate        || null,
        vendorPhone:   invoiceData.vendorPhone    || '',
        projectName:   invoiceData.projectName    || '',
        totalAmount:   invoiceData.totalAmount    || 0,
        currency:      invoiceData.currency       || getUserDefaults(userId).currency,
        lineItems:     invoiceData.lineItems      || [],
        description:   invoiceData.description    || '',
        accountCode:   invoiceData.accountCode    || '',
        taxAmount:     invoiceData.taxAmount      || 0,
        subTotal:      invoiceData.subTotal       || 0,
        paymentReference: invoiceData.paymentReference || '',
        // The email's own date when we have it; otherwise arrival is now.
        receivedAt:    invoiceData.receivedAt || new Date().toISOString(),
      },
    });

    await invStore.add(record);
    procState.addInvoice();

    // Stored so the user can see it, but never sent as a blank draft.
    const hold = holdReason(record);
    if (hold) {
      logger.warn('Invoice held for review — skipping Xero submit', { id, vendor: record.vendorName, userId, reason: hold });
      await invStore.update(id, { status: 'review-needed', errorMsg: hold });
      return { id, status: 'review-needed' };
    }

    // The template verifier read the document differently from the parser on
    // something that affects money. The parser's figures were kept; a person
    // decides which reading is right before anything reaches Xero.
    if (invoiceData.reviewReason) {
      logger.warn('Invoice flagged by template verification — skipping Xero submit', {
        id, vendor: record.vendorName, userId, reason: invoiceData.reviewReason,
      });
            await invStore.update(id, { status: 'review-needed', errorMsg: `Please check: ${invoiceData.reviewReason}` });
      return { id, status: 'review-needed' };
    }

        // Whether this document may go to Xero without a person looking at it is
    // decided by the intake profile, not only by the auto-process switch: an
    // emailed bill may, a bill someone uploaded by hand never does — they have
    // it in front of them and will review it (intake/profiles.js).
    const mayAutoPost = profileFor(record.invoiceType).autoPost(record.source);
    if (settingsUser.get('autoProcess') && mayAutoPost) {
      // What goes to Xero is the STORED row — the same payload a manual submit
      // sends. The raw parser object used to go instead, so the two paths
      // could differ (and the PDF is read back from disk by id anyway).
      scheduleXeroSubmit({ ...invStore.getById(id), _invoiceStoreId: id }, id);
      logger.info('Invoice queued for Xero submission', { id, vendor: record.vendorName, userId });
    } else if (!mayAutoPost) {
      logger.info('Stored for review — this source never auto-posts', { id, source: record.source, userId });
    } else {
      logger.info('Auto-process disabled — invoice stored for manual review', { id, userId });
    }
    return { id, status: record.status };
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

    // null means no connected org: nothing was sent, so the row waits as
    // pending rather than being marked posted.
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

module.exports = { createHandler, submitInvoiceToXero, holdReason };
