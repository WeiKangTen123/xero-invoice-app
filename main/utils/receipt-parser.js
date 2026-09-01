const logger = require('./logger');
const { callGemini } = require('./gemini-client');

// Reads a photographed receipt.
//
// The existing invoice parser is text-only: pdf-parse pulls a text layer out of
// a PDF and sends TEXT to Gemini. A photographed receipt has no text layer, so
// that path cannot see it at all. This sends the IMAGE instead.
//
// No new dependency is needed. gemini-client posts to Google's
// OpenAI-compatibility endpoint, which accepts an image_url content part
// carrying a base64 data URI, and _callOnce passes `messages` through
// unchanged — so model rotation, key rotation and quota handling are inherited.
//
// Nothing here reaches Xero.

const SYSTEM_PROMPT = `You read photographed shop receipts and return ONLY valid JSON. No explanation, no markdown.

Extract:
- merchant: the shop or business that was PAID (not the customer, not the payment network, not the bank)
- date: YYYY-MM-DD of the purchase (null if unreadable)
- currency: 3-letter ISO code read from the receipt (SGD, USD, MYR, GBP, EUR, AUD...). "S$" or PayNow implies SGD; "RM" implies MYR; "£" GBP; "€" EUR. If only a bare "$" appears with no other signal, return null rather than guessing.
- total: the FINAL amount paid, as a plain number. No symbols, no thousands separators.
- tax: the GST/VAT/service-tax amount as a plain number, only if the receipt states it separately. null if not shown. 0 if the receipt says no tax applies.
- subTotal: the pre-tax amount as a plain number, only if explicitly printed. null otherwise.
- description: a short phrase describing what was bought, at most 60 characters.
- confidence: "high" if the total and merchant are clearly legible, "low" if the photo is blurred, cropped, or you are guessing any of them.

Rules:
- Never invent a value. Anything you cannot read is null.
- total is the amount actually charged, after discounts and including tax.
- If several totals appear (subtotal, tax, total, cash tendered, change), pick the amount CHARGED, never the cash tendered.`;

// The parser must never widen a number. A receipt total is the one field a user
// is least likely to re-check, so a value that isn't a clean finite number is
// dropped rather than coerced.
function _num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function _isoDate(value) {
  if (!value || typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // A receipt dated in the future is a misread year far more often than a real
  // pre-dated purchase, so it is dropped rather than shown as fact.
  const parsed = new Date(Date.UTC(y, mo - 1, d));
  if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== mo - 1 || parsed.getUTCDate() !== d) return null;
  if (parsed.getTime() > Date.now() + 86400000) return null;
  return value.trim();
}

function _currency(value) {
  if (!value || typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

// Normalises whatever the model returned into the shape the invoice store uses.
// Exported for testing: this is where a bad model response is made harmless.
function normalise(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  const total = _num(parsed.total);
  const tax   = _num(parsed.tax);
  const sub   = _num(parsed.subTotal);

  // A negative total is a refund, which this flow does not model, and a zero
  // total tells the user nothing. Both are treated as "not read".
  const usableTotal = total !== null && total > 0 ? total : null;

  return {
    merchant:    typeof parsed.merchant === 'string' && parsed.merchant.trim() ? parsed.merchant.trim().slice(0, 120) : null,
    date:        _isoDate(parsed.date),
    currency:    _currency(parsed.currency),
    total:       usableTotal,
    // Tax cannot exceed the total; if it does, one of the two was misread and
    // neither should be presented as fact.
    tax:         tax !== null && tax >= 0 && (usableTotal === null || tax <= usableTotal) ? tax : null,
    subTotal:    sub !== null && sub >= 0 && (usableTotal === null || sub <= usableTotal) ? sub : null,
    description: typeof parsed.description === 'string' && parsed.description.trim() ? parsed.description.trim().slice(0, 200) : null,
    confidence:  parsed.confidence === 'high' ? 'high' : 'low',
  };
}

function _stripToJson(content) {
  const raw       = String(content || '').trim();
  const noThought = raw.replace(/<thought>[\s\S]*?<\/thought>/g, '').trim();
  const cleaned   = noThought.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  return JSON.parse(cleaned);
}

// Reads a receipt image. Returns a normalised record, or null if it could not
// be read — never throws at the caller, because a parse failure must not lose
// the receipt. See routes/receipts.js.
async function parseReceiptImage(userId, buffer, mime, { maxAttempts = 2 } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;

  const dataUri = `data:${mime};base64,${buffer.toString('base64')}`;
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Read this receipt and return the JSON described.' },
        { type: 'image_url', image_url: { url: dataUri } },
      ],
    },
  ];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const content = await callGemini(userId, messages, { temperature: 0, maxTokens: 600 });
      const result  = normalise(_stripToJson(content));
      if (result) return result;
      logger.warn('Receipt parse returned an unusable shape', { userId, attempt });
    } catch (err) {
      logger.warn('Receipt parse attempt failed', { userId, attempt, error: err.message });
    }
  }
  return null;
}

module.exports = { parseReceiptImage, normalise, SYSTEM_PROMPT, _num, _isoDate, _currency };
