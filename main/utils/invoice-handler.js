const { enqueueInvoice }  = require('../queue/processor');
const { getUserDefaults, isActive } = require('./users');
const { newId } = require('./ids');
const { reconnectXero }   = require('../xero/reconnect');
const { xeroErrMsg }      = require('../xero/xero-utils');
const { notifyError }     = require('./notify');
const { buildRecord } = require('../intake/record');
const { profileFor } = require('../intake/profiles');
const { normaliseDocument, bankAccountIds } = require('../intake/document');
const { hashBuffer } = require('../intake/dedup');
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
  const from  = record.source === 'email-image' ? 'the photo' : 'the PDF';
  const total = Number(record.totalAmount) || 0;
  if (total <= 0) return `Could not read an amount from ${from}`;
  const auto = !record.invoiceNumber || record.invoiceNumber === '—' || /^INV-\d{12,}$/.test(record.invoiceNumber);
  if (auto) return `Could not read an invoice number from ${from}`;
  return null;
}

// A supplier's bill whose bank account is not one on the last bill stored
// from that supplier. This is the commonest invoice fraud: a lookalike
// address, or the supplier's own hacked mailbox, sends a genuine-looking bill
// with the account changed, and the reader copies whatever account is printed
// into the draft. Such a bill is held for a person with both sets of details
// side by side, never posted. Null when nothing differs or there is nothing to
// compare: a first bill, or either bill without an account number on it.
function bankDetailsChange(invStore, record) {
  if (record.invoiceType !== 'ACCPAY') return null;
  const current = bankAccountIds(record.paymentReference);
  if (!current.length) return null;
  const last = invStore.lastBillFrom(record.vendorName || record.contactName, record.id);
  if (!last) return null;
  const previous = bankAccountIds(last.paymentReference);
  if (!previous.length || current.every(id => previous.includes(id))) return null;
  const which = [last.invoiceNumber && last.invoiceNumber !== '—' ? last.invoiceNumber : null, last.invoiceDate].filter(Boolean).join(', ');
  return `Bank details differ from this supplier's last bill: this one says "${record.paymentReference}", ` +
    `the last one${which ? ` (${which})` : ''} said "${last.paymentReference}". ` +
    'Confirm the change with the supplier, on a number you already have, before paying';
}

// A photographed bill's image is kept the way a claim's receipt is, so the
// review page shows it beside the figures and Xero gets it as the attachment.
// Returns { file, mime }, or { note } saying why it was not kept: the bill is
// stored either way, because losing the bill over its attachment would be
// worse than a person attaching it by hand. Required here because it is only
// needed when a photo arrives.
async function _keepPhoto(userId, id, buffer, mime) {
  const receiptStore = require('./receipt-store');
  try {
    if (!receiptStore.isAcceptedMime(mime)) {
      const label = String(mime || 'this format').split('/').pop().toUpperCase();
      return { note: `the photo is ${label}, which Xero does not take as an attachment, so it was not kept; attach a JPEG or PNG copy by hand` };
    }
    const fit = await receiptStore.fitToLimit(buffer, mime);
    if (fit.reason) return { note: `the photo was not kept: ${fit.reason}` };
    return { file: receiptStore.forUser(userId).save(id, fit.buffer, fit.mime), mime: fit.mime };
  } catch (err) {
    return { note: `the photo could not be kept with the bill (${err.message})` };
  }
}

// Whether an invoice already waiting in this account's Xero chain may still go.
// Disabling stops the watcher and the workers, but a submit queued just before
// sits here for a few seconds; this is the last point it can be held back. A
// failed lookup lets it through: the store writes around it read the same
// database and would fail the same way, and refusing would strand the record.
function accountMayPost(userId) {
  try { return isActive(userId); } catch (_) { return true; }
}

// Another record, already in Xero, that this one would duplicate — or null. A
// record that is itself in Xero is sent as an update to its own bill, so it
// has nothing to duplicate.
function postedDuplicateOf(invStore, record) {
  if (!record || record.xeroInvoiceId) return null;
  return invStore.findPosted(
    record.vendorName || record.contactName,
    record.invoiceNumber,
    record.invoiceDate,
    record.totalAmount,
    record.id
  );
}

// No org to send to is the account's setup, not a fault in this invoice or in
// Xero; it is shown on the row and does not page anyone.
const _SETUP_CODES = new Set(['XERO_TENANT_CHOICE', 'XERO_TENANT_GONE']);

function createHandler(userId, { submitDelayMs = XERO_SUBMIT_DELAY_MS } = {}) {
  const invStore      = invoiceStore.forUser(userId);
  const pdfStoreUser  = pdfStore.forUser(userId);
  const settingsUser  = settingsStore.forUser(userId);
  const procState     = processState.forUser(userId);

  let _xeroChain = Promise.resolve();

  // The automatic path sends through submitInvoiceToXero, like a manual submit
  // and the boot retry. It used to post on its own: it never claimed the row,
  // so the boot retry could send the same pending row at the same moment, and
  // its duplicate branch copied the other row's Xero ID onto this one, which
  // the unique index refuses — the update threw, the row stayed pending, and
  // Submit all or the next boot posted it a second time.
  function scheduleXeroSubmit(id, sourceEmail) {
    _xeroChain = _xeroChain.then(async () => {
      await new Promise(r => setTimeout(r, submitDelayMs));

      // Disabled or deleted while it waited: back to pending for a person to
      // review, never posted. A deleted account's row is already gone with it.
      if (!accountMayPost(userId)) {
        logger.info('Account disabled before Xero submit — held as pending', { id, userId });
        try { await invStore.update(id, { status: 'pending' }); } catch (_) {}
        return;
      }

      // Sent by hand, edited back to review or deleted while it waited: not
      // this chain's to send any more. claimForSubmit would take a posted row
      // (that is how a correction goes), so only a row still pending goes.
      if (invStore.getById(id)?.status !== 'pending') {
        logger.info('Invoice no longer pending when its Xero turn came — skipped', { id, userId });
        return;
      }

      try {
        // Checks for a posted duplicate just before claiming the row, so a
        // concurrent scan that sent this bill while it waited stops it here.
        await submitInvoiceToXero(userId, id);
      } catch (err) {
        const errMsg = xeroErrMsg(err);
        logger.error('Failed to submit invoice to Xero', { id, error: errMsg, userId });
        if (_SETUP_CODES.has(err?.code)) return;
        try {
          await notifyError({ context: 'Xero submit failed', error: errMsg, email: sourceEmail });
        } catch (_) {}
      }
    }).catch(err => {
      logger.error('Unexpected error in Xero submission chain', { error: err?.message || String(err), userId });
    });
  }

  // Resolves once every send queued so far has finished. For tests and for
  // anything that must not cut a send off halfway.
  function whenIdle() { return _xeroChain; }

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
    const photo = invoiceData.imageBuffer ? await _keepPhoto(userId, id, invoiceData.imageBuffer, invoiceData.imageMime) : null;
    if (photo?.note) logger.warn('Photographed bill stored without its photo', { id, userId, note: photo.note });

    // The file as it arrived, hashed, so the same PDF or photo sent again under
    // another email is recognised before it is read (queue/email-worker.js).
    const fileHash = hashBuffer(invoiceData.pdfBuffer || invoiceData.imageBuffer);

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
        // Left undefined when unknown, which the store skips rather than
        // writing an empty value over nothing.
        messageId:     invoiceData.messageId  || undefined,
        confidence:    invoiceData.confidence || undefined,
        receiptHash:   fileHash || undefined,
        receiptFile:   photo?.file || undefined,
        receiptMime:   photo?.file ? photo.mime : undefined,
      },
    });

    // Before the row is added, so the supplier's last bill is not this one.
    const bank = bankDetailsChange(invStore, record);

    await invStore.add(record);
    procState.addInvoice();

    // Two kinds of reason stop a bill here, and the row shows both. holdReason
    // is about the stored row (no amount, no number), so it is never sent as a
    // blank draft. reviewReason is what the reader found in the document: the
    // template verifier disagreeing about money, the bill reader's figures not
    // adding up, a document that is not a bill at all, or a PDF only partly
    // read. The figures are kept as read; a person decides before anything
    // reaches Xero. A hold used to return before the review reason was looked
    // at, so a row held for its number never said its lines did not add up.
    // Changed bank details come first: of everything here, that is the one
    // that costs money if it is missed.
    const hold   = holdReason(record);
    const review = [invoiceData.reviewReason, photo?.note].filter(Boolean).join('; ') || null;
    if (bank || hold || review) {
      const errorMsg = [bank, hold, review && `Please check: ${review}`].filter(Boolean).join('. ');
      logger.warn('Invoice held for review — skipping Xero submit', { id, vendor: record.vendorName, userId, hold, review, bankDetailsChanged: !!bank });
      await invStore.update(id, { status: 'review-needed', errorMsg });
      return { id, status: 'review-needed' };
    }

    // Whether this document may go to Xero without a person looking at it is
    // decided by the intake profile, not only by the auto-process switch: an
    // emailed bill may, a bill someone uploaded by hand never does — they have
    // it in front of them and will review it (intake/profiles.js).
    const mayAutoPost = profileFor(record.invoiceType).autoPost(record.source);
    if (settingsUser.get('autoProcess') && mayAutoPost) {
      // What goes to Xero is the STORED row, read again when its turn comes —
      // the same payload a manual submit sends. The raw parser object used to
      // go instead, so the two paths could differ (and the PDF is read back
      // from disk by id anyway).
      scheduleXeroSubmit(id, record.sourceEmail);
      logger.info('Invoice queued for Xero submission', { id, vendor: record.vendorName, userId });
    } else if (!mayAutoPost) {
      logger.info('Stored for review — this source never auto-posts', { id, source: record.source, userId });
    } else {
      logger.info('Auto-process disabled — invoice stored for manual review', { id, userId });
    }
    return { id, status: record.status };
  }
  return { onInvoiceEmail, whenIdle };
}

// ── Manual / reusable Xero submission ────────────────────────────────────────
// Standalone function — not tied to the per-user rate-limiting chain inside
// createHandler. Suitable for UI-triggered one-shot submissions and retries.
// Can be called any number of times on the same invoice (idempotent guard below).
//
// allowDuplicate is for a person who has seen that this matches a bill already
// in Xero and wants it sent anyway; every other caller leaves it off, and a
// match is marked duplicate and not sent.
async function submitInvoiceToXero(userId, invoiceId, { allowDuplicate = false } = {}) {
  const invStore = invoiceStore.forUser(userId);

  // The duplicate check and the claim run with no await between them, so no
  // other send can post a matching bill in the gap.
  if (!allowDuplicate) {
    const current = invStore.getById(invoiceId);
    if (!current) throw new Error('Invoice not found');
    const dup = current.status === 'submitting' ? null : postedDuplicateOf(invStore, current);
    if (dup) {
      // Points at the other row; the Xero ID stays only on the row it belongs
      // to (one Xero invoice, one local record — a unique index enforces it).
      invStore.update(invoiceId, { status: 'duplicate', duplicateOf: dup.id });
      logger.info('Duplicate of an invoice already in Xero — not sent', { invoiceId, duplicateOf: dup.id, userId });
      return null;
    }
  }

  // Atomically claim the invoice for submission — prevents concurrent callers
  // (boot-time retry, manual submit, submit-all) from posting the same invoice twice.
  const claim = await invStore.claimForSubmit(invoiceId);
  if (!claim.claimed) {
    if (claim.reason === 'already submitting') return null;
    throw new Error('Invoice not found');
  }

  const record = invStore.getById(invoiceId);
  // Already in Xero: this send is a correction. However it ends, the row stays
  // posted — it is in Xero, and 'error' hid it from the duplicate checks.
  const inXero = !!record.xeroInvoiceId;
  // Pass _invoiceStoreId so createDraftInvoice can read the PDF from disk
  const invoiceData = { ...record, _invoiceStoreId: invoiceId };

  try {
    // Reconnect Xero if the token cache was cleared (e.g. server restart).
    // Inside the try: a failed reconnect used to leave the row claimed, in
    // 'submitting', with nothing left to finish it.
    const cache   = tokenCache.forUser(userId);
    const tenants = await cache.getAllTenants();
    if (!tenants.length) {
      logger.info('No cached Xero tenants — reconnecting before submit', { userId });
      await reconnectXero(userId);
    }

    const sent = await enqueueInvoice(userId, invoiceData);

    // null means no connected org: nothing was sent, so a new row waits as
    // pending rather than being marked posted.
    let patch;
    if (sent) {
      patch = { status: 'posted', xeroInvoiceId: sent.xeroInvoiceId, xeroTenantId: sent.tenantId,
                submittedAt: new Date().toISOString(), errorMsg: null };
    } else if (inXero) {
      patch = { status: 'posted', errorMsg: 'Xero is not connected. The correction was not sent.' };
    } else {
      patch = { status: 'pending', errorMsg: null };
    }

    await invStore.update(invoiceId, patch);
    logger.info('Invoice submitted to Xero', { invoiceId, xeroInvoiceId: sent?.xeroInvoiceId || 'queued', userId });
    return sent ? sent.xeroInvoiceId : null;
  } catch (err) {
    const errMsg = xeroErrMsg(err);
    await invStore.update(invoiceId, { status: inXero ? 'posted' : 'error', errorMsg: errMsg });
    throw err;
  }
}

module.exports = { createHandler, submitInvoiceToXero, postedDuplicateOf, holdReason, bankDetailsChange, accountMayPost };
