const { createDraftInvoice }                 = require('../xero/invoices');
const { notifyInvoiceCreated, notifyError }  = require('../utils/notify');
const logger = require('../utils/logger');

let invoiceQueue = null;

function getQueue() {
  if (invoiceQueue) return invoiceQueue;
  if (!process.env.REDIS_URL) {
    logger.warn('REDIS_URL not set — Bull queue disabled, processing inline');
    return null;
  }
  try {
    const Bull = require('bull');
    invoiceQueue = new Bull('invoice-processing', {
      redis: process.env.REDIS_URL,
      defaultJobOptions: {
        attempts:         5,
        backoff:          { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail:     200,
      }
    });

    invoiceQueue.process(3, async (job) => {
      const { userId, invoiceData, tenantId, tenantName } = job.data;
      logger.info('Processing invoice job', { jobId: job.id, tenant: tenantName, userId });

      const xeroInvoice = await createDraftInvoice(userId, tenantId, invoiceData);

      // Update the invoice store record now that Xero has accepted it.
      // This covers the async queue path — the inline path is already handled
      // by scheduleXeroSubmit / submitInvoiceToXero in invoice-handler.js.
      if (invoiceData._invoiceStoreId) {
        try {
          const invStore = require('../utils/invoice-store').forUser(userId);
          await invStore.update(invoiceData._invoiceStoreId, {
            status:       'posted',
            xeroInvoiceId: xeroInvoice.invoiceID,
            submittedAt:  new Date().toISOString(),
            errorMsg:     null,
          });
        } catch (storeErr) {
          logger.warn('Could not update invoice store after queue job succeeded', {
            jobId: job.id, storeId: invoiceData._invoiceStoreId, error: storeErr.message,
          });
        }
      }

      await notifyInvoiceCreated({
        tenantName,
        vendorName:    invoiceData.vendorName,
        invoiceNumber: invoiceData.invoiceNumber,
        totalAmount:   invoiceData.totalAmount,
        currency:      invoiceData.currency || 'SGD',
        invoiceID:     xeroInvoice.invoiceID,
      });
      return { invoiceID: xeroInvoice.invoiceID, success: true };
    });

    invoiceQueue.on('failed', async (job, err) => {
      if (job.attemptsMade >= job.opts.attempts) {
        logger.error('Job exhausted retries', { jobId: job.id, error: err.message });
        try {
          await notifyError({
            context: `Job ${job.id} failed after ${job.opts.attempts} attempts`,
            error:   err.message,
            email:   job.data.invoiceData?.sourceEmail,
          });
        } catch (_) {}
      }
    });

    invoiceQueue.on('error', err => logger.error('Queue error', { error: err.message }));
    logger.info('Bull queue initialised with Redis');
    return invoiceQueue;
  } catch (err) {
    logger.error('Failed to init Bull queue', { error: err.message });
    return null;
  }
}

async function enqueueInvoice(userId, invoiceData) {
  const tokenCache = require('../utils/token-cache').forUser(userId);
  const tenants    = await tokenCache.getAllTenants();

  if (!tenants.length) {
    logger.warn('No connected Xero tenants — invoice not queued', {
      vendor: invoiceData.vendorName, userId,
    });
    return null;
  }

  const queue        = getQueue();
  let firstInvoiceId = null;
  let lastErr        = null;

  for (const tenant of tenants) {
    const tenantId   = tenant.tenant_id;
    const tenantName = tenant.tenant_name;

    if (queue) {
      await queue.add(
        { userId, invoiceData, tenantId, tenantName },
        { jobId: `${userId}-${tenantId}-${invoiceData.invoiceNumber}-${Date.now()}` }
      );
      logger.info('Invoice queued', { tenant: tenantName, vendor: invoiceData.vendorName, userId });
    } else {
      try {
        logger.info('Processing invoice inline', { tenant: tenantName, userId });
        const xeroInvoice = await createDraftInvoice(userId, tenantId, invoiceData);
        await notifyInvoiceCreated({
          tenantName,
          vendorName:    invoiceData.vendorName,
          invoiceNumber: invoiceData.invoiceNumber,
          totalAmount:   invoiceData.totalAmount,
          currency:      invoiceData.currency || 'SGD',
          invoiceID:     xeroInvoice.invoiceID,
        });
        logger.info('Invoice created inline', { invoiceID: xeroInvoice.invoiceID, userId });
        firstInvoiceId = firstInvoiceId || xeroInvoice.invoiceID;
      } catch (err) {
        const detail = err?.response?.body || err?.response?.data || err?.body || err?.message || String(err);
        logger.error('Inline invoice creation failed', {
          tenant: tenantName, error: err.message, detail: JSON.stringify(detail), userId,
        });
        lastErr = err;
      }
    }
  }

  if (lastErr && !firstInvoiceId) throw lastErr;
  return firstInvoiceId || null;
}

module.exports = { enqueueInvoice };
