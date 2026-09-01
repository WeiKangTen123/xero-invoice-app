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
      expect(parser.normalise(good)).toEqual(good);
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

    test('returns the normalised record on a clean response', async () => {
      callGemini.mockResolvedValue(JSON.stringify(good));
      expect(await parser.parseReceiptImage('u1', JPEG, 'image/jpeg')).toEqual(good);
    });

    test('tolerates a fenced or thought-wrapped response', async () => {
      callGemini.mockResolvedValue('<thought>reading…</thought>\n```json\n' + JSON.stringify(good) + '\n```');
      expect((await parser.parseReceiptImage('u1', JPEG, 'image/jpeg')).merchant).toBe('Grab');
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
      callGemini.mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce(JSON.stringify(good));
      expect(await parser.parseReceiptImage('u1', JPEG, 'image/jpeg')).toEqual(good);
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
