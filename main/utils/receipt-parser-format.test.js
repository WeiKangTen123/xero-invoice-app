// The receipt reader asks for a schema, not just JSON in the prompt — one for
// a single photo or text PDF, one sized to the batch for several photos — and
// still reads either shape back, because a refused schema falls back to plain
// JSON mode. Its confidence is kept honest against what survived cleaning.
jest.mock('./gemini-client', () => ({ callGemini: jest.fn(), GEMINI_MODELS: ['m1'] }));
const { callGemini } = require('./gemini-client');
const parser = require('./receipt-parser');
const { CATEGORIES } = require('../claims/categories');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const img = n => ({ buffer: Buffer.from([0xff, 0xd8, n]), mime: 'image/jpeg' });
const receipt = (extra = {}) => ({
  merchant: 'Grab', date: '2026-08-24', time: '08:08', currency: 'SGD', total: 18.4, tax: null, subTotal: null,
  category: 'Local Travel', description: 'Orchard Rd to Changi Airport @ Grab (08:08)', lineItems: [], confidence: 'high', ...extra,
});

beforeEach(() => jest.clearAllMocks());

describe('single receipt', () => {
  test('a photo is read with the receipts schema', async () => {
    callGemini.mockResolvedValue(JSON.stringify({ receipts: [receipt()] }));
    await parser.parseReceiptImage('u1', JPEG, 'image/jpeg');
    const { responseFormat } = callGemini.mock.calls[0][2];
    expect(responseFormat.type).toBe('json_schema');
    expect(responseFormat.json_schema.name).toBe('receipts');
    expect(responseFormat.json_schema.schema).toBe(parser.RECEIPTS_SCHEMA);
  });

  test('a text PDF is read with the same schema', async () => {
    callGemini.mockResolvedValue(JSON.stringify({ receipts: [receipt()] }));
    await parser.parseReceiptText('u1', 'GRAB  Total S$18.40');
    expect(callGemini.mock.calls[0][2].responseFormat).toEqual(parser.RESPONSE_FORMAT);
  });

  test('the schema holds the category to the listed names and confidence to high/low', () => {
    const item = parser.RECEIPTS_SCHEMA.properties.receipts.items;
    expect(item.properties.category.enum).toEqual(CATEGORIES.map(c => c.name));
    expect(item.properties.confidence.enum).toEqual(['high', 'low']);
    // Omitted when the model cannot place it, and a text PDF has no image.
    expect(item.required).not.toContain('box_2d');
    expect(parser.RECEIPTS_SCHEMA.properties.receipts.minItems).toBe(1);
  });
});

describe('batch', () => {
  test('a batch is read with a schema sized to it', async () => {
    const reads = [1, 2, 3].map(i => ({ index: i, ...receipt({ merchant: `M${i}` }), otherReceipts: 0 }));
    callGemini.mockResolvedValue(JSON.stringify({ receipts: reads }));
    const out = await parser.parseReceiptBatch('u1', [img(1), img(2), img(3)]);
    expect(callGemini).toHaveBeenCalledTimes(1);
    expect(out.map(r => r.merchant)).toEqual(['M1', 'M2', 'M3']);
    const { responseFormat } = callGemini.mock.calls[0][2];
    expect(responseFormat.json_schema.name).toBe('receipt_batch');
    const list = responseFormat.json_schema.schema.properties.receipts;
    expect(list.minItems).toBe(3);
    expect(list.items.properties.index).toEqual({ type: 'integer', minimum: 1, maximum: 3 });
    expect(list.items.required).toEqual(expect.arrayContaining(['index', 'otherReceipts', 'total', 'merchant']));
  });

  test('the prompt asks for the same object shape the schema holds it to', async () => {
    callGemini.mockResolvedValue(JSON.stringify({ receipts: [1, 2].map(i => ({ index: i, ...receipt(), otherReceipts: 0 })) }));
    await parser.parseReceiptBatch('u1', [img(1), img(2)]);
    const prompt = callGemini.mock.calls[0][1][1].content[0].text;
    expect(prompt).toMatch(/"receipts"/);
  });

  test('a bare array (a model in plain JSON mode) is still read', async () => {
    callGemini.mockResolvedValue(JSON.stringify([1, 2].map(i => ({ index: i, ...receipt({ merchant: `M${i}` }) }))));
    const out = await parser.parseReceiptBatch('u1', [img(1), img(2)]);
    expect(out.map(r => r.merchant)).toEqual(['M1', 'M2']);
  });
});

describe('confidence', () => {
  test('"high" stands when the total and merchant were read', () => {
    expect(parser.normalise(receipt()).confidence).toBe('high');
  });

  test('"high" with no usable total is low — the prompt defines high as a legible total', () => {
    expect(parser.normalise(receipt({ total: null })).confidence).toBe('low');
    expect(parser.normalise(receipt({ total: -5 })).confidence).toBe('low');
  });

  test('"high" with no merchant is low', () => {
    expect(parser.normalise(receipt({ merchant: '  ' })).confidence).toBe('low');
  });
});
