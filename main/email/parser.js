const pdfParse             = require('pdf-parse');
const path                 = require('path');
const logger               = require('../utils/logger');
const { extractWithRetry } = require('./llm-parser');

// Max PDFs from a single email to process concurrently.
// The llm-parser rate limiter (15 RPM) is the outer constraint;
// this controls parallelism within one email's attachments.
const MAX_PDF_CONCURRENCY = 5;

// ── Filename sanitisation ─────────────────────────────────────────────────────
// Email attachment filenames come from untrusted senders and often contain
// characters that break HTTP Content-Disposition headers or filesystems:
//   "  →  '   (double-quote terminates the quoted header value)
//   /\ →  -   (path separators could escape storage directories)
//   control chars, non-printable → removed
//   runs of whitespace → single space
function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'invoice.pdf';
  const ext  = name.toLowerCase().endsWith('.pdf') ? '' : '.pdf';
  // Use \u escapes so no editor/encoding issue corrupts the character classes.
  // Curly single quotes: ‘ ’ ‚ ‛; prime marks: ′ ‵
  // Curly double quotes: “ ” „ ‟; double primes: ″ ‶
  const safe = name
    .replace(/[/\\]/g, '-')
    .replace(/[‘’‚‛′‵]/g, "'")
    .replace(/[“”„‟″‶]/g, "'")
    .replace(/"/g, "'")
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (safe || 'invoice') + ext;
}

// ── Date utilities ────────────────────────────────────────────────────────────

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function toISODate(raw) {
  if (!raw) return localDateStr(new Date());
  try {
    const trimmed = raw.trim();
    // Skip JS Date() for slash-delimited strings — the engine assumes MM/DD/YYYY
    // which is wrong for SG invoices that use DD/MM/YYYY.
    if (!trimmed.includes('/')) {
      const direct = new Date(trimmed);
      if (!isNaN(direct)) return localDateStr(direct);
    }
    const parts = trimmed.split(/[\/\-\.]/);
    let d;
    if (parts[0].length === 4) {
      // YYYY-MM-DD (ISO / LLM output)
      d = new Date(`${parts[0]}-${parts[1].padStart(2,'0')}-${parts[2].padStart(2,'0')}`);
    } else {
      // Treat as DD/MM/YYYY — handles both unambiguous (day > 12) and ambiguous
      // dates, preferring day-first for SG locale
      d = new Date(`${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`);
    }
    return isNaN(d) ? localDateStr(new Date()) : localDateStr(d);
  } catch {
    return localDateStr(new Date());
  }
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// ── Field helpers ─────────────────────────────────────────────────────────────

function getMatch(text, pattern) {
  const m = text.match(pattern);
  return m ? m[1].trim() : null;
}

function mapTaxType(raw) {
  const t = (raw || '').toLowerCase().trim();
  if (!t || t === 'none' || t === 'n/a' || t === '-' || t === 'no tax') return 'NONE';
  if (t.includes('gst') || t.includes('vat')) return 'TAX001';
  return 'NONE';
}

// Resolve per-user defaults, falling back to .env globals
function _userDefaults(userId) {
  if (!userId) {
    return {
      currency:    process.env.DEFAULT_CURRENCY    || 'USD',
      accountCode: process.env.DEFAULT_ACCOUNT_CODE || '310',
    };
  }
  const { getUserConfig } = require('../utils/users');
  const cfg = getUserConfig(userId);
  return {
    currency:    cfg.DEFAULT_CURRENCY    || process.env.DEFAULT_CURRENCY    || 'USD',
    accountCode: cfg.DEFAULT_ACCOUNT_CODE || process.env.DEFAULT_ACCOUNT_CODE || '310',
  };
}

// ── PDF text extraction ───────────────────────────────────────────────────────

async function extractText(email) {
  const pdfAtts = (email.attachments || []).filter(a =>
    a.contentType === 'application/pdf' ||
    (a.filename || '').toLowerCase().endsWith('.pdf')
  );

  if (pdfAtts.length > 0) {
    const results = [];
    for (const att of pdfAtts) {
      const safeName = sanitizeFilename(att.filename);
      try {
        const data        = await pdfParse(att.content);
        const extractable = data.text && data.text.trim().length > 50;
        if (extractable) {
          logger.info('Extracted text from PDF attachment', { chars: data.text.length, file: att.filename });
        } else {
          // Image-based / scanned PDF — text extraction yielded nothing useful.
          // Still capture the buffer so the PDF is saved and the user can see it;
          // _parseOne will mark it review-needed since LLM will extract nothing.
          logger.warn('PDF has insufficient extractable text — saving for manual review', { file: att.filename });
        }
        results.push({
          text:        extractable ? data.text : `[PDF: ${safeName}]`,
          source:      'pdf',
          pdfBuffer:   att.content,
          pdfFilename: safeName,
          noText:      !extractable,
        });
      } catch (err) {
        // pdf-parse failed entirely (corrupt/encrypted PDF) — still save the raw
        // buffer so the file appears in the system for manual handling.
        logger.warn('PDF text extraction failed — saving raw for manual review', { file: att.filename, error: err.message });
        results.push({
          text:        `[PDF: ${safeName}]`,
          source:      'pdf',
          pdfBuffer:   att.content,
          pdfFilename: safeName,
          noText:      true,
        });
      }
    }
    if (results.length > 0) return results;
  }

  const body = email.text || email.html?.replace(/<[^>]+>/g, ' ') || '';
  return [{ text: body, source: 'email', pdfBuffer: null, pdfFilename: null }];
}

// ── Template format parser ────────────────────────────────────────────────────

function parseTemplateFormat(text, email, defaults) {
  const contactName = getMatch(text, /Client\s*\/\s*Customer[^:\n]*:\s*([^\n]+)/i) || 'Unknown';

  const contactEmail = (getMatch(text, /^Email\s*:\s*([^\n]+)/im) ||
                       email.from?.value?.[0]?.address || '')
                       .replace(/<[^>]+>/g, '').trim();

  const addrMatch    = text.match(/Address\s*:\s*([\s\S]+?)(?:\n\s*\n|\nCreate New|\nDate\s*:|\nPayment)/i);
  const contactAddress = addrMatch
    ? addrMatch[1].replace(/\n/g, ', ').replace(/,\s*,/g, ',').trim()
    : '';

  const invoiceDate = email.date
    ? new Date(email.date).toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];

  const rawPaymentField = getMatch(text, /Payment\s+Terms?\s*\/\s*Payment\s+Date\s*:\s*([^\n]+)/i);
  let dueDate;
  logger.info('Due date field raw', { rawPaymentField });
  if (rawPaymentField) {
    const daysMatch = rawPaymentField.match(/(\d+)\s*days?/i);
    dueDate = daysMatch ? addDays(invoiceDate, parseInt(daysMatch[1])) : toISODate(rawPaymentField);
  } else {
    dueDate = addDays(invoiceDate, 30);
  }

  const currencyLine    = getMatch(text, /^Currency\s*:\s*([^\n]+)/im) || '';
  const currencyParts   = currencyLine.split(',').map(s => s.trim());
  const brandingThemeName = currencyParts.length > 1 ? currencyParts[0] : 'Standard';

  const taxSetting      = getMatch(text, /Tax\s+inclusive\s*\/\s*exclusive\s*:\s*([^\n]+)/i) || '';
  const lineAmountTypes = /inclusive/i.test(taxSetting) ? 'Inclusive' : 'Exclusive';

  const lineItems = [];
  const lineItemRegex = /[ \t]*(?:\d+\.\s*)?Description\s*\/\s*Details\s*:([\s\S]+?)[ \t]*\nAmount\s*:\s*([\d,]*\.?\d*)[ \t]*\nDiscount\s*:\s*([\d.]*)[ \t]*%?[ \t]*\nTax\s*\(If\s*applicable\)\s*:\s*([^\n]*)/gi;
  let match;
  while ((match = lineItemRegex.exec(text)) !== null) {
    const desc = match[1].trim().replace(/[•·]/g, '*');
    if (!desc) continue;
    lineItems.push({
      description:  desc,
      unitAmount:   parseFloat((match[2] || '0').replace(/,/g, '')) || 0,
      discountRate: parseFloat(match[3]) || 0,
      taxType:      mapTaxType(match[4])
    });
  }

  if (!lineItems.length) {
    const desc = getMatch(text, /(?:\d+\.\s*)?Description\s*\/\s*Details\s*:\s*([^\n]+)/i) ||
                 email.subject || `Invoice from ${contactName}`;
    const amt  = parseFloat(
      (getMatch(text, /Amount\s*:\s*([\d,]+\.?\d*)/i) || '0').replace(/,/g, '')
    );
    lineItems.push({ description: desc, unitAmount: amt, discountRate: 0, taxType: 'NONE' });
  }

  const totalAmount = lineItems.reduce((sum, item) =>
    sum + item.unitAmount * (1 - (item.discountRate || 0) / 100), 0);

  const invoiceNumber =
    getMatch(text, /invoice\s*(?:no|number|#|num)[.:\s]*([A-Z0-9][A-Z0-9\-\/]{1,30})/i) ||
    'INV-' + Date.now();

  return {
    contactName:      contactName.trim().slice(0, 255),
    contactEmail:     contactEmail.trim(),
    contactAddress:   contactAddress.slice(0, 500),
    vendorName:       contactName.trim().slice(0, 255),
    invoiceNumber:    invoiceNumber.slice(0, 100),
    invoiceDate,
    dueDate,
    currency:         defaults.currency,
    brandingThemeName,
    lineAmountTypes,
    lineItems,
    totalAmount:      parseFloat(totalAmount.toFixed(2)),
    description:      (email.subject || `Invoice from ${contactName}`).slice(0, 500),
    sourceEmail:      email.from?.text || '',
    accountCode:      defaults.accountCode,
  };
}

// ── Generic / fallback regex parser ──────────────────────────────────────────

function parseGenericFormat(text, email, defaults) {
  const fromName = email.from?.value?.[0]?.name ||
                   email.from?.text?.replace(/<.*>/,'').trim() ||
                   'Unknown Vendor';

  const rawVendor =
    getMatch(text, /(?:client|customer|bill\s*to|billed\s*to)[:\s*]+([A-Za-z][^\n\r]{1,80})/i) ||
    getMatch(text, /(?:from|supplier|vendor|billed\s*by)[:\s]+([A-Za-z][^\n\r,]{1,60})/i) ||
    fromName;
  const vendorName = rawVendor.replace(/^\*+/, '').replace(/\*+$/, '').trim() || fromName;

  const invoiceNumber =
    getMatch(text, /invoice\s*(?:no|number|#|num)[.:\s]*([A-Z0-9][A-Z0-9\-\/]{1,30})/i) ||
    getMatch(text, /(?:invoice\s*number|inv\s*no)[.:\s]*([A-Z0-9][A-Z0-9\-\/]{1,30})/i) ||
    'INV-' + Date.now();

  const rawDate     = getMatch(text, /(?:invoice\s*)?date[:\s]*(\d{1,4}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i);
  const rawDue      = getMatch(text, /due\s*(?:date|by)[:\s]*(\d{1,4}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i);
  const invoiceDate = toISODate(rawDate);
  const dueDate     = rawDue ? toISODate(rawDue) : addDays(invoiceDate,
    parseInt(getMatch(text, /terms?[:\s]*(\d+)\s*days/i) || '30'));

  const rawTotal =
    getMatch(text, /(?:total\s*(?:amount\s*due|due|payable)?|amount\s*due)[:\s]*(?:SGD|USD|AUD|GBP|EUR)?\s*\$?([\d,]+\.?\d{0,2})/i) ||
    getMatch(text, /(?:fees?|amount)[:\s]*(?:SGD|USD|AUD|GBP|EUR)\s*([\d,]+\.?\d{0,2})/i) ||
    getMatch(text, /invoice\s+of\s+(?:SGD|USD|AUD|GBP|EUR)\s*([\d,]+\.?\d{0,2})/i) ||
    getMatch(text, /\$\s*([\d,]+\.\d{2})/);

  const rawSub = getMatch(text, /(?:sub\s*total|subtotal|net\s*amount)[:\s]*(?:SGD|USD|AUD|GBP|EUR)?\s*\$?([\d,]+\.?\d{0,2})/i);
  const rawTax = getMatch(text, /(?:gst|vat|tax\s*amount|tax)[:\s]*(?:SGD|USD|AUD|GBP|EUR)?\s*\$?([\d,]+\.?\d{0,2})/i);

  const totalAmount = rawTotal ? parseFloat(rawTotal.replace(/,/g,'')) : 0;
  const taxAmount   = rawTax   ? parseFloat(rawTax.replace(/,/g,''))   : 0;
  let   subTotal    = rawSub   ? parseFloat(rawSub.replace(/,/g,''))   : totalAmount - taxAmount;
  if (subTotal <= 0) subTotal = totalAmount;

  const cleanVendor = vendorName.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 255) || 'Unknown Vendor';

  return {
    contactName:      cleanVendor,
    contactEmail:     email.from?.value?.[0]?.address || '',
    contactAddress:   '',
    vendorName:       cleanVendor,
    invoiceNumber:    invoiceNumber.slice(0, 100),
    invoiceDate,
    dueDate,
    currency:         defaults.currency,
    brandingThemeName:'Standard',
    lineAmountTypes:  'Exclusive',
    lineItems: [{
      description:  (email.subject || `Invoice from ${cleanVendor}`).slice(0, 500),
      unitAmount:   parseFloat(subTotal.toFixed(2)),
      discountRate: 0,
      taxType:      taxAmount > 0 ? 'TAX001' : 'NONE'
    }],
    totalAmount:   parseFloat(totalAmount.toFixed(2)),
    description:   (email.subject || `Invoice from ${cleanVendor}`).slice(0, 500),
    sourceEmail:   email.from?.text || '',
    accountCode:   defaults.accountCode,
    subTotal:      parseFloat(subTotal.toFixed(2)),
    taxAmount:     parseFloat(taxAmount.toFixed(2)),
  };
}

// ── LLM-based PDF parser ──────────────────────────────────────────────────────

async function parsePDFWithLLM(text, email, pdfFilename, userId, defaults) {
  let llm;
  try {
    llm = await extractWithRetry(text, pdfFilename || 'invoice.pdf', userId);
  } catch (err) {
    logger.warn('LLM parse failed, falling back to regex', { error: err.message, userId });
    return parseGenericFormat(text, email, defaults);
  }

  const invoiceDate = llm.invoiceDate || new Date().toISOString().split('T')[0];
  const dueDate     = llm.dueDate     || addDays(invoiceDate, 30);

  const lineItems = (llm.lineItems || []).map(li => ({
    description:  li.description,
    unitAmount:   parseFloat(li.amount ?? li.unitAmount) || 0,
    discountRate: 0,
    taxType:      'NONE',
  }));

  if (!lineItems.length) {
    lineItems.push({
      description:  email.subject || `Invoice from ${llm.vendorName}`,
      unitAmount:   parseFloat(llm.totalAmount) || 0,
      discountRate: 0,
      taxType:      'NONE',
    });
  }

  const fallbackInvoiceNumber = path.basename(pdfFilename || '', '.pdf').split(' ')[0] || ('INV-' + Date.now());

  return {
    contactName:      (llm.vendorName || 'Unknown Vendor').slice(0, 255),
    contactEmail:     llm.vendorEmail   || email.from?.value?.[0]?.address || '',
    contactAddress:   llm.vendorAddress || '',
    vendorName:       (llm.vendorName || 'Unknown Vendor').slice(0, 255),
    vendorPhone:      llm.vendorPhone   || '',
    invoiceNumber:    (llm.invoiceNumber || fallbackInvoiceNumber).slice(0, 100),
    invoiceDate,
    dueDate,
    currency:         llm.currency || defaults.currency,
    brandingThemeName:'Standard',
    lineAmountTypes:  'Exclusive',
    lineItems,
    totalAmount:      parseFloat(llm.totalAmount) || 0,
    description:      (email.subject || `Invoice from ${llm.vendorName}`).slice(0, 500),
    sourceEmail:      email.from?.text || '',
    accountCode:      defaults.accountCode,
    paymentReference: llm.paymentReference || '',
    projectName:      llm.projectName      || '',
  };
}

// ── Per-extract parser ────────────────────────────────────────────────────────

async function _parseOne({ text, source, pdfBuffer, pdfFilename, noText }, email, userId, defaults) {
  if (!text || text.length < 3) return null;

  const isTemplate = /Client\s*\/\s*Customer[^:\n]*:/i.test(text) &&
                     /(?:\d+\.\s*)?Description\s*\/\s*Details\s*:/i.test(text);

  if (!isTemplate && source !== 'pdf') {
    logger.info('Email skipped — does not match template and has no PDF', {
      subject: email.subject, from: email.from?.text, userId,
    });
    return null;
  }

  let parsed;
  if (isTemplate) {
    logger.info('Template format detected', { userId });
    parsed = parseTemplateFormat(text, email, defaults);
  } else if (noText) {
    // Image-based or corrupt PDF — no usable text for the LLM.
    // Fall back to generic regex (will extract what it can from email headers/subject)
    // and let the invoice-handler mark it review-needed via the zero-amount guard.
    logger.info('PDF has no extractable text — using generic parser, will be review-needed', { file: pdfFilename, userId });
    parsed = parseGenericFormat(text, email, defaults);
  } else {
    logger.info('PDF invoice detected — using LLM parser', { file: pdfFilename, userId });
    parsed = await parsePDFWithLLM(text, email, pdfFilename, userId, defaults);
  }

  const invoiceType = source === 'pdf' ? 'ACCPAY' : 'ACCREC';
  const result = {
    ...parsed,
    invoiceType,
    source,
    pdfBuffer:     pdfBuffer   || null,
    pdfFilename:   pdfFilename || null,
    emailBodyText: text.slice(0, 50000),
  };

  logger.info('Invoice parsed', {
    vendor:      result.vendorName,
    number:      result.invoiceNumber,
    total:       result.totalAmount,
    source:      result.source,
    invoiceType: result.invoiceType,
    lineItems:   result.lineItems?.length || 1,
    format:      isTemplate ? 'template' : 'llm',
    userId,
  });

  return result;
}

// ── Main entry ────────────────────────────────────────────────────────────────
// Accepts userId so:
//  - LLM calls use that user's API keys and rate limiter
//  - Currency/account defaults come from user config
//  - PDFs within one email are processed in batches of MAX_PDF_CONCURRENCY

async function parseInvoice(email, userId) {
  const extracts = await extractText(email);
  const defaults = _userDefaults(userId);
  const invoices = [];

  if (extracts.length > 1) {
    logger.info(`Batch processing ${extracts.length} PDF(s) — up to ${MAX_PDF_CONCURRENCY} concurrent`, { userId });
  }

  // Process in chunks of MAX_PDF_CONCURRENCY to balance speed and API pressure
  for (let i = 0; i < extracts.length; i += MAX_PDF_CONCURRENCY) {
    const chunk   = extracts.slice(i, i + MAX_PDF_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map(extract => _parseOne(extract, email, userId, defaults))
    );
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) invoices.push(r.value);
      else if (r.status === 'rejected') logger.error('PDF parse error in batch', { error: r.reason?.message, userId });
    }
  }

  return invoices.length > 0 ? invoices : null;
}

module.exports = { parseInvoice };
