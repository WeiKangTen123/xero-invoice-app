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

test('when the model fails, the regex guess is flagged for review and never numbered from the filename', async () => {
  extractWithRetry.mockRejectedValue(new Error('quota'));
  const r = await parsePDFWithLLM('Total: 500', EMAIL, 'Scan_0001.pdf', 'u1', DEFAULTS);
  expect(r.reviewReason).toMatch(/could not be read/);
  expect(r.invoiceNumber).not.toBe('Scan_0001');
});

test('a model answer with no invoice number is numbered so that the handler holds it', async () => {
  extractWithRetry.mockResolvedValue({ vendorName: 'Acme', invoiceNumber: null, totalAmount: 10, lineItems: [] });
  const r = await parsePDFWithLLM('text', EMAIL, 'Scan_0001.pdf', 'u1', DEFAULTS);
  expect(r.invoiceNumber).toMatch(/^INV-\d{12,}$/);
});

// ── Holding a bill whose reading cannot be trusted ──────────────────────────
// Bills read by the model were posted as read: nothing checked that the lines
// added up to the subtotal, or the subtotal and tax to the total, and every PDF
// was a bill whatever it was. Each of these is now a review reason; the
// figures are kept exactly as read (flag, never overwrite).
describe('the LLM bill path flags what does not add up', () => {
  const bill = (over = {}) => ({
    vendorName: 'Acme', invoiceNumber: 'A-10', invoiceDate: '2026-09-01', currency: 'SGD', documentType: 'invoice',
    lineItems: [{ description: 'Design', amount: 600 }, { description: 'Build', amount: 400 }],
    subTotal: 1000, taxAmount: 90, totalAmount: 1090, ...over,
  });

  test('figures that agree are not flagged', async () => {
    extractWithRetry.mockResolvedValue(bill());
    const r = await parsePDFWithLLM('text', EMAIL, 'a.pdf', 'u1', DEFAULTS);
    expect(r.reviewReason).toBeNull();
    expect(r.documentType).toBe('invoice');
  });

  test('a difference within two cents is rounding, not a disagreement', async () => {
    extractWithRetry.mockResolvedValue(bill({ lineItems: [{ description: 'Design', amount: 600.01 }, { description: 'Build', amount: 400 }], totalAmount: 1090.02 }));
    const r = await parsePDFWithLLM('text', EMAIL, 'a.pdf', 'u1', DEFAULTS);
    expect(r.reviewReason).toBeNull();
  });

  test('lines that do not add up to the subtotal hold the bill, and the figures stay as read', async () => {
    extractWithRetry.mockResolvedValue(bill({ lineItems: [{ description: 'Design', amount: 600 }] }));
    const r = await parsePDFWithLLM('text', EMAIL, 'a.pdf', 'u1', DEFAULTS);
    expect(r.reviewReason).toMatch(/line items add up to SGD 600\.00, but the subtotal is SGD 1,000\.00/);
    expect(r).toMatchObject({ subTotal: 1000, taxAmount: 90, totalAmount: 1090 });
    expect(r.lineItems).toHaveLength(1);
  });

  test('a subtotal and tax that do not make the total hold the bill', async () => {
    extractWithRetry.mockResolvedValue(bill({ totalAmount: 1200 }));
    const r = await parsePDFWithLLM('text', EMAIL, 'a.pdf', 'u1', DEFAULTS);
    expect(r.reviewReason).toMatch(/subtotal SGD 1,000\.00 plus tax SGD 90\.00 comes to SGD 1,090\.00, but the total is SGD 1,200\.00/);
    expect(r.totalAmount).toBe(1200);
  });

  test('with no subtotal stated, the lines are checked against the total less tax', async () => {
    extractWithRetry.mockResolvedValue(bill({ subTotal: null, taxAmount: 90, totalAmount: 1190 }));
    const r = await parsePDFWithLLM('text', EMAIL, 'a.pdf', 'u1', DEFAULTS);
    expect(r.reviewReason).toMatch(/line items add up to SGD 1,000\.00, but the total before tax is SGD 1,100\.00/);
  });

  test('a total on page two that the lines never reach is caught', async () => {
    // The model read only some lines: no subtotal or tax, lines short of the total.
    extractWithRetry.mockResolvedValue(bill({ subTotal: null, taxAmount: null, totalAmount: 1500 }));
    const r = await parsePDFWithLLM('text', EMAIL, 'a.pdf', 'u1', DEFAULTS);
    expect(r.reviewReason).toMatch(/but the total is SGD 1,500\.00/);
  });

  test('no lines read is not a mismatch: the one line is built from the total', async () => {
    extractWithRetry.mockResolvedValue(bill({ lineItems: [], subTotal: null, taxAmount: null }));
    const r = await parsePDFWithLLM('text', EMAIL, 'a.pdf', 'u1', DEFAULTS);
    expect(r.reviewReason).toBeNull();
  });

  test.each([
    ['receipt', /receipt for a payment already made/],
    ['statement', /statement of account/],
    ['credit note', /credit note/],
    ['Quotation', /quote or estimate/],
    ['delivery order', /does not look like an invoice or bill/],
  ])('a document the model calls "%s" is held with what it appears to be', async (type, reason) => {
    extractWithRetry.mockResolvedValue(bill({ documentType: type }));
    const r = await parsePDFWithLLM('text', EMAIL, 'a.pdf', 'u1', DEFAULTS);
    expect(r.reviewReason).toMatch(reason);
  });

  test('"tax invoice" and "bill" are bills; an unanswered type is treated as before', async () => {
    for (const documentType of ['Tax Invoice', 'bill', undefined]) {
      extractWithRetry.mockResolvedValue(bill({ documentType }));
      const r = await parsePDFWithLLM('text', EMAIL, 'a.pdf', 'u1', DEFAULTS);
      expect(r.reviewReason).toBeNull();
    }
  });

  test('a PDF longer than what was sent says so and is held', async () => {
    extractWithRetry.mockResolvedValue(bill({ textTruncated: { sentChars: 30000, totalChars: 41250 } }));
    const r = await parsePDFWithLLM('text', EMAIL, 'a.pdf', 'u1', DEFAULTS);
    expect(r.reviewReason).toMatch(/first 30,000 of 41,250 characters/);
  });

  test('several reasons are all given', async () => {
    extractWithRetry.mockResolvedValue(bill({ documentType: 'statement', totalAmount: 5000 }));
    const r = await parsePDFWithLLM('text', EMAIL, 'a.pdf', 'u1', DEFAULTS);
    expect(r.reviewReason).toMatch(/statement of account.*; .*plus tax/);
  });

  test('a reading cut off even after the larger retry falls back to the regex guess and says why', async () => {
    extractWithRetry.mockRejectedValue(Object.assign(new Error('cut off'), { code: 'GEMINI_TRUNCATED' }));
    const r = await parsePDFWithLLM('Total: 500', EMAIL, 'a.pdf', 'u1', DEFAULTS);
    expect(r.reviewReason).toMatch(/cut off before it finished/);
  });

  test.each([['S$', 'SGD'], ['s$', 'SGD'], ['US$', 'USD'], ['sgd', 'SGD'], ['RM', 'MYR'], ['£', 'GBP']])(
    'a currency answered as "%s" is stored as %s', async (given, code) => {
      extractWithRetry.mockResolvedValue(bill({ currency: given }));
      const r = await parsePDFWithLLM('text', EMAIL, 'a.pdf', 'u1', { ...DEFAULTS, currency: 'AUD' });
      expect(r.currency).toBe(code);
    });

  test('a bare "$" falls back to the text, then the default — never stored as "$"', async () => {
    extractWithRetry.mockResolvedValue(bill({ currency: '$' }));
    const r = await parsePDFWithLLM('Amount due $1,090.00', EMAIL, 'a.pdf', 'u1', { ...DEFAULTS, currency: 'AUD' });
    expect(r.currency).toBe('AUD');
  });
});
