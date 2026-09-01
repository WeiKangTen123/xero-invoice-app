const db  = require('../db');
const MAX = 500;

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

// ── Row <-> JS record mapping ─────────────────────────────────────────────────
// DB columns are snake_case; every field the rest of the app reads/writes on an
// invoice record is camelCase (unchanged from the old invoices.json shape).

const COLUMNS = [
  'id', 'user_id', 'status', 'has_pdf', 'pdf_filename', 'vendor_name', 'contact_name',
  'contact_email', 'contact_address', 'invoice_number', 'invoice_date', 'due_date',
  'total_amount', 'currency', 'invoice_type', 'source', 'source_email',
  'description', 'account_code', 'tax_amount', 'sub_total', 'payment_reference',
  'xero_invoice_id', 'error_msg', 'duplicate_of', 'resolved_by', 'resolved_at',
  'submitted_at', 'processed_at', 'updated_at',
];

const FIELD_TO_COLUMN = {
  id: 'id', userId: 'user_id', status: 'status', hasPdf: 'has_pdf',
  pdfFilename: 'pdf_filename', vendorName: 'vendor_name', contactName: 'contact_name',
  contactEmail: 'contact_email', contactAddress: 'contact_address',
  invoiceNumber: 'invoice_number', invoiceDate: 'invoice_date', dueDate: 'due_date',
  totalAmount: 'total_amount', currency: 'currency', invoiceType: 'invoice_type',
  source: 'source', sourceEmail: 'source_email',
  description: 'description', accountCode: 'account_code', taxAmount: 'tax_amount',
  subTotal: 'sub_total', paymentReference: 'payment_reference',
  xeroInvoiceId: 'xero_invoice_id', errorMsg: 'error_msg', duplicateOf: 'duplicate_of',
  resolvedBy: 'resolved_by', resolvedAt: 'resolved_at', submittedAt: 'submitted_at',
  processedAt: 'processed_at', updatedAt: 'updated_at',
  // Expense claims. Kept separate from pdfFilename rather than overloading it:
  // a bill's PDF and a claim's receipt are attached to Xero by different paths
  // and a single field would hide which one a row actually has.
  receiptFile: 'receipt_file', receiptMime: 'receipt_mime',
};

// total_amount/tax_amount/sub_total are persisted as integer cents (see schema.sql)
// but every caller outside this file works in decimal dollars — these two helpers
// are the only place that boundary is crossed.
const MONEY_FIELDS = new Set(['totalAmount', 'taxAmount', 'subTotal']);
function _dollarsToCents(value) { return Math.round((Number(value) || 0) * 100); }
function _centsToDollars(value) { return Math.round(value || 0) / 100; }

// better-sqlite3 can only bind numbers/strings/bigints/buffers/null — booleans and
// undefined (both of which show up on invoice records, e.g. hasPdf) need coercing.
function _toBindable(field, value) {
  if (MONEY_FIELDS.has(field)) return _dollarsToCents(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

function _rowToRecord(row, reports, lineItems) {
  if (!row) return null;
  return {
    id:                row.id,
    status:            row.status,
    hasPdf:            !!row.has_pdf,
    pdfFilename:       row.pdf_filename,
    vendorName:        row.vendor_name,
    contactName:       row.contact_name,
    contactEmail:      row.contact_email,
    contactAddress:    row.contact_address,
    invoiceNumber:     row.invoice_number,
    invoiceDate:       row.invoice_date,
    dueDate:           row.due_date,
    totalAmount:       _centsToDollars(row.total_amount),
    currency:          row.currency,
    invoiceType:       row.invoice_type,
    source:            row.source,
    sourceEmail:       row.source_email,
    lineItems:         lineItems || [],
    description:       row.description,
    accountCode:       row.account_code,
    taxAmount:         _centsToDollars(row.tax_amount),
    subTotal:          _centsToDollars(row.sub_total),
    paymentReference:  row.payment_reference,
    xeroInvoiceId:     row.xero_invoice_id,
    errorMsg:          row.error_msg,
    duplicateOf:       row.duplicate_of,
    resolvedBy:        row.resolved_by,
    resolvedAt:        row.resolved_at,
    submittedAt:       row.submitted_at,
    processedAt:       row.processed_at,
    receiptFile:       row.receipt_file,
    receiptMime:       row.receipt_mime,
    reports:           reports || [],
  };
}

function forUser(userId) {
  function _reportsFor(invoiceId) {
    return db.prepare(`
      SELECT user_email AS userEmail, note, reported_at AS reportedAt
      FROM invoice_reports WHERE invoice_id = ? ORDER BY id
    `).all(invoiceId);
  }

  function _lineItemsFor(invoiceId) {
    return db.prepare(`
      SELECT description, unit_amount AS unitAmount, discount_rate AS discountRate
      FROM invoice_line_items WHERE invoice_id = ? ORDER BY sort_order
    `).all(invoiceId).map(li => ({ ...li, unitAmount: _centsToDollars(li.unitAmount) }));
  }

  function _replaceLineItems(invoiceId, lineItems) {
    db.prepare('DELETE FROM invoice_line_items WHERE invoice_id = ?').run(invoiceId);
    const insert = db.prepare(`
      INSERT INTO invoice_line_items (invoice_id, sort_order, description, unit_amount, discount_rate)
      VALUES (?, ?, ?, ?, ?)
    `);
    (lineItems || []).forEach((item, i) => {
      insert.run(invoiceId, i, item.description ?? null, _dollarsToCents(item.unitAmount), item.discountRate ?? null);
    });
  }

  function _hydrate(row) { return row ? _rowToRecord(row, _reportsFor(row.id), _lineItemsFor(row.id)) : null; }

  // Batched version of _hydrate for a whole row set — one query for all reports
  // (and line items) instead of one query per invoice. getAll/getReported/getFlagged/
  // findPosted/findStored all fan out over every matching invoice, so without this
  // each of those calls issued 1 + N queries (N = invoice count, up to 500/user).
  function _hydrateMany(rows) {
    if (!rows.length) return [];
    const placeholders = rows.map(() => '?').join(',');
    const ids = rows.map(r => r.id);

    const reportRows = db.prepare(`
      SELECT invoice_id AS invoiceId, user_email AS userEmail, note, reported_at AS reportedAt
      FROM invoice_reports WHERE invoice_id IN (${placeholders}) ORDER BY id
    `).all(...ids);
    const reportsByInvoice = new Map();
    for (const r of reportRows) {
      if (!reportsByInvoice.has(r.invoiceId)) reportsByInvoice.set(r.invoiceId, []);
      reportsByInvoice.get(r.invoiceId).push({ userEmail: r.userEmail, note: r.note, reportedAt: r.reportedAt });
    }

    const lineItemRows = db.prepare(`
      SELECT invoice_id AS invoiceId, description, unit_amount AS unitAmount, discount_rate AS discountRate
      FROM invoice_line_items WHERE invoice_id IN (${placeholders}) ORDER BY invoice_id, sort_order
    `).all(...ids);
    const lineItemsByInvoice = new Map();
    for (const li of lineItemRows) {
      if (!lineItemsByInvoice.has(li.invoiceId)) lineItemsByInvoice.set(li.invoiceId, []);
      lineItemsByInvoice.get(li.invoiceId).push({
        description: li.description, unitAmount: _centsToDollars(li.unitAmount), discountRate: li.discountRate,
      });
    }

    return rows.map(row => _rowToRecord(row, reportsByInvoice.get(row.id) || [], lineItemsByInvoice.get(row.id) || []));
  }

  function getAll() {
    const rows = db.prepare('SELECT * FROM invoices WHERE user_id = ? ORDER BY rowid DESC').all(userId);
    return _hydrateMany(rows);
  }

  function getById(id) {
    const row = db.prepare('SELECT * FROM invoices WHERE id = ? AND user_id = ?').get(id, userId);
    return _hydrate(row);
  }

  function add(invoice) {
    const existing = db.prepare('SELECT 1 FROM invoices WHERE id = ? AND user_id = ?').get(invoice.id, userId);
    if (existing) return null;

    const cols = ['id', 'user_id'];
    const vals = [invoice.id, userId];
    for (const [field, column] of Object.entries(FIELD_TO_COLUMN)) {
      if (field === 'id' || field === 'userId' || !(field in invoice)) continue;
      cols.push(column);
      vals.push(_toBindable(field, invoice[field]));
    }
    if (!cols.includes('processed_at')) { cols.push('processed_at'); vals.push(new Date().toISOString()); }

    const placeholders = cols.map(() => '?').join(', ');
    db.prepare(`INSERT INTO invoices (${cols.join(', ')}) VALUES (${placeholders})`).run(...vals);
    if ('lineItems' in invoice) _replaceLineItems(invoice.id, invoice.lineItems);

    // Enforce the same MAX-500-per-user cap the old JSON store had.
    db.prepare(`
      DELETE FROM invoices WHERE user_id = ? AND id NOT IN (
        SELECT id FROM invoices WHERE user_id = ? ORDER BY rowid DESC LIMIT ?
      )
    `).run(userId, userId, MAX);

    return getById(invoice.id);
  }

  function update(id, patch) {
    const existing = db.prepare('SELECT 1 FROM invoices WHERE id = ? AND user_id = ?').get(id, userId);
    if (!existing) return null;

    const sets = ['updated_at = ?'];
    const args = [new Date().toISOString()];
    for (const [field, value] of Object.entries(patch)) {
      if (field === 'lineItems') continue; // handled separately below (child table, not a column)
      const column = FIELD_TO_COLUMN[field];
      if (!column || column === 'id' || column === 'user_id') continue;
      sets.push(`${column} = ?`);
      args.push(_toBindable(field, value));
    }
    db.prepare(`UPDATE invoices SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...args, id, userId);
    if ('lineItems' in patch) _replaceLineItems(id, patch.lineItems);
    return getById(id);
  }

  function addReport(id, report) {
    const existing = getById(id);
    if (!existing) return null;
    db.prepare(`
      INSERT INTO invoice_reports (invoice_id, user_email, note, reported_at)
      VALUES (?, ?, ?, ?)
    `).run(id, report.userEmail, report.note, new Date().toISOString());
    return update(id, { status: 'reported' });
  }

  function getReported() {
    const rows = db.prepare('SELECT * FROM invoices WHERE user_id = ? AND status = ?').all(userId, 'reported');
    return _hydrateMany(rows);
  }

  // Returns all invoices that need human attention: user-flagged reports and
  // system-flagged parsing failures that could not be submitted to Xero.
  function getFlagged() {
    const rows = db.prepare("SELECT * FROM invoices WHERE user_id = ? AND status IN ('reported', 'review-needed')").all(userId);
    return _hydrateMany(rows);
  }

  function remove(id) {
    const info = db.prepare('DELETE FROM invoices WHERE id = ? AND user_id = ?').run(id, userId);
    return info.changes > 0;
  }

  // Core invoice-matching logic used by both findPosted and findStored.
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
  function findPosted(vendorName, invoiceNumber, invoiceDate, totalAmount) {
    const normV = _normalizeVendor(vendorName);
    const rows = db.prepare("SELECT * FROM invoices WHERE user_id = ? AND status = 'posted'").all(userId);
    const candidates = _hydrateMany(rows);
    return candidates.find(inv => _matchesInvoice(inv, normV, invoiceNumber, invoiceDate, totalAmount)) || null;
  }

  // Returns any already-stored record matching this invoice (posted, pending, or review-needed).
  function findStored(vendorName, invoiceNumber, invoiceDate, totalAmount) {
    const normV = _normalizeVendor(vendorName);
    const rows = db.prepare("SELECT * FROM invoices WHERE user_id = ? AND status NOT IN ('duplicate', 'error')").all(userId);
    const candidates = _hydrateMany(rows);
    return candidates.find(inv => _matchesInvoice(inv, normV, invoiceNumber, invoiceDate, totalAmount)) || null;
  }

  // Atomically marks an invoice as 'submitting' if it isn't already in-flight.
  // A 'posted' invoice CAN be re-claimed — that's a deliberate re-post of a correction,
  // which the Xero layer routes to an update-in-place using the stored xeroInvoiceId
  // rather than creating a duplicate bill (see queue/processor.js submitDraftInvoice).
  // better-sqlite3 is synchronous, so the whole select-then-write happens on one tick
  // of the single-threaded event loop — no other call can interleave.
  function claimForSubmit(id) {
    const claim = db.transaction(() => {
      const row = db.prepare('SELECT status FROM invoices WHERE id = ? AND user_id = ?').get(id, userId);
      if (!row) return { claimed: false, reason: 'not found' };
      if (row.status === 'submitting') return { claimed: false, reason: 'already submitting' };
      db.prepare("UPDATE invoices SET status = 'submitting', error_msg = NULL WHERE id = ? AND user_id = ?").run(id, userId);
      return { claimed: true };
    });
    return claim();
  }

  function clear() {
    db.prepare('DELETE FROM invoices WHERE user_id = ?').run(userId);
  }

  return { getAll, getById, add, update, addReport, getReported, getFlagged, remove, clear, findPosted, findStored, claimForSubmit };
}

module.exports = { forUser, FIELD_TO_COLUMN, _toBindable }; // exposed for the one-time JSON->SQLite importer
