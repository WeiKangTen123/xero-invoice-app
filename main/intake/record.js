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

function buildRecord({ id = newId(), document: doc, invoiceType, source, defaults = {}, extras = {} }) {
  const profile = profileFor(invoiceType);
  const contact = doc.contact || {};
  const name = contact.name || 'Unknown';

  return {
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
    currency:         doc.currency || defaults.currency || require('../utils/users').getUserDefaults(null).currency,
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
}

module.exports = { buildRecord, newId };
