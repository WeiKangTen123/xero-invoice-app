const logger = require('../utils/logger');
const { callGemini } = require('../utils/gemini-client');
const { parseLlmJson } = require('../utils/llm-json');

// ── Prompt ────────────────────────────────────────────────────────────────────

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
  Judge from the document's own heading and wording, not from the filename.`;

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
  ], { temperature: 0, maxTokens: MAX_REPLY_TOKENS });

  const parsed = parseLlmJson(content);
  // extractWithRetry treats a throw as a retryable attempt, so keep that contract.
  if (!parsed || typeof parsed !== 'object') throw new Error('Model reply was not valid JSON');
  // Carried on the result rather than only logged: the person reviewing the
  // bill needs to know a later page was never read.
  if (text.length > sent.length) {
    parsed.textTruncated = { sentChars: sent.length, totalChars: text.length };
  }
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

module.exports = { extractWithRetry, MAX_TEXT_CHARS, SYSTEM_PROMPT };
