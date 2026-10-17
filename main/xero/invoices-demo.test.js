// A demo account's documents go to the Demo Company and nowhere else: the
// send (invoice-handler, the processor, xero/invoices.js and contacts.js as
// they are), the status read-back (status-sync.js) and a claim all run
// against the demo facade, the SDK is never built, and the two direct calls
// to api.xero.com (the attachment, the delivery address) are skipped as
// done. Real users, token cache, invoice store, PDF store and database; the
// SDK class, axios and Slack are replaced, and the demo folder is stubbed to
// its contract with a facade that answers like Xero.
const mockFacade = {
  createInvoices:        jest.fn(),
  updateInvoice:         jest.fn(),
  getContacts:           jest.fn(),
  createContacts:        jest.fn(),
  getInvoiceAttachments: jest.fn(),
  getBrandingThemes:     jest.fn(),
  getTaxRates:           jest.fn(),
  getOrganisations:      jest.fn(),
  getAccounts:           jest.fn(),
  getInvoices:           jest.fn(),
};
const mockDemoApiFor = jest.fn(() => mockFacade);
jest.mock('./demo/api', () => ({
  DEMO_TENANT: { tenantId: 'demo-company', tenantName: 'Demo Company Pte Ltd' },
  DEMO_TOKEN_PREFIX: 'demo:',
  isDemoToken: t => typeof t === 'string' && t.startsWith('demo:'),
  userIdFromDemoToken: t => (typeof t === 'string' && t.startsWith('demo:') ? t.slice(5) : null),
  demoApiFor: mockDemoApiFor,
}));
jest.mock('xero-node', () => ({ AccountingApi: jest.fn(() => { throw new Error('the SDK must not be built for a demo account'); }) }));
jest.mock('axios', () => ({ put: jest.fn(), post: jest.fn(), get: jest.fn() }));
jest.mock('../utils/notify', () => ({
  ...jest.requireActual('../utils/notify'),
  notifyError:          jest.fn(async () => {}),
  notifyInvoiceCreated: jest.fn(async () => {}),
}));

const axios = require('axios');
let users, invoiceStore, pdfStore, logger, handler, statusSync, db;
let demo, store, n = 0;

const bill = (extra = {}) => ({
  invoiceType: 'ACCPAY', vendorName: 'Acme Corp', contactName: 'Acme Corp',
  invoiceNumber: 'A-100', invoiceDate: '2026-09-01', dueDate: '2026-09-30',
  totalAmount: 109, subTotal: 100, taxAmount: 9, currency: 'SGD',
  lineItems: [{ description: 'Widgets', unitAmount: 100 }],
  ...extra,
});
const postNote = id => db.prepare('SELECT post_note FROM invoices WHERE id = ?').get(id).post_note;

beforeAll(() => {
  require('../db/migrate').run();
  db           = require('../db');
  users        = require('../utils/users');
  invoiceStore = require('../utils/invoice-store');
  pdfStore     = require('../utils/pdf-store');
  logger       = require('../utils/logger');
  handler      = require('../utils/invoice-handler');
  statusSync   = require('./status-sync');
});

beforeEach(async () => {
  for (const fn of Object.values(mockFacade)) fn.mockReset();
  mockDemoApiFor.mockClear();
  axios.put.mockReset(); axios.post.mockReset(); axios.get.mockReset();
  demo  = await users.createUser(`demo${Date.now()}-${n++}@test.com`, 'password123', 'user', { demo: true });
  store = invoiceStore.forUser(demo.id);

  mockFacade.getContacts.mockResolvedValue({ body: { contacts: [{ contactID: 'demo-contact-acme', name: 'Acme Corp', contactStatus: 'ACTIVE' }] } });
  mockFacade.createContacts.mockImplementation(async (_t, body) => ({ body: { contacts: [{ contactID: 'demo-contact-new', name: body.contacts[0].name }] } }));
  mockFacade.createInvoices.mockImplementation(async () => ({
    body: { invoices: [{ invoiceID: 'demo-inv-1', status: 'DRAFT', amountDue: 109, amountPaid: 0, total: 109 }] },
  }));
  mockFacade.getInvoiceAttachments.mockResolvedValue({ body: { attachments: [] } });
  mockFacade.getBrandingThemes.mockResolvedValue({ body: { brandingThemes: [] } });
  mockFacade.getTaxRates.mockResolvedValue({ body: { taxRates: [
    { taxType: 'TX', name: 'Standard-Rated Purchases', status: 'ACTIVE', displayTaxRate: 9, canApplyToExpenses: true, canApplyToRevenue: false },
  ] } });
  mockFacade.getOrganisations.mockResolvedValue({ body: { organisations: [{ baseCurrency: 'SGD' }] } });
  mockFacade.getAccounts.mockResolvedValue({ body: { accounts: [] } });
  mockFacade.getInvoices.mockResolvedValue({ body: { invoices: [] } });
});

describe('posting from a demo account', () => {
  test('a bill with a PDF and an address is sent to the Demo Company through the facade, nothing reaches Xero, and the row reads posted', async () => {
    store.add({ id: 'd1', status: 'pending', processedAt: new Date().toISOString(), ...bill({ contactAddress: '1 Demo Road', hasPdf: true, pdfFilename: 'acme.pdf' }) });
    pdfStore.forUser(demo.id).save('d1', Buffer.from('%PDF-1.4 demo bill'));
    const info = jest.spyOn(logger, 'info');

    await expect(handler.submitInvoiceToXero(demo.id, 'd1')).resolves.toBe('demo-inv-1');

    // The facade, for this account, and the SDK never built.
    expect(mockDemoApiFor).toHaveBeenCalledWith(demo.id);
    expect(require('xero-node').AccountingApi).not.toHaveBeenCalled();
    const [tenantId, body, , , key] = mockFacade.createInvoices.mock.calls[0];
    expect(tenantId).toBe('demo-company');
    expect(body.invoices[0]).toMatchObject({ type: 'ACCPAY', status: 'DRAFT', contact: { contactID: 'demo-contact-acme' }, invoiceNumber: 'A-100', currencyCode: 'SGD' });
    expect(body.invoices[0].lineItems[0]).toMatchObject({ description: 'Widgets', taxType: 'TX', unitAmount: 100 });
    expect(key).toMatch(/^create-d1-[0-9a-f]{16}$/);
    expect(mockFacade.getContacts.mock.calls[0][0]).toBe('demo-company');

    // The two direct calls skipped as done: no note on the row, and a log line each.
    expect(axios.put).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
    expect(postNote('d1')).toBeNull();
    expect(info).toHaveBeenCalledWith('Demo account: attachment not sent to Xero', { invoiceID: 'demo-inv-1', file: 'acme.pdf' });
    expect(info).toHaveBeenCalledWith('Demo account: delivery address not sent to Xero', { invoiceID: 'demo-inv-1' });

    expect(store.getById('d1')).toMatchObject({
      status: 'posted', xeroInvoiceId: 'demo-inv-1', xeroTenantId: 'demo-company', errorMsg: null,
      xeroStatus: 'DRAFT', xeroAmountDue: 109, xeroAmountPaid: 0,
    });
  });

  test('a mileage claim goes to the claimant in the Demo Company, with no attachment looked for', async () => {
    users.saveUserConfig(demo.id, { CLAIM_PAYEE_NAME: 'Dana Demo', MILEAGE_RATE: '0.60', MILEAGE_ACCOUNT_CODE: '493' });
    mockFacade.getContacts.mockResolvedValue({ body: { contacts: [] } });
    store.add({
      id: 'm1', status: 'pending', processedAt: new Date().toISOString(),
      invoiceType: 'EXPENSE', vendorName: null, contactName: null, claimKind: 'mileage', claimQuantity: 20, claimRate: 0.6, claimUnit: 'km',
      description: 'Client visit, 20 km', invoiceNumber: 'MIL-1', invoiceDate: '2026-09-02', dueDate: '2026-09-02',
      totalAmount: 12, subTotal: 12, taxAmount: 0, currency: 'SGD', accountCode: '493',
      lineItems: [{ description: 'Client visit, 20 km at 0.60', unitAmount: 12 }],
    });

    await expect(handler.submitInvoiceToXero(demo.id, 'm1')).resolves.toBe('demo-inv-1');

    expect(mockFacade.createContacts.mock.calls[0][1].contacts[0]).toMatchObject({ name: 'Dana Demo', isSupplier: true });
    const [tenantId, body] = mockFacade.createInvoices.mock.calls[0];
    expect(tenantId).toBe('demo-company');
    expect(body.invoices[0]).toMatchObject({ type: 'ACCPAY', contact: { contactID: 'demo-contact-new' }, invoiceNumber: 'MIL-1' });
    expect(body.invoices[0].lineItems[0]).toMatchObject({ accountCode: '493', unitAmount: 12 });
    expect(mockFacade.getInvoiceAttachments).not.toHaveBeenCalled();
    expect(axios.put).not.toHaveBeenCalled();
    expect(store.getById('m1')).toMatchObject({ status: 'posted', xeroInvoiceId: 'demo-inv-1', xeroTenantId: 'demo-company' });
  });

  test('a correction updates the document in the Demo Company', async () => {
    mockFacade.updateInvoice.mockImplementation(async (_t, id) => ({ body: { invoices: [{ invoiceID: id, status: 'DRAFT', amountDue: 109, amountPaid: 0, total: 109 }] } }));
    store.add({ id: 'c1', status: 'posted', xeroInvoiceId: 'demo-inv-9', xeroTenantId: 'demo-company', processedAt: new Date().toISOString(), ...bill() });

    await expect(handler.submitInvoiceToXero(demo.id, 'c1')).resolves.toBe('demo-inv-9');

    expect(mockFacade.updateInvoice.mock.calls[0].slice(0, 2)).toEqual(['demo-company', 'demo-inv-9']);
    expect(mockFacade.createInvoices).not.toHaveBeenCalled();
    expect(store.getById('c1')).toMatchObject({ status: 'posted', xeroInvoiceId: 'demo-inv-9', xeroTenantId: 'demo-company' });
  });
});

describe('the status read-back for a demo account', () => {
  test('asks the facade about the Demo Company and stores what it says', async () => {
    // Row ids are global, so not 'd1' again.
    store.add({ id: 's1', status: 'pending', processedAt: new Date().toISOString(), ...bill() });
    await handler.submitInvoiceToXero(demo.id, 's1');
    mockDemoApiFor.mockClear();
    mockFacade.getInvoices.mockResolvedValue({ body: { invoices: [
      { invoiceID: 'demo-inv-1', status: 'AUTHORISED', amountDue: 109, amountPaid: 0, total: 109 },
    ] } });

    const result = await statusSync.syncUser(demo.id);

    expect(result).toEqual({ checked: 1, updated: 1, failedTenants: 0 });
    expect(mockDemoApiFor).toHaveBeenCalledWith(demo.id);
    expect(require('xero-node').AccountingApi).not.toHaveBeenCalled();
    const [tenantId, since, , , ids, , , , , , , , summaryOnly] = mockFacade.getInvoices.mock.calls[0];
    expect([tenantId, since, ids, summaryOnly]).toEqual(['demo-company', undefined, ['demo-inv-1'], true]);
    expect(store.getById('s1')).toMatchObject({ status: 'posted', xeroStatus: 'AUTHORISED', xeroAmountDue: 109, xeroSyncedAt: expect.any(String) });
    expect(statusSync.repostRefusal(store.getById('s1'))).toBe('Approved in Xero, so it can no longer be changed from here');
  });
});
