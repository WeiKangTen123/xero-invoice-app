const pdfParse             = require('pdf-parse');
const { verifyTemplateExtraction } = require('./template-verifier');
const { isPaymentSchedule }        = require('./invoice-template');
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

// Strips email forwarding clutter (Fwd:, Re:, [EXTERNAL], [Spam]) so descriptions
// derived from email subjects are clean and human-readable.
function cleanSubject(subject) {
  if (!subject || typeof subject !== 'string') return '';
  return subject
    .replace(/^(\s*(fwd?|re|fw)\s*:\s*)+/i, '')
    .replace(/^\[(external|spam|bulk)\]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Shared helpers ────────────────────────────────────────────────────────────
// Dates, numbers, currency and the subtotal/tax invariant come from the intake
// core, so this parser, the receipt parser and the row builder cannot drift
// apart again. toISODate keeps its old contract — "today" when unreadable —
// because a due date it cannot read is better dated today than left blank;
// callers that want null (an invoice date) use intake.parseDate directly.
const intake = require('../intake/document');
const { CURRENCY_CODES, addDays } = intake;
function toISODate(raw) { return intake.parseDate(raw) || intake.today(); }
function getMatch(text, pattern) {
  const m = text.match(pattern);
  return m ? m[1].trim() : null;
}
const _detectCurrency    = intake.detectCurrency;
const { cleanCurrency }  = require('../intake/record');
const _parseTaxPercent   = intake.parseTaxPercent;
const _ensureSubtotalTax = intake.ensureSubtotalTax;
// Resolve per-user defaults, falling back to .env globals
function _userDefaults(userId) {
  const d = require('../utils/users').getUserDefaults(userId);
  return { currency: d.currency, accountCode: d.accountCode.bill, accountCodes: d.accountCode };
}

// What an attachment is: the mark the queue put on it, or, for a caller that
// hands over a raw mailparser result, the same rule the queue applies.
const _kind = a => a.kind || intake.documentKind(a);

// A document forwarded inside the email is read as coming from the inner
// message's sender, under its subject (see email-queue _forwardedOrigin): the
// outer sender is a colleague passing it on, and "Fwd: …" says nothing about
// what was bought. The arrival date and the Message-ID stay the outer email's.
function _readAs(email, origin) {
  if (!origin) return email;
  return {
    ...email,
    from:    origin.from?.text ? origin.from : email.from,
    subject: origin.subject || email.subject,
  };
}

// 'high' | 'medium' | 'low', or null when the reader did not say.
function _confidence(value) {
  const c = String(value || '').trim().toLowerCase();
  return ['high', 'medium', 'low'].includes(c) ? c : null;
}

// ── PDF text extraction ───────────────────────────────────────────────────────

// `email.skipBody` is set by the worker when the body must not be read: the
// email came with PDFs (its body was never the document), or a row was
// already made from it. Without it, an email whose PDFs had all been read
// before would fall through to its body and be read as something else.
async function extractText(email) {
  const pdfAtts = (email.attachments || []).filter(a => _kind(a) === 'pdf');

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
          origin:      att.forwarded || null,
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
          origin:      att.forwarded || null,
        });
      }
    }
    if (results.length > 0) return results;
  }

  if (email.skipBody) return [];
  const body = email.text || email.html?.replace(/<[^>]+>/g, ' ') || '';
  return [{ text: body, source: 'email', pdfBuffer: null, pdfFilename: null }];
}

// ── Template format parser ────────────────────────────────────────────────────

function parseTemplateFormat(rawText, email, defaults) {
  const text = _plainTemplateText(rawText);
  const contactName = getMatch(text, /Client\s*\/\s*Customer[^:\n]*:\s*([^\n]+)/i) || 'Unknown';

  const contactEmail = (getMatch(text, /^Email\s*:\s*([^\n]+)/im) ||
                       email.from?.value?.[0]?.address || '')
                       .replace(/<[^>]+>/g, '').trim();

  // The address runs until a blank line or the next template label. It used to
  // stop only on three named labels, so with "Currency :" directly beneath it —
  // which is where the template puts it — the address came through as
  // "58 Senoko Road, Singapore 758122, Currency : SGD, Standard". Any
  // "Label :" shaped line ends it now, so reordering the template's header
  // fields cannot reintroduce this.
  const addrMatch    = text.match(/Address\s*:\s*([\s\S]+?)(?=\n\s*\n|\n\s*[A-Z][A-Za-z /()]{1,40}\s*:|\n\s*\d+\.\s*Description|$)/i);
  const contactAddress = addrMatch
    ? addrMatch[1].replace(/\n/g, ', ').replace(/,\s*,/g, ',').trim()
    : '';

  // "Invoice Date :" is optional on the template. When it is there it is the
  // invoice's date; when it is not, the email's arrival date stands in, which
  // is what every AR invoice was dated by until this field existed. The digit
  // check is because toISODate answers "today" for anything it cannot read,
  // and "TBC" should fall through to the email date rather than become today.
  const statedDate  = getMatch(text, /^Invoice\s*Date\s*:\s*([^\n]+)/im);
  const invoiceDate = (statedDate && /\d/.test(statedDate))
    ? toISODate(statedDate)
    : email.date
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

  // This template's "Currency:" line has actually been used to carry a currency
  // code AND a branding theme name together (comma-separated, either order seen
  // in practice — "SGD, Standard" or "Standard, SGD") — previously only the
  // non-currency part was ever kept, and only when there happened to be a comma,
  // so the actual currency code in this field was silently discarded even when
  // explicitly stated. Order-agnostic here: whichever part is a real ISO code is
  // the currency, whichever isn't is the theme name.
  const currencyLine      = getMatch(text, /^Currency\s*:\s*([^\n]+)/im) || '';
  const currencyParts     = currencyLine.split(',').map(s => s.trim()).filter(Boolean);
  const templateCurrency  = currencyParts.find(p => CURRENCY_CODES.includes(p.toUpperCase())) || null;
  const brandingThemeName = currencyParts.find(p => !CURRENCY_CODES.includes(p.toUpperCase())) || 'Standard';

  const taxSetting      = getMatch(text, /Tax\s+inclusive\s*\/\s*exclusive\s*:\s*([^\n]+)/i) || '';
  const lineAmountTypes = /inclusive/i.test(taxSetting) ? 'Inclusive' : 'Exclusive';
  // "Inclusive" means each Amount already contains its tax. The tax was added
  // on top regardless, so a 1,090 line at 9% became a 1,188.10 invoice, and
  // the row disagreed with the total Xero computed once posted. Inclusive
  // amounts carry their tax inside: the total is the lines, and the tax is the
  // part of each line that is tax.
  const inclusive       = lineAmountTypes === 'Inclusive';

  const lineItems = [];
  let taxAmount = 0;
  // Two things about this pattern, both learned from production rows:
  //
  // "Amount :" is followed by an optional currency token before the number —
  // the template writes "Amount : SGD1000". The digits class alone stopped at
  // the S and every AR amount parsed as zero.
  //
  // The whitespace after "Discount :" and "Tax (If applicable) :" is [ \t], not
  // \s. The template leaves both values blank, and a greedy \s* crossed the
  // newlines so that ([^\n]*) captured the NEXT line — which is the next item's
  // "2. Description / Details :" header. Item one swallowed item two's opening
  // label, item two could never match, and stored descriptions carried stray
  // "Description / Detai" fragments. Neither was caught because nothing tested
  // this function against the template it exists for. See parser.test.js.
  //
  // Between "Amount", "Discount" and "Tax" the seams are \s*\n — a sender who
  // leaves blank lines after "Amount : 1000" (they do) must not lose the block.
  // The value captures close before those seams, so nothing leaks across.
  const lineItemRegex = /[ \t]*(?:\d+\.\s*)?Description\s*\/\s*Details\s*:([\s\S]+?)[ \t]*\nAmount\s*:\s*(?:[A-Za-z]{3}|[A-Za-z]{0,2}[$£€])?\s*([\d,]*\.?\d*)[ \t]*\s*\nDiscount\s*:[ \t]*([\d.]*)[ \t]*%?[ \t]*\s*\nTax\s*\(If\s*applicable\)\s*:[ \t]*([^\n]*)/gi;
  let match;
  const schedules = [];
  while ((match = lineItemRegex.exec(text)) !== null) {
    const desc = match[1].trim().replace(/[•·]/g, '*');
    if (!desc) continue;
    const unitAmount   = parseFloat((match[2] || '0').replace(/,/g, '')) || 0;
    const discountRate = parseFloat(match[3]) || 0;
    // A block that describes HOW the money is paid — "50% upon confirmation,
    // 50% on event date" — is a payment schedule, not more work. Its amount is
    // an instalment of the real items and must not be added to the total; its
    // text (scope of work, terms) belongs on the invoice, so it is kept.
    if (lineItems.length && _isPaymentSchedule(desc)) {
      schedules.push({ text: desc, amount: unitAmount });
      continue;
    }
    // A real percentage (e.g. "GST 9%") contributes a computable dollar amount to
    // the invoice-level taxAmount; free text with no number ("GST", "-") doesn't —
    // resolveTaxType in xero/invoices.js needs a dollar figure, not a label.
    const taxPercent = _parseTaxPercent(match[4]);
    if (taxPercent != null) {
      const net = unitAmount * (1 - discountRate / 100);
      taxAmount += inclusive ? net * taxPercent / (100 + taxPercent) : net * (taxPercent / 100);
    }
    lineItems.push({ description: desc, unitAmount, discountRate });
  }

  let scheduleReason = null;
  const scheduleNotes = schedules.map(sc => _scheduleText(sc));
  if (schedules.length) {
    const last = lineItems[lineItems.length - 1];
    last.description = [last.description, ...scheduleNotes].join('\n');
    const instalments = schedules.map(sc => sc.amount).filter(a => a > 0);
    scheduleReason = `the email has a payment schedule block (${instalments.map(a => a.toLocaleString('en')).join(', ') || 'no amount'}) ` +
      `alongside the line items — it was read as terms, not as another item. Confirm the total`;
  }

  if (!lineItems.length) {
    const desc = getMatch(text, /(?:\d+\.\s*)?Description\s*\/\s*Details\s*:\s*([^\n]+)/i) ||
                 cleanSubject(email.subject) || `Invoice from ${contactName}`;
    const amt  = parseFloat(
      (getMatch(text, /Amount\s*:\s*(?:[A-Za-z]{3}|[A-Za-z]{0,2}[$£€])?\s*([\d,]+\.?\d*)/i) || '0').replace(/,/g, '')
    );
    lineItems.push({ description: desc, unitAmount: amt, discountRate: 0 });
  }

  const lineTotal   = lineItems.reduce((sum, item) =>
    sum + item.unitAmount * (1 - (item.discountRate || 0) / 100), 0);
  // Rounded once, here, and the subtotal taken as the difference, so subtotal
  // plus tax is the total to the cent whichever way the lines are stated.
  taxAmount         = Math.round(taxAmount * 100) / 100;
  const totalAmount = Math.round((inclusive ? lineTotal : lineTotal + taxAmount) * 100) / 100;
  const subTotal    = Math.round((totalAmount - taxAmount) * 100) / 100;

  // "Invoice Number :" is optional on the template and wins when present. The
  // loose pattern beneath it predates the field and can match prose ("invoice
  // number will follow" → "will"), so it is only consulted when the label is
  // absent. INV-<timestamp> is the last resort, and invoice-handler treats that
  // shape as "no number" when deciding whether an invoice is worth submitting.
  const invoiceNumber =
    getMatch(text, /^Invoice\s*(?:Number|No\.?|#)\s*:\s*([A-Za-z0-9][A-Za-z0-9\-\/_.]{0,60})/im) ||
    getMatch(text, /invoice\s*(?:no|number|#|num)[.:\s]*([A-Z0-9][A-Z0-9\-\/]{1,30})/i) ||
    'INV-' + Date.now();

  return {
    // When the EMAIL arrived, not when we got round to reading it.
    receivedAt:       email.date ? new Date(email.date).toISOString() : null,
    contactName:      contactName.trim().slice(0, 255),
    contactEmail:     contactEmail.trim(),
    contactAddress:   contactAddress.slice(0, 500),
    vendorName:       contactName.trim().slice(0, 255),
    invoiceNumber:    invoiceNumber.slice(0, 100),
    invoiceDate,
    dueDate,
    currency:         templateCurrency || _detectCurrency(text) || defaults.currency,
    // Whether the document itself named the currency. The line above falls
    // back to the Setup default, and supplier memory (utils/supplier-memory.js)
    // must not mistake that fallback for a currency the supplier stated.
    currencyStated:   !!(templateCurrency || _detectCurrency(text)),
    brandingThemeName,
    lineAmountTypes,
    lineItems,
    totalAmount:      parseFloat(totalAmount.toFixed(2)),
    subTotal:         parseFloat(subTotal.toFixed(2)),
    taxAmount:        parseFloat(taxAmount.toFixed(2)),
    description:      (_describeItems(lineItems) || cleanSubject(email.subject) || `Invoice from ${contactName}`).slice(0, 500),
    sourceEmail:      email.from?.text || '',
    accountCode:      defaults.accountCode,
    // Set when a block was read as a payment schedule. A person confirms the
    // total before anything moves; the handler turns this into review-needed.
    reviewReason:     scheduleReason,
    // The text of those blocks as attached to the last item, so the verifier
    // can correct the item's own wording without dropping the terms.
    scheduleNotes,
  };
}

// Declared with the template (invoice-template.js) so the verifier applies the
// same rule; kept under this name for the tests that pin it.
const _isPaymentSchedule = isPaymentSchedule;

// Strip the nested "Description / Details :" label a sender leaves inside the
// block; the words are what matter.
// mailparser turns the HTML email into Markdown-ish text: bold becomes
// *Project*:, list items become "   - ". Those marks are formatting, not
// content — they were ending up in stored descriptions ("Project*: Demo").
function _plainTemplateText(text) {
  return String(text || '')
    .replace(/^[ \t]*[-•·][ \t]+/gm, '')                 // list bullets
    .replace(/(^|[\s(])[*_]{1,2}(?=\S)/gm, '$1')          // opening emphasis
    .replace(/(?<=\S)[*_]{1,2}(?=[\s:;,.)]|$)/gm, '');   // closing emphasis
}

function _scheduleText(sc) {
  const t = sc.text.replace(/^\s*[*]?\s*Description\s*\/\s*Details\s*:\s*/gim, '').trim();
  return /payment\s*terms?/i.test(t) ? t : `Payment terms: ${t}`;
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
    // When the EMAIL arrived, not when we got round to reading it.
    receivedAt:       email.date ? new Date(email.date).toISOString() : null,
    contactName:      cleanVendor,
    contactEmail:     email.from?.value?.[0]?.address || '',
    contactAddress:   '',
    vendorName:       cleanVendor,
    invoiceNumber:    invoiceNumber.slice(0, 100),
    invoiceDate,
    dueDate,
    currency:         _detectCurrency(text) || defaults.currency,
    // Whether the document itself named the currency. The line above falls
    // back to the Setup default, and supplier memory (utils/supplier-memory.js)
    // must not mistake that fallback for a currency the supplier stated.
    currencyStated:   !!_detectCurrency(text),
    brandingThemeName:'Standard',
    lineAmountTypes:  'Exclusive',
    lineItems: [{
      description:  (cleanSubject(email.subject) || `Invoice from ${cleanVendor}`).slice(0, 500),
      unitAmount:   parseFloat(subTotal.toFixed(2)),
      discountRate: 0,
    }],
    totalAmount:   parseFloat(totalAmount.toFixed(2)),
    description:   (cleanSubject(email.subject) || `Invoice from ${cleanVendor}`).slice(0, 500),
    sourceEmail:   email.from?.text || '',
    accountCode:   defaults.accountCode,
    subTotal:      parseFloat(subTotal.toFixed(2)),
    taxAmount:     parseFloat(taxAmount.toFixed(2)),
  };
}

// ── LLM-based PDF parser ──────────────────────────────────────────────────────

function _oneLine(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length >= 4 ? t.slice(0, 200) : '';
}

// A description built from the items themselves: the first line of each,
// joined, so "create AP invoice" never stands in for what was bought.
function _describeItems(lineItems) {
  const names = (lineItems || [])
    .map(li => {
      const lines = String(li.description || '').split('\n').map(l => l.replace(/^\s*[*•·-]\s*/, '').trim());
      // The AR template names the job as "Project: X" / "Campaign: Y".
      const field = label => (lines.find(l => new RegExp(`^${label}\\s*:`, 'i').test(l)) || '').replace(/^[^:]*:\s*/, '').trim();
      const project = field('Project'), campaign = field('Campaign');
      if (project) return campaign ? `${project} — ${campaign}` : project;
      return (lines.find(Boolean) || '').replace(/^(Project|Campaign)\s*:\s*/i, '');
    })
    .filter(n => n && n.toLowerCase() !== 'item');
  if (!names.length) return '';
  const shown = names.slice(0, 4).join(', ');
  return names.length > 4 ? `${shown} +${names.length - 4} more` : shown;
}

// The bank's address from the payment box kept being returned as the vendor's
// (JCPINV-1063 stored DBS's). The model now has a slot for the bank address;
// a vendor address that is the same text, or that sits inside the assembled
// payment reference, is the bank's and is dropped rather than stored wrong.
function _vendorAddress(llm) {
  const norm = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const addr = String(llm.vendorAddress || '').trim();
  if (!addr) return '';
  const a = norm(addr);
  const bank = norm(llm.bankAddress);
  if (bank && (a === bank || a.includes(bank) || bank.includes(a))) return '';
  const pay = norm(llm.paymentReference);
  if (pay && a.length >= 12 && pay.includes(a)) return '';
  return addr;
}

// What the model says the document is. Every PDF that reached this path used to
// become a bill, so a receipt for something already paid, a statement listing
// bills already in Xero, a credit note or a quote could be posted as a new bill
// to pay. Anything but an invoice is held, with what it appears to be.
const DOCUMENT_TYPES = {
  invoice:     null,
  receipt:     'this PDF looks like a receipt for a payment already made, not a bill to pay',
  statement:   'this PDF looks like a statement of account, not a bill; the invoices on it may already be in Xero',
  credit_note: 'this PDF looks like a credit note, not a bill; it would go to Xero as a credit note, not a bill',
  quote:       'this PDF looks like a quote or estimate, not a bill',
  other:       'this PDF does not look like an invoice or bill',
};
function _documentType(value) {
  const t = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!t) return null;   // not answered: treated as before, as a bill
  if (/^(tax_)?invoice$|^bill$|^supplier_invoice$/.test(t)) return 'invoice';
  if (/receipt|payment_confirmation/.test(t)) return 'receipt';
  if (/statement/.test(t)) return 'statement';
  if (/credit/.test(t)) return 'credit_note';
  if (/quot|estimate|pro_?forma/.test(t)) return 'quote';
  return Object.prototype.hasOwnProperty.call(DOCUMENT_TYPES, t) ? t : 'other';
}

// Within two cents is rounding, not a disagreement.
const MONEY_TOLERANCE = 0.02;
const _money2 = n => Math.round(n * 100) / 100;
const _fmt = (n, cur) => `${cur ? cur + ' ' : ''}${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Whether the figures the model read add up. They were posted as read, so a
// misread line or a total from the wrong row went to Xero with nothing to say
// so. Same rule as the template verifier (template-verifier.js): a
// disagreement about money is a flag, never an overwrite — the figures are
// kept as read and a person decides. Null when they agree.
//
// `itemsRead` is false when the model returned no lines and the one line was
// built from the total, which agrees with it by construction.
function _moneyMismatch({ lineItems, subTotal, taxAmount, totalAmount, currency }, { itemsRead = true } = {}) {
  const total = Number(totalAmount);
  if (!(total > 0)) return null;   // a zero total is held on its own (invoice-handler.holdReason)
  const sub = subTotal ?? null;
  const tax = taxAmount ?? null;
  const problems = [];

  if (sub !== null && tax !== null && Math.abs(_money2(sub + tax) - total) > MONEY_TOLERANCE) {
    problems.push(`the subtotal ${_fmt(sub, currency)} plus tax ${_fmt(tax, currency)} comes to ${_fmt(sub + tax, currency)}, but the total is ${_fmt(total, currency)}`);
  }
  if (itemsRead && Array.isArray(lineItems) && lineItems.length) {
    const lines = _money2(lineItems.reduce((s, li) => s + (Number(li.unitAmount) || 0) * (1 - (Number(li.discountRate) || 0) / 100), 0));
    const expected = sub !== null ? sub : _money2(total - (tax || 0));
    const against  = sub !== null ? 'subtotal' : tax !== null ? 'total before tax' : 'total';
    if (Math.abs(lines - expected) > MONEY_TOLERANCE) {
      problems.push(`the line items add up to ${_fmt(lines, currency)}, but the ${against} is ${_fmt(expected, currency)}`);
    }
  }
  return problems.length ? problems.join('; ') : null;
}

async function parsePDFWithLLM(text, email, pdfFilename, userId, defaults) {
  let llm;
  try {
    llm = await extractWithRetry(text, pdfFilename || 'invoice.pdf', userId);
  } catch (err) {
    logger.warn('LLM parse failed, falling back to regex', { error: err.message, userId });
    const guess = parseGenericFormat(text, email, defaults);
    // A regex guess at a PDF is never sent on unreviewed.
    guess.reviewReason = err && err.code === 'GEMINI_TRUNCATED'
      ? "the model's reading of the PDF was cut off before it finished; the figures below are a rough guess from the text"
      : 'the PDF could not be read by the model; the figures below are a rough guess from the text';
    return guess;
  }

  // Model answers are text. The shared cleaners read "1,250.00" as 1250 and
  // "14/09/2026" as a date; parseFloat read the first as 1 and the second
  // threw. An unreadable invoice date falls back to the email's date — never
  // today, which is the drift intake/document.js exists to stop.
  const emailDate   = email.date ? intake.localDateStr(new Date(email.date)) : intake.today();
  const invoiceDate = intake.isoDate(llm.invoiceDate) || intake.parseDate(llm.invoiceDate) || emailDate;
  const dueDate     = intake.isoDate(llm.dueDate) || intake.parseDate(llm.dueDate) || intake.addDays(invoiceDate, 30);

  // One normaliser for every reader: "2 × 75.00" rides in the description and
  // unitAmount is the line total — the figure Xero must receive.
  const lineItems = (Array.isArray(llm.lineItems) ? llm.lineItems : []).map(li => intake.normaliseLineItem(li)).filter(Boolean)
    .map(({ description, unitAmount, discountRate }) => ({ description, unitAmount, discountRate }));
  const itemsRead = lineItems.length > 0;

  if (!lineItems.length) {
    lineItems.push({
      description:  cleanSubject(email.subject) || `Invoice from ${llm.vendorName}`,
      unitAmount:   intake.money(llm.totalAmount) ?? 0,
      discountRate: 0,
    });
  }

  // A model that answers "S$" or "sgd" is cleaned to the code Xero takes, the
  // same way the row builder cleans it (intake/record.js).
  const currency    = cleanCurrency(llm.currency) || _detectCurrency(text) || defaults.currency;
  const currencyStated = !!(cleanCurrency(llm.currency) || _detectCurrency(text));
  const totalAmount = intake.money(llm.totalAmount) ?? 0;
  const subTotal    = intake.money(llm.subTotal);
  const taxAmount   = intake.money(llm.taxAmount);
  const documentType = _documentType(llm.documentType);

  // Everything here holds the bill for a person rather than posting it; the
  // handler turns reviewReason into review-needed. Several can apply at once.
  const reasons = [];
  if (documentType && DOCUMENT_TYPES[documentType]) reasons.push(DOCUMENT_TYPES[documentType]);
  const mismatch = _moneyMismatch({ lineItems, subTotal, taxAmount, totalAmount, currency }, { itemsRead });
  if (mismatch) reasons.push(mismatch);
  if (llm.textTruncated) {
    reasons.push(`the PDF is long, and only its first ${llm.textTruncated.sentChars.toLocaleString('en-US')} of ${llm.textTruncated.totalChars.toLocaleString('en-US')} characters were read; a total or line on a later page may be missing`);
  }
  if (reasons.length) logger.warn('LLM bill held for review', { userId, file: pdfFilename, documentType, reasons });

  // No number is left auto-shaped ("INV-<timestamp>") so the handler holds
  // the bill; the filename's first token used to stand in and looked real.
  return {
    // When the EMAIL arrived, not when we got round to reading it.
    receivedAt:       email.date ? new Date(email.date).toISOString() : null,
    contactName:      (llm.vendorName || 'Unknown Vendor').slice(0, 255),
    contactEmail:     llm.vendorEmail   || email.from?.value?.[0]?.address || '',
    contactAddress:   _vendorAddress(llm),
    vendorName:       (llm.vendorName || 'Unknown Vendor').slice(0, 255),
    vendorPhone:      llm.vendorPhone   || '',
    invoiceNumber:    String(llm.invoiceNumber || `INV-${Date.now()}`).slice(0, 100),
    invoiceDate,
    dueDate,
    // Regex fallback covers the rare case the LLM leaves currency null on text that
    // actually does state it — belt-and-braces, not the primary detection path.
    currency,
    // Whether the document itself named the currency. The line above falls
    // back to the Setup default, and supplier memory (utils/supplier-memory.js)
    // must not mistake that fallback for a currency the supplier stated.
    currencyStated,
    brandingThemeName:'Standard',
    lineAmountTypes:  'Exclusive',
    lineItems,
    totalAmount,
    // Both nullable — _ensureSubtotalTax (called by the shared caller) fills in
    // whichever the LLM didn't find from whichever it did, so xero/invoices.js
    // always has a real dollar figure to look up the org's actual tax rate with.
    subTotal,
    taxAmount,
    documentType: documentType || 'invoice',
    reviewReason: reasons.length ? reasons.join('; ') : null,
    // What the bill is for, read from its items — not the subject line the
    // sender typed to forward it ("create AP invoice").
    description:      (_oneLine(llm.description) || _describeItems(lineItems) || cleanSubject(email.subject) || `Invoice from ${llm.vendorName}`).slice(0, 500),
    sourceEmail:      email.from?.text || '',
    accountCode:      defaults.accountCode,
    paymentReference: llm.paymentReference || '',
    projectName:      llm.projectName      || '',
    // How sure the reader says it is, when it says.
    confidence:       _confidence(llm.confidence),
  };
}

// ── Photographed bills ────────────────────────────────────────────────────────
// A photo of a bill (a phone snap of a paper invoice, a screenshot) has no text
// for the bill reader, so it goes to the vision reader the receipt upload
// already uses (utils/receipt-parser.js). That reader is built for receipts:
// it reads the merchant, the date, the figures and the lines, not an invoice
// number, a due date or bank details. So a photographed bill is stored for a
// person to finish against the photo and never reaches Xero on its own: its
// source is one the bill profile never auto-posts (intake/profiles.js).
const IMAGE_SOURCE = 'email-image';

async function parseImageBill(att, email, userId, defaults = _userDefaults(userId)) {
  const src  = _readAs(email, att.forwarded);
  const mime = intake.imageMime(att) || 'image/jpeg';

  // Required here rather than at the top: most mail carries no photo, and
  // this file should not need the vision reader to load.
  let read = null;
  try {
    read = await require('../utils/receipt-parser').parseReceiptImage(userId, att.content, mime);
  } catch (err) {
    // The reader promises not to throw; if it does, the photo is still kept
    // as a bill for a person rather than lost with the job.
    logger.warn('Photographed bill could not be read', { userId, file: att.filename, error: err.message });
  }
  const receipts = Array.isArray(read?.receipts) ? read.receipts : [];
  const r = receipts[0] || null;

  const reasons = ['this bill came in as a photo, and the image reader does not read invoice numbers, due dates or bank details; check it against the photo'];
  if (!r) reasons.push('the photo could not be read; nothing below was read from it');
  else if (r.confidence !== 'high') reasons.push('the image reader was not confident of what it read');
  if (receipts.length > 1) reasons.push(`the photo seems to hold ${receipts.length} documents, and only the first was read`);

  const emailDate   = email.date ? intake.localDateStr(new Date(email.date)) : intake.today();
  const invoiceDate = r?.date || emailDate;
  const vendor      = String(r?.merchant || src.from?.value?.[0]?.name || 'Unknown Vendor').slice(0, 255);
  const totalAmount = r?.total ?? 0;
  // The receipt reader writes "[Category] what @ where"; a bill has no category.
  const described   = _oneLine(String(r?.description || '').replace(/^\s*\[[^\]]*\]\s*/, ''));
  const description = (described || cleanSubject(src.subject) || `Bill from ${vendor}`).slice(0, 500);
  const lineItems   = (r?.lineItems || []).map(li => ({ description: li.description, unitAmount: li.unitAmount, discountRate: li.discountRate || 0 }));
  if (!lineItems.length) lineItems.push({ description, unitAmount: totalAmount, discountRate: 0 });

  const parsed = {
    receivedAt:       email.date ? new Date(email.date).toISOString() : null,
    contactName:      vendor,
    contactEmail:     src.from?.value?.[0]?.address || '',
    contactAddress:   '',
    vendorName:       vendor,
    invoiceDate,
    dueDate:          intake.addDays(invoiceDate, 30),
    currency:         r?.currency || defaults.currency,
    // Whether the document itself named the currency. The line above falls
    // back to the Setup default, and supplier memory (utils/supplier-memory.js)
    // must not mistake that fallback for a currency the supplier stated.
    currencyStated:   !!r?.currency,
    brandingThemeName:'Standard',
    lineAmountTypes:  'Exclusive',
    lineItems,
    totalAmount,
    subTotal:         r?.subTotal ?? null,
    taxAmount:        r?.tax ?? null,
    documentType:     'invoice',
    description,
    sourceEmail:      email.from?.text || '',
    accountCode:      defaults.accountCode,
    paymentReference: '',
    invoiceType:      'ACCPAY',
    source:           IMAGE_SOURCE,
    reviewReason:     reasons.join('; '),
    pdfBuffer:        null,
    pdfFilename:      null,
    // The photo itself, stored with the row by invoice-handler so the person
    // reviewing sees it and it goes to Xero as the attachment.
    imageBuffer:      att.content,
    imageMime:        mime,
    imageFilename:    att.filename || null,
    messageId:        email.messageId || null,
    confidence:       _confidence(r?.confidence),
  };
  _ensureSubtotalTax(parsed);
  logger.info('Photographed bill read', { userId, file: att.filename, vendor, total: totalAmount, read: !!r });
  return parsed;
}

// ── Per-extract parser ────────────────────────────────────────────────────────

async function _parseOne({ text, source, pdfBuffer, pdfFilename, noText, origin }, outer, userId, defaults) {
  if (!text || text.length < 3) return null;
  const email = _readAs(outer, origin);

  const isTemplate = /Client\s*\/\s*Customer[^:\n]*:/i.test(text) &&
                     /(?:\d+\.\s*)?Description\s*\/\s*Details\s*:/i.test(text);

  if (!isTemplate && source !== 'pdf') {
    logger.info('Email skipped — does not match template and has no PDF', {
      subject: email.subject, from: email.from?.text, userId,
    });
    return null;
  }

  let parsed;
  let reviewReason = null;
  if (isTemplate) {
    logger.info('Template format detected', { userId });
    parsed = parseTemplateFormat(text, email, defaults);
    // Second reading. Corrects names, addresses and descriptions in place;
    // flags — never overwrites — any disagreement about money. On any failure
    // the regex result stands, so this cannot make an email worse than before.
    const check = await verifyTemplateExtraction(text, parsed, userId);
    parsed = check.parsed;
    reviewReason = [parsed.reviewReason, check.reviewReason].filter(Boolean).join('; ') || null;
  } else if (noText) {
    // Image-based or corrupt PDF — no usable text for the LLM.
    // Fall back to generic regex (will extract what it can from email headers/subject)
    // and let the invoice-handler mark it review-needed via the zero-amount guard.
    logger.info('PDF has no extractable text — using generic parser, will be review-needed', { file: pdfFilename, userId });
    parsed = parseGenericFormat(text, email, defaults);
    parsed.reviewReason = 'the PDF has no readable text; nothing below was read from it';
  } else {
    logger.info('PDF invoice detected — using LLM parser', { file: pdfFilename, userId });
    parsed = await parsePDFWithLLM(text, email, pdfFilename, userId, defaults);
  }
  _ensureSubtotalTax(parsed);

  const invoiceType = source === 'pdf' ? 'ACCPAY' : 'ACCREC';
  const result = {
    ...parsed,
    invoiceType,
    source,
    // Set by the template verifier, or by a parser that could only guess.
    // invoice-handler turns it into review-needed rather than posting.
    reviewReason: reviewReason || parsed.reviewReason || null,
    pdfBuffer:     pdfBuffer   || null,
    pdfFilename:   pdfFilename || null,
    // The email in the mailbox, which for a forwarded bill is the forward.
    sourceEmail:   outer.from?.text || '',
    // What recognises this email if it is delivered again (intake/dedup.js).
    messageId:     outer.messageId || null,
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
//  - Photos go to the vision reader (parseImageBill), PDFs and the body to the
//    text readers; the queue marked which is which

async function parseInvoice(email, userId) {
  const extracts = await extractText(email);
  const images   = (email.attachments || []).filter(a => _kind(a) === 'image');
  const defaults = _userDefaults(userId);
  const invoices = [];
  const tasks    = [
    ...extracts.map(extract => () => _parseOne(extract, email, userId, defaults)),
    ...images.map(att => () => parseImageBill(att, email, userId, defaults)),
  ];

  if (tasks.length > 1) {
    logger.info(`Batch processing ${tasks.length} document(s) — up to ${MAX_PDF_CONCURRENCY} concurrent`, { userId });
  }

  // Process in chunks of MAX_PDF_CONCURRENCY to balance speed and API pressure
  for (let i = 0; i < tasks.length; i += MAX_PDF_CONCURRENCY) {
    const chunk   = tasks.slice(i, i + MAX_PDF_CONCURRENCY);
    const settled = await Promise.allSettled(chunk.map(run => run()));
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) invoices.push(r.value);
      else if (r.status === 'rejected') logger.error('PDF parse error in batch', { error: r.reason?.message, userId });
    }
  }

  return invoices.length > 0 ? invoices : null;
}

module.exports = { parseInvoice, parseImageBill, sanitizeFilename, IMAGE_SOURCE, parseTemplateFormat, parsePDFWithLLM, _ensureSubtotalTax, _parseTaxPercent, _detectCurrency, cleanSubject, _isPaymentSchedule, _describeItems, _vendorAddress, _moneyMismatch, _documentType }; // helpers exposed for tests
