const { AccountingApi }          = require('xero-node');
const { withRetry }              = require('./xero-utils');
const logger                     = require('../utils/logger');

async function getOrCreateContact(userId, tenantId, { vendorName, sourceEmail, address, phone, email, invoiceType }) {
  const cache = require('../utils/token-cache').forUser(userId);
  const token = await cache.getValidToken(tenantId);

  const accountingApi       = new AccountingApi();
  accountingApi.accessToken = token;

  const cleanName = vendorName
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 255) || 'Unknown Vendor';

  // Search for existing contact by exact name
  try {
    const where    = `Name=="${cleanName.replace(/"/g, '')}"`;
    const response = await withRetry(() =>
      accountingApi.getContacts(tenantId, undefined, where, undefined, undefined, undefined, undefined, undefined, true)
    );
    const contacts = response.body.contacts || [];
    if (contacts.length > 0) {
      logger.info('Contact found', { tenantId, vendorName, contactID: contacts[0].contactID });
      return contacts[0].contactID;
    }
  } catch (err) {
    logger.warn('Contact search failed, will create new', { vendorName, error: err.message });
  }

  const isACCREC = invoiceType === 'ACCREC';
  const newContact = {
    contacts: [{
      name:         cleanName,
      emailAddress: email || sourceEmail || '',
      isSupplier:   !isACCREC,
      isCustomer:   isACCREC,
      addresses:    address ? [{ addressType: 'STREET', addressLine1: address.slice(0, 500) }] : [],
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
    return contactID;
  } catch (createErr) {
    // Race condition: another process created the contact between our search and create.
    // Re-search before propagating the error.
    const where2   = `Name=="${cleanName.replace(/"/g, '')}"`;
    const retry    = await withRetry(() => accountingApi.getContacts(tenantId, undefined, where2));
    const existing = retry.body.contacts || [];
    if (existing.length > 0) {
      logger.info('Contact found on retry after create conflict', { tenantId, vendorName: cleanName, contactID: existing[0].contactID });
      return existing[0].contactID;
    }
    throw createErr;
  }
}

module.exports = { getOrCreateContact };
