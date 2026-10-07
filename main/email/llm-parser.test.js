// What the bill reader sends the model, and when it asks again. The reader used
// to send the first 3,000 characters — about one page — so a total on page two
// was never seen, and it retried a cut-off reply with the identical request.
jest.mock('../utils/gemini-client', () => ({ callGemini: jest.fn(), GEMINI_MODELS: ['m'] }));
const { callGemini } = require('../utils/gemini-client');
const { extractWithRetry, MAX_TEXT_CHARS, SYSTEM_PROMPT } = require('./llm-parser');

const reply = JSON.stringify({ vendorName: 'Acme', totalAmount: 1234.56, documentType: 'invoice' });
const userText = () => callGemini.mock.calls[0][1].find(m => m.role === 'user').content;

beforeEach(() => callGemini.mockReset());

test('the whole document is sent, so a total on a later page is read', async () => {
  const page = 'Line item description and amount 100.00\n'.repeat(120);       // ~4,800 characters a page
  const pdf  = `${page}\f${page}\fTOTAL DUE SGD 1,234.56`;
  expect(pdf.length).toBeGreaterThan(3000);
  callGemini.mockResolvedValue(reply);

  const out = await extractWithRetry(pdf, 'bill.pdf', 'u1');
  expect(userText()).toContain('TOTAL DUE SGD 1,234.56');
  expect(userText()).toContain(pdf);
  expect(out.textTruncated).toBeUndefined();
});

test('past the cap, the text is cut and the result says how much was read', async () => {
  const pdf = 'x'.repeat(MAX_TEXT_CHARS + 5000);
  callGemini.mockResolvedValue(reply);

  const out = await extractWithRetry(pdf, 'long.pdf', 'u1');
  expect(MAX_TEXT_CHARS).toBeGreaterThanOrEqual(30000);
  expect(userText().length).toBeLessThan(MAX_TEXT_CHARS + 200);
  expect(out.textTruncated).toEqual({ sentChars: MAX_TEXT_CHARS, totalChars: MAX_TEXT_CHARS + 5000 });
});

test('the reply has room for a long itemised bill', async () => {
  callGemini.mockResolvedValue(reply);
  await extractWithRetry('text', 'a.pdf', 'u1');
  expect(callGemini.mock.calls[0][2].maxTokens).toBeGreaterThan(800);
});

test('the model is asked what kind of document this is', () => {
  expect(SYSTEM_PROMPT).toMatch(/documentType/);
  for (const t of ['invoice', 'receipt', 'statement', 'credit_note', 'quote', 'other']) expect(SYSTEM_PROMPT).toContain(`"${t}"`);
});

test('a reply cut off even after the client\'s larger retry is not sent again identically', async () => {
  callGemini.mockRejectedValue(Object.assign(new Error('cut off'), { code: 'GEMINI_TRUNCATED' }));
  await expect(extractWithRetry('text', 'a.pdf', 'u1')).rejects.toMatchObject({ code: 'GEMINI_TRUNCATED' });
  expect(callGemini).toHaveBeenCalledTimes(1);
});

test('a reply that is not JSON is still retried — that is what the loop is for', async () => {
  jest.useFakeTimers();
  try {
    callGemini.mockResolvedValueOnce('Sorry, here is the invoice:').mockResolvedValueOnce(reply);
    const pending = extractWithRetry('text', 'a.pdf', 'u1', 2);
    await jest.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toMatchObject({ vendorName: 'Acme' });
    expect(callGemini).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
  }
});
