const logger = require('../utils/logger');
const { callGemini } = require('../utils/gemini-client');

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
- currency: SGD if PayNow or SGD keyword present, otherwise USD
- lineItems: array of { description, amount } — include full multi-line descriptions
- totalAmount: total due as a plain number (no commas, no symbols)
- paymentReference: combine all payment details — PayNow ID, bank name, account number, SWIFT, beneficiary — format: "Bank: OCBC | Acct: 601-493935-001 | Swift: OCBCSGSG | Beneficiary: Denise Teo" — null if none
- projectName: artist or project name this invoice relates to (null if not applicable)`;

// ── Core LLM call ─────────────────────────────────────────────────────────────

async function _callLLM(pdfText, filename, userId) {
  const content = await callGemini(userId, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: `Invoice filename: ${filename}\n\nInvoice text:\n${pdfText.slice(0, 3000)}` },
  ], { temperature: 0, maxTokens: 800 });

  const raw       = content.trim();
  const noThought = raw.replace(/<thought>[\s\S]*?<\/thought>/g, '').trim();
  const cleaned   = noThought.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  return JSON.parse(cleaned);
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
