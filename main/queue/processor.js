const { createDraftInvoice, updateDraftInvoice } = require('../xero/invoices');
const { notifyInvoiceCreated } = require('../utils/notify');
const logger = require('../utils/logger');

// Posts a draft to Xero, inline, for every connected org.
//
// There used to be a second path here: a Bull queue built whenever REDIS_URL
// was set. No Redis ever ran on the deployment box, so every submit sat in
// ioredis' offline queue for minutes and then failed, while the reconnect
// loop wrote thousands of empty "Queue error" lines. The inline path was the
// only one whose status bookkeeping was right, so it is now the only path.

// Routes to an update when the invoice already has a Xero ID (re-posting a
// correction), otherwise creates a new draft — keeps re-posts from ever creating
// a duplicate bill in the connected Xero org.
function submitDraftInvoice(userId, tenantId, invoiceData) {
  return invoiceData.xeroInvoiceId
    ? updateDraftInvoice(userId, tenantId, invoiceData.xeroInvoiceId, invoiceData)
    : createDraftInvoice(userId, tenantId, invoiceData);
}

async function enqueueInvoice(userId, invoiceData) {
  const tokenCache = require('../utils/token-cache').forUser(userId);
  const tenants    = await tokenCache.getAllTenants();

  if (!tenants.length) {
    logger.warn('No connected Xero tenants — invoice not submitted', { vendor: invoiceData.vendorName, userId });
    return null;
  }

  let firstInvoiceId = null;
  let lastErr        = null;

  for (const tenant of tenants) {
    const tenantId   = tenant.tenant_id;
    const tenantName = tenant.tenant_name;
    try {
      const mode = invoiceData.xeroInvoiceId ? 'update' : 'create';
      logger.info('Submitting invoice to Xero', { tenant: tenantName, userId, mode });
      const xeroInvoice = await submitDraftInvoice(userId, tenantId, invoiceData);
      await notifyInvoiceCreated({
        tenantName,
        vendorName:    invoiceData.vendorName,
        invoiceNumber: invoiceData.invoiceNumber,
        totalAmount:   invoiceData.totalAmount,
        currency:      invoiceData.currency || 'SGD',
        invoiceID:     xeroInvoice.invoiceID,
      });
      logger.info(`Invoice ${mode === 'update' ? 'updated' : 'created'}`, { invoiceID: xeroInvoice.invoiceID, userId });
      firstInvoiceId = firstInvoiceId || xeroInvoice.invoiceID;
    } catch (err) {
      const detail = err?.response?.body || err?.response?.data || err?.body || err?.message || String(err);
      logger.error('Invoice submission failed', { tenant: tenantName, error: err.message, detail: JSON.stringify(detail), userId });
      lastErr = err;
    }
  }

  if (lastErr && !firstInvoiceId) throw lastErr;
  return firstInvoiceId || null;
}

module.exports = { enqueueInvoice };
