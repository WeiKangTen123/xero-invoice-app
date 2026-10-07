// Per-supplier memory: a new bill (or sales invoice) from a contact the user
// has dealt with before starts from what the user settled last time, rather
// than from the Setup defaults.
//
// The source is one record: the newest from the same contact (names compared
// as the duplicate checks compare them) and of the same type that a person
// settled — sent to Xero and not voided or deleted there, or marked reviewed
// (invoice-store lastSettledFrom). Claims never take part. A claim is one
// purchase by one person, not a supplier relationship, and a receipt from a
// café says nothing about how the next one should be coded.
//
// What is remembered, and only where the new document did not say:
//
//   accountCode   What the last one was coded to. Lines carry no account of
//                 their own in the store today (one account per document,
//                 sent on every line), so this is the header account; the
//                 line rule below is there for a source that does carry them.
//   currency      Only when the document did not state one: a supplier who
//                 bills in USD on a PDF that prints a bare "$" should not
//                 become SGD because that is the account's default.
//   xeroTenantId  The company it went to, while that company is still
//                 connected. Posting treats it as a suggestion: if the company
//                 has gone by then, the usual choice applies (queue/processor).
//
// Tax is not remembered. A record stores no tax type, and what was posted is
// not kept either: it is resolved at posting from the figures, with the Xero
// contact's own AP/AR tax type preferred among equal rates
// (xero/invoices.js resolveTaxType). That already follows the contact.
//
// Precedence for the account, highest first: what the document or a person
// set; this memory; the Xero contact's default account; Setup's default. The
// last two are decided at posting (xero/invoices.js buildLineItems), which is
// why intake no longer writes the Setup default onto the record: written
// there, it always won, and the contact's default never applied.
//
// Every field filled from memory is recorded on the record as prefilledFrom,
// with the record it came from, so the review page can say "from last bill
// (INV-123, 3 Sep)" and link to it. Changing the field drops that entry
// (invoice-store update).

const { currencyCode } = require('../intake/document');
const logger = require('./logger');

// Names the readers use when they found none. Every unnamed bill would
// otherwise be "the same supplier" as every other unnamed bill.
const NO_NAME = /^unknown(?:\s+(?:vendor|supplier|customer|merchant))?$/i;

// The Setup default account for a kind of document: the one posting falls back
// to when neither the record nor the Xero contact names one. A sales invoice
// uses the invoice default and everything else the bill default, which is the
// rule buildLineItems applies (a claim posts as a bill).
function setupAccountFor(defaults, invoiceType) {
  const codes = defaults?.accountCode || {};
  return invoiceType === 'ACCREC' ? codes.invoice : codes.bill;
}

// Every account Setup would supply on its own, of any kind. The bill reader
// puts the bill default on every document it reads (it reads no account from
// the page), so a value equal to one of these is Setup speaking, not the
// document; the same goes for rows stored before this module, which carry the
// default intake used to write.
function setupAccountCodes(defaults) {
  return new Set(Object.values(defaults?.accountCode || {}).filter(Boolean).map(c => String(c).trim()));
}

// An account the document itself named: the given one, unless it is only a
// Setup default the reader filled in. '' when there is none.
function documentAccountCode(accountCode, defaults) {
  const code = String(accountCode || '').trim();
  return code && !setupAccountCodes(defaults).has(code) ? code : '';
}

// The account to carry over from the source. One account across every line
// that has one is that account; a mix is not guessed line by line, so it is
// the document's own account, or the first line's when the document has none.
function rememberedAccount(source) {
  const lines = (source.lineItems || []).map(li => String(li?.accountCode || '').trim()).filter(Boolean);
  const distinct = [...new Set(lines)];
  if (distinct.length === 1) return distinct[0];
  const header = String(source.accountCode || '').trim();
  if (distinct.length > 1) return header || lines[0];
  return header;
}

// Companies the account is connected to now: the persisted list, which
// survives a restart, and whatever the token cache holds this minute. A
// failed read means none, so nothing is remembered rather than a company
// that may have gone.
function connectedTenantIds(userId) {
  const ids = new Set();
  try {
    const tokenCache = require('./token-cache');
    if (typeof tokenCache.getPersistedTenants === 'function') {
      for (const t of tokenCache.getPersistedTenants(userId) || []) ids.add(String(t.tenantId ?? t.tenant_id));
    }
    const live = tokenCache.forUser(userId);
    if (live && typeof live.getAllTenants === 'function') {
      for (const t of live.getAllTenants() || []) ids.add(String(t.tenant_id ?? t.tenantId));
    }
  } catch (err) {
    logger.warn('Could not read connected Xero companies for supplier memory', { userId, error: err.message });
  }
  ids.delete('undefined');
  return ids;
}

function _from(source) {
  const number = source.invoiceNumber && source.invoiceNumber !== '—' ? source.invoiceNumber : null;
  return { fromId: source.id, fromNumber: number, fromDate: source.invoiceDate || null };
}

// Fills what the record does not already say from the contact's last settled
// document, and records where each value came from. Changes the record in
// place (before it is stored) and returns it. Never throws: a failed lookup
// costs the suggestion, not the bill, so nothing is applied until every value
// has been worked out.
//
// `currencyStated` says whether the document named its currency. Leave it out
// and the record's currency is taken as stated unless it is the Setup default:
// the bill reader fills that in when the page says nothing, and nothing else
// on what it hands over tells the two apart.
function prefill(userId, record, { store, defaults, currencyStated } = {}) {
  if (!record || !store || typeof store.lastSettledFrom !== 'function') return record;
  if (!['ACCPAY', 'ACCREC'].includes(record.invoiceType) || record.claimKind) return record;
  const name = String(record.vendorName || record.contactName || '').trim();
  if (!name || NO_NAME.test(name)) return record;

  let patch;
  try {
    patch = _recall(userId, record, name, { store, defaults, currencyStated });
  } catch (err) {
    logger.warn('Supplier memory lookup failed; the record keeps its own values', { userId, id: record.id, error: err.message });
    return record;
  }
  if (!patch) return record;

  const { values, from } = patch;
  Object.assign(record, values);
  record.prefilledFrom = { ...(record.prefilledFrom || {}), ...Object.fromEntries(Object.keys(values).map(f => [f, from])) };
  logger.info('Prefilled from the last settled document from this contact', {
    userId, id: record.id, fromId: from.fromId, fields: Object.keys(values),
  });
  return record;
}

// The values to fill and the record they come from, or null for none.
function _recall(userId, record, name, { store, defaults, currencyStated }) {
  const source = store.lastSettledFrom(name, record.invoiceType, record.id);
  if (!source) return null;
  const setup = defaults || require('./users').getUserDefaults(userId);
  const values = {};

  // A code equal to a Setup default is not remembered: on a row stored before
  // this module it is the default intake wrote, not a choice, and carrying it
  // forward would keep the contact's own default from ever applying.
  if (!String(record.accountCode || '').trim()) {
    const code = rememberedAccount(source);
    if (code && !setupAccountCodes(setup).has(code)) values.accountCode = code;
  }

  const stated = currencyStated !== undefined ? !!currencyStated
    : !!record.currency && record.currency !== setup.currency;
  const lastCurrency = currencyCode(source.currency);
  if (!stated && lastCurrency && lastCurrency !== record.currency) values.currency = lastCurrency;

  // A company the document or its route already chose is never replaced.
  if (!record.xeroTenantId && source.xeroTenantId && connectedTenantIds(userId).has(String(source.xeroTenantId))) {
    values.xeroTenantId = source.xeroTenantId;
  }

  return Object.keys(values).length ? { values, from: _from(source) } : null;
}

module.exports = {
  prefill, rememberedAccount, documentAccountCode, setupAccountFor, setupAccountCodes, connectedTenantIds,
};
