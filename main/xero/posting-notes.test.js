// The whole send, end to end, with only Xero's side replaced: the handler, the
// processor, xero/invoices.js and the store are real. A note recorded after
// Xero accepted the document (an attachment refused, a total that came back
// different) has to survive the handler's closing update, which clears
// errorMsg on success, and the row has to stay posted.
const mockApi = {
  createInvoices:    jest.fn(),
  getBrandingThemes: jest.fn(async () => ({ body: { brandingThemes: [] } })),
  getTaxRates:       jest.fn(async () => ({ body: { taxRates: [] } })),
  getOrganisations:  jest.fn(async () => ({ body: { organisations: [{ baseCurrency: 'SGD' }] } })),
};
jest.mock('xero-node', () => ({ AccountingApi: jest.fn(() => mockApi) }));
jest.mock('axios', () => ({ put: jest.fn(), post: jest.fn(async () => ({})) }));
jest.mock('./contacts', () => ({
  ...jest.requireActual('./contacts'),
  resolveContact: jest.fn(async () => ({ contactID: 'contact-1' })),
}));
jest.mock('../utils/token-cache', () => ({
  forUser: () => ({
    getValidToken: async () => 'tok',
    getAllTenants: async () => [{ tenant_id: 'tenant-1', tenant_name: 'Demo' }],
  }),
  getPersistedTenants: () => [{ tenantId: 'tenant-1' }],
}));
jest.mock('./reconnect', () => ({ reconnectXero: jest.fn(async () => {}) }));
jest.mock('../utils/notify', () => ({ notifyError: jest.fn(async () => {}), notifyInvoiceCreated: jest.fn(async () => {}) }));

describe('a note from the send reaches the row', () => {
  let store, userId, axios, receiptStore, submitInvoiceToXero;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    axios = require('axios');
    axios.put.mockReset();
    mockApi.createInvoices.mockReset();
    const u = await require('../utils/users').createUser(`pn${Date.now()}${Math.random()}@test.com`, 'password123', 'user');
    userId = u.id;
    store = require('../utils/invoice-store').forUser(userId);
    receiptStore = require('../utils/receipt-store').forUser(userId);
    ({ submitInvoiceToXero } = require('../utils/invoice-handler'));
  });

  const addClaim = (extra = {}) => store.add({
    id: `c-${Math.random().toString(36).slice(2, 8)}`, status: 'review-needed', invoiceType: 'EXPENSE', source: 'claim',
    vendorName: 'FairPrice', invoiceNumber: 'EXP-1', invoiceDate: '2026-09-01', dueDate: '2026-09-01',
    totalAmount: 12.5, subTotal: 12.5, taxAmount: 0, currency: 'SGD', description: 'Pantry snacks',
    processedAt: new Date().toISOString(), ...extra,
  });

  test('an attachment Xero refused: posted, with the reconnect note', async () => {
    const rec = addClaim();
    const file = receiptStore.save(rec.id, Buffer.from([0xff, 0xd8, 0xff, 1, 2]), 'image/jpeg');
    store.update(rec.id, { receiptFile: file, receiptMime: 'image/jpeg' });
    mockApi.createInvoices.mockResolvedValue({ body: { invoices: [{ invoiceID: 'xero-pn-1', total: 12.5 }] } });
    axios.put.mockRejectedValue(Object.assign(new Error('Request failed with status code 401'), {
      response: { status: 401, data: '', headers: { 'www-authenticate': 'Bearer error="insufficient_scope"' } },
    }));

    await expect(submitInvoiceToXero(userId, rec.id)).resolves.toBe('xero-pn-1');
    const row = store.getById(rec.id);
    expect(row.status).toBe('posted');
    expect(row.xeroInvoiceId).toBe('xero-pn-1');
    expect(row.errorMsg).toMatch(/^Sent to Xero, but the attachment failed: .*Reconnect Xero in Setup to allow attachments/);

    // The bytes and type that were offered to Xero.
    const [url, body, opts] = axios.put.mock.calls[0];
    expect(decodeURIComponent(url)).toMatch(/Attachments\/Receipt EXP-1 FairPrice\.jpg$/);
    expect(body.equals(Buffer.from([0xff, 0xd8, 0xff, 1, 2]))).toBe(true);
    expect(opts.headers['Content-Type']).toBe('image/jpeg');
  });

  test('a clean send leaves no note', async () => {
    const rec = addClaim();
    mockApi.createInvoices.mockResolvedValue({ body: { invoices: [{ invoiceID: 'xero-pn-2', total: 12.5 }] } });
    await submitInvoiceToXero(userId, rec.id);
    expect(store.getById(rec.id)).toMatchObject({ status: 'posted', errorMsg: null });
  });

  test('a total that came back different: posted, with the totals side by side', async () => {
    const rec = addClaim();
    mockApi.createInvoices.mockResolvedValue({ body: { invoices: [{ invoiceID: 'xero-pn-3', total: 10 }] } });
    await submitInvoiceToXero(userId, rec.id);
    expect(store.getById(rec.id)).toMatchObject({
      status: 'posted',
      errorMsg: 'Sent to Xero, but Xero\'s total is SGD 10.00 where the document says SGD 12.50. Check the lines and tax in Xero.',
    });
  });
});
