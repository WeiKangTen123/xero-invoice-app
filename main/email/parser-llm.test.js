// What the model returns is text. "1,250.00" and "14/09/2026" are normal
// answers; parseFloat read the first as 1 and addDays threw on the second,
// which lost the bill after the mail was already marked read.
jest.mock('./llm-parser', () => ({ extractWithRetry: jest.fn() }));
jest.mock('./template-verifier', () => ({ verifyTemplateExtraction: jest.fn(async (t, p) => ({ parsed: p, reviewReason: null })) }));
const { extractWithRetry } = require('./llm-parser');
const { parsePDFWithLLM } = require('./parser');

const EMAIL = { subject: 'Invoice', date: '2026-09-10T02:00:00Z', from: { text: 'x@y.com', value: [{ address: 'x@y.com' }] } };
const DEFAULTS = { currency: 'SGD', accountCode: '310' };

beforeEach(() => extractWithRetry.mockReset());

test('amounts with thousands separators are read as numbers, not truncated', async () => {
  extractWithRetry.mockResolvedValue({ vendorName: 'Acme', invoiceNumber: 'A-1', totalAmount: '1,250.00', subTotal: '1,250.00', taxAmount: '0',
    lineItems: [{ description: 'Work', quantity: 1, unitPrice: '1,250.00', amount: '1,250.00' }] });
  const r = await parsePDFWithLLM('text', EMAIL, 'a.pdf', 'u1', DEFAULTS);
  expect(r.totalAmount).toBe(1250);
  expect(r.lineItems[0].unitAmount).toBe(1250);
});

test('a day-first date is read; a non-ISO date never throws', async () => {
  extractWithRetry.mockResolvedValue({ vendorName: 'Acme', invoiceNumber: 'A-2', totalAmount: 10, invoiceDate: '14/09/2026', dueDate: null, lineItems: [] });
  const r = await parsePDFWithLLM('text', EMAIL, 'a.pdf', 'u1', DEFAULTS);
  expect(r.invoiceDate).toBe('2026-09-14');
  expect(r.dueDate).toBe('2026-10-14');
});

test('no readable invoice date falls back to the email date, never today', async () => {
  extractWithRetry.mockResolvedValue({ vendorName: 'Acme', invoiceNumber: 'A-3', totalAmount: 10, invoiceDate: 'TBC', lineItems: [] });
  const r = await parsePDFWithLLM('text', EMAIL, 'a.pdf', 'u1', DEFAULTS);
  expect(r.invoiceDate).toBe('2026-09-10');
});
