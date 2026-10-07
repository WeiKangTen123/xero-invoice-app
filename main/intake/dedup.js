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
    // An 'error' row is skipped only if it never reached Xero: a failed
    // correction of a posted bill keeps its Xero ID and is still in Xero.
    r.status !== 'duplicate' && (r.status !== 'error' || r.xeroInvoiceId) &&
    vendorMatches(r.vendorName, name) &&
    String(r.invoiceDate || '').slice(0, 10) === String(date).slice(0, 10) &&
    sameAmount(r.totalAmount, amount));
  return hit ? { match: hit, reason: 'the same vendor, date and amount', certain: false } : null;
}

// An emailed document that already produced a record, checked BEFORE it is
// read. findDuplicate needs what the model read (number, date, amount), so it
// can only run after the model has been paid for; and a second reading that
// differs by a digit is not recognised at all. A mailbox reconnect, or someone
// marking old mail unread, delivers the same message again, and every
// attachment on it went back through the model and could come out as a new
// row. Two signals answer it without reading anything:
//
//   1. The same message: its Message-ID with the same attachment (by stored
//      filename), or, for a mail read from its body, the same Message-ID on a
//      row made from a body. Certain: it is the very email.
//   2. The same file: the SHA-256 of the attachment, by the profile's hash
//      rule. Catches the same PDF forwarded again under a new Message-ID.
//
// `filename` is the stored (sanitised) attachment name and is passed only for
// a PDF; `source` narrows the message match to rows made one way ('email' for
// a body). Returns { match, reason, certain } or null.
function findEmailDuplicate({ store, profile = null, messageId = null, filename, source, hash = null }) {
  if (messageId && typeof store.findByMessage === 'function' && (filename !== undefined || source !== undefined)) {
    const byMessage = store.findByMessage(messageId, { filename, source });
    if (byMessage) return { match: byMessage, reason: 'the same email (Message-ID) and attachment', certain: true };
  }
  const rules = profile?.dedup || { byHash: true };
  if (rules.byHash && hash && typeof store.findByReceiptHash === 'function') {
    const byHash = store.findByReceiptHash(hash);
    if (byHash) return { match: byHash, reason: 'the same file', certain: true };
  }
  return null;
}

module.exports = { hashBuffer, findDuplicate, findEmailDuplicate, sameAmount, vendorMatches };
