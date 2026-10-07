// A reply cut off at its token limit has already had gemini-client's one
// larger retry. Asking again with the identical request stops at the
// identical place, so the verifier gives up at once and the parser's result
// stands (rule 1) — it still retries once for any other failure.
jest.mock('../utils/gemini-client', () => ({ callGemini: jest.fn(), GEMINI_MODELS: [] }));
const { callGemini } = require('../utils/gemini-client');
const { verifyTemplateExtraction } = require('./template-verifier');

const parsed = () => ({
  contactName: 'PereOcean Demo', vendorName: 'PereOcean Demo', contactEmail: 'a@b.com',
  contactAddress: '58 Senoko Road', currency: 'SGD', invoiceDate: '2026-08-17', dueDate: '2026-09-16',
  lineItems: [{ description: 'Water Cartons', unitAmount: 1000, discountRate: 0 }],
  subTotal: 1000, taxAmount: 0, totalAmount: 1000,
});
const cutOff = () => Object.assign(new Error('Gemini reply was cut off at 2048 tokens'), { code: 'GEMINI_TRUNCATED', partial: '{"contactName": "Pere' });

beforeEach(() => callGemini.mockReset());

test('a cut-off reply is not asked for again, and the parser result stands', async () => {
  callGemini.mockRejectedValue(cutOff());
  const p = parsed();
  const r = await verifyTemplateExtraction('text', p, 'u1');
  expect(callGemini).toHaveBeenCalledTimes(1);
  expect(r.parsed).toBe(p);
  expect(r.verified).toBe(false);
});

test('any other failure still gets its one retry', async () => {
  jest.useFakeTimers();
  try {
    callGemini.mockRejectedValue(new Error('socket hang up'));
    const pending = verifyTemplateExtraction('text', parsed(), 'u1');
    await jest.advanceTimersByTimeAsync(2000);
    const r = await pending;
    expect(callGemini).toHaveBeenCalledTimes(2);
    expect(r.verified).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});
