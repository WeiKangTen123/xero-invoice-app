const { AccountingApi }          = require('xero-node');
const { withRetry }              = require('./xero-utils');
const logger                     = require('../utils/logger');

// Xero's contact name for a document, or null when there is nothing to name
// it by. A claim with no merchant reached here as null and crashed on
// null.replace; and a name that cleaned to nothing went to a shared
// "Unknown Vendor" contact, filing unrelated bills under one made-up payee.
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

// The tax defaults Xero keeps on a contact. resolveTaxType prefers one of these
// when several of the org's rates fit the document equally well.
function _taxDefaults(contact) {
  return {
    accountsPayableTaxType:    contact?.accountsPayableTaxType    || null,
    accountsReceivableTaxType: contact?.accountsReceivableTaxType || null,
  };
}

// Finds the contact by exact name or creates it. Returns { contactID } plus the
// contact's default tax types when Xero sent them (a new contact has none).
async function resolveContact(userId, tenantId, { vendorName, sourceEmail, address, phone, email, invoiceType }) {
  const cleanName = cleanContactName(vendorName);
  if (!cleanName) throw new Error(NO_NAME_MSG);

  const cache = require('../utils/token-cache').forUser(userId);
  const token = await cache.getValidToken(tenantId);

  const accountingApi       = new AccountingApi();
  accountingApi.accessToken = token;

  // Search for an existing contact by exact name. The SDK call is positional:
  // the eighth argument is summaryOnly; a `true` one slot later was being sent
  // as a search term, so the exact-name lookup never worked as written.
  //
  // A failed search propagates. It used to fall through to create, which
  // relied on Xero's unique-name rule to stop the duplicate; the caller's
  // retry handles a transient failure better than a second contact does.
  const where    = `Name=="${cleanName.replace(/"/g, '')}"`;
  const response = await withRetry(() =>
    accountingApi.getContacts(tenantId, undefined, where, undefined, undefined, undefined, undefined, true)
  );
  const contacts = response.body.contacts || [];
  if (contacts.length > 0) {
    logger.info('Contact found', { tenantId, vendorName: cleanName, contactID: contacts[0].contactID });
    return { contactID: contacts[0].contactID, ..._taxDefaults(contacts[0]) };
  }

  const isACCREC = invoiceType === 'ACCREC';
  const newContact = {
    contacts: [{
      name:         cleanName,
      emailAddress: email || sourceEmail || '',
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
    return { contactID, ..._taxDefaults(contacts[0]) };
  } catch (createErr) {
    // Race condition: another process created the contact between our search and create.
    // Re-search before propagating the error.
    const retry    = await withRetry(() => accountingApi.getContacts(tenantId, undefined, where));
    const existing = retry.body.contacts || [];
    if (existing.length > 0) {
      logger.info('Contact found on retry after create conflict', { tenantId, vendorName: cleanName, contactID: existing[0].contactID });
      return { contactID: existing[0].contactID, ..._taxDefaults(existing[0]) };
    }
    throw createErr;
  }
}

// The contact ID alone, for callers that need nothing else.
async function getOrCreateContact(userId, tenantId, details) {
  return (await resolveContact(userId, tenantId, details)).contactID;
}

module.exports = { getOrCreateContact, resolveContact, cleanContactName, NO_NAME_MSG };
