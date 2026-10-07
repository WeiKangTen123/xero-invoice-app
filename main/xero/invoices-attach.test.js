// Attachments on what is sent to Xero: a bill's PDF and an expense claim's
// receipt. They never arrived — the token had no accounting.attachments scope,
// claims' receipts were never even tried, and a failure was only logged.
// Nothing here reaches Xero: the SDK class and axios are replaced.
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const mockApi = {
  createInvoices:                    jest.fn(),
  updateInvoice:                     jest.fn(),
  getInvoiceAttachments:             jest.fn(),
  createInvoiceAttachmentByFileName: jest.fn(),
  getBrandingThemes:                 jest.fn(async () => ({ body: { brandingThemes: [] } })),
  getTaxRates:                       jest.fn(async () => ({ body: { taxRates: [] } })),
  getOrganisations:                  jest.fn(async () => ({ body: { organisations: [{ baseCurrency: 'SGD' }] } })),
};
jest.mock('xero-node', () => ({ AccountingApi: jest.fn(() => mockApi) }));
jest.mock('axios', () => ({ put: jest.fn(), post: jest.fn() }));
jest.mock('./contacts', () => ({
  ...jest.requireActual('./contacts'),
  resolveContact: jest.fn(async () => ({ contactID: 'contact-1' })),
}));
jest.mock('../utils/token-cache', () => ({ forUser: () => ({ getValidToken: async () => 'tok' }) }));

let mockPdfPath = null;
jest.mock('../utils/pdf-store', () => ({ forUser: () => ({ getPath: () => mockPdfPath }) }));

const mockReceipts = {};
jest.mock('../utils/receipt-store', () => ({
  forUser: () => ({ read: name => mockReceipts[name] || null }),
  extensionFor: mime => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' })[mime] || null,
}));

let mockConfig = {};
jest.mock('../utils/users', () => ({
  getUserConfig: () => mockConfig,
  defaultsFrom:  () => ({ zeroTaxRate: 'NONE', accountCode: { claim: '429', bill: '429', invoice: '200' }, currency: 'SGD' }),
}));

const mockAddNote = jest.fn();
jest.mock('../utils/invoice-store', () => ({ forUser: () => ({ addPostingNote: mockAddNote }) }));

const axios = require('axios');
const { createDraftInvoice, updateDraftInvoice } = require('./invoices');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const claim = (extra = {}) => ({
  _invoiceStoreId: 'claim-1', invoiceType: 'EXPENSE', vendorName: 'FairPrice', invoiceNumber: 'EXP-ABC123',
  invoiceDate: '2026-09-01', dueDate: '2026-09-01', totalAmount: 12.5, subTotal: 12.5, taxAmount: 0,
  currency: 'SGD', lineItems: [], description: 'Groceries for the office',
  receiptFile: 'claim-1.jpg', receiptMime: 'image/jpeg', ...extra,
});

const bill = (extra = {}) => ({
  _invoiceStoreId: 'bill-1', invoiceType: 'ACCPAY', vendorName: 'Acme', invoiceNumber: 'A-1',
  invoiceDate: '2026-09-01', dueDate: '2026-09-30', totalAmount: 100, subTotal: 100, taxAmount: 0,
  currency: 'SGD', lineItems: [{ description: 'Widgets', unitAmount: 100 }],
  hasPdf: true, pdfFilename: 'acme-a1.pdf', ...extra,
});

const httpError = (status, data, headers = {}) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data, headers } });

beforeEach(() => {
  for (const fn of Object.values(mockApi)) if (jest.isMockFunction(fn)) fn.mockClear();
  mockApi.createInvoices.mockReset().mockResolvedValue({ body: { invoices: [{ invoiceID: 'xero-1', total: 12.5 }] } });
  mockApi.updateInvoice.mockReset().mockResolvedValue({ body: { invoices: [{ invoiceID: 'xero-1', total: 12.5 }] } });
  mockApi.getInvoiceAttachments.mockReset().mockResolvedValue({ body: { attachments: [] } });
  axios.put.mockReset().mockResolvedValue({ status: 200, data: {} });
  axios.post.mockReset().mockResolvedValue({ status: 200, data: {} });
  mockAddNote.mockReset();
  mockConfig = {};
  mockPdfPath = null;
  for (const k of Object.keys(mockReceipts)) delete mockReceipts[k];
});

describe('a claim\'s receipt', () => {
  test('is attached with its bytes, its stored type and a readable name', async () => {
    mockReceipts['claim-1.jpg'] = JPEG;
    const created = await createDraftInvoice('u1', 'tenant-1', claim());
    expect(created.invoiceID).toBe('xero-1');

    expect(axios.put).toHaveBeenCalledTimes(1);
    const [url, body, opts] = axios.put.mock.calls[0];
    expect(url).toBe(`https://api.xero.com/api.xro/2.0/Invoices/xero-1/Attachments/${encodeURIComponent('Receipt EXP-ABC123 FairPrice.jpg')}`);
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.equals(JPEG)).toBe(true);                 // the file itself, not a JSON rendering of it
    expect(opts.headers['Content-Type']).toBe('image/jpeg');
    expect(opts.headers['xero-tenant-id']).toBe('tenant-1');
    // Not the SDK's upload: 7.0.0 sent the bytes as JSON, and even 20.0.0
    // labels them application/x-www-form-urlencoded unless given headers
    // (sdk-attachment-body.test.js). The direct PUT sends the file's own type.
    expect(mockApi.createInvoiceAttachmentByFileName).not.toHaveBeenCalled();
    expect(mockAddNote).not.toHaveBeenCalled();
  });

  test('a PNG or PDF receipt keeps its own type and extension', async () => {
    mockReceipts['claim-1.png'] = Buffer.from('png');
    await createDraftInvoice('u1', 'tenant-1', claim({ receiptFile: 'claim-1.png', receiptMime: 'image/png' }));
    expect(decodeURIComponent(axios.put.mock.calls[0][0])).toMatch(/Receipt EXP-ABC123 FairPrice\.png$/);
    expect(axios.put.mock.calls[0][2].headers['Content-Type']).toBe('image/png');
  });

  test('a receipt file that is gone leaves a note, and the claim is still sent', async () => {
    const created = await createDraftInvoice('u1', 'tenant-1', claim());
    expect(created.invoiceID).toBe('xero-1');
    expect(axios.put).not.toHaveBeenCalled();
    expect(mockAddNote).toHaveBeenCalledWith('claim-1',
      'Sent to Xero, but the attachment failed: the receipt file is no longer on the server.');
  });
});

describe('a bill\'s PDF', () => {
  test('is attached from the PDF store as application/pdf under its own name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-'));
    mockPdfPath = path.join(dir, 'bill-1.pdf');
    fs.writeFileSync(mockPdfPath, Buffer.from('%PDF-1.4 test'));
    mockApi.createInvoices.mockResolvedValue({ body: { invoices: [{ invoiceID: 'xero-2', total: 100 }] } });

    await createDraftInvoice('u1', 'tenant-1', bill());
    const [url, body, opts] = axios.put.mock.calls[0];
    expect(url).toMatch(/\/Invoices\/xero-2\/Attachments\/acme-a1\.pdf$/);
    expect(body.toString()).toBe('%PDF-1.4 test');
    expect(opts.headers['Content-Type']).toBe('application/pdf');
  });
});

describe('when Xero refuses the attachment', () => {
  test('missing scope (403): still posted, and the row says to reconnect', async () => {
    mockReceipts['claim-1.jpg'] = JPEG;
    axios.put.mockRejectedValue(httpError(403, { Title: 'Forbidden' }));
    const created = await createDraftInvoice('u1', 'tenant-1', claim());
    expect(created.invoiceID).toBe('xero-1');
    const [id, note] = mockAddNote.mock.calls[0];
    expect(id).toBe('claim-1');
    expect(note).toMatch(/^Sent to Xero, but the attachment failed: /);
    expect(note).toContain('Reconnect Xero in Setup to allow attachments');
  });

  test('missing scope (401 insufficient_scope) is read the same way', async () => {
    mockReceipts['claim-1.jpg'] = JPEG;
    axios.put.mockRejectedValue(httpError(401, '', { 'www-authenticate': 'Bearer error="insufficient_scope"' }));
    await createDraftInvoice('u1', 'tenant-1', claim());
    expect(mockAddNote.mock.calls[0][1]).toContain('Reconnect Xero in Setup to allow attachments');
  });

  test('a Custom Connection is told it needs the Web app sign-in', async () => {
    mockConfig = { XERO_CONNECTION_TYPE: 'custom' };
    mockReceipts['claim-1.jpg'] = JPEG;
    axios.put.mockRejectedValue(httpError(403, {}));
    await createDraftInvoice('u1', 'tenant-1', claim());
    const note = mockAddNote.mock.calls[0][1];
    expect(note).toContain('Reconnect Xero in Setup to allow attachments');
    expect(note).toContain('Custom Connection');
  });

  test('any other refusal carries Xero\'s own reason', async () => {
    mockReceipts['claim-1.jpg'] = JPEG;
    axios.put.mockRejectedValue(httpError(400, { Message: 'The file is too large' }));
    await createDraftInvoice('u1', 'tenant-1', claim());
    expect(mockAddNote).toHaveBeenCalledWith('claim-1', 'Sent to Xero, but the attachment failed: The file is too large.');
  });
});

describe('a correction (update in place)', () => {
  test('attaches only what Xero does not already hold', async () => {
    mockReceipts['claim-1.jpg'] = JPEG;
    mockApi.getInvoiceAttachments.mockResolvedValue({ body: { attachments: [{ fileName: 'Receipt EXP-ABC123 FairPrice.jpg' }] } });
    await updateDraftInvoice('u1', 'tenant-1', 'xero-1', claim());
    expect(axios.put).not.toHaveBeenCalled();

    mockApi.getInvoiceAttachments.mockResolvedValue({ body: { attachments: [] } });
    await updateDraftInvoice('u1', 'tenant-1', 'xero-1', claim());
    expect(axios.put).toHaveBeenCalledTimes(1);   // refused the first time, arrives now
  });

  test('a token still without the scope says so, and the correction stands', async () => {
    mockReceipts['claim-1.jpg'] = JPEG;
    mockApi.getInvoiceAttachments.mockRejectedValue(JSON.stringify({
      response: { statusCode: 401, headers: { 'www-authenticate': 'Bearer error="insufficient_scope"' } },
    }));
    const updated = await updateDraftInvoice('u1', 'tenant-1', 'xero-1', claim());
    expect(updated.invoiceID).toBe('xero-1');
    expect(axios.put).not.toHaveBeenCalled();
    expect(mockAddNote.mock.calls[0][1]).toContain('Reconnect Xero in Setup to allow attachments');
  });
});
