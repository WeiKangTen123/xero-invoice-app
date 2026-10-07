const { AccountingApi }          = require('xero-node');
const { withRetry }              = require('./xero-utils');
const logger                     = require('../utils/logger');

// Xero's contact name for a document, or null when there is nothing to name
// it by. A claim with no merchant reached here as null and crashed on
// null.replace; and a name that cleaned to nothing went to a shared
// "Unknown Vendor" contact, filing unrelated bills under one made-up payee.
//
// Quotes stay in the name. This is the name the contact is created with and
// the name an existing contact is compared against, so both sides agree; the
// lookup used to strip quotes from the search but keep them on create, so a
// name containing `"` was never found again and every post after the first
// failed on Xero's unique-name rule.
function cleanContactName(name) {
  if (name === null || name === undefined) return null;
  const clean = String(name)
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 255);
  return clean || null;
}

const NO_NAME_MSG = 'There is no supplier, customer or payee name to send to Xero. Add the name and send it again.';

// How two names are compared: Xero treats contact names case-insensitively
// (its unique-name rule refuses "ACME PTE LTD" beside "Acme Pte Ltd"), so a
// bill from one must find the other rather than try to create it.
function _nameKey(name) {
  const clean = cleanContactName(name);
  return clean ? clean.toLowerCase() : null;
}

// What to hand Xero's searchTerm. It is a contains-search across names,
// numbers and emails, so the longest stretch of the name without a quote
// finds the contact whatever Xero makes of quote characters; the exact name
// is then picked out of the results here.
function _searchTermFor(cleanName) {
  const pieces = cleanName.split('"').map(s => s.trim()).filter(Boolean);
  if (!pieces.length) return cleanName;
  return pieces.reduce((a, b) => (b.length > a.length ? b : a));
}

// The defaults Xero keeps on a contact. resolveTaxType prefers its tax type
// when several of the org's rates fit the document equally well, and
// xero/invoices.js uses its account code for a document that names none.
function _contactDefaults(contact) {
  return {
    accountsPayableTaxType:      contact?.accountsPayableTaxType      || null,
    accountsReceivableTaxType:   contact?.accountsReceivableTaxType   || null,
    purchasesDefaultAccountCode: contact?.purchasesDefaultAccountCode || null,
    salesDefaultAccountCode:     contact?.salesDefaultAccountCode     || null,
  };
}

function _isArchived(contact) {
  return String(contact?.contactStatus || '').toUpperCase() === 'ARCHIVED';
}

// The contact whose name is this one, ignoring case, or null. Archived
// contacts are searched too: a supplier archived in Xero is still that
// supplier, and creating a second contact under the same name splits their
// history (or is refused). An active match wins over an archived one.
//
// Full records, not summaryOnly: the summary leaves out the contact's default
// account codes and tax types, which are the point of looking it up.
//
// A failed search propagates. It used to fall through to create, which
// relied on Xero's unique-name rule to stop the duplicate; the caller's
// retry handles a transient failure better than a second contact does.
async function _findContact(accountingApi, tenantId, cleanName) {
  // getContacts(tenant, ifModifiedSince, where, order, iDs, page, includeArchived, summaryOnly, searchTerm)
  const response = await withRetry(() => accountingApi.getContacts(
    tenantId, undefined, undefined, undefined, undefined, undefined, true, false, _searchTermFor(cleanName),
  ));
  const want    = _nameKey(cleanName);
  const matches = (response?.body?.contacts || []).filter(c => c && c.contactID && _nameKey(c.name) === want);
  return matches.find(c => !_isArchived(c)) || matches[0] || null;
}

function _plainAddress(value) {
  const s = String(value || '').trim();
  const bracketed = s.match(/<([^<>\s]+@[^<>\s]+)>/);
  const address = (bracketed ? bracketed[1] : s).trim().toLowerCase();
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(address) ? address : null;
}

// The addresses that belong to this account rather than to any supplier: its
// sign-in email, the mailbox bills arrive in, and the sender it is set to
// accept mail from. A forwarded bill's sender is one of these, and the email
// parser falls back to the sender when the document shows no address — which
// gave new suppliers the forwarding mailbox as their email in Xero.
function _ownAddresses(userId) {
  const own = new Set();
  try {
    const users  = require('../utils/users');
    const config = users.getUserConfig(userId) || {};
    const user   = typeof users.findById === 'function' ? users.findById(userId) : null;
    for (const v of [user && user.email, config.IMAP_USER, config.IMAP_FILTER_FROM]) {
      const a = _plainAddress(v);
      if (a) own.add(a);
    }
  } catch (_) { /* no account details to compare: keep the email */ }
  return own;
}

// The email a new contact is created with: the document's own address for the
// supplier or customer, or none. Never the email's sender (sourceEmail) — in
// the forwarding flow that is the person or mailbox who forwarded the bill,
// not the supplier — and never one of this account's own addresses.
function _contactEmail(userId, email) {
  const address = _plainAddress(email);
  if (!address) return null;
  return _ownAddresses(userId).has(address) ? null : address;
}

// Finds the contact by name (ignoring case) or creates it. Returns { contactID }
// plus the contact's default tax types and account codes when Xero has them (a
// new contact has none). A `sourceEmail` in the details is ignored: see
// _contactEmail.
async function resolveContact(userId, tenantId, { vendorName, address, phone, email, invoiceType }) {
  const cleanName = cleanContactName(vendorName);
  if (!cleanName) throw new Error(NO_NAME_MSG);

  const cache = require('../utils/token-cache').forUser(userId);
  const token = await cache.getValidToken(tenantId);

  const accountingApi       = new AccountingApi();
  accountingApi.accessToken = token;

  const found = await _findContact(accountingApi, tenantId, cleanName);
  if (found) {
    logger.info('Contact found', { tenantId, vendorName: cleanName, contactID: found.contactID, archived: _isArchived(found) });
    return { contactID: found.contactID, ..._contactDefaults(found) };
  }

  const isACCREC     = invoiceType === 'ACCREC';
  const emailAddress = _contactEmail(userId, email);
  const newContact = {
    contacts: [{
      name:         cleanName,
      ...(emailAddress && { emailAddress }),
      isSupplier:   !isACCREC,
      isCustomer:   isACCREC,
      addresses:    address ? [{ addressType: 'STREET', addressLine1: String(address).slice(0, 500) }] : [],
      phones:       phone   ? [{ phoneType: 'DEFAULT', phoneNumber: String(phone).slice(0, 50) }] : [],
    }]
  };

  try {
    const created   = await withRetry(() => accountingApi.createContacts(tenantId, newContact));
    const contacts  = created.body.contacts || [];
    if (!contacts.length || !contacts[0].contactID) {
      throw new Error(`Xero returned no contact after creation for "${cleanName}"`);
    }
    const contactID = contacts[0].contactID;
    logger.info('Contact created', { tenantId, vendorName: cleanName, contactID });
    return { contactID, ..._contactDefaults(contacts[0]) };
  } catch (createErr) {
    // Race condition: another process created the contact between our search and create.
    // Re-search before propagating the error.
    const existing = await _findContact(accountingApi, tenantId, cleanName);
    if (existing) {
      logger.info('Contact found on retry after create conflict', { tenantId, vendorName: cleanName, contactID: existing.contactID });
      return { contactID: existing.contactID, ..._contactDefaults(existing) };
    }
    throw createErr;
  }
}

// The contact ID alone, for callers that need nothing else.
async function getOrCreateContact(userId, tenantId, details) {
  return (await resolveContact(userId, tenantId, details)).contactID;
}

module.exports = { getOrCreateContact, resolveContact, cleanContactName, NO_NAME_MSG };
