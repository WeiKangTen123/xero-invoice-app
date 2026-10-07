// What a change to a record says in its history: one sentence a bookkeeper
// can read, and the facts behind it. utils/audit-log.js stores them.
//
// Most events are written from the store (invoice-store.js), where every
// route, the chat assistant and the background readers already meet: a
// record created, its business fields edited, its status moved, a duplicate
// marked or cleared, a hold placed or released, a report resolved, what Xero
// said had become of it, and its deletion. What the store cannot know is
// written where it is known: how a send to Xero went (invoice-handler.js),
// that a split was merged back (routes/receipts.js), and the note on a report.
//
// Every function here records and returns nothing, and callers run them
// through auditLog.safely: a mistake in describing a change must never undo
// the change.
const db       = require('../db');
const auditLog = require('./audit-log');
const { SYSTEM } = require('./audit-context');

// The fields whose before and after are kept: what a record is worth and who
// it is with. Free text (description, address), files and the app's own
// bookkeeping (status, notes, timestamps) are left out; status has events of
// its own below. [field, column, label, kind]
const TRACKED = [
  ['vendorName',       'vendor_name',       'vendor'],
  ['contactName',      'contact_name',      'contact'],
  ['contactEmail',     'contact_email',     'contact email'],
  ['invoiceNumber',    'invoice_number',    'number'],
  ['invoiceDate',      'invoice_date',      'date'],
  ['dueDate',          'due_date',          'due date'],
  ['totalAmount',      'total_amount',      'total',    'money'],
  ['subTotal',         'sub_total',         'subtotal', 'money'],
  ['taxAmount',        'tax_amount',        'tax',      'money'],
  ['currency',         'currency',          'currency'],
  ['accountCode',      'account_code',      'account'],
  ['invoiceType',      'invoice_type',      'type'],
  // Bank details: the field a fraudulent bill changes.
  ['paymentReference', 'payment_reference', 'payment details'],
  ['claimQuantity',    'claim_quantity',    'quantity', 'number'],
  ['xeroTenantId',     'xero_tenant_id',    'company'],
];

const STATUS_WORDS = {
  pending: 'pending', reviewed: 'reviewed', reported: 'reported', 'review-needed': 'needs review',
  error: 'failed', posted: 'posted', duplicate: 'duplicate', submitting: 'sending',
};

const VALUE_MAX = 120;

const _clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const _cents = v => Math.round((Number(v) || 0) * 100);
const _money = cents => (Math.round(Number(cents) || 0) / 100).toFixed(2);
const _text = v => String(v ?? '').trim();

// A value in the form the column holds, for comparing: cents for money.
function _stored(kind, value) {
  if (kind === 'money') return value === null || value === undefined ? 0 : Math.round(Number(value) || 0);
  if (kind === 'number') return value === null || value === undefined || value === '' ? null : Number(value);
  return _text(value);
}
function _incoming(kind, value) {
  if (kind === 'money') return _cents(value);
  if (kind === 'number') return value === null || value === undefined || value === '' ? null : Number(value);
  return _text(value);
}
// As shown in the history: money to two places, nothing as null ("—").
function _shown(kind, stored) {
  if (kind === 'money') return _money(stored);
  if (stored === null || stored === undefined || stored === '') return null;
  return _clip(String(stored), VALUE_MAX);
}

// A list in prose: "vendor, total and account".
function _list(words) {
  if (words.length <= 1) return words.join('');
  if (words.length > 4) return `${words.slice(0, 3).join(', ')} and ${words.length - 3} more`;
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function _lines(count, cents) {
  return `${count} line${count === 1 ? '' : 's'}, ${_money(cents)}`;
}

// How another record is named in a sentence: its number and contact, or its id.
function _ref(userId, id) {
  if (!id) return 'another record';
  try {
    const r = db.prepare('SELECT invoice_number, vendor_name FROM invoices WHERE id = ? AND user_id = ?').get(id, userId);
    const number = r && r.invoice_number && r.invoice_number !== '—' ? r.invoice_number : null;
    const label = [number, r && r.vendor_name ? `(${r.vendor_name})` : null].filter(Boolean).join(' ');
    return label || id;
  } catch (_) {
    return id;
  }
}

// A connected company's name, or its id when it is not on file.
function _tenantName(userId, tenantId) {
  if (!tenantId) return null;
  try {
    const t = (require('./token-cache').getPersistedTenants(userId) || [])
      .find(x => String(x.tenantId ?? x.tenant_id) === String(tenantId));
    return (t && (t.tenantName ?? t.tenant_name)) || String(tenantId);
  } catch (_) {
    return String(tenantId);
  }
}

// "Acme Ltd INV-1, SGD 120.00" from a record (camelCase) or a row (snake_case).
function _what(rec) {
  const vendor = rec.vendorName ?? rec.vendor_name ?? rec.contactName ?? rec.contact_name;
  const number = rec.invoiceNumber ?? rec.invoice_number;
  const kind   = rec.claimKind ?? rec.claim_kind;
  const cents  = rec.total_amount !== undefined ? rec.total_amount : _cents(rec.totalAmount);
  const name = [vendor || (kind === 'mileage' ? 'Mileage claim' : kind === 'per_diem' ? 'Per diem claim' : null),
    number && number !== '—' ? number : null].filter(Boolean).join(' ');
  const amount = cents ? `${rec.currency ? `${rec.currency} ` : ''}${_money(cents)}` : null;
  return [name, amount].filter(Boolean).join(', ');
}

function _facts(rec) {
  const cents = rec.total_amount !== undefined ? rec.total_amount : _cents(rec.totalAmount);
  return {
    vendorName:    (rec.vendorName ?? rec.vendor_name) || null,
    invoiceNumber: (rec.invoiceNumber ?? rec.invoice_number) || null,
    totalAmount:   cents ? Number(_money(cents)) : 0,
    currency:      rec.currency || null,
    invoiceType:   (rec.invoiceType ?? rec.invoice_type) || null,
  };
}

// ── Created ──────────────────────────────────────────────────────────────────

// How a record came to be, from where it came from. `how` is what only the
// caller knows: 'split' for a receipt split off another in the same upload.
function _origin(record, how) {
  if (how === 'split') {
    return record.receiptPage
      ? `Created by splitting an upload into separate receipts (page ${record.receiptPage})`
      : 'Created by splitting a photo into separate receipts';
  }
  if (record.claimKind === 'mileage')  return 'Mileage claim added';
  if (record.claimKind === 'per_diem') return 'Per diem claim added';
  const from = record.sourceEmail ? ` (from ${record.sourceEmail})` : '';
  switch (record.source) {
    case 'pdf':         return `Created from an emailed PDF${from}`;
    case 'email':       return `Created from an email${from}`;
    case 'email-image': return `Created from a photo sent by email${from}`;
    case 'upload':      return record.invoiceType === 'EXPENSE' ? 'Created from an uploaded receipt' : 'Created from an uploaded PDF';
    case 'phone':       return 'Created from a phone capture';
    case 'form':        return record.invoiceType === 'ACCREC' ? 'Invoice typed in' : 'Typed in';
    case 'spreadsheet': return 'Created from a spreadsheet import';
    case 'claim':       return 'Created from a claim import';
    default:            return 'Created';
  }
}

const PREFILL_WORDS = { accountCode: 'account', currency: 'currency', xeroTenantId: 'company' };

// A mileage or per diem claim has no vendor or number; what it is, is how
// far or how long, and what that came to: "42 km, SGD 25.20".
function _allowance(record) {
  const q = Number(record.claimQuantity);
  const unit = record.claimUnit || (record.claimKind === 'mileage' ? 'km' : 'day');
  const qty = Number.isFinite(q) && q > 0 ? `${q} ${unit === 'day' && q !== 1 ? 'days' : unit}` : null;
  const cents = _cents(record.totalAmount);
  return [qty, cents ? `${record.currency ? `${record.currency} ` : ''}${_money(cents)}` : null].filter(Boolean).join(', ');
}

function created(userId, record, { how = null } = {}) {
  const origin = _origin(record, how);
  const what = record.claimKind === 'mileage' || record.claimKind === 'per_diem' ? _allowance(record) : _what(record);
  let text = what ? `${origin}: ${what}` : origin;

  const prefilled = record.prefilledFrom && typeof record.prefilledFrom === 'object' ? record.prefilledFrom : null;
  const fields = prefilled ? Object.keys(prefilled) : [];
  if (fields.length) {
    const from = prefilled[fields[0]] || {};
    const last = record.invoiceType === 'ACCREC' ? 'last invoice' : 'last bill';
    text += `. Prefilled from the ${last}${from.fromNumber ? ` (${from.fromNumber})` : ''}: ${_list(fields.map(f => PREFILL_WORDS[f] || f))}`;
  }
  if (record.status === 'duplicate') text += `. Marked as a duplicate of ${_ref(userId, record.duplicateOf)}`;
  else if (record.duplicateOf) text += `. Possible duplicate of ${_ref(userId, record.duplicateOf)}`;

  auditLog.recordInvoiceEvent({
    userId, invoiceId: record.id, action: 'created', summary: text,
    details: {
      source: record.source || null, how: how || null, status: record.status || null,
      sourceEmail: record.sourceEmail || null, claimKind: record.claimKind || null,
      ..._facts(record),
      ...(fields.length ? { prefilledFrom: prefilled } : {}),
      ...(record.duplicateOf ? { duplicateOf: record.duplicateOf } : {}),
    },
  });
}

// ── Updated ──────────────────────────────────────────────────────────────────

// Business fields this patch actually changes, before and after. The review
// page sends its whole form on Save, so a field counts only when its value
// differs from what was stored.
function _changes(existing, patch, lines) {
  const changes = [];
  for (const [field, column, label, kind] of TRACKED) {
    if (patch[field] === undefined) continue;
    const before = _stored(kind, existing[column]);
    const after  = _incoming(kind, patch[field]);
    if (before === after) continue;
    changes.push({ field, label, from: _shown(kind, before), to: _shown(kind, after) });
  }
  if (lines && Array.isArray(patch.lineItems)) {
    const count = patch.lineItems.length;
    const cents = patch.lineItems.reduce((s, li) => s + _cents(li && li.unitAmount), 0);
    if (count !== lines.count || cents !== lines.cents) {
      changes.push({ field: 'lineItems', label: 'lines', from: _lines(lines.count, lines.cents), to: _lines(count, cents) });
    }
  }
  return changes;
}

const _reason = msg => _clip(_text(msg).replace(/^Please check:\s*/i, ''), 160);

// The status events one patch makes, most specific first. A resolution is
// one event whatever else moved with it; a duplicate marked or cleared is
// one; otherwise a hold, a release or a plain move, and separately a
// duplicate flag set or cleared without the status moving.
function _statusEvents(userId, existing, patch) {
  const out  = [];
  const from = existing.status;
  const to   = patch.status !== undefined ? patch.status : from;
  const moved = to !== from;
  const dupBefore = existing.duplicate_of || null;
  const dupAfter  = patch.duplicateOf !== undefined ? (patch.duplicateOf || null) : dupBefore;
  const hadHold   = from === 'review-needed' && !!_text(existing.error_msg);

  if (patch.resolvedAt) {
    out.push({
      action: 'report.resolved',
      summary: `Report resolved${moved ? `; now ${STATUS_WORDS[to] || to}` : ''}`,
      details: { resolvedBy: patch.resolvedBy || null, from, to },
    });
    return out;
  }

  if (to === 'duplicate' && (moved || dupAfter !== dupBefore)) {
    out.push({ action: 'duplicate.marked', summary: `Marked as a duplicate of ${_ref(userId, dupAfter)}`, details: { duplicateOf: dupAfter } });
    return out;
  }
  if (from === 'duplicate' && moved) {
    out.push({ action: 'duplicate.cleared', summary: `Confirmed not a duplicate; now ${STATUS_WORDS[to] || to}`, details: { duplicateOf: dupBefore, from, to } });
    return out;
  }

  if (dupAfter && dupAfter !== dupBefore) {
    out.push({ action: 'duplicate.flagged', summary: `Flagged as a possible duplicate of ${_ref(userId, dupAfter)}`, details: { duplicateOf: dupAfter } });
  } else if (!dupAfter && dupBefore) {
    out.push({ action: 'duplicate.cleared', summary: 'Duplicate flag cleared', details: { duplicateOf: dupBefore } });
  }

  // A hold: the record put (or kept) at needs review with a reason. Intake
  // holds a bill whose bank details changed, or that it could not read, by
  // writing the reason with the status; an upload is already at needs review,
  // so a new reason on its own counts too.
  const newReason = patch.errorMsg && _text(patch.errorMsg) !== _text(existing.error_msg) ? patch.errorMsg : null;
  if (to === 'review-needed' && (moved || newReason) && patch.status !== undefined) {
    if (newReason && /bank details differ/i.test(newReason)) {
      out.push({ action: 'hold', summary: "Held: bank details differ from the supplier's last bill", details: { kind: 'bank', reason: _reason(newReason) } });
    } else if (newReason) {
      out.push({ action: 'hold', summary: `Held for review: ${_reason(newReason)}`, details: { kind: 'review', reason: _reason(newReason) } });
    } else {
      out.push({ action: 'status', summary: 'Marked as needing review', details: { from, to } });
    }
    return out;
  }
  if (!moved) return out;

  if (to === 'reviewed') {
    out.push(hadHold
      ? { action: 'hold.released', summary: 'Marked reviewed, releasing the hold', details: { from, to, reason: _reason(existing.error_msg) } }
      : { action: 'reviewed', summary: 'Marked reviewed', details: { from, to } });
  } else if (to === 'pending') {
    out.push(hadHold
      ? { action: 'hold.released', summary: 'Moved to pending, releasing the hold', details: { from, to, reason: _reason(existing.error_msg) } }
      : { action: 'status', summary: 'Moved back to pending', details: { from, to } });
  } else if (to === 'reported') {
    out.push({ action: 'reported', summary: 'Marked as reported', details: { from, to } });
  } else {
    out.push({ action: 'status', summary: `Status changed from ${STATUS_WORDS[from] || from} to ${STATUS_WORDS[to] || to}`, details: { from, to } });
  }
  return out;
}

// Called by invoice-store update() after its write. `existing` is the row as
// it was; `lines` the line count and total before, when the patch carried
// line items. `withStatus` false leaves status to the caller (addReport).
function updated(userId, id, existing, patch, { lines = null, withStatus = true } = {}) {
  // The patch that ends a send: how it went is the handler's to say, with
  // the Xero ID and company it got, so the store adds nothing.
  if (existing.status === 'submitting' && patch.status !== undefined && patch.status !== 'submitting') return;

  const changes = _changes(existing, patch, lines);
  if (changes.length) {
    for (const c of changes) {
      if (c.field === 'xeroTenantId') { c.from = _tenantName(userId, c.from); c.to = _tenantName(userId, c.to); }
    }
    auditLog.recordInvoiceEvent({
      userId, invoiceId: id, action: 'edited',
      summary: `Changed ${_list(changes.map(c => c.label))}`,
      details: { changes },
    });
  }
  if (!withStatus) return;
  for (const e of _statusEvents(userId, existing, patch)) {
    auditLog.recordInvoiceEvent({ userId, invoiceId: id, ...e });
  }
}

// ── Reported, merged, deleted ────────────────────────────────────────────────

function reported(userId, id, note) {
  const text = _clip(_text(note), 160);
  auditLog.recordInvoiceEvent({
    userId, invoiceId: id, action: 'reported',
    summary: text ? `Reported a problem: ${text}` : 'Reported a problem',
    details: { note: _clip(_text(note), 500) },
  });
}

function merged(userId, id, removed) {
  auditLog.recordInvoiceEvent({
    userId, invoiceId: id, action: 'merged',
    summary: `Split merged back into one record (${removed} other part${removed === 1 ? '' : 's'} removed)`,
    details: { removed },
  });
}

// `row` is the record as it was, read just before it went. `bulk` names the
// bulk action when the store itself is that action (Clear all).
function deleted(userId, id, row, { bulk = null, via = null } = {}) {
  const what = row ? _what(row) : '';
  const lead = via === 'merge' ? 'Deleted when the split was merged back' : 'Deleted';
  auditLog.recordInvoiceEvent({
    userId, invoiceId: id, action: 'deleted',
    summary: what ? `${lead}: ${what}` : lead,
    details: { ...(row ? _facts(row) : {}), status: row ? row.status : null, ...(bulk ? { bulk } : {}) },
  });
}

// ── Xero ─────────────────────────────────────────────────────────────────────

function xeroSent(userId, id, { mode, xeroInvoiceId, tenantId, tenantName }) {
  const company = tenantName || _tenantName(userId, tenantId);
  const where = company ? ` in ${company}` : '';
  auditLog.recordInvoiceEvent({
    userId, invoiceId: id, action: 'xero.sent',
    summary: mode === 'update'
      ? `Correction sent to Xero, updating the draft${where}`
      : `Sent to Xero as a new draft${where}${xeroInvoiceId ? ` (Xero ID ${xeroInvoiceId})` : ''}`,
    details: { mode, xeroInvoiceId: xeroInvoiceId || null, tenantId: tenantId || null, tenantName: company || null },
  });
}

function xeroNotSent(userId, id, { inXero }) {
  auditLog.recordInvoiceEvent({
    userId, invoiceId: id, action: 'xero.not_sent',
    summary: inXero ? 'Correction not sent: Xero is not connected' : 'Not sent: no Xero company is connected',
    details: { inXero: !!inXero },
  });
}

function xeroFailed(userId, id, { reason, inXero }) {
  const why = _clip(_text(reason), 200);
  auditLog.recordInvoiceEvent({
    userId, invoiceId: id, action: 'xero.failed',
    summary: `${inXero ? 'Sending the correction to Xero failed' : 'Sending to Xero failed'}${why ? `: ${why}` : ''}`,
    details: { reason: _clip(_text(reason), 500), inXero: !!inXero },
  });
}

// Sends a restart cut off (invoice-store releaseInterrupted). Whether they
// reached Xero is unknown, which is the point of saying so.
function interrupted(userId, id, { inXero }) {
  auditLog.recordInvoiceEvent({
    userId, invoiceId: id, action: inXero ? 'xero.failed' : 'hold',
    summary: inXero
      ? 'Correction send was interrupted by a restart; check Xero before sending again'
      : 'Held: sending to Xero was interrupted by a restart; check Xero before sending again',
    details: { kind: 'interrupted', inXero: !!inXero },
    actor: SYSTEM,
  });
}

// What Xero says now against what was stored, both as the columns hold them
// (status, cents due and paid, paid-on day). Only a change a person would
// want to know of is written: the first look at a new draft is not one.
function xeroStatus(userId, id, before, after, currency = null) {
  const was = before.xero_status || null;
  const now = after.xero_status || null;
  const cur = currency ? `${currency} ` : '';
  const paid = after.xero_amount_paid;
  const due  = after.xero_amount_due;
  const partPaid = `Part-paid in Xero: ${cur}${_money(paid)} paid, ${cur}${_money(due)} still due`;

  let summary = null;
  if (now !== was) {
    if (now === 'DRAFT' && !was) return;
    switch (now) {
      case 'DRAFT':      summary = 'Back to draft in Xero'; break;
      case 'SUBMITTED':  summary = 'Submitted for approval in Xero'; break;
      case 'AUTHORISED': summary = paid > 0 ? partPaid : 'Approved in Xero'; break;
      case 'PAID':       summary = `Paid in Xero${after.xero_paid_on ? ` on ${after.xero_paid_on}` : ''}`; break;
      case 'VOIDED':     summary = 'Voided in Xero'; break;
      case 'DELETED':    summary = 'Deleted in Xero'; break;
      default:           summary = `Xero status is now ${now}`;
    }
  } else if (!was) {
    return;
  } else if (paid !== before.xero_amount_paid && paid > 0) {
    summary = partPaid;
  } else if (due !== before.xero_amount_due) {
    summary = `Amount due in Xero is now ${cur}${_money(due)}`;
  } else if (after.xero_paid_on !== before.xero_paid_on && after.xero_paid_on) {
    summary = `Paid in Xero on ${after.xero_paid_on}`;
  } else {
    return;
  }

  const view = r => ({
    status: r.xero_status || null,
    amountDue: r.xero_amount_due === null || r.xero_amount_due === undefined ? null : Number(_money(r.xero_amount_due)),
    amountPaid: r.xero_amount_paid === null || r.xero_amount_paid === undefined ? null : Number(_money(r.xero_amount_paid)),
    paidOn: r.xero_paid_on || null,
  });
  auditLog.recordInvoiceEvent({
    userId, invoiceId: id, action: 'xero.status', summary,
    details: { from: view(before), to: view(after) },
    // What Xero reports is Xero's doing, whoever pressed Refresh.
    actor: SYSTEM,
  });
}

module.exports = {
  created, updated, reported, merged, deleted, xeroSent, xeroNotSent, xeroFailed, interrupted, xeroStatus,
  TRACKED,
};
