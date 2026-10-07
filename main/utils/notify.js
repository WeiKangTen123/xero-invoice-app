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
    `*Financial Automation error*`,
    `Context: ${context}`,
    `Error: ${error}`,
    email ? `Source email: ${email}` : ''
  ].filter(Boolean).join('\n');
  await notifySlack(msg);
  logger.error('Error notification sent', { context, error });
}

// notifyError, at most once per key per window. For alerts raised by traffic
// rather than by a one-off event: a broken route fails on every request, and
// one Slack message per request would bury the channel, and the message that
// mattered, within minutes. The first occurrence is sent; repeats inside the
// window are dropped (they are still in the log). Resolves true when sent.
const THROTTLE_WINDOW_MS = 10 * 60 * 1000;
const _lastSent = new Map();

function notifyErrorThrottled({ key, windowMs = THROTTLE_WINDOW_MS, now = Date.now(), ...alert }) {
  const k = key ?? String(alert.error);
  const last = _lastSent.get(k);
  if (last !== undefined && now - last < windowMs) return Promise.resolve(false);
  _lastSent.set(k, now);
  // Messages that carry an id are each distinct, so the map is swept of
  // expired keys as it grows rather than kept for the life of the process.
  if (_lastSent.size > 500) {
    for (const [old, at] of _lastSent) if (now - at >= windowMs) _lastSent.delete(old);
  }
  return notifyError(alert).then(() => true);
}

module.exports = { notifyInvoiceCreated, notifyError, notifyErrorThrottled, THROTTLE_WINDOW_MS };
