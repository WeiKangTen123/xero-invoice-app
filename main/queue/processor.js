const { createDraftInvoice, updateDraftInvoice } = require('../xero/invoices');
const { notifyInvoiceCreated } = require('../utils/notify');
const logger = require('../utils/logger');

// Posts a draft to Xero, inline, to ONE connected org.
//
// There used to be a second path here: a Bull queue built whenever REDIS_URL
// was set. No Redis ever ran on the deployment box, so every submit sat in
// ioredis' offline queue for minutes and then failed, while the reconnect
// loop wrote thousands of empty "Queue error" lines. The inline path was the
// only one whose status bookkeeping was right, so it is now the only path.
//
// It also used to post to EVERY connected org and keep only the first Xero ID,
// so an account with two companies got each bill twice, and a later
// correction sent the first company's invoice ID to both.

const CHOOSE_TENANT_MSG = 'Choose a default Xero company in Setup before sending.';
const TENANT_GONE_MSG   = 'The Xero company this was sent to is no longer connected. Reconnect it before sending this again.';

// Routes to an update when the invoice already has a Xero ID (re-posting a
// correction), otherwise creates a new draft — keeps re-posts from ever creating
// a duplicate bill in the connected Xero org.
function submitDraftInvoice(userId, tenantId, invoiceData) {
  return invoiceData.xeroInvoiceId
    ? updateDraftInvoice(userId, tenantId, invoiceData.xeroInvoiceId, invoiceData)
    : createDraftInvoice(userId, tenantId, invoiceData);
}

function _tenantError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Which connected org this invoice goes to. One already in Xero goes back to
// the org that holds it and nowhere else. A new one goes to the account's
// chosen default while that is still connected, or to the only org there is.
// With several connected and none chosen there is no right answer to guess,
// so nothing is sent.
function chooseTenant(userId, invoiceData, tenants) {
  const connected = id => tenants.find(t => String(t.tenant_id) === String(id)) || null;

  if (invoiceData.xeroTenantId) {
    const stored = connected(invoiceData.xeroTenantId);
    if (!stored) throw _tenantError(TENANT_GONE_MSG, 'XERO_TENANT_GONE');
    return stored;
  }

  // With one org connected a default can only name that org or one that is
  // gone, so the answer is the same either way.
  if (tenants.length === 1) return tenants[0];
  const defaultTenantId = require('../utils/settings-store').forUser(userId).get('defaultTenantId');
  const chosen = defaultTenantId ? connected(defaultTenantId) : null;
  if (chosen) return chosen;
  throw _tenantError(CHOOSE_TENANT_MSG, 'XERO_TENANT_CHOICE');
}

// Returns { xeroInvoiceId, tenantId } — the caller stores both — or null when no
// org is connected and nothing was sent. A Xero failure, or an invoice with no
// org to go to, is thrown.
async function enqueueInvoice(userId, invoiceData) {
  const tokenCache = require('../utils/token-cache').forUser(userId);
  const tenants    = await tokenCache.getAllTenants();

  if (!tenants.length) {
    logger.warn('No connected Xero tenants — invoice not submitted', { vendor: invoiceData.vendorName, userId });
    return null;
  }

  const tenant     = chooseTenant(userId, invoiceData, tenants);
  const tenantId   = tenant.tenant_id;
  const tenantName = tenant.tenant_name;
  const mode       = invoiceData.xeroInvoiceId ? 'update' : 'create';

  logger.info('Submitting invoice to Xero', { tenant: tenantName, userId, mode });
  let xeroInvoice;
  try {
    xeroInvoice = await submitDraftInvoice(userId, tenantId, invoiceData);
  } catch (err) {
    const detail = err?.response?.body || err?.response?.data || err?.body || err?.message || String(err);
    logger.error('Invoice submission failed', { tenant: tenantName, error: err.message, detail: JSON.stringify(detail), userId });
    throw err;
  }
  logger.info(`Invoice ${mode === 'update' ? 'updated' : 'created'}`, { invoiceID: xeroInvoice.invoiceID, userId });

  // The bill is in Xero by now. A failed notification must not be read as a
  // failed send, or the row is marked error and the next attempt posts it again.
  try {
    await notifyInvoiceCreated({
      tenantName,
      vendorName:    invoiceData.vendorName,
      invoiceNumber: invoiceData.invoiceNumber,
      totalAmount:   invoiceData.totalAmount,
      currency:      invoiceData.currency || 'SGD',
      invoiceID:     xeroInvoice.invoiceID,
    });
  } catch (err) {
    logger.warn('Invoice notification failed', { error: err?.message || String(err), userId });
  }

  return { xeroInvoiceId: xeroInvoice.invoiceID, tenantId };
}

module.exports = { enqueueInvoice, chooseTenant, CHOOSE_TENANT_MSG, TENANT_GONE_MSG };
