// What the bill reader asks the model for (a schema, not just a prompt), and
// how far its reading is to be trusted. Confidence is the model's own answer
// checked against the reading itself: do the figures add up, is there a date,
// is there a currency, is it an invoice. The worst of those wins.
jest.mock('../utils/gemini-client', () => ({ callGemini: jest.fn(), GEMINI_MODELS: ['m'] }));
const { callGemini } = require('../utils/gemini-client');
const { extractWithRetry, billConfidence, BILL_SCHEMA } = require('./llm-parser');

// A bill that reconciles: two lines make the subtotal, subtotal plus GST is the total.
const clean = (extra = {}) => ({
  vendorName: 'Branworks Pte Ltd', vendorAddress: null, bankAddress: null, vendorEmail: null, vendorPhone: null,
  invoiceNumber: 'INV-1042', invoiceDate: '2026-04-21', dueDate: '2026-05-21', currency: 'SGD',
  lineItems: [
    { description: 'Accounting - April 2026', quantity: 1, unitPrice: 300, amount: 300 },
    { description: 'Payroll - April 2026', quantity: 1, unitPrice: 100, amount: 100 },
  ],
  subTotal: 400, taxAmount: 36, totalAmount: 436,
  paymentReference: null, projectName: null, description: 'Accounting and payroll, April 2026',
  documentType: 'invoice', confidence: 'high',
  ...extra,
});

beforeEach(() => callGemini.mockReset());

describe('structured output', () => {
  test('the bill schema is sent as response_format', async () => {
    callGemini.mockResolvedValue(JSON.stringify(clean()));
    await extractWithRetry('text', 'bill.pdf', 'u1');
    const opts = callGemini.mock.calls[0][2];
    expect(opts.responseFormat).toEqual({ type: 'json_schema', json_schema: { name: 'bill', schema: BILL_SCHEMA } });
  });

  test('the schema asks for every field the prompt names, the document type and the confidence', () => {
    for (const f of ['vendorName', 'invoiceNumber', 'invoiceDate', 'currency', 'lineItems', 'totalAmount', 'subTotal', 'taxAmount', 'paymentReference', 'documentType', 'confidence']) {
      expect(BILL_SCHEMA.required).toContain(f);
    }
    expect(BILL_SCHEMA.properties.documentType.enum).toEqual(['invoice', 'receipt', 'statement', 'credit_note', 'quote', 'other']);
    expect(BILL_SCHEMA.properties.confidence.enum).toEqual(['high', 'medium', 'low']);
  });

  test('a fenced plain-JSON reply (the fallback after a refused schema) is still read', async () => {
    callGemini.mockResolvedValue('```json\n' + JSON.stringify(clean()) + '\n```');
    const out = await extractWithRetry('text', 'bill.pdf', 'u1');
    expect(out.vendorName).toBe('Branworks Pte Ltd');
  });
});

describe('confidence on the parsed record', () => {
  test('high when everything reconciles and the model is sure', async () => {
    callGemini.mockResolvedValue(JSON.stringify(clean()));
    const out = await extractWithRetry('text', 'bill.pdf', 'u1');
    expect(out.confidence).toBe('high');
  });

  test('low when the line items do not add up to the total', async () => {
    callGemini.mockResolvedValue(JSON.stringify(clean({ totalAmount: 536, subTotal: null, taxAmount: 36 })));
    const out = await extractWithRetry('text', 'bill.pdf', 'u1');
    expect(out.confidence).toBe('low');
  });

  test('low when subtotal plus tax is not the total — even though the model said high', () => {
    const r = billConfidence(clean({ subTotal: 400, taxAmount: 36, totalAmount: 446 }));
    expect(r.confidence).toBe('low');
    expect(r.reasons.join(' ')).toMatch(/subtotal plus tax/);
  });

  test('low when the total is missing', () => {
    expect(billConfidence(clean({ totalAmount: null })).confidence).toBe('low');
  });

  test('low when the invoice date is missing', () => {
    const r = billConfidence(clean({ invoiceDate: null }));
    expect(r.confidence).toBe('low');
    expect(r.reasons).toContain('no invoice date');
  });

  test('low when no currency is given and the text names none either', () => {
    expect(billConfidence(clean({ currency: null }), 'Total $436.00').confidence).toBe('low');
  });

  test('a currency the text names counts — parser.js reads it from there when the model leaves it null', () => {
    expect(billConfidence(clean({ currency: null }), 'Total SGD 436.00').confidence).toBe('high');
  });

  test('medium when it is not an invoice', () => {
    expect(billConfidence(clean({ documentType: 'statement' })).confidence).toBe('medium');
  });

  test('the model\'s own doubt counts: its low is low, its medium caps at medium', () => {
    expect(billConfidence(clean({ confidence: 'low' })).confidence).toBe('low');
    expect(billConfidence(clean({ confidence: 'medium' })).confidence).toBe('medium');
  });

  test('medium when there is nothing to check the total against', () => {
    expect(billConfidence(clean({ lineItems: [], subTotal: null, taxAmount: null, totalAmount: 436 })).confidence).toBe('medium');
  });

  test('within two cents is rounding, not a mismatch (same tolerance as parser.js)', () => {
    expect(billConfidence(clean({ totalAmount: 436.01 })).confidence).toBe('high');
  });

  test('low when part of a long document was never read', async () => {
    const { MAX_TEXT_CHARS } = require('./llm-parser');
    callGemini.mockResolvedValue(JSON.stringify(clean()));
    const out = await extractWithRetry('x'.repeat(MAX_TEXT_CHARS + 10), 'long.pdf', 'u1');
    expect(out.textTruncated).toBeTruthy();
    expect(out.confidence).toBe('low');
  });

  test('the stored value is always one of the three, never what the model made up', async () => {
    callGemini.mockResolvedValue(JSON.stringify(clean({ confidence: 'very sure' })));
    const out = await extractWithRetry('text', 'bill.pdf', 'u1');
    expect(['high', 'medium', 'low']).toContain(out.confidence);
  });
});
