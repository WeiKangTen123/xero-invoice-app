// Xero's Idempotency-Key on invoice creation. A create whose answer never
// arrived (a dropped connection, a timeout, a restart) and is sent again
// within Xero's six-minute window returns the first invoice instead of making
// a second draft. Nothing here reaches Xero: the SDK class is replaced.
const mockCreateInvoices = jest.fn();
jest.mock('xero-node', () => ({
  AccountingApi: jest.fn().mockImplementation(() => ({
    createInvoices: mockCreateInvoices,
    getBrandingThemes: jest.fn(async () => ({ body: { brandingThemes: [] } })),
  })),
}));
jest.mock('./contacts', () => ({ getOrCreateContact: jest.fn(async () => 'contact-1') }));
jest.mock('./xero-utils', () => ({ withRetry: fn => fn(), xeroErrMsg: e => e?.message || String(e) }));
jest.mock('../utils/token-cache', () => ({ forUser: () => ({ getValidToken: async () => 'token' }) }));
jest.mock('../utils/pdf-store', () => ({ forUser: () => ({ getPath: () => null }) }));
jest.mock('../utils/users', () => ({
  getUserConfig: () => ({}),
  defaultsFrom: () => ({ zeroTaxRate: 'NONE', accountCode: { bill: '429', invoice: '200' }, currency: 'SGD' }),
}));

const { createDraftInvoice, createIdempotencyKey } = require('./invoices');

const invoice = (extra = {}) => ({
  _invoiceStoreId: 'local-123', invoiceType: 'ACCPAY', vendorName: 'Acme', invoiceNumber: 'A-1',
  invoiceDate: '2026-09-01', dueDate: '2026-09-30', totalAmount: 100, subTotal: 100, taxAmount: 0,
  currency: 'SGD', lineItems: [{ description: 'Widgets', unitAmount: 100 }], ...extra,
});

beforeEach(() => {
  mockCreateInvoices.mockReset().mockResolvedValue({ body: { invoices: [{ invoiceID: 'xero-1' }] } });
});

test('createInvoices is called with an idempotency key tied to the local invoice', async () => {
  await createDraftInvoice('u1', 'tenant-1', invoice());
  expect(mockCreateInvoices).toHaveBeenCalledTimes(1);
  // createInvoices(xeroTenantId, invoices, summarizeErrors?, unitdp?, idempotencyKey?)
  const [tenantId, , summarizeErrors, unitdp, key] = mockCreateInvoices.mock.calls[0];
  expect(tenantId).toBe('tenant-1');
  expect(summarizeErrors).toBeUndefined();
  expect(unitdp).toBeUndefined();
  expect(key).toMatch(/^create-local-123-[0-9a-f]{16}$/);
});

test('the same row sent again uses the same key, so Xero returns the first invoice', async () => {
  await createDraftInvoice('u1', 'tenant-1', invoice());
  await createDraftInvoice('u1', 'tenant-1', invoice());
  expect(mockCreateInvoices.mock.calls[0][4]).toBe(mockCreateInvoices.mock.calls[1][4]);
});

// A row Xero refused, then corrected, must not be answered with the refusal
// Xero kept for the old key.
test('a corrected row, or another org, gets a different key', async () => {
  await createDraftInvoice('u1', 'tenant-1', invoice());
  await createDraftInvoice('u1', 'tenant-1', invoice({ invoiceDate: '2026-09-02' }));
  await createDraftInvoice('u1', 'tenant-2', invoice());
  const keys = mockCreateInvoices.mock.calls.map(c => c[4]);
  expect(new Set(keys).size).toBe(3);
  for (const k of keys) expect(k.startsWith('create-local-123-')).toBe(true);
});

test('no local id, no key', () => {
  expect(createIdempotencyKey(null, 't', {})).toBeNull();
  expect(createIdempotencyKey('abc', 't', {}).length).toBeLessThanOrEqual(128);
});
