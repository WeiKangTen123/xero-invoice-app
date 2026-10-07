const { profileFor }                = require('../intake/profiles');
const { hashBuffer, findDuplicate } = require('../intake/dedup');
const { getUserDefaults }           = require('../utils/users');
const { newId }                     = require('../utils/ids');
const { today }                     = require('../intake/document');
const { resolveAccountCode }        = require('./category-account');
const { normaliseCurrency }         = require('./claim-form');
const invoiceStore                  = require('../utils/invoice-store');
const logger                        = require('../utils/logger');

// Every claim record is built here. It used to be assembled in four places —
// the upload route, its two split-sibling loops, and the claim import — and
// they disagreed: siblings were `source: 'upload'` even from a phone, with no
// currency, no account (Xero then fell to the sales account), no number and
// no received time; every import's first line was "EXP-1".

// EXP-<group>-<line> for a form line inside an import, else EXP-<id>. The
// group tail keeps two imports' line 1 apart.
function claimNumber({ id, groupId, row }) {
  if (row && row.no) return `EXP-${groupId ? String(groupId).slice(-4).toUpperCase() + '-' : ''}${row.no}`;
  return `EXP-${String(id).slice(-6).toUpperCase()}`;
}

// What the claim says it was for: the reader's corporate description when
// the claimant wrote nothing (or only the merchant); else the claimant's own
// words with the category and time; else "Expense claim @ merchant".
function claimDescription({ receipt, row, category }) {
  const cat = category || (receipt && receipt.category) || null;
  const rowText = row && row.description;
  if (receipt && receipt.description && (!rowText || rowText === receipt.merchant)) return receipt.description;
  if (rowText) {
    const parts = [];
    if (cat && !rowText.startsWith('[')) parts.push(`[${cat}]`);
    parts.push(rowText);
    if (receipt && receipt.time && !rowText.includes(receipt.time)) parts.push(`(${receipt.time})`);
    return parts.join(' ').slice(0, 250);
  }
  if (receipt && receipt.merchant) {
    return `${cat ? `[${cat}] ` : ''}Expense claim @ ${receipt.merchant}${receipt.time ? ` (${receipt.time})` : ''}`.slice(0, 250);
  }
  return cat ? `[${cat}] Expense claim` : null;
}

// One row shape. `extras` is what only the caller knows — the stored file,
// its hash, a split box or page, a duplicate note — spread last.
function newClaimRow({ userId, id = newId(), source, groupId = null, receipt = null, row = null, category = null, extras = {} }) {
  const defaults = getUserDefaults(userId);
  const now      = new Date().toISOString();
  const date     = (row && row.date) || (receipt && receipt.date) || today();
  return {
    id,
    status:        profileFor('EXPENSE').initialStatus(source),
    invoiceType:   'EXPENSE',
    source,
    invoiceNumber: claimNumber({ id, groupId, row }),
    invoiceDate:   date,
    dueDate:       date,
    // Cleaned here as well as on the form, so a symbol from any reader ("S$")
    // never reaches Xero as the currency.
    currency:      normaliseCurrency(row && row.currency) || normaliseCurrency(receipt && receipt.currency) || defaults.currency,
    // The form's exchange rate in Xero's terms (claim-form.js). Xero is given
    // it only when the claim's currency is not the org's own.
    currencyRate:  (row && row.currencyRate > 0) ? row.currencyRate : null,
    accountCode:   defaults.accountCode.claim,
    // The claimant's own figures are what is recorded. The receipt read is
    // evidence, and a disagreement is reported rather than silently preferred.
    vendorName:    (receipt && receipt.merchant) || null,
    totalAmount:   (row && row.amount != null) ? row.amount : (receipt && receipt.total != null ? receipt.total : null),
    subTotal:      receipt && receipt.subTotal != null ? receipt.subTotal : null,
    taxAmount:     receipt && receipt.tax      != null ? receipt.tax      : null,
    lineItems:     receipt && Array.isArray(receipt.lineItems) && receipt.lineItems.length ? receipt.lineItems : [],
    description:   claimDescription({ receipt, row, category }),
    receiptGroup:  groupId,
    processedAt:   now,
    receivedAt:    now,
    ...extras,
  };
}

// What a read receipt changes on an existing row. undefined leaves a field
// alone (invoice-store's rule), so a value the reader could not make out
// never erases one already there.
function claimPatch(r, extras = {}) {
  return {
    vendorName:  r.merchant    ?? undefined,
    invoiceDate: r.date        ?? undefined,
    dueDate:     r.date        ?? undefined,
    currency:    r.currency    ?? undefined,
    totalAmount: r.total       ?? undefined,
    taxAmount:   r.tax         ?? undefined,
    subTotal:    r.subTotal    ?? undefined,
    description: r.description ?? undefined,
    lineItems:   Array.isArray(r.lineItems) && r.lineItems.length ? r.lineItems : undefined,
    ...extras,
  };
}

// The account follows what the receipt was for, matched against the org's
// chart (category-account). The form's heading leads the description, but
// the chart may only know the reader's wording, so both are tried. No match,
// or no connected org, and null — the caller keeps whatever it had.
//
// `tenantId` is the company a claim already in Xero lives in; without it the
// chart is read from the company a new claim will be sent to.
async function accountFor(userId, category, receipt, { tenantId } = {}) {
  const cat = category || (receipt && receipt.category) || null;
  if (!cat) return null;                       // nothing to look up — the chart is never asked
  const alt = receipt && receipt.category && receipt.category !== cat ? receipt.category : null;
  const ask = c => (tenantId ? resolveAccountCode(userId, c, { tenantId }) : resolveAccountCode(userId, c));
  return (await ask(cat)) || (alt ? await ask(alt) : null) || null;
}

// Turns one matched claim line into a local record. Injected into the import
// job so the job itself stays testable without a database.
//
// Dedup happens HERE rather than earlier because it needs the finished figures —
// the claimant's amount and date, not the model's guess — and because doing it
// one record at a time means a repeat inside a single archive is caught too: the
// first row is committed before the second is checked.
async function createClaimRecord({ userId, groupId, row, receipt, match, category, store, reviewReason = null }) {
  const id       = newId();
  const invStore = invoiceStore.forUser(userId);

  const hash = receipt && receipt.buffer ? hashBuffer(receipt.buffer) : null;
  const dup = findDuplicate({
    store: invStore, profile: profileFor('EXPENSE'), hash,
    vendorName: (receipt && receipt.merchant) || null,
    // The claim line's own date and amount, falling back to the receipt for a
    // loose receipt with no line.
    date:   row.date ?? (receipt && receipt.date) ?? null,
    amount: row.amount ?? (receipt && receipt.total) ?? null,
  });

  let storedName = null;
  let mime = null;
  let storeFailure = null;
  if (dup && dup.certain) {
    // Byte-identical to something already held, so writing the file again would
    // put a second identical copy on disk for no gain. Point at the original's
    // file instead; countByReceiptFile already refuses to delete a file another
    // row still references, so neither record can orphan the other's image.
    storedName = dup.match.receiptFile || null;
    mime = dup.match.receiptMime || (receipt && receipt.mime) || null;
  } else if (receipt && receipt.buffer) {
    try {
      mime = receipt.mime;
      storedName = await store(userId, id, receipt.buffer, receipt.mime);
    } catch (err) {
      // A receipt that will not store is not a reason to lose the claim line,
      // but it is a reason to say so: the claim would otherwise go to Xero
      // with no receipt attached and nothing on the row to explain why.
      logger.warn('Claim receipt could not be stored', { userId, id, error: err.message });
      storedName = null;
      mime = null;
      storeFailure = `The receipt image could not be saved (${err.message}), so it will not be attached in Xero. Add the receipt to this claim again.`;
    }
  }

  // A discrepancy is recorded on the row so it survives the job expiring. A
  // suspected duplicate is recorded the same way, and takes precedence: it is
  // the more urgent of the two things to look at.
  const matchRef = dup ? (dup.match.invoiceNumber || dup.match.id) : null;
  const mainNote =
    dup && !dup.certain
      ? `Possible duplicate of ${matchRef} — ${dup.reason}. Check before approving.`
    : dup
      ? `Duplicate of ${matchRef} — ${dup.reason}`
    : match && match.discrepancy
      ? `Claimed ${match.discrepancy.claimed} but the receipt says ${match.discrepancy.onReceipt}`
      // A receipt with no claim line is not an error — it is simply a claim that
      // arrived without a form. Only a line MISSING its receipt is a problem.
      : (!receipt && row.no ? 'No receipt found for this claim line' : null);

  const claimRow = newClaimRow({ userId, id, source: 'claim', groupId, receipt, row, category });
  // A currency the form gave but no code could be read from: the claim takes
  // the receipt's or the default, and says which.
  const currencyNote = row && row.currencyUnread && !normaliseCurrency(row.currency)
    ? `The claim form gives the currency as "${row.currencyUnread}", which is not a currency code; ${claimRow.currency} was used. Check it before approving.`
    : null;
  // The duplicate note stays first: the import reads "Possible duplicate" from
  // the start of it.
  // What the import was unsure of — a weak receipt match, a suggested category,
  // a second receipt in one photo — used to reach only the import summary,
  // which is gone once the dialog closes. It goes on the claim itself.
  const reviewNote = reviewReason ? `Please check: ${String(reviewReason).replace(/\.\s*$/, '')}.` : null;
  const note = [mainNote, reviewNote, currencyNote, storeFailure].filter(Boolean).join(' ') || null;

  const accountCode = await accountFor(userId, category, receipt);

  return invStore.add({
    ...claimRow,
    // Exact image match is auto-marked 'duplicate'. Field match stays
    // 'review-needed' with duplicateOf linked so the reviewer can settle it.
    status:      dup && dup.certain ? 'duplicate' : 'review-needed',
    duplicateOf: dup ? dup.match.id : null,
    ...(accountCode ? { accountCode } : {}),
    receiptFile: storedName,
    receiptMime: mime,
    receiptHash: hash,
    errorMsg:    note,
  });
}

module.exports = { newClaimRow, claimPatch, claimNumber, claimDescription, accountFor, createClaimRecord };
