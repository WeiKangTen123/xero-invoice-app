const { AccountingApi }              = require('xero-node');
const fs                             = require('fs');
const axios                          = require('axios');
const { getOrCreateContact }         = require('./contacts');
const { withRetry, xeroErrMsg } = require('./xero-utils');
const logger                         = require('../utils/logger');

// Per-tenant base currency cache — avoids an extra Xero API call on every invoice.
// Populated lazily on first currency mismatch, persists for the server lifetime.
const _orgBaseCurrencyCache = new Map();

async function getOrgBaseCurrency(accountingApi, tenantId) {
  if (_orgBaseCurrencyCache.has(tenantId)) return _orgBaseCurrencyCache.get(tenantId);
  try {
    const res      = await accountingApi.getOrganisations(tenantId);
    const currency = res.body.organisations?.[0]?.baseCurrency || 'USD';
    _orgBaseCurrencyCache.set(tenantId, currency);
    logger.info('Xero org base currency detected', { tenantId, baseCurrency: currency });
    return currency;
  } catch (err) {
    logger.warn('Could not fetch org base currency — falling back to USD', { error: xeroErrMsg(err) });
    return 'USD';
  }
}

async function getBrandingThemeID(accountingApi, tenantId, themeName) {
  if (!themeName) return undefined;
  try {
    const res    = await accountingApi.getBrandingThemes(tenantId);
    const themes = res.body.brandingThemes || [];
    const match  = themes.find(t => t.name?.toLowerCase() === themeName.toLowerCase());
    if (match) {
      logger.info('Branding theme found', { themeName, themeID: match.brandingThemeID });
      return match.brandingThemeID;
    }
    logger.warn('Branding theme not found, using default', { themeName });
  } catch (err) {
    logger.warn('Could not fetch branding themes', { error: err.message });
  }
  return undefined;
}

function buildLineItems(invoiceData, userConfig) {
  const rawLineItems = invoiceData.lineItems ? [...invoiceData.lineItems] : null;

  if (invoiceData.paymentReference && rawLineItems) {
    const paymentLines = 'Payment details:\n' + invoiceData.paymentReference.replace(/\s*\|\s*/g, '\n');
    rawLineItems.push({ description: paymentLines, unitAmount: 0 });
  }

  const zeroRate    = userConfig.ZERO_TAX_RATE         || process.env.ZERO_TAX_RATE         || 'NONE';
  const accountCode = invoiceData.accountCode           || userConfig.DEFAULT_ACCOUNT_CODE   || process.env.DEFAULT_ACCOUNT_CODE || '200';

  if (rawLineItems) {
    return rawLineItems.map(item => {
      const amount = parseFloat(item.unitAmount) || 0;
      if (amount === 0) return { description: item.description };
      const taxType = (item.taxType === 'NONE' || !item.taxType) ? zeroRate : item.taxType;
      return {
        description: item.description,
        accountCode,
        taxType,
        quantity:    1.0,
        unitAmount:  amount,
        ...(parseFloat(item.discountRate) > 0 && { discountRate: parseFloat(item.discountRate) }),
      };
    });
  }

  // Fallback single-line item when no line items were extracted
  return [{
    description: invoiceData.description,
    quantity:    1.0,
    unitAmount:  parseFloat(invoiceData.subTotal) || 0,
    accountCode: invoiceData.accountCode || userConfig.DEFAULT_ACCOUNT_CODE || process.env.DEFAULT_ACCOUNT_CODE || '310',
    taxType:     zeroRate,
  }];
}

function _referenceField(invoiceData) {
  if (invoiceData.projectName) return invoiceData.projectName;
  const s = invoiceData.description || '';
  return s.includes('|') ? s.split('|').pop().trim() : s;
}

// Create a fresh AccountingApi instance per call so concurrent users cannot
// contaminate each other's token state on a shared singleton.
async function createDraftInvoice(userId, tenantId, invoiceData) {
  const { getUserConfig } = require('../utils/users');
  const pdfStore          = require('../utils/pdf-store').forUser(userId);
  const cache             = require('../utils/token-cache').forUser(userId);
  const userConfig        = getUserConfig(userId);

  const token                   = await cache.getValidToken(tenantId);
  const accountingApi           = new AccountingApi();
  accountingApi.accessToken     = token;

  const contactID = await getOrCreateContact(userId, tenantId, {
    vendorName:  invoiceData.contactName  || invoiceData.vendorName,
    sourceEmail: invoiceData.contactEmail || invoiceData.sourceEmail,
    email:       invoiceData.contactEmail || invoiceData.vendorEmail || '',
    address:     invoiceData.contactAddress || '',
    phone:       invoiceData.vendorPhone    || '',
    invoiceType: invoiceData.invoiceType,
  });

  const brandingThemeID = await getBrandingThemeID(accountingApi, tenantId, invoiceData.brandingThemeName);
  const lineItems       = buildLineItems(invoiceData, userConfig);
  const lineAmountTypes = invoiceData.lineAmountTypes === 'Inclusive' ? 'Inclusive' : 'Exclusive';
  let currencyCode = invoiceData.currency || userConfig.DEFAULT_CURRENCY || process.env.DEFAULT_CURRENCY || 'USD';

  const invoiceBody = {
    invoices: [{
      type:          invoiceData.invoiceType || 'ACCPAY',
      status:        'DRAFT',
      contact:       { contactID },
      date:          invoiceData.invoiceDate,
      dueDate:       invoiceData.dueDate,
      invoiceNumber: invoiceData.invoiceNumber,
      reference:     _referenceField(invoiceData),
      currencyCode,
      lineAmountTypes,
      ...(brandingThemeID && { brandingThemeID }),
      lineItems,
    }]
  };

  let result;
  try {
    result = await withRetry(() => accountingApi.createInvoices(tenantId, invoiceBody));
  } catch (err) {
    // If Xero org isn't subscribed to this currency, detect the org's base currency
    // and retry once with that — avoids hardcoding USD and works for any Xero org.
    const msg = xeroErrMsg(err);
    if (msg.includes('not subscribed to currency')) {
      const baseCurrency = await getOrgBaseCurrency(accountingApi, tenantId);
      if (baseCurrency !== currencyCode) {
        logger.warn('Currency not subscribed — retrying with org base currency', {
          attempted: currencyCode, fallback: baseCurrency, userId,
        });
        currencyCode = baseCurrency;
        invoiceBody.invoices[0].currencyCode = baseCurrency;
        // Update the stored record so future retries also use the correct currency
        if (invoiceData._invoiceStoreId) {
          try {
            const invStore = require('../utils/invoice-store').forUser(userId);
            await invStore.update(invoiceData._invoiceStoreId, { currency: baseCurrency });
          } catch (_) {}
        }
        result = await withRetry(() => accountingApi.createInvoices(tenantId, invoiceBody));
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }
  const created = result.body.invoices[0];

  // Set delivery address — best-effort, non-fatal if Xero rejects it
  if (invoiceData.contactAddress) {
    try {
      const freshToken = await cache.getValidToken(tenantId);
      await axios.post(
        `https://api.xero.com/api.xro/2.0/Invoices/${created.invoiceID}`,
        {
          InvoiceID:        created.invoiceID,
          InvoiceAddresses: [{ InvoiceAddressType: 'TO', AddressLine1: invoiceData.contactAddress }],
        },
        {
          headers: {
            Authorization:    `Bearer ${freshToken}`,
            'xero-tenant-id': tenantId,
            'Content-Type':   'application/json',
          },
        }
      );
      logger.info('Delivery address set on invoice', { invoiceID: created.invoiceID });
    } catch (err) {
      logger.warn('Delivery address not set', { error: err?.response?.data?.Message || err.message });
    }
  }

  // Attach original email body as plain text — best-effort, non-fatal
  if (invoiceData.emailBodyText) {
    try {
      const buf = Buffer.from(invoiceData.emailBodyText, 'utf8');
      await accountingApi.createInvoiceAttachmentByFileName(
        tenantId, created.invoiceID, 'original-email.txt', buf, false
      );
      logger.info('Email body attached to invoice', { invoiceID: created.invoiceID });
    } catch (err) {
      logger.warn('Failed to attach email body', { error: xeroErrMsg(err), invoiceID: created.invoiceID });
    }
  }

  // Attach original PDF from per-user disk store — best-effort, non-fatal
  const pdfPath = invoiceData._invoiceStoreId ? pdfStore.getPath(invoiceData._invoiceStoreId) : null;
  if (pdfPath && invoiceData.pdfFilename) {
    try {
      const pdfStream = fs.createReadStream(pdfPath);
      await accountingApi.createInvoiceAttachmentByFileName(
        tenantId, created.invoiceID, invoiceData.pdfFilename, pdfStream, false
      );
      logger.info('PDF attached to Xero invoice', { invoiceID: created.invoiceID, file: invoiceData.pdfFilename });
    } catch (err) {
      logger.warn('Failed to attach PDF to Xero', { error: xeroErrMsg(err), invoiceID: created.invoiceID, file: invoiceData.pdfFilename });
    }
  }

  logger.info('Draft invoice created', {
    tenantId,
    invoiceID:   created.invoiceID,
    vendor:      invoiceData.contactName || invoiceData.vendorName,
    amount:      invoiceData.totalAmount,
    invoiceType: invoiceData.invoiceType,
    lineItems:   lineItems.length,
    currency:    currencyCode,
    userId,
  });

  return created;
}

module.exports = { createDraftInvoice };
