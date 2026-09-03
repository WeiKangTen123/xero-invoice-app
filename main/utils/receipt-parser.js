const logger = require('./logger');
const { callGemini } = require('./gemini-client');
const { parseLlmJson } = require('./llm-json');

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

An image may contain MORE THAN ONE receipt (several laid on a desk). Return a JSON
object: { "receipts": [ ... ] } with one entry per DISTINCT receipt. One receipt in
the photo means one entry. Never split a single long receipt into several entries.

For each receipt also return:
- box_2d: the 2D bounding box of that receipt as [ymin, xmin, ymax, xmax], each
  normalised 0-1000 with [0,0] at the top-left of the image. Cover the whole
  receipt and nothing else. Omit it if you cannot locate the receipt confidently.

Per receipt, extract:
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
- If several totals appear (subtotal, tax, total, cash tendered, change), pick the amount CHARGED, never the cash tendered.
- A card slip or payment terminal stub belonging to a receipt beside it is NOT a separate receipt.
- If you are unsure whether something is a second receipt, return one entry rather than two.`;

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
    box:         _box(parsed.box_2d),
  };
}

// Normalises a whole response. Accepts both shapes: { receipts: [...] } and a
// bare single object, because a model asked for an array will still sometimes
// return one object and that must not be treated as a failure.
function normaliseMany(parsed) {
  const list = Array.isArray(parsed?.receipts) ? parsed.receipts
             : Array.isArray(parsed)           ? parsed
             : parsed && typeof parsed === 'object' ? [parsed]
             : [];
  const receipts = list.map(normalise).filter(Boolean);
  if (!receipts.length) return null;
  return { receipts, ...splittable(receipts) };
}

// A box is [ymin, xmin, ymax, xmax] normalised 0-1000. Anything malformed
// becomes null, which stops that receipt from being split out.
function _box(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const n = value.map(v => Number(v));
  if (n.some(v => !Number.isFinite(v) || v < 0 || v > 1000)) return null;
  const [ymin, xmin, ymax, xmax] = n;
  if (ymax <= ymin || xmax <= xmin) return null;
  return [ymin, xmin, ymax, xmax];
}

function _area(b) { return (b[2] - b[0]) * (b[3] - b[1]); }

function _overlapFraction(a, b) {
  const dy = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const dx = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (dy <= 0 || dx <= 0) return 0;
  return (dy * dx) / Math.min(_area(a), _area(b));
}

// The smallest slice of the frame a real receipt could plausibly occupy. Below
// this it is far more likely to be a stray box than a document.
const MIN_BOX_AREA = 0.02 * 1000 * 1000;   // 2% of the image
// Above this the model has almost certainly cut one receipt in half.
const MAX_BOX_OVERLAP = 0.25;

// Decides whether a multi-receipt read is trustworthy enough to split on
// WITHOUT asking. Auto-splitting is only safe when the evidence is unambiguous;
// anything doubtful falls back to a single record holding the whole image,
// because inventing a second receipt is worse than not splitting one.
//
// Exported and tested directly — this function is the whole safety argument.
function splittable(receipts) {
  if (!Array.isArray(receipts) || receipts.length < 2) return { split: false, reason: 'single' };

  const boxes = receipts.map(r => r.box);
  if (boxes.some(b => !b)) return { split: false, reason: 'a receipt has no usable box' };
  if (boxes.some(b => _area(b) < MIN_BOX_AREA)) return { split: false, reason: 'a box is too small to be a receipt' };

  // Every receipt needs SOMETHING identifying, or it is probably not a receipt.
  if (receipts.some(r => !r.merchant && r.total === null)) {
    return { split: false, reason: 'a detected receipt has neither a merchant nor a total' };
  }

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (_overlapFraction(boxes[i], boxes[j]) > MAX_BOX_OVERLAP) {
        return { split: false, reason: 'boxes overlap, so one receipt may have been cut in half' };
      }
    }
  }
  return { split: true, reason: null };
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
      const content = await callGemini(userId, messages, { temperature: 0, maxTokens: 1200 });
      const result  = normaliseMany(parseLlmJson(content));
      if (result) return result;
      logger.warn('Receipt parse returned an unusable shape', { userId, attempt });
    } catch (err) {
      logger.warn('Receipt parse attempt failed', { userId, attempt, error: err.message });
    }
  }
  return null;
}

module.exports = { parseReceiptImage, normalise, normaliseMany, splittable, SYSTEM_PROMPT, _num, _isoDate, _currency, _box, _overlapFraction };
