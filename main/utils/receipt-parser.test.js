jest.mock('./gemini-client', () => ({ callGemini: jest.fn(), GEMINI_MODELS: ['m1'] }));
const { callGemini } = require('./gemini-client');
const parser = require('./receipt-parser');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const good = {
  merchant: 'Grab', date: '2026-08-24', currency: 'SGD',
  total: 18.4, tax: 1.51, subTotal: 16.89, description: 'Airport ride', confidence: 'high',
};

beforeEach(() => jest.clearAllMocks());

describe('utils/receipt-parser', () => {
  describe('normalise — where a bad model response is made harmless', () => {
    test('passes a clean response through', () => {
      expect(parser.normalise(good)).toEqual({ ...good, lineItems: [], box: null });
    });

    test('normalises line items and their prices correctly', () => {
      const withItems = {
        ...good,
        lineItems: [
          { description: 'Burger', unitAmount: '12.50', quantity: 2 },
          { description: 'Fries', unitAmount: 4.5, discountRate: 10 },
          { invalid: true },
        ],
      };
      const res = parser.normalise(withItems);
      expect(res.lineItems).toEqual([
        { description: 'Burger', unitAmount: 12.5, discountRate: 0 },
        { description: 'Fries', unitAmount: 4.5, discountRate: 10 },
      ]);
    });

    test('rejects a non-object outright', () => {
      expect(parser.normalise(null)).toBeNull();
      expect(parser.normalise('nope')).toBeNull();
      expect(parser.normalise(42)).toBeNull();
    });

    test('a total that is not a clean positive number is dropped, never coerced', () => {
      // The total is the field a user is least likely to re-check by hand.
      expect(parser.normalise({ ...good, total: 'abc' }).total).toBeNull();
      expect(parser.normalise({ ...good, total: 0 }).total).toBeNull();
      expect(parser.normalise({ ...good, total: -5 }).total).toBeNull();   // a refund, not modelled
      expect(parser.normalise({ ...good, total: null }).total).toBeNull();
    });

    test('strips currency symbols and separators from a numeric string', () => {
      expect(parser.normalise({ ...good, total: 'S$1,234.50' }).total).toBe(1234.5);
    });

    test('tax larger than the total means one of them was misread, so tax is dropped', () => {
      expect(parser.normalise({ ...good, total: 10, tax: 99 }).tax).toBeNull();
      expect(parser.normalise({ ...good, total: 10, tax: 10 }).tax).toBe(10);   // equal is allowed
      expect(parser.normalise({ ...good, tax: -1 }).tax).toBeNull();
    });

    test('a subtotal above the total is dropped for the same reason', () => {
      expect(parser.normalise({ ...good, total: 10, subTotal: 50 }).subTotal).toBeNull();
    });

    test('tax and subtotal survive when the total itself is unreadable', () => {
      // They are independently printed on the receipt; losing them too would
      // discard information the user could have used.
      const r = parser.normalise({ ...good, total: null, tax: 1.51, subTotal: 16.89 });
      expect(r.total).toBeNull();
      expect(r.tax).toBe(1.51);
      expect(r.subTotal).toBe(16.89);
    });

    test('only a real ISO currency code is kept', () => {
      expect(parser.normalise({ ...good, currency: 'sgd' }).currency).toBe('SGD');
      expect(parser.normalise({ ...good, currency: '$' }).currency).toBeNull();
      expect(parser.normalise({ ...good, currency: 'DOLLARS' }).currency).toBeNull();
      expect(parser.normalise({ ...good, currency: null }).currency).toBeNull();
    });

    test('only a real calendar date in ISO form is kept', () => {
      expect(parser.normalise({ ...good, date: '24/08/2026' }).date).toBeNull();
      expect(parser.normalise({ ...good, date: '2026-13-01' }).date).toBeNull();
      expect(parser.normalise({ ...good, date: '2026-02-30' }).date).toBeNull();  // not a real day
      expect(parser.normalise({ ...good, date: 'yesterday' }).date).toBeNull();
    });

    test('a future date is a misread year far more often than a real purchase', () => {
      const nextYear = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
      expect(parser.normalise({ ...good, date: nextYear }).date).toBeNull();
    });

    test('confidence defaults to low unless the model explicitly says high', () => {
      expect(parser.normalise({ ...good, confidence: 'high' }).confidence).toBe('high');
      expect(parser.normalise({ ...good, confidence: 'medium' }).confidence).toBe('low');
      expect(parser.normalise({ ...good, confidence: undefined }).confidence).toBe('low');
    });

    test('blank or non-string text fields become null, not empty strings', () => {
      const r = parser.normalise({ ...good, merchant: '   ', description: '' });
      expect(r.merchant).toBeNull();
      expect(r.description).toBeNull();
    });

    test('long text is truncated rather than rejected', () => {
      const r = parser.normalise({ ...good, merchant: 'x'.repeat(500) });
      expect(r.merchant.length).toBe(120);
    });
  });

  describe('parseReceiptImage', () => {
    test('sends the image as a vision content part, not as text', async () => {
      callGemini.mockResolvedValue(JSON.stringify(good));
      await parser.parseReceiptImage('u1', JPEG, 'image/jpeg');

      const [, messages] = callGemini.mock.calls[0];
      const userMsg = messages.find(m => m.role === 'user');
      expect(Array.isArray(userMsg.content)).toBe(true);
      const image = userMsg.content.find(c => c.type === 'image_url');
      expect(image).toBeDefined();
      expect(image.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    });

    test('returns one receipt in the list for a single-receipt photo', async () => {
      callGemini.mockResolvedValue(JSON.stringify({ receipts: [good] }));
      const r = await parser.parseReceiptImage('u1', JPEG, 'image/jpeg');
      expect(r.receipts).toHaveLength(1);
      expect(r.receipts[0]).toMatchObject({ merchant: 'Grab', total: 18.4 });
      expect(r.split).toBe(false);   // one receipt is never a split
    });

    test('a bare object is accepted, not treated as a failure', async () => {
      // A model asked for an array will still sometimes return one object.
      callGemini.mockResolvedValue(JSON.stringify(good));
      const r = await parser.parseReceiptImage('u1', JPEG, 'image/jpeg');
      expect(r.receipts).toHaveLength(1);
    });

    test('tolerates a fenced or thought-wrapped response', async () => {
      callGemini.mockResolvedValue('<thought>reading…</thought>\n```json\n' + JSON.stringify({ receipts: [good] }) + '\n```');
      expect((await parser.parseReceiptImage('u1', JPEG, 'image/jpeg')).receipts[0].merchant).toBe('Grab');
    });

    test('returns null rather than throwing when Gemini fails — the receipt must survive', async () => {
      callGemini.mockRejectedValue(new Error('quota exceeded'));
      await expect(parser.parseReceiptImage('u1', JPEG, 'image/jpeg')).resolves.toBeNull();
    });

    test('returns null on unparseable output instead of a half-filled record', async () => {
      callGemini.mockResolvedValue('I could not read that receipt, sorry!');
      expect(await parser.parseReceiptImage('u1', JPEG, 'image/jpeg')).toBeNull();
    });

    test('retries once before giving up, since one bad JSON reply is often transient', async () => {
      callGemini.mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce(JSON.stringify({ receipts: [good] }));
      expect((await parser.parseReceiptImage('u1', JPEG, 'image/jpeg')).receipts[0]).toMatchObject({ merchant: 'Grab' });
      expect(callGemini).toHaveBeenCalledTimes(2);
    });

    test('does not call Gemini at all for an empty buffer', async () => {
      expect(await parser.parseReceiptImage('u1', Buffer.alloc(0), 'image/jpeg')).toBeNull();
      expect(await parser.parseReceiptImage('u1', null, 'image/jpeg')).toBeNull();
      expect(callGemini).not.toHaveBeenCalled();
    });

    test('the prompt forbids inventing values and pins which total to take', async () => {
      // Both rules exist because a receipt photo invites exactly these errors.
      expect(parser.SYSTEM_PROMPT).toMatch(/Never invent/i);
      expect(parser.SYSTEM_PROMPT).toMatch(/never the cash tendered/i);
    });
  });
});

// ── Splitting one photo into several receipts ───────────────────────────────
// splittable() is the entire safety argument for doing this WITHOUT asking the
// user first. Auto-splitting a photo that held one receipt invents a second
// record with made-up figures, which is worse than never splitting at all — so
// every doubtful case must fall back to one record.
describe('receipt-parser — when a photo may be split', () => {
  const { splittable, normaliseMany, _box, _overlapFraction } = require('./receipt-parser');
  const at = (box, over = {}) => ({ merchant: 'Shop', total: 10, box, ...over });

  describe('_box', () => {
    test('accepts a well-formed normalised box', () => {
      expect(_box([100, 50, 900, 450])).toEqual([100, 50, 900, 450]);
    });

    test('rejects anything malformed, which then blocks a split', () => {
      expect(_box(null)).toBeNull();
      expect(_box([1, 2, 3])).toBeNull();               // wrong length
      expect(_box([0, 0, 0, 0])).toBeNull();            // zero area
      expect(_box([900, 50, 100, 450])).toBeNull();     // inverted
      expect(_box([0, 0, 1200, 500])).toBeNull();       // out of range
      expect(_box(['a', 'b', 'c', 'd'])).toBeNull();
    });
  });

  test('two clearly separate receipts are split', () => {
    const r = splittable([
      at([100, 20, 900, 460], { merchant: 'Grab', total: 18.4 }),
      at([100, 540, 900, 980], { merchant: 'FairPrice', total: 62.1 }),
    ]);
    expect(r.split).toBe(true);
  });

  test('a single receipt is never split', () => {
    expect(splittable([at([0, 0, 1000, 1000])]).split).toBe(false);
    expect(splittable([]).split).toBe(false);
    expect(splittable(null).split).toBe(false);
  });

  test('a missing box blocks the split rather than guessing a region', () => {
    const r = splittable([at([100, 20, 900, 460]), at(null)]);
    expect(r.split).toBe(false);
    expect(r.reason).toMatch(/box/i);
  });

  test('heavily overlapping boxes block the split — one receipt cut in half', () => {
    const r = splittable([
      at([100, 100, 900, 900]),
      at([150, 150, 880, 880]),   // almost entirely inside the first
    ]);
    expect(r.split).toBe(false);
    expect(r.reason).toMatch(/overlap/i);
  });

  test('slightly touching boxes still split — receipts often sit edge to edge', () => {
    const r = splittable([
      at([100, 20, 900, 500]),
      at([100, 480, 900, 960]),   // ~4% overlap
    ]);
    expect(r.split).toBe(true);
  });

  test('a sliver of a box blocks the split', () => {
    const r = splittable([at([100, 20, 900, 460]), at([0, 0, 10, 10])]);
    expect(r.split).toBe(false);
    expect(r.reason).toMatch(/too small/i);
  });

  test('a detected receipt with neither merchant nor total blocks the split', () => {
    // Probably a phone case or a napkin, not a receipt.
    const r = splittable([
      at([100, 20, 900, 460], { merchant: 'Grab', total: 18.4 }),
      at([100, 540, 900, 980], { merchant: null, total: null }),
    ]);
    expect(r.split).toBe(false);
    expect(r.reason).toMatch(/merchant|total/i);
  });

  test('one identifiable field is enough — a merchant with no readable total', () => {
    const r = splittable([
      at([100, 20, 900, 460], { merchant: 'Grab', total: null }),
      at([100, 540, 900, 980], { merchant: 'FairPrice', total: 62.1 }),
    ]);
    expect(r.split).toBe(true);
  });

  test('three receipts split when all are clean', () => {
    const r = splittable([
      at([50, 20, 480, 480]), at([50, 520, 480, 980]), at([520, 20, 950, 480]),
    ]);
    expect(r.split).toBe(true);
  });

  test('one bad box among three blocks the whole split', () => {
    // Partial splitting would silently drop a receipt, which is worse.
    const r = splittable([
      at([50, 20, 480, 480]), at([50, 520, 480, 980]), at(null),
    ]);
    expect(r.split).toBe(false);
  });

  test('_overlapFraction measures against the SMALLER box', () => {
    // A small box entirely inside a large one is fully overlapping, even though
    // it covers little of the larger one.
    expect(_overlapFraction([0, 0, 1000, 1000], [400, 400, 600, 600])).toBeCloseTo(1);
    expect(_overlapFraction([0, 0, 100, 100], [900, 900, 1000, 1000])).toBe(0);
  });

  describe('normaliseMany', () => {
    test('carries the split decision alongside the receipts', () => {
      const r = normaliseMany({ receipts: [
        { merchant: 'Grab', total: 18.4, box_2d: [100, 20, 900, 460] },
        { merchant: 'FairPrice', total: 62.1, box_2d: [100, 540, 900, 980] },
      ] });
      expect(r.receipts).toHaveLength(2);
      expect(r.split).toBe(true);
    });

    test('an empty or unusable response is null, not an empty split', () => {
      expect(normaliseMany({ receipts: [] })).toBeNull();
      expect(normaliseMany(null)).toBeNull();
      expect(normaliseMany('nope')).toBeNull();
    });
  });
});

// ── Batched reading ─────────────────────────────────────────────────────────
// One call per receipt makes a nine-receipt claim nine throttled round trips.
// Batching is faster, and its risk is attribution — the right figures against
// the wrong image — so a reply that cannot be attributed is discarded rather
// than trusted.
describe('receipt-parser — reading several at once', () => {
  const img = n => ({ buffer: Buffer.from([0xff, 0xd8, n]), mime: 'image/jpeg' });
  const read = (index, merchant, total) =>
    ({ index, merchant, date: '2026-02-23', currency: 'SGD', total, tax: null, subTotal: null, description: null, confidence: 'high' });

  beforeEach(() => jest.clearAllMocks());

  test('reads a batch in one call and keeps the order', async () => {
    callGemini.mockResolvedValue(JSON.stringify([read(1, 'Grab', 15.8), read(2, 'Gojek', 25), read(3, 'CDG', 30.6)]));
    const out = await parser.parseReceiptBatch('u1', [img(1), img(2), img(3)]);
    expect(callGemini).toHaveBeenCalledTimes(1);
    expect(out.map(r => r.merchant)).toEqual(['Grab', 'Gojek', 'CDG']);
    expect(out.map(r => r.total)).toEqual([15.8, 25, 30.6]);
  });

  test('the index decides placement, not the order the model replied in', async () => {
    // A model that answers out of order must not silently transpose figures.
    callGemini.mockResolvedValue(JSON.stringify([read(3, 'CDG', 30.6), read(1, 'Grab', 15.8), read(2, 'Gojek', 25)]));
    const out = await parser.parseReceiptBatch('u1', [img(1), img(2), img(3)]);
    expect(out.map(r => r.merchant)).toEqual(['Grab', 'Gojek', 'CDG']);
  });

  test('a reply that does not account for every image is DISCARDED and re-read singly', async () => {
    // The attribution guard. Two answers for three images could be attributed
    // three ways, so none of them is trusted.
    callGemini
      .mockResolvedValueOnce(JSON.stringify([read(1, 'Grab', 15.8), read(2, 'Gojek', 25)]))   // 2 for 3
      .mockResolvedValue(JSON.stringify({ receipts: [read(1, 'Single', 9.9)] }));
    const out = await parser.parseReceiptBatch('u1', [img(1), img(2), img(3)]);
    expect(callGemini).toHaveBeenCalledTimes(4);          // 1 failed batch + 3 singles
    expect(out.every(r => r.merchant === 'Single')).toBe(true);
  });

  test('a batch that throws falls back rather than losing the receipts', async () => {
    callGemini
      .mockRejectedValueOnce(new Error('quota'))
      .mockResolvedValue(JSON.stringify({ receipts: [read(1, 'Fallback', 5)] }));
    const out = await parser.parseReceiptBatch('u1', [img(1), img(2)]);
    expect(out.filter(Boolean)).toHaveLength(2);
    expect(out[0].merchant).toBe('Fallback');
  });

  test('splits into batches of the configured size', async () => {
    callGemini.mockResolvedValue(JSON.stringify([read(1, 'A', 1), read(2, 'B', 2)]));
    await parser.parseReceiptBatch('u1', [img(1), img(2), img(3), img(4)], { batchSize: 2 });
    expect(callGemini).toHaveBeenCalledTimes(2);
  });

  test('a single receipt does not use the batch path at all', async () => {
    callGemini.mockResolvedValue(JSON.stringify({ receipts: [read(1, 'Only', 12)] }));
    const out = await parser.parseReceiptBatch('u1', [img(1)]);
    expect(out[0].merchant).toBe('Only');
    const prompt = JSON.stringify(callGemini.mock.calls[0][1]);
    expect(prompt).not.toContain('SEPARATE receipts');
  });

  test('progress is reported as results land', async () => {
    callGemini.mockResolvedValue(JSON.stringify([read(1, 'A', 1), read(2, 'B', 2)]));
    const seen = [];
    await parser.parseReceiptBatch('u1', [img(1), img(2), img(3), img(4)], { batchSize: 2, onProgress: n => seen.push(n) });
    expect(seen).toEqual([2, 4]);
  });

  test('every image is sent, each labelled with its number', async () => {
    callGemini.mockResolvedValue(JSON.stringify([read(1, 'A', 1), read(2, 'B', 2)]));
    await parser.parseReceiptBatch('u1', [img(1), img(2)]);
    const content = callGemini.mock.calls[0][1].find(m => m.role === 'user').content;
    expect(content.filter(c => c.type === 'image_url')).toHaveLength(2);
    expect(JSON.stringify(content)).toContain('Receipt 1:');
    expect(JSON.stringify(content)).toContain('Receipt 2:');
  });

  test('an empty list does no work', async () => {
    expect(await parser.parseReceiptBatch('u1', [])).toEqual([]);
    expect(callGemini).not.toHaveBeenCalled();
  });
});
