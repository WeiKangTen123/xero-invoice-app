const axios = require('axios');
const logger = require('./logger');

async function notifySlack(message) {
  if (!process.env.SLACK_WEBHOOK_URL) return;
  try {
    await axios.post(process.env.SLACK_WEBHOOK_URL, { text: message });
  } catch (err) {
    logger.warn('Slack notification failed', { error: err.message });
  }
}

async function notifyInvoiceCreated({ tenantName, vendorName, invoiceNumber, totalAmount, currency, invoiceID }) {
  const xeroUrl = `https://go.xero.com/AccountsPayable/Edit.aspx?InvoiceID=${invoiceID}`;
  const msg = [
    `*New Draft Invoice Created in Xero*`,
    `Org: ${tenantName}`,
    `Vendor: ${vendorName}`,
    `Invoice #: ${invoiceNumber}`,
    `Amount: ${currency || 'SGD'} ${Number(totalAmount).toFixed(2)}`,
    `<${xeroUrl}|Review in Xero>`
  ].join('\n');
  await notifySlack(msg);
  logger.info('Invoice created notification sent', { invoiceID, vendorName });
}

async function notifyError({ context, error, email }) {
  const msg = [
    `*Xero Invoice App Error*`,
    `Context: ${context}`,
    `Error: ${error}`,
    email ? `Source email: ${email}` : ''
  ].filter(Boolean).join('\n');
  await notifySlack(msg);
  logger.error('Error notification sent', { context, error });
}

module.exports = { notifyInvoiceCreated, notifyError };
