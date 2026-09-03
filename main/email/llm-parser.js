const logger = require('../utils/logger');
const { callGemini } = require('../utils/gemini-client');
const { parseLlmJson } = require('../utils/llm-json');

// ── Prompt ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an invoice data extractor. Return ONLY valid JSON, no explanation, no markdown.

Extract these fields:
- vendorName: seller/service provider name (NOT the buyer/recipient of the invoice)
- vendorAddress: vendor's full street address (null if not found)
- vendorEmail: vendor's email address (null if not found)
- vendorPhone: vendor's phone number (null if not found)
- invoiceNumber: invoice reference number (null if not found)
- invoiceDate: YYYY-MM-DD (null if not found)
- dueDate: YYYY-MM-DD (null if not stated)
- currency: the invoice's actual currency as a 3-letter ISO code (USD, SGD, AUD, GBP, EUR, MYR, etc.) — read explicit codes or symbols on the invoice ("S$" or "PayNow" implies SGD; "£" implies GBP; "€" implies EUR; "A$" implies AUD). If only a bare "$" appears with no other currency signal anywhere on the invoice, return null rather than guessing.
- lineItems: array of { description, amount } — include full multi-line descriptions
- totalAmount: total due as a plain number (no commas, no symbols)
- subTotal: pre-tax subtotal as a plain number, only if explicitly shown on the invoice (null if not shown)
- taxAmount: total tax/GST/VAT amount as a plain number, only if explicitly shown (null if not shown; 0 if the invoice explicitly states no tax applies)
- paymentReference: combine all payment details — PayNow ID, bank name, account number, SWIFT, beneficiary — format: "Bank: OCBC | Acct: 601-493935-001 | Swift: OCBCSGSG | Beneficiary: Denise Teo" — null if none
- projectName: artist or project name this invoice relates to (null if not applicable)`;

// ── Core LLM call ─────────────────────────────────────────────────────────────

async function _callLLM(pdfText, filename, userId) {
  const content = await callGemini(userId, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: `Invoice filename: ${filename}\n\nInvoice text:\n${pdfText.slice(0, 3000)}` },
  ], { temperature: 0, maxTokens: 800 });

  const parsed = parseLlmJson(content);
  // extractWithRetry treats a throw as a retryable attempt, so keep that contract.
  if (!parsed) throw new Error('Model reply was not valid JSON');
  return parsed;
}

// ── Public API ────────────────────────────────────────────────────────────────

// extractWithRetry goes through the shared Gemini client, which already rotates
// between models on a quota error — this loop only covers transient failures
// (e.g. a malformed JSON response) that model rotation doesn't address.
async function extractWithRetry(pdfText, filename, userId, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await _callLLM(pdfText, filename, userId);
    } catch (err) {
      if (attempt < maxAttempts) {
        logger.warn(`LLM extraction failed — retrying (attempt ${attempt}/${maxAttempts})`, { filename, error: err.message });
        await new Promise(r => setTimeout(r, attempt * 3_000));
      } else {
        throw err;
      }
    }
  }
}

logger.info('LLM parser initialised (Gemini, model rotation on quota errors)');

module.exports = { extractWithRetry };
