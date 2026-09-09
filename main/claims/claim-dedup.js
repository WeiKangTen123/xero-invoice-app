const crypto = require('crypto');

// Recognising a receipt already in the system.
//
// Follows the same shape as the invoice pipeline's dedup — point the newcomer at
// the original with duplicateOf rather than dropping it silently — so a
// duplicate is visible and reversible instead of a receipt that vanished.
//
// Two signals, and the difference between them decides what happens:
//
//   1. The image itself. A SHA-256 of the file is exact: the same photograph,
//      or the same claim archive imported twice, is the commonest duplicate
//      here and this catches it without judgement. `certain: true` — a byte-for-
//      byte match is a fact, so the newcomer is marked 'duplicate' outright.
//
//   2. Vendor, date and amount. Weaker, and used only when there is no image to
//      compare — a claim line typed from a spreadsheet with no receipt attached.
//      Deliberately requires all three: two coffees from the same shop on the
//      same day for the same amount are unusual, but two on different days are
//      not, and merging those would lose a real expense. `certain: false` — it
//      is a suspicion, so the row is FLAGGED and left for a person to settle.
//
// That split matters because 'duplicate' is a locked status: PATCH
// /api/invoices/:id/status refuses to move a row out of it. Auto-marking on a
// guess would bury a real expense behind a status nobody can undo. Two identical
// coffees bought the same afternoon are rare but they are not impossible, and
// the person holding the receipts is better placed to judge than this file is.

function hashBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function _norm(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function sameAmount(a, b) {
  if (a === null || b === null || a === undefined || b === undefined) return false;
  return Math.round(Number(a) * 100) === Math.round(Number(b) * 100);
}

// Returns the existing record this one duplicates, or null.
//
// `store` is the invoice store for the user; `candidates` is an optional
// pre-fetched list used for the fields path so a batch import does not query
// once per receipt.
function findDuplicate({ store, hash, vendorName, date, amount, candidates = null, excludeId = null }) {
  // 1. Exact image match.
  if (hash) {
    const byHash = store.findByReceiptHash(hash);
    if (byHash && byHash.id !== excludeId) {
      return { match: byHash, reason: 'the same receipt image', certain: true };
    }
  }

  // 2. Fields, only with all three present. Without an image there is nothing
  //    else to go on, and anything looser merges real expenses.
  if (!vendorName || !date || amount === null || amount === undefined) return null;

  const rows = candidates || store.getAll();
  const v = _norm(vendorName);
  const hit = rows.find(r =>
    r.id !== excludeId &&
    r.status !== 'duplicate' && r.status !== 'error' &&
    _norm(r.vendorName) === v &&
    String(r.invoiceDate || '').slice(0, 10) === String(date).slice(0, 10) &&
    sameAmount(r.totalAmount, amount));

  return hit ? { match: hit, reason: 'the same vendor, date and amount', certain: false } : null;
}

module.exports = { hashBuffer, findDuplicate, sameAmount };
