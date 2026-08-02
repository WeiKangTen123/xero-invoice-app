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

// Per-tenant cache of the org's own configured tax rates — avoids an extra Xero
// API call on every invoice. Populated lazily, persists for the server lifetime.
const _orgTaxRatesCache = new Map();

async function getOrgTaxRates(accountingApi, tenantId) {
  if (_orgTaxRatesCache.has(tenantId)) return _orgTaxRatesCache.get(tenantId);
  try {
    const res   = await accountingApi.getTaxRates(tenantId);
    const rates = (res.body.taxRates || []).filter(r => r.status === 'ACTIVE');
    _orgTaxRatesCache.set(tenantId, rates);
    logger.info('Xero org tax rates loaded', { tenantId, count: rates.length });
    return rates;
  } catch (err) {
    logger.warn('Could not fetch org tax rates — tax will be posted as a flat line item', { error: xeroErrMsg(err) });
    return [];
  }
}

// Matches the invoice's actual detected tax (subTotal/taxAmount — real dollar
// figures from parser.js, dynamic per invoice) against the connected Xero org's
// own configured tax rates, instead of guessing a hardcoded TaxType code (which
// varies per org/country and hard-fails the whole invoice if it doesn't exist on
// that org). If no confident match is found, the caller falls back to posting the
// tax as its own flat line item so the total still reconciles — just without
// proper per-line GST categorisation in Xero's own reports.
const TAX_RATE_TOLERANCE_PCT = 0.75;

async function resolveTaxType(accountingApi, tenantId, invoiceData, zeroRate) {
  const subTotal  = Number(invoiceData.subTotal)  || 0;
  const taxAmount = Number(invoiceData.taxAmount) || 0;

  if (subTotal <= 0 || taxAmount <= 0) return { taxType: zeroRate, applied: true, unmatchedTaxAmount: 0 };

  const effectiveRate = (taxAmount / subTotal) * 100;
  // Below this, treat as effectively tax-free rather than risk matching an
  // unrelated 0%-ish rate whose semantics (zero-rated vs exempt vs GST-free)
  // can't be told apart from dollar figures alone.
  if (effectiveRate < 0.1) return { taxType: zeroRate, applied: true, unmatchedTaxAmount: 0 };

  const rates     = await getOrgTaxRates(accountingApi, tenantId);
  const isExpense = invoiceData.invoiceType !== 'ACCREC'; // ACCPAY (bill) is this app's primary case
  const candidates = rates.filter(r => isExpense ? r.canApplyToExpenses : r.canApplyToRevenue);

  let best = null;
  let bestDiff = Infinity;
  for (const r of candidates) {
    const diff = Math.abs((r.displayTaxRate || 0) - effectiveRate);
    if (diff < bestDiff) { bestDiff = diff; best = r; }
  }

  if (best && bestDiff <= TAX_RATE_TOLERANCE_PCT) {
    logger.info('Matched invoice tax to org tax rate', {
      tenantId, effectiveRate: effectiveRate.toFixed(2), matched: best.name, taxType: best.taxType,
    });
    return { taxType: best.taxType, applied: true, unmatchedTaxAmount: 0 };
  }

  logger.warn('No matching org tax rate for detected tax — posting as a flat line item', {
    tenantId, effectiveRate: effectiveRate.toFixed(2), taxAmount,
  });
  return { taxType: zeroRate, applied: false, unmatchedTaxAmount: taxAmount };
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

// Every non-zero line item is tagged with ONE resolved tax type for the whole
// invoice (see resolveTaxType) — invoices from this app carry a single overall
// tax rate, not a per-line mix, so there's no meaningful per-item signal to
// resolve independently.
async function buildLineItems(invoiceData, userConfig, accountingApi, tenantId) {
  const rawLineItems = invoiceData.lineItems ? [...invoiceData.lineItems] : null;

  if (invoiceData.paymentReference && rawLineItems) {
    const paymentLines = 'Payment details:\n' + invoiceData.paymentReference.replace(/\s*\|\s*/g, '\n');
    rawLineItems.push({ description: paymentLines, unitAmount: 0 });
  }

  const zeroRate    = userConfig.ZERO_TAX_RATE         || process.env.ZERO_TAX_RATE         || 'NONE';
  const accountCode = invoiceData.accountCode           || userConfig.DEFAULT_ACCOUNT_CODE   || process.env.DEFAULT_ACCOUNT_CODE || '200';

  const { taxType, applied, unmatchedTaxAmount } =
    await resolveTaxType(accountingApi, tenantId, invoiceData, zeroRate);

  let items;
  if (rawLineItems) {
    items = rawLineItems.map(item => {
      const amount = parseFloat(item.unitAmount) || 0;
      if (amount === 0) return { description: item.description };
      return {
        description: item.description,
        accountCode,
        taxType,
        quantity:    1.0,
        unitAmount:  amount,
        ...(parseFloat(item.discountRate) > 0 && { discountRate: parseFloat(item.discountRate) }),
      };
    });
  } else {
    // Fallback single-line item when no line items were extracted
    items = [{
      description: invoiceData.description,
      quantity:    1.0,
      unitAmount:  parseFloat(invoiceData.subTotal) || 0,
      accountCode: invoiceData.accountCode || userConfig.DEFAULT_ACCOUNT_CODE || process.env.DEFAULT_ACCOUNT_CODE || '310',
      taxType,
    }];
  }

  // No org tax rate confidently matched the invoice's detected tax — rather than
  // silently dropping it (the previous behaviour), post it as its own flat-dollar
  // line so the Xero total still reconciles to the real invoice total. Not
  // categorised as GST in Xero's own reports, but never silently wrong either.
  if (!applied && unmatchedTaxAmount > 0) {
    items.push({
      description: 'Tax / GST',
      accountCode,
      taxType:    zeroRate,
      quantity:   1.0,
      unitAmount: unmatchedTaxAmount,
    });
  }

  return items;
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
  const lineItems       = await buildLineItems(invoiceData, userConfig, accountingApi, tenantId);
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

module.exports = {
  createDraftInvoice, updateDraftInvoice,
  // Exposed for tests only — internal to the create/update flow above.
  buildLineItems, resolveTaxType, getOrgTaxRates,
};
