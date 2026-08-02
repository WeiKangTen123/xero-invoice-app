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

// Builds the Xero invoice body + resolves the contact — shared by create and update,
// since both send the same shape to their respective Xero endpoints.
async function _buildInvoiceBody(userId, tenantId, invoiceData, accountingApi) {
  const { getUserConfig } = require('../utils/users');
  const userConfig        = getUserConfig(userId);

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
  const currencyCode    = invoiceData.currency || userConfig.DEFAULT_CURRENCY || process.env.DEFAULT_CURRENCY || 'USD';

  return {
    currencyCode,
    invoiceBody: {
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
    },
  };
}

// Submits with the currency-mismatch retry: if the Xero org isn't subscribed to the
// attempted currency, detect the org's base currency and retry once with that.
async function _submitWithCurrencyRetry(submitFn, accountingApi, tenantId, invoiceBody, currencyCode, userId, invoiceData) {
  try {
    return await withRetry(() => submitFn(invoiceBody));
  } catch (err) {
    const msg = xeroErrMsg(err);
    if (!msg.includes('not subscribed to currency')) throw err;

    const baseCurrency = await getOrgBaseCurrency(accountingApi, tenantId);
    if (baseCurrency === currencyCode) throw err;

    logger.warn('Currency not subscribed — retrying with org base currency', {
      attempted: currencyCode, fallback: baseCurrency, userId,
    });
    invoiceBody.invoices[0].currencyCode = baseCurrency;
    if (invoiceData._invoiceStoreId) {
      try {
        const invStore = require('../utils/invoice-store').forUser(userId);
        await invStore.update(invoiceData._invoiceStoreId, { currency: baseCurrency });
      } catch (_) {}
    }
    return await withRetry(() => submitFn(invoiceBody));
  }
}

// Create a fresh AccountingApi instance per call so concurrent users cannot
// contaminate each other's token state on a shared singleton.
async function createDraftInvoice(userId, tenantId, invoiceData) {
  const pdfStore             = require('../utils/pdf-store').forUser(userId);
  const cache                = require('../utils/token-cache').forUser(userId);
  const token                = await cache.getValidToken(tenantId);
  const accountingApi        = new AccountingApi();
  accountingApi.accessToken  = token;

  const { invoiceBody, currencyCode } = await _buildInvoiceBody(userId, tenantId, invoiceData, accountingApi);

  const result = await _submitWithCurrencyRetry(
    body => accountingApi.createInvoices(tenantId, body),
    accountingApi, tenantId, invoiceBody, currencyCode, userId, invoiceData
  );
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
    lineItems:   invoiceBody.invoices[0].lineItems.length,
    currency:    currencyCode,
    userId,
  });

  return created;
}

// Updates an existing Xero invoice in place (PUT /Invoices/{InvoiceID}) instead of
// creating a new one — used when re-posting a correction to an invoice that was
// already sent to Xero, so it doesn't create a duplicate bill.
// Only works while the invoice is still editable on the Xero side (DRAFT/SUBMITTED
// status there) — if it's since been approved/paid in Xero itself, this will throw
// and the caller surfaces the Xero error as-is.
async function updateDraftInvoice(userId, tenantId, xeroInvoiceId, invoiceData) {
  const cache                = require('../utils/token-cache').forUser(userId);
  const token                = await cache.getValidToken(tenantId);
  const accountingApi        = new AccountingApi();
  accountingApi.accessToken  = token;

  const { invoiceBody, currencyCode } = await _buildInvoiceBody(userId, tenantId, invoiceData, accountingApi);

  const result = await _submitWithCurrencyRetry(
    body => accountingApi.updateInvoice(tenantId, xeroInvoiceId, body),
    accountingApi, tenantId, invoiceBody, currencyCode, userId, invoiceData
  );
  const updated = result.body.invoices[0];

  // Re-apply delivery address — best-effort, non-fatal. Not re-attaching the email
  // body/PDF here since those were already attached on the original create and
  // re-attaching on every correction would just pile up duplicate attachments.
  if (invoiceData.contactAddress) {
    try {
      const freshToken = await cache.getValidToken(tenantId);
      await axios.post(
        `https://api.xero.com/api.xro/2.0/Invoices/${xeroInvoiceId}`,
        {
          InvoiceID:        xeroInvoiceId,
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
    } catch (err) {
      logger.warn('Delivery address not updated', { error: err?.response?.data?.Message || err.message });
    }
  }

  logger.info('Draft invoice updated', {
    tenantId,
    invoiceID:   updated.invoiceID,
    vendor:      invoiceData.contactName || invoiceData.vendorName,
    amount:      invoiceData.totalAmount,
    currency:    currencyCode,
    userId,
  });

  return updated;
}

module.exports = { createDraftInvoice, updateDraftInvoice };
