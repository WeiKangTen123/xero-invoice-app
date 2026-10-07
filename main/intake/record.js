const { profileFor } = require('./profiles');

// A Document plus a profile becomes a row. This was built in three places —
// the email handler, the receipt upload, the claim import — each with its own
// defaults and its own idea of the initial status. One builder now, and the
// status comes from the profile rather than from whichever file happened to
// be constructing the row.
//
// `extras` is for what only one path knows: a stored PDF's filename, a
// receipt's image and hash, a claim's category. They are spread last, so a
// path can override a default but the shape is always the same.

const { newId } = require('../utils/ids');
const { CURRENCY_CODES, currencyCode, detectCurrency } = require('./document');

// A currency as Xero will take it — a three-letter code — from whatever a
// reader handed over: "sgd", "SGD 1,200", "S$", "RM". Null when nothing in it
// names a currency (a bare "$" does not), so the caller falls back to a
// default instead of storing junk. A symbol on its own is looked up here; text
// around an amount goes to the intake helper. "US$" is matched before that
// helper sees it, because its symbol scan finds the "S$" inside and says SGD.
const SYMBOLS = [
  [/^US\s?\$$/i, 'USD'], [/^S\s?\$$/i, 'SGD'], [/^A\s?\$$/i, 'AUD'], [/^NZ\s?\$$/i, 'NZD'],
  [/^HK\s?\$$/i, 'HKD'], [/^CA?\s?\$$/i, 'CAD'], [/^RM$/i, 'MYR'], [/^£$/, 'GBP'], [/^€$/, 'EUR'], [/^₹$/, 'INR'],
];
function cleanCurrency(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const v = value.trim();
  const code = currencyCode(v);
  if (code) return code;
  const lead = v.match(/^([A-Za-z]{3})\b/);
  if (lead && CURRENCY_CODES.includes(lead[1].toUpperCase())) return lead[1].toUpperCase();
  const symbol = SYMBOLS.find(([re]) => re.test(v));
  if (symbol) return symbol[1];
  if (/^US\s?\$/i.test(v)) return 'USD';
  return detectCurrency(v);
}

function buildRecord({ id = newId(), document: doc, invoiceType, source, defaults = {}, extras = {} }) {
  const profile = profileFor(invoiceType);
  const contact = doc.contact || {};
  const name = contact.name || 'Unknown';

  const row = {
    id,
    status:           profile.initialStatus(source),
    hasPdf:           false,
    pdfFilename:      null,
    // vendorName and contactName have always both been written, from one
    // label, and read from either depending on the caller. Kept in step.
    vendorName:       name,
    contactName:      contact.name || '',
    contactEmail:     contact.email || '',
    contactAddress:   contact.address || '',
    invoiceNumber:    doc.number || '—',
    invoiceDate:      doc.date || null,
    dueDate:          doc.dueDate || null,
    totalAmount:      doc.total || 0,
    currency:         null, // decided below, after the extras
    invoiceType:      profile.xeroType === 'ACCREC' ? 'ACCREC' : invoiceType,
    source,
    sourceEmail:      '',
    lineItems:        (doc.lineItems || []).map(li => ({
      description: li.description, unitAmount: li.unitAmount, discountRate: li.discountRate || 0,
    })),
    description:      doc.description || '',
    accountCode:      defaults.accountCode || '',
    taxAmount:        doc.taxAmount || 0,
    subTotal:         doc.subTotal || 0,
    paymentReference: doc.paymentReference || '',
    brandingThemeName: doc.brandingThemeName || undefined,
    lineAmountTypes:  doc.lineAmountTypes || undefined,
    processedAt:      new Date().toISOString(),
    receivedAt:       extras.receivedAt || new Date().toISOString(),
    reports:          [],
    ...extras,
  };
  // Extras are spread last, so a path that passed its raw parser value ("S$")
  // used to override the cleaned code above, and Xero refused the bill. The
  // currency is cleaned once more here, whichever side supplied it.
  row.currency = cleanCurrency(extras.currency)
    || doc.currency
    || cleanCurrency(defaults.currency)
    || require('../utils/users').getUserDefaults(null).currency;
  return row;
}

module.exports = { buildRecord, newId, cleanCurrency };
