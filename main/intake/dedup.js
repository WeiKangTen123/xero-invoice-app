const crypto = require('crypto');

// Recognising a document already in the system — one implementation for
// bills, invoices and claims. Until now there were two, and the second opened
// with a comment saying it followed the shape of the first.
//
// Three signals, in order of certainty. The profile says which apply:
//
//   1. The file itself. A SHA-256 of the bytes is exact: the same photograph,
//      the same PDF, the same archive imported twice. `certain: true`.
//
//   2. The document number, with contact, date and amount. A supplier's
//      invoice number is meant to be unique, so a match on it is a fact. The
//      store's own matcher decides this — it already knows an auto-generated
//      INV-<timestamp> is not a real number and falls back to fields for those.
//      `certain: true`.
//
//   3. Contact, date and amount, with no number and no file to compare — a
//      claim line typed from a spreadsheet, say. All three must agree. Two
//      coffees from the same shop on the same day for the same amount are
//      unusual; two on different days are not, and merging those would lose a
//      real expense. `certain: false` — a suspicion for a person to settle.
//
// That split matters because 'duplicate' is a locked status: nothing moves a
// row out of it. Auto-marking on a suspicion would bury a real expense behind
// a status nobody can undo.

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

function vendorMatches(v1, v2) {
  const a = _norm(v1);
  const b = _norm(v2);
  if (!a || !b) return false;
  if (a === b) return true;
  const strip = s => s.replace(/\b(pte|ltd|limited|sdn|bhd|inc|corp|corporation|llc|co)\b/g, '').trim().replace(/\s+/g, ' ');
  const sa = strip(a);
  const sb = strip(b);
  if (sa === sb) return true;
  // Brands: "isetan" inside "isetan singapore limited".
  if (sa.length >= 4 && sb.length >= 4 && (sa.includes(sb) || sb.includes(sa))) return true;
  return false;
}

// Returns { match, reason, certain } or null.
//
// `profile` is optional; without one every signal is tried, which is what the
// claim path always did. `candidates` lets a batch import pass one pre-fetched
// list rather than querying per document.
function findDuplicate({ store, profile = null, hash, contactName, vendorName, number, date, amount, candidates = null, excludeId = null }) {
  const name = contactName ?? vendorName;
  const rules = profile?.dedup || { byHash: true, byNumber: true, byFields: true };

  if (rules.byHash && hash && typeof store.findByReceiptHash === 'function') {
    const byHash = store.findByReceiptHash(hash);
    if (byHash && byHash.id !== excludeId) return { match: byHash, reason: 'the same receipt image', certain: true };
  }

  if (rules.byNumber && number && typeof store.findStored === 'function') {
    const byNumber = store.findStored(name, number, date, amount);
    if (byNumber && byNumber.id !== excludeId) return { match: byNumber, reason: 'the same document number', certain: true };
  }

  if (!rules.byFields) return null;
  if (!name || !date || amount === null || amount === undefined) return null;
  const rows = candidates || store.getAll();
  const hit = rows.find(r =>
    r.id !== excludeId &&
    r.status !== 'duplicate' && r.status !== 'error' &&
    vendorMatches(r.vendorName, name) &&
    String(r.invoiceDate || '').slice(0, 10) === String(date).slice(0, 10) &&
    sameAmount(r.totalAmount, amount));
  return hit ? { match: hit, reason: 'the same vendor, date and amount', certain: false } : null;
}

module.exports = { hashBuffer, findDuplicate, sameAmount, vendorMatches };
