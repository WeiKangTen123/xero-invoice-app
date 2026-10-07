const logger = require('../utils/logger');
const { callGemini } = require('../utils/gemini-client');
const { parseLlmJson, jsonSchemaFormat, nullable } = require('../utils/llm-json');
const intake = require('../intake/document');

// ── Prompt ────────────────────────────────────────────────────────────────────

const DOCUMENT_TYPES = ['invoice', 'receipt', 'statement', 'credit_note', 'quote', 'other'];

const SYSTEM_PROMPT = `You are an invoice data extractor. Return ONLY valid JSON, no explanation, no markdown.

Extract these fields:
- vendorName: the party that ISSUED the invoice — the one whose logo/letterhead, GST/UEN number and bank account details appear on it. The name printed under the word INVOICE, or after "Bill To" / "To" / "Attention", is the CUSTOMER being billed; never return that as vendorName
- vendorAddress: the vendor's own street address — the one printed beside the vendor's name or logo. NEVER the bank's address from the payment details / bank transfer box (null if not found)
- bankAddress: the address printed inside the bank / payment details block, if any (null if none). This is where the bank's address goes, so it never ends up in vendorAddress
- vendorEmail: vendor's email address (null if not found)
- vendorPhone: vendor's phone number (null if not found)
- invoiceNumber: invoice reference number (null if not found)
- invoiceDate: YYYY-MM-DD (null if not found)
- dueDate: YYYY-MM-DD (null if not stated)
- currency: the invoice's actual currency as a 3-letter ISO code (USD, SGD, AUD, GBP, EUR, MYR, etc.) — read explicit codes or symbols on the invoice ("S$" or "PayNow" implies SGD; "£" implies GBP; "€" implies EUR; "A$" implies AUD). If only a bare "$" appears with no other currency signal anywhere on the invoice, return null rather than guessing.
- lineItems: array of { description, quantity, unitPrice, amount } — description as printed (full multi-line), quantity and unitPrice as plain numbers when the invoice shows them (null otherwise), amount = the line total
- totalAmount: total due as a plain number (no commas, no symbols)
- subTotal: pre-tax subtotal as a plain number, only if explicitly shown on the invoice (null if not shown)
- taxAmount: total tax/GST/VAT amount as a plain number, only if explicitly shown (null if not shown; 0 if the invoice explicitly states no tax applies)
- paymentReference: combine all payment details — PayNow ID, bank name, account number, SWIFT, beneficiary — format: "Bank: OCBC | Acct: 601-493935-001 | Swift: OCBCSGSG | Beneficiary: Denise Teo" — null if none
- projectName: artist or project name this invoice relates to (null if not applicable)
- description: ONE line, at most 120 characters, saying what this invoice is for, written from the line items (e.g. "Notarial certificate, witnessing, true-copy certification and SAL authentication"). Not the vendor name, not the invoice number, not the email subject.
- documentType: what this document IS, exactly one of:
    "invoice"     — an invoice or bill asking to be paid (a tax invoice counts)
    "receipt"     — proof that a payment was already made (a paid receipt, a payment confirmation)
    "statement"   — a statement of account listing several invoices, payments or a running balance
    "credit_note" — a credit note or credit memo reducing what is owed
    "quote"       — a quotation, estimate or pro-forma, not yet a bill
    "other"       — anything else (a contract, a delivery order, a letter, a remittance advice)
  Judge from the document's own heading and wording, not from the filename.
- confidence: how sure you are of what you read, exactly one of:
    "high"   — the vendor, the total, the date and every line are plainly printed and you read them without guessing
    "medium" — everything is there but something needed interpretation (an ambiguous label, a line split across pages)
    "low"    — the text is garbled, partial or out of order, or you guessed any of vendorName, totalAmount or invoiceDate`;

// The reply's shape, held by the endpoint rather than asked for in prose.
// Every field is required and nullable: "not on the document" is answered as
// null, never by leaving the key out, so a missing key always means a fault.
const str  = () => nullable({ type: 'string' });
const numb = () => nullable({ type: 'number' });
const BILL_SCHEMA = {
  type: 'object',
  properties: {
    vendorName:       str(),
    vendorAddress:    str(),
    bankAddress:      str(),
    vendorEmail:      str(),
    vendorPhone:      str(),
    invoiceNumber:    str(),
    invoiceDate:      str(),
    dueDate:          str(),
    currency:         str(),
    lineItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: { description: str(), quantity: numb(), unitPrice: numb(), amount: numb() },
        required: ['description', 'quantity', 'unitPrice', 'amount'],
      },
    },
    totalAmount:      numb(),
    subTotal:         numb(),
    taxAmount:        numb(),
    paymentReference: str(),
    projectName:      str(),
    description:      str(),
    documentType:     { type: 'string', enum: DOCUMENT_TYPES },
    confidence:       { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: [
    'vendorName', 'vendorAddress', 'bankAddress', 'vendorEmail', 'vendorPhone', 'invoiceNumber',
    'invoiceDate', 'dueDate', 'currency', 'lineItems', 'totalAmount', 'subTotal', 'taxAmount',
    'paymentReference', 'projectName', 'description', 'documentType', 'confidence',
  ],
};
const RESPONSE_FORMAT = jsonSchemaFormat('bill', BILL_SCHEMA);

// ── Confidence ────────────────────────────────────────────────────────────────
//
// The record says how far its figures can be trusted, so the review list can
// mark the ones a person should look at ("Check this") instead of every bill
// looking equally certain. The model's own answer is one input, never the
// only one: a model will say "high" about a total it read from the wrong row.
// So the reading is also checked against itself — do the figures add up, is
// there a date, a currency — and the worst of the two wins.
//
//   low    — no usable total; the figures do not add up; no invoice date; no
//            currency anywhere; part of the document was never read; or the
//            model itself says it guessed
//   medium — nothing is wrong, but something is unconfirmed: not an invoice,
//            no line or subtotal to check the total against, or the model
//            says it had to interpret
//   high   — everything above checks out
//
// The same arithmetic, and the same two-cent tolerance, as parser.js's
// _moneyMismatch — which holds the bill with the reason — so a bill held for
// a mismatch is never also marked high. Not imported: parser.js requires
// this file.
const MONEY_TOLERANCE = 0.02;
const _money2 = n => Math.round(n * 100) / 100;

function _figuresReconcile({ lineItems, subTotal, taxAmount, totalAmount }) {
  const problems = [];
  if (subTotal !== null && taxAmount !== null && Math.abs(_money2(subTotal + taxAmount) - totalAmount) > MONEY_TOLERANCE) {
    problems.push('subtotal plus tax does not equal the total');
  }
  if (lineItems.length) {
    const lines = _money2(lineItems.reduce((s, li) => s + (Number(li.unitAmount) || 0) * (1 - (Number(li.discountRate) || 0) / 100), 0));
    const expected = subTotal !== null ? subTotal : _money2(totalAmount - (taxAmount || 0));
    if (Math.abs(lines - expected) > MONEY_TOLERANCE) problems.push('the line items do not add up to the total');
  }
  return problems;
}

// Same reading of the answer as parser.js's _documentType, for "invoice" only.
const _isInvoice = t => /^(tax_)?invoice$|^bill$|^supplier_invoice$/.test(String(t || '').trim().toLowerCase().replace(/[\s-]+/g, '_'));

// Pure; exported for testing. `reply` is the model's JSON, `text` what it
// was given. Returns { confidence, reasons }.
function billConfidence(reply, text = '', { textTruncated = false } = {}) {
  const low = [];
  const medium = [];

  const total = intake.money(reply.totalAmount);
  // One normaliser for every reader, as parser.js uses: the stored amount is
  // the line total.
  const lineItems = (Array.isArray(reply.lineItems) ? reply.lineItems : []).map(li => intake.normaliseLineItem(li)).filter(Boolean);
  if (!(total > 0)) {
    low.push('no total was read');
  } else {
    const sub = intake.money(reply.subTotal);
    const tax = intake.money(reply.taxAmount);
    low.push(..._figuresReconcile({ lineItems, subTotal: sub, taxAmount: tax, totalAmount: total }));
    if (!lineItems.length && !(sub !== null && tax !== null)) medium.push('nothing to check the total against');
  }
  if (!(intake.isoDate(reply.invoiceDate) || intake.parseDate(reply.invoiceDate))) low.push('no invoice date');
  // parser.js falls back to the text's own currency when the model leaves it
  // null, so a currency the text states is a currency present.
  if (!intake.currencyCode(reply.currency) && !intake.detectCurrency(String(text || ''))) low.push('no currency');
  if (textTruncated) low.push('part of the document was not read');
  if (!_isInvoice(reply.documentType)) medium.push('not an invoice');

  const own = String(reply.confidence || '').trim().toLowerCase();
  if (own === 'low') low.push('the model was unsure of its reading');
  else if (own === 'medium') medium.push('the model had to interpret part of it');

  const confidence = low.length ? 'low' : medium.length ? 'medium' : 'high';
  return { confidence, reasons: low.length ? low : medium };
}

// ── Core LLM call ─────────────────────────────────────────────────────────────

// The whole document goes to the model, up to this many characters. It used to
// be the first 3,000 — about one page — so a bill whose total sits on page two
// was read without it, and nothing said so. 30,000 covers any bill seen so far;
// past it, the result says what was left out and the bill is held (parser.js).
const MAX_TEXT_CHARS = 30_000;
// Room for a long itemised bill. A reply cut off at this limit is retried once
// at a larger one by gemini-client, so this is the usual size, not a ceiling.
const MAX_REPLY_TOKENS = 2_048;

async function _callLLM(pdfText, filename, userId) {
  const text = String(pdfText || '');
  const sent = text.slice(0, MAX_TEXT_CHARS);
  const content = await callGemini(userId, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: `Invoice filename: ${filename}\n\nInvoice text:\n${sent}` },
  ], { temperature: 0, maxTokens: MAX_REPLY_TOKENS, responseFormat: RESPONSE_FORMAT });

  // Still parsed leniently: a refused schema falls back to plain JSON mode,
  // whose reply is only as clean as the model makes it.
  const parsed = parseLlmJson(content);
  // extractWithRetry treats a throw as a retryable attempt, so keep that contract.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Model reply was not valid JSON');
  // Carried on the result rather than only logged: the person reviewing the
  // bill needs to know a later page was never read.
  const cut = text.length > sent.length;
  if (cut) {
    parsed.textTruncated = { sentChars: sent.length, totalChars: text.length };
  }
  // Replaces the model's own answer: what the record stores is the checked one.
  const { confidence, reasons } = billConfidence(parsed, sent, { textTruncated: cut });
  if (confidence !== 'high') logger.info('Bill read with reduced confidence', { userId, filename, confidence, reasons });
  parsed.confidence = confidence;
  return parsed;
}

// ── Public API ────────────────────────────────────────────────────────────────

// extractWithRetry goes through the shared Gemini client, which already rotates
// between models and keys and gives a cut-off reply one larger retry — this
// loop only covers transient failures (e.g. a malformed JSON response) that
// rotation doesn't address. A reply still cut off after that larger retry is
// not retried here: the identical request would stop at the identical place,
// twice more, before the regex fallback took over anyway.
async function extractWithRetry(pdfText, filename, userId, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await _callLLM(pdfText, filename, userId);
    } catch (err) {
      const truncated = !!err && err.code === 'GEMINI_TRUNCATED';
      if (attempt < maxAttempts && !truncated) {
        logger.warn(`LLM extraction failed — retrying (attempt ${attempt}/${maxAttempts})`, { filename, error: err.message });
        await new Promise(r => setTimeout(r, attempt * 3_000));
      } else {
        throw err;
      }
    }
  }
}

logger.info('LLM parser initialised (Gemini, model and key rotation)');

module.exports = { extractWithRetry, billConfidence, MAX_TEXT_CHARS, SYSTEM_PROMPT, BILL_SCHEMA, RESPONSE_FORMAT };
