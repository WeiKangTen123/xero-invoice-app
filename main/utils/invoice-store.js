const fs   = require('fs');
const path = require('path');

const BASE_DIR = path.join(__dirname, '../data/users');
const MAX      = 500;

// Normalise a vendor name for dedup comparison.
// Strips honorifics, common legal suffixes, punctuation, and lowercases so that
// "BLCKLB PTE. LTD." and "blcklb Pte Ltd" are treated as the same vendor.
function _normalizeVendor(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/\b(mr|mrs|miss|ms|dr|prof)\.?\s+/g, '')
    .replace(/[\s.]+(?:pte\.?\s*ltd\.?|pvt\.?\s*ltd\.?|sdn\.?\s*bhd\.?|llc|inc|corp|co|ltd|gmbh|k\.k|bv|ag|sa|nv|oy|ab)\.?\s*$/g, '')
    .replace(/[.\s,]+/g, ' ')
    .trim();
}

// Cache store instances — one per userId, each with its own write mutex
const _stores = new Map();

function forUser(userId) {
  if (_stores.has(userId)) return _stores.get(userId);

  const FILE = path.join(BASE_DIR, userId, 'invoices.json');

  // Serialise all writes through a promise chain so concurrent callers never
  // clobber each other's updates on the JSON file.
  let _writeLock = Promise.resolve();

  function _withLock(fn) {
    const result = _writeLock.then(fn);
    _writeLock = result.catch(() => {});
    return result;
  }

  function read() {
    try {
      if (!fs.existsSync(FILE)) return [];
      return JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch { return []; }
  }

  function _write(list) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
  }

  function getAll()     { return read(); }
  function getById(id)  { return read().find(inv => inv.id === id) || null; }

  function add(invoice) {
    return _withLock(() => {
      const list = read();
      if (list.find(i => i.id === invoice.id)) return null;
      list.unshift(invoice);
      if (list.length > MAX) list.splice(MAX);
      _write(list);
      return invoice;
    });
  }

  function update(id, patch) {
    return _withLock(() => {
      const list = read();
      const idx  = list.findIndex(i => i.id === id);
      if (idx === -1) return null;
      list[idx] = { ...list[idx], ...patch };
      _write(list);
      return list[idx];
    });
  }

  function addReport(id, report) {
    return _withLock(() => {
      const list    = read();
      const idx     = list.findIndex(i => i.id === id);
      if (idx === -1) return null;
      const reports = list[idx].reports || [];
      reports.push({ ...report, reportedAt: new Date().toISOString() });
      list[idx] = { ...list[idx], status: 'reported', reports };
      _write(list);
      return list[idx];
    });
  }

  function getReported() { return read().filter(i => i.status === 'reported'); }

  // Returns all invoices that need human attention: user-flagged reports and
  // system-flagged parsing failures that could not be submitted to Xero.
  function getFlagged()  { return read().filter(i => i.status === 'reported' || i.status === 'review-needed'); }

  function remove(id) {
    return _withLock(() => {
      const list = read();
      const idx  = list.findIndex(i => i.id === id);
      if (idx === -1) return false;
      list.splice(idx, 1);
      _write(list);
      return true;
    });
  }

  // Core invoice-matching logic used by both findPosted and findStored.
  // Returns true when `inv` is a semantic match for the given invoice fields.
  function _matchesInvoice(inv, normV, invoiceNumber, invoiceDate, totalAmount) {
    const isAutoNum = !invoiceNumber ||
      invoiceNumber === '—' ||
      /^INV-\d{12,}$/.test(invoiceNumber);

    const normInvV = _normalizeVendor(inv.vendorName);

    if (isAutoNum) {
      return normInvV === normV &&
             inv.invoiceDate === invoiceDate &&
             Math.abs((inv.totalAmount || 0) - (totalAmount || 0)) < 0.01;
    }

    const invNumMatch = normInvV === normV &&
      (inv.invoiceNumber || '').toLowerCase() === (invoiceNumber || '').toLowerCase();
    if (invNumMatch) {
      // Same vendor + invoice# but meaningfully different amounts → treat as distinct invoices.
      // Allows same invoice rescanned (LLM rounding < 1%) while letting through corrections
      // or separate invoices that happen to share an invoice number across different currencies.
      const a = totalAmount || 0;
      const b = inv.totalAmount || 0;
      if (a > 0 && b > 0 && Math.abs(a - b) / Math.max(a, b) > 0.01) return false;
      return true;
    }

    const invIsAutoNum = !inv.invoiceNumber ||
      inv.invoiceNumber === '—' ||
      /^INV-\d{12,}$/.test(inv.invoiceNumber);
    if (invIsAutoNum && normInvV === normV && inv.invoiceDate === invoiceDate) {
      const a = totalAmount  || 0;
      const b = inv.totalAmount || 0;
      if (a === 0 || b === 0 || Math.abs(a - b) < 0.01) return true;
    }
    return false;
  }

  // Returns a posted record matching this invoice, or null.
  // Used as a guard inside the Xero submission queue to prevent re-posting.
  function findPosted(vendorName, invoiceNumber, invoiceDate, totalAmount) {
    const normV = _normalizeVendor(vendorName);
    return read().find(inv =>
      inv.status === 'posted' &&
      _matchesInvoice(inv, normV, invoiceNumber, invoiceDate, totalAmount)
    ) || null;
  }

  // Returns any already-stored record matching this invoice (posted, pending, or review-needed).
  // Used as an upfront guard in onInvoiceEmail to prevent storing duplicates on re-scans.
  function findStored(vendorName, invoiceNumber, invoiceDate, totalAmount) {
    const normV   = _normalizeVendor(vendorName);
    const exclude = new Set(['duplicate', 'error']);
    return read().find(inv =>
      !exclude.has(inv.status) &&
      _matchesInvoice(inv, normV, invoiceNumber, invoiceDate, totalAmount)
    ) || null;
  }

  // Atomically marks an invoice as 'submitting' if it isn't already posted or
  // in-flight. Returns { claimed: true } or { claimed: false, reason }.
  // All state checks + the write happen inside a single lock so two concurrent
  // callers can never both claim the same invoice.
  function claimForSubmit(id) {
    return _withLock(() => {
      const list = read();
      const idx  = list.findIndex(i => i.id === id);
      if (idx === -1)                         return { claimed: false, reason: 'not found' };
      if (list[idx].status === 'posted')      return { claimed: false, reason: 'already posted', xeroInvoiceId: list[idx].xeroInvoiceId };
      if (list[idx].status === 'submitting')  return { claimed: false, reason: 'already submitting' };
      list[idx] = { ...list[idx], status: 'submitting', errorMsg: null };
      _write(list);
      return { claimed: true };
    });
  }

  function clear() { return _withLock(() => _write([])); }

  const store = { getAll, getById, add, update, addReport, getReported, getFlagged, remove, clear, findPosted, findStored, claimForSubmit };
  _stores.set(userId, store);
  return store;
}

module.exports = { forUser };
