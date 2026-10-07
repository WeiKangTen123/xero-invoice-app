const logger = require('./logger');
const { callGemini } = require('./gemini-client');
const { parseLlmJson, jsonSchemaFormat, nullable } = require('./llm-json');

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

const { CATEGORIES, canonicalCategory } = require('../claims/categories');

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
- time: HH:MM in 24-hour format if printed on the receipt (e.g. "12:01", "16:37", "21:09"), null if not printed.
- currency: 3-letter ISO code read from the receipt (SGD, USD, MYR, GBP, EUR, AUD...). "S$" or PayNow implies SGD; "RM" implies MYR; "£" GBP; "€" EUR. If only a bare "$" appears with no other signal, return null rather than guessing.
- total: the FINAL amount paid, as a plain number. No symbols, no thousands separators.
- tax: the GST/VAT/service-tax amount as a plain number, only if the receipt states it separately. null if not shown. 0 if the receipt says no tax applies.
- subTotal: the pre-tax amount as a plain number, only if explicitly printed. null otherwise.
- category: one of these exact names, judged from what was bought and when:
${CATEGORIES.map(c => `    "${c.name}": ${c.scope}`).join('\n')}
  When nothing on the receipt settles it, use "General Expense".
- description: WHAT was bought and WHERE, from what is printed, max 200 characters.
  Format: "[Category] <what was bought> @ <Merchant> (<HH:MM>)". For a ride, put
  "<pickup> to <dropoff>" in place of what was bought when both are printed,
  e.g. "[Local Travel] Orchard Rd to Changi Airport @ Grab (08:08)".
  "[Entertainment/Meals] Lunch for 2 @ Dong Seoul Supply (12:01)" is right.
  "Client lunch to discuss the project" is wrong, because the receipt does not say so.
  Do not invent a business purpose, a client, a meeting or a reason — the claimant
  adds that when they review. Do not add a place that is not printed.
- lineItems: array of each individual item or service listed on the receipt with its price:
    [
      {
        "description": "item description or dish name",
        "unitAmount": the price of ONE unit as a plain number (e.g. 1.60),
        "quantity": item quantity if shown (e.g. 1, 6), default 1,
        "lineTotal": the amount printed on that line (quantity × unit price, e.g. 9.60); same as unitAmount when quantity is 1,
        "discountRate": discount percent if shown, default 0
      }
    ]
- confidence: "high" if the total and merchant are clearly legible, "low" if the photo is blurred, cropped, or you are guessing any of them.

Rules:
- Never invent a value. Anything you cannot read is null.
- total is the amount actually charged, after discounts and including tax.
- If several totals appear (subtotal, tax, total, cash tendered, change), pick the amount CHARGED, never the cash tendered.
- A card slip or payment terminal stub belonging to a receipt beside it is NOT a separate receipt.
- If you are unsure whether something is a second receipt, return one entry rather than two.`;

// The reply's shape, held by the endpoint rather than asked for in prose (see
// llm-json.jsonSchemaFormat). Required-and-nullable for what the prompt says
// to return as null, so "unreadable" is an explicit null and not a dropped
// key. box_2d alone is optional: the prompt says to omit it when unsure, and
// a text PDF has no image to place one on. The category is held to the listed
// names, which canonicalCategory below would otherwise have to map back.
const _str  = () => nullable({ type: 'string' });
const _numb = () => nullable({ type: 'number' });
const RECEIPT_FIELDS = {
  merchant:    _str(),
  date:        _str(),
  time:        _str(),
  currency:    _str(),
  total:       _numb(),
  tax:         _numb(),
  subTotal:    _numb(),
  category:    { type: 'string', enum: CATEGORIES.map(c => c.name) },
  description: _str(),
  lineItems: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        description:  { type: 'string' },
        unitAmount:   _numb(),
        quantity:     _numb(),
        lineTotal:    _numb(),
        discountRate: _numb(),
      },
      required: ['description', 'unitAmount', 'quantity', 'lineTotal', 'discountRate'],
    },
  },
  confidence:  { type: 'string', enum: ['high', 'low'] },
  box_2d:      { type: 'array', items: { type: 'number', minimum: 0, maximum: 1000 }, minItems: 4, maxItems: 4 },
};
const RECEIPT_REQUIRED = ['merchant', 'date', 'time', 'currency', 'total', 'tax', 'subTotal', 'category', 'description', 'lineItems', 'confidence'];

// One photo or one text PDF: { receipts: [...] }, at least one entry.
const RECEIPTS_SCHEMA = {
  type: 'object',
  properties: {
    receipts: {
      type: 'array',
      minItems: 1,
      items: { type: 'object', properties: RECEIPT_FIELDS, required: RECEIPT_REQUIRED },
    },
  },
  required: ['receipts'],
};
const RESPONSE_FORMAT = jsonSchemaFormat('receipts', RECEIPTS_SCHEMA);

// A batch of `count` photos: the same entry plus the image it belongs to and
// how many further receipts that image shows. minItems is the batch size, so
// a reply that skips an image is refused by the endpoint rather than by
// _readBatch after the quota is spent. No maxItems: a photo of two receipts
// may list both, and _readBatch decides whether that can be trusted.
function batchSchema(count) {
  return {
    type: 'object',
    properties: {
      receipts: {
        type: 'array',
        minItems: count,
        items: {
          type: 'object',
          properties: {
            index:         { type: 'integer', minimum: 1, maximum: count },
            ...RECEIPT_FIELDS,
            otherReceipts: { type: 'integer', minimum: 0 },
          },
          required: ['index', ...RECEIPT_REQUIRED, 'otherReceipts'],
        },
      },
    },
    required: ['receipts'],
  };
}
// One name for every size: the sizes differ only in their numbers, so a
// refusal gemini-client remembers for one (by name) holds for all of them.
const batchResponseFormat = count => jsonSchemaFormat('receipt_batch', batchSchema(count));

// Number, date and currency cleaning are shared with every other intake path;
// see intake/document.js for why a value is dropped rather than coerced.
const _intake = require('../intake/document');
const _num     = _intake.num;
const _isoDate = _intake.isoDate;
function _time(value) {
  if (!value || typeof value !== 'string') return null;
  const m = value.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\s*(AM|PM)?$/i);
  if (!m) return null;
  let hours = parseInt(m[1], 10);
  const minutes = m[2];
  const ampm = m[3] ? m[3].toUpperCase() : null;
  if (ampm === 'PM' && hours < 12) hours += 12;
  if (ampm === 'AM' && hours === 12) hours = 0;
  return `${String(hours).padStart(2, '0')}:${minutes}`;
}

const _currency = _intake.currencyCode;
// Normalises whatever the model returned into the shape the invoice store uses.
// Exported for testing: this is where a bad model response is made harmless.
function normalise(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  const total = _num(parsed.total);
  const tax   = _num(parsed.tax);
  let   sub   = _num(parsed.subTotal);
  // Singapore receipts print "Sub Total 16.10 / GST 1.33" where the GST is
  // already inside the sub total. A subtotal equal to the total with a tax
  // beside it is that case: the pre-tax figure is total − tax.
  if (sub !== null && total !== null && tax !== null && tax > 0 && Math.abs(sub - total) < 0.005) {
    sub = Math.round((total - tax) * 100) / 100;
  }

  // A negative total is a refund, which this flow does not model, and a zero
  // total tells the user nothing. Both are treated as "not read".
  const usableTotal = total !== null && total > 0 ? total : null;

  // One normaliser for every reader (intake/document.js): the stored amount is
  // the LINE total and a quantity rides in the text. Receipts carry no tax
  // percent per line, and the store's shape has none.
  const lineItems = (Array.isArray(parsed.lineItems) ? parsed.lineItems : [])
    .map(li => _intake.normaliseLineItem(li))
    .filter(Boolean)
    .map(({ description, unitAmount, discountRate }) => ({ description: description.slice(0, 200), unitAmount, discountRate }));

  // Only a listed category survives; a reworded one is mapped back, an
  // invented one is dropped and never prefixed onto the description.
  const category = canonicalCategory(parsed.category);
  let desc = typeof parsed.description === 'string' && parsed.description.trim() ? parsed.description.trim().slice(0, 250) : null;
  if (desc && category && !desc.startsWith('[')) {
    desc = `[${category}] ${desc}`.slice(0, 250);
  }

  const merchant = typeof parsed.merchant === 'string' && parsed.merchant.trim() ? parsed.merchant.trim().slice(0, 120) : null;
  // Stored on the claim (claim-record.js) so the review list can say which
  // reads to check. The prompt defines "high" as the total and merchant being
  // clearly legible, so a "high" whose total or merchant did not survive the
  // cleaning above is not high — the model's word is not the only evidence.
  const confidence = parsed.confidence === 'high' && usableTotal !== null && merchant ? 'high' : 'low';

  return {
    merchant,
    date:        _isoDate(parsed.date),
    time:        _time(parsed.time),
    category,
    currency:    _currency(parsed.currency),
    total:       usableTotal,
    // Tax cannot exceed the total; if it does, one of the two was misread and
    // neither should be presented as fact.
    tax:         tax !== null && tax >= 0 && (usableTotal === null || tax <= usableTotal) ? tax : null,
    subTotal:    sub !== null && sub >= 0 && (usableTotal === null || sub <= usableTotal) ? sub : null,
    description: desc,
    lineItems,
    confidence,
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
  return _readWith(userId, [
    { type: 'text', text: 'Read this receipt and return the JSON described.' },
    { type: 'image_url', image_url: { url: dataUri } },
  ], maxAttempts);
}

// A PDF with a text layer is read from that text. Same prompt, same
// normaliser, no image: the model cannot place a box on text, so box_2d is
// simply absent and a text PDF is never split by region (pages do that).
const MAX_TEXT_CHARS = 20000;
async function parseReceiptText(userId, text, { maxAttempts = 2 } = {}) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) return null;
  return _readWith(userId,
    `Read this receipt text (extracted from a PDF, so there is no image and no box_2d) and return the JSON described.\n\n${body.slice(0, MAX_TEXT_CHARS)}`,
    maxAttempts);
}

// One attempt loop for both readers: a transient model error or an unusable
// shape earns a second try, then the receipt is left for the user. A reply cut
// off at its token limit does not: gemini-client has already asked again with
// a larger limit, and the identical request would stop at the identical place.
async function _readWith(userId, userContent, maxAttempts) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: userContent },
  ];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const content = await callGemini(userId, messages, { temperature: 0, maxTokens: 1200, responseFormat: RESPONSE_FORMAT });
      const result  = normaliseMany(parseLlmJson(content));
      if (result) return result;
      logger.warn('Receipt parse returned an unusable shape', { userId, attempt });
    } catch (err) {
      logger.warn('Receipt parse attempt failed', { userId, attempt, error: err.message });
      if (err && err.code === 'GEMINI_TRUNCATED') break;
    }
  }
  return null;
}

// A photo in a claim batch stands for ONE claim line, so only one receipt read
// from it can become that line's record. A second receipt in the same photo
// used to be dropped without a word — the claimant was never told to claim it.
// It is now kept on the record as a review reason, with what was read of it,
// so the person approving the claim sees it and can split it out.
function _flagOthers(primary, others, extraCount = 0) {
  if (!primary) return primary;
  const seen = (others || []).filter(Boolean);
  const count = Math.max(seen.length, Math.floor(Number(extraCount) || 0));
  if (!count) return primary;
  const described = seen
    .map(r => [r.merchant || 'an unread merchant', r.total != null ? `${r.currency ? r.currency + ' ' : ''}${r.total.toFixed(2)}` : null, r.date].filter(Boolean).join(', '))
    .join('; ');
  const reason = `This photo appears to hold ${count + 1} receipts; only the first was read into this claim`
    + (described ? ` (also seen: ${described})` : '')
    + (count > 1 ? '. Upload the other receipts on their own so they are claimed.' : '. Upload the other receipt on its own so it is claimed.');
  return {
    ...primary,
    reviewReason: primary.reviewReason ? `${primary.reviewReason}; ${reason}` : reason,
    otherReceipts: seen.map(({ merchant, date, currency, total }) => ({ merchant, date, currency, total })),
  };
}


// ── Reading several receipts in one call ────────────────────────────────────
//
// One call per receipt means a nine-receipt claim is nine round trips, each
// throttled to stay inside the per-minute quota — minutes of waiting for work
// the model could do together. Batching sends several images in one request.
//
// The risk is attribution: the model returning the right figures against the
// wrong image. So each image is numbered in the prompt, the reply must carry
// that number back, and a reply whose count does not match the batch is
// DISCARDED and the batch re-read one at a time. Faster when it works, exactly
// as accurate as before when it does not.
const BATCH_SIZE = 5;

function _batchPrompt(count) {
  return `You are reading ${count} SEPARATE receipts. They are unrelated to each other.

Return ONLY a JSON object whose "receipts" array has exactly ${count} entries, one per image, in the order given:
{"receipts": [{"index": 1, "merchant": ..., "date": ..., "time": ..., "category": ..., "currency": ..., "total": ..., "tax": ..., "subTotal": ..., "description": ..., "lineItems": [...], "confidence": ..., "otherReceipts": 0}]}

"index" is the image's position, starting at 1. Every image must appear exactly once.
If one image shows more than one separate receipt, read the most prominent one for that image and set "otherReceipts" to how many further separate receipts it shows (0 when there are none). A card slip belonging to the receipt beside it is not a separate receipt.
Apply the field rules and corporate description formatting from the system prompt to each receipt independently — never carry a figure from one receipt to another.`;
}

// Reads a batch. Returns an array the same length as `images`, with null where a
// receipt could not be read, or null overall if the reply cannot be trusted.
async function _readBatch(userId, images) {
  const content = [{ type: 'text', text: _batchPrompt(images.length) }];
  images.forEach((img, i) => {
    content.push({ type: 'text', text: `Receipt ${i + 1}:` });
    content.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.buffer.toString('base64')}` } });
  });

  const raw = await callGemini(userId, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content },
  ], { temperature: 0, maxTokens: Math.max(4000, 800 * images.length), responseFormat: batchResponseFormat(images.length) });

  // Both shapes are still accepted: a refused schema falls back to plain JSON
  // mode, and a model asked for an object will sometimes send the bare array.
  const parsed = parseLlmJson(raw);
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.receipts) ? parsed.receipts : null);
  // A reply that does not account for every image cannot be attributed safely.
  if (!list || list.length < images.length) return null;
  // More entries than images is a model that found two receipts in one photo
  // and listed both. That is only trusted when every entry names its image;
  // otherwise the whole batch is re-read one at a time.
  const extraEntries = list.length > images.length;

  const out    = new Array(images.length).fill(null);
  const others = images.map(() => []);
  const counts = new Array(images.length).fill(0);
  for (let pos = 0; pos < list.length; pos++) {
    const item = list[pos];
    const idx = Number(item && item.index);
    const named = Number.isInteger(idx) && idx >= 1 && idx <= images.length;
    if (extraEntries && !named) return null;
    // Fall back to position when the model omits the index, but never overwrite.
    const at = named ? idx - 1 : pos;
    if (at < 0 || at >= images.length) continue;
    const read = normalise(item);
    if (!read) continue;
    if (out[at]) { others[at].push(read); continue; }
    out[at] = read;
    counts[at] = _num(item.otherReceipts) || 0;
  }
  // Two reads for one image and none for another is a misnumbered reply, not
  // a photo of two receipts: nothing in it can be attributed with confidence.
  const doubled = others.some(o => o.length);
  if ((extraEntries || doubled) && out.some(x => !x)) return null;
  for (let i = 0; i < out.length; i++) out[i] = _flagOthers(out[i], others[i], counts[i]);
  return out.some(x => x) ? out : null;
}

// Reads many receipts, batching where it can and falling back per-image where it
// cannot. `onProgress(doneCount)` fires as results land so a job can report it.
async function parseReceiptBatch(userId, images, { batchSize = BATCH_SIZE, onProgress } = {}) {
  const results = new Array(images.length).fill(null);
  let done = 0;

  for (let start = 0; start < images.length; start += batchSize) {
    const slice = images.slice(start, start + batchSize);

    let batch = null;
    if (slice.length > 1) {
      try { batch = await _readBatch(userId, slice); }
      catch (err) { logger.warn('Receipt batch failed, falling back to one at a time', { userId, size: slice.length, error: err.message }); }
    }

    if (batch) {
      batch.forEach((r, i) => { results[start + i] = r; });
      done += slice.length;
      onProgress && onProgress(done);
      continue;
    }

    // Either a single image, or a batch whose reply could not be trusted.
    for (let i = 0; i < slice.length; i++) {
      const single = await parseReceiptImage(userId, slice[i].buffer, slice[i].mime);
      results[start + i] = single && single.receipts
        ? _flagOthers(single.receipts[0], single.receipts.slice(1))
        : null;
      done++;
      onProgress && onProgress(done);
    }
  }

  return results;
}

module.exports = { parseReceiptImage, parseReceiptText, parseReceiptBatch, _readBatch, BATCH_SIZE, normalise, normaliseMany, splittable, SYSTEM_PROMPT, RECEIPTS_SCHEMA, RESPONSE_FORMAT, batchSchema, batchResponseFormat, _num, _isoDate, _time, _currency, _box, _overlapFraction };
