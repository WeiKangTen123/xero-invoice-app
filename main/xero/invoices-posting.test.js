// The send to Xero from end to end: submitInvoiceToXero, the processor's
// choice of org, and xero/invoices.js and contacts.js as they are, against the
// test database and the real PDF store. Only the edges are replaced — the Xero
// SDK, axios (the delivery address and the attachments), the token cache that
// would hold a real sign-in, and Slack.
//
// What is checked is what reaches Xero in the invoice body and what the row
// says afterwards. How a contact is looked up is contacts.js's business, so
// the SDK's contact search answers with the contact whatever it is asked.
const mockApi = {
  createInvoices:        jest.fn(),
  updateInvoice:         jest.fn(),
  getContacts:           jest.fn(),
  getContact:            jest.fn(),
  createContacts:        jest.fn(),
  getInvoiceAttachments: jest.fn(),
  getBrandingThemes:     jest.fn(),
  getTaxRates:           jest.fn(),
  getOrganisations:      jest.fn(),
  getAccounts:           jest.fn(),
};
jest.mock('xero-node', () => ({ AccountingApi: jest.fn(() => mockApi) }));
jest.mock('axios', () => ({ put: jest.fn(), post: jest.fn() }));
const mockTenants = { list: [] };
jest.mock('../utils/token-cache', () => ({
  forUser: () => ({ getValidToken: async () => 'access-token', getAllTenants: () => mockTenants.list }),
  getPersistedTenants: () => [],
}));
jest.mock('./reconnect', () => ({ reconnectXero: jest.fn(async () => {}) }));
jest.mock('../utils/notify', () => ({
  ...jest.requireActual('../utils/notify'),
  notifyError:          jest.fn(async () => {}),
  notifyInvoiceCreated: jest.fn(async () => {}),
}));

const axios = require('axios');
let users, invoiceStore, settings, pdfStore, logger, handler, xeroInvoices;
let userId, store, defaults, tenantA, tenantB, n = 0;

// A Singapore org: one 9% rate for purchases, one for sales.
const TAX_RATES = [
  { taxType: 'TX', name: 'Standard-Rated Purchases', status: 'ACTIVE', displayTaxRate: 9, canApplyToExpenses: true,  canApplyToRevenue: false },
  { taxType: 'SR', name: 'Standard-Rated Supplies',  status: 'ACTIVE', displayTaxRate: 9, canApplyToExpenses: false, canApplyToRevenue: true },
];
const CONTACTS = {
  'Acme Corp':   { contactID: 'contact-acme',   name: 'Acme Corp',   contactStatus: 'ACTIVE' },
  'Globex Pte':  { contactID: 'contact-globex', name: 'Globex Pte',  contactStatus: 'ACTIVE' },
};
const answerContact = name => mockApi.getContacts.mockResolvedValue({ body: { contacts: [CONTACTS[name]] } });

// Each send is the body's one invoice; the rest of the argument list is
// the SDK's own.
const created = () => mockApi.createInvoices.mock.calls.map(c => ({ tenantId: c[0], invoice: c[1].invoices[0], key: c[4] }));
const updated = () => mockApi.updateInvoice.mock.calls.map(c => ({ tenantId: c[0], xeroId: c[1], invoice: c[2].invoices[0] }));

const bill = (extra = {}) => ({
  invoiceType: 'ACCPAY', vendorName: 'Acme Corp', contactName: 'Acme Corp',
  invoiceNumber: 'A-100', invoiceDate: '2026-09-01', dueDate: '2026-09-30',
  totalAmount: 109, subTotal: 100, taxAmount: 9, currency: 'SGD',
  lineItems: [{ description: 'Widgets', unitAmount: 60 }, { description: 'Gadgets', unitAmount: 40 }],
  ...extra,
});
const sale = (extra = {}) => bill({
  invoiceType: 'ACCREC', vendorName: 'Globex Pte', contactName: 'Globex Pte', invoiceNumber: 'INV-7',
  lineItems: [{ description: 'Consulting', unitAmount: 100 }], ...extra,
});
const addRow = (id, extra = {}) => store.add({
  id, status: 'pending', processedAt: new Date().toISOString(), ...bill(), ...extra,
});
const xeroValidationError = message => new Error(JSON.stringify({
  response: { statusCode: 400, body: { Elements: [{ ValidationErrors: [{ Message: message }] }] } },
}));

beforeAll(() => {
  require('../db/migrate').run();
  users        = require('../utils/users');
  invoiceStore = require('../utils/invoice-store');
  settings     = require('../utils/settings-store');
  pdfStore     = require('../utils/pdf-store');
  logger       = require('../utils/logger');
  handler      = require('../utils/invoice-handler');
  xeroInvoices = require('./invoices');
});

beforeEach(async () => {
  // The code sets accessToken on the shared instance; only the methods reset.
  for (const fn of Object.values(mockApi)) if (jest.isMockFunction(fn)) fn.mockReset();
  axios.put.mockReset().mockResolvedValue({ status: 200, data: {} });
  axios.post.mockReset().mockResolvedValue({ status: 200, data: {} });

  const u = await users.createUser(`posting${Date.now()}-${n++}@test.com`, 'password123', 'user');
  userId   = u.id;
  store    = invoiceStore.forUser(userId);
  defaults = users.getUserDefaults(userId);

  // Two connected orgs, the second the default. Fresh ids per test, so the
  // per-org caches in xero/invoices.js (tax rates, base currency, themes)
  // never carry an answer from one test into the next.
  tenantA = `org-a-${n}`;
  tenantB = `org-b-${n}`;
  mockTenants.list = [{ tenant_id: tenantA, tenant_name: 'Org A' }, { tenant_id: tenantB, tenant_name: 'Org B' }];
  settings.forUser(userId).set({ defaultTenantId: tenantB });

  answerContact('Acme Corp');
  mockApi.getContact.mockResolvedValue({ body: { contacts: [CONTACTS['Acme Corp']] } });
  mockApi.createContacts.mockRejectedValue(new Error('this test expects the contact to be found'));
  mockApi.createInvoices.mockImplementation(async () => ({ body: { invoices: [{ invoiceID: 'xero-new-1' }] } }));
  mockApi.updateInvoice.mockImplementation(async (_t, id) => ({ body: { invoices: [{ invoiceID: id }] } }));
  mockApi.getInvoiceAttachments.mockResolvedValue({ body: { attachments: [] } });
  mockApi.getBrandingThemes.mockResolvedValue({ body: { brandingThemes: [{ name: 'Standard', brandingThemeID: 'theme-std' }] } });
  mockApi.getTaxRates.mockResolvedValue({ body: { taxRates: TAX_RATES } });
  mockApi.getOrganisations.mockResolvedValue({ body: { organisations: [{ baseCurrency: 'SGD' }] } });
  mockApi.getAccounts.mockResolvedValue({ body: { accounts: [] } });
});

describe('createDraftInvoice — the body Xero is sent', () => {
  test('a bill: ACCPAY, DRAFT, the contact, its lines with the matched tax, Exclusive, its currency — and no theme', async () => {
    const res = await xeroInvoices.createDraftInvoice(userId, tenantA, bill({ _invoiceStoreId: 'row-b1', brandingThemeName: 'Standard' }));
    expect(res).toEqual({ invoiceID: 'xero-new-1' });

    const [sent] = created();
    expect(created()).toHaveLength(1);
    expect(sent.tenantId).toBe(tenantA);
    expect(sent.key).toMatch(/^create-row-b1-[0-9a-f]{16}$/);
    expect(sent.invoice).toMatchObject({
      type:            'ACCPAY',
      status:          'DRAFT',
      contact:         { contactID: 'contact-acme' },
      date:            '2026-09-01',
      dueDate:         '2026-09-30',
      invoiceNumber:   'A-100',
      currencyCode:    'SGD',
      lineAmountTypes: 'Exclusive',
    });
    expect(sent.invoice.lineItems).toEqual([
      { description: 'Widgets', accountCode: defaults.accountCode.bill, taxType: 'TX', quantity: 1, unitAmount: 60 },
      { description: 'Gadgets', accountCode: defaults.accountCode.bill, taxType: 'TX', quantity: 1, unitAmount: 40 },
    ]);
    // A bill is the supplier's document: it never carries our branding theme,
    // and the org's own currency takes no exchange rate.
    expect(sent.invoice).not.toHaveProperty('brandingThemeID');
    expect(sent.invoice).not.toHaveProperty('currencyRate');
    expect(mockApi.getBrandingThemes).not.toHaveBeenCalled();
    expect(mockApi.updateInvoice).not.toHaveBeenCalled();
  });

  test('a sales invoice: ACCREC with the branding theme, the sales tax type, and Inclusive kept', async () => {
    answerContact('Globex Pte');
    await xeroInvoices.createDraftInvoice(userId, tenantA, sale({
      brandingThemeName: 'standard', lineAmountTypes: 'Inclusive', lineItems: [{ description: 'Consulting', unitAmount: 109 }],
    }));
    const [{ invoice }] = created();
    expect(invoice).toMatchObject({
      type: 'ACCREC', status: 'DRAFT', contact: { contactID: 'contact-globex' },
      brandingThemeID: 'theme-std', lineAmountTypes: 'Inclusive', currencyCode: 'SGD',
    });
    // Inclusive lines already hold the tax: no flat tax line beside them.
    expect(invoice.lineItems).toEqual([
      { description: 'Consulting', accountCode: defaults.accountCode.invoice, taxType: 'SR', quantity: 1, unitAmount: 109 },
    ]);
  });

  test("a foreign-currency document carries its exchange rate; one in the org's currency does not", async () => {
    await xeroInvoices.createDraftInvoice(userId, tenantA, bill({ currency: 'USD', currencyRate: 1.35 }));
    await xeroInvoices.createDraftInvoice(userId, tenantB, bill({ currency: 'SGD', currencyRate: 1.35 }));
    const [usd, sgd] = created();
    expect(usd.invoice).toMatchObject({ currencyCode: 'USD', currencyRate: 1.35 });
    expect(sgd.invoice.currencyCode).toBe('SGD');
    expect(sgd.invoice).not.toHaveProperty('currencyRate');
  });

  test('a delivery address Xero refuses is not fatal: the draft stands', async () => {
    axios.post.mockRejectedValue(Object.assign(new Error('Request failed with status code 400'), {
      response: { status: 400, data: { Message: 'Address line too long' } },
    }));
    const warn = jest.spyOn(logger, 'warn');
    try {
      await expect(xeroInvoices.createDraftInvoice(userId, tenantA, bill({ contactAddress: '1 Long Road' })))
        .resolves.toEqual({ invoiceID: 'xero-new-1' });
      expect(axios.post).toHaveBeenCalledWith(
        expect.stringMatching(/\/Invoices\/xero-new-1$/),
        { InvoiceID: 'xero-new-1', InvoiceAddresses: [{ InvoiceAddressType: 'TO', AddressLine1: '1 Long Road' }] },
        expect.anything(),
      );
      expect(warn).toHaveBeenCalledWith('Delivery address not set', { error: 'Address line too long' });
    } finally { warn.mockRestore(); }
  });
});

describe('updateDraftInvoice — a correction', () => {
  test('sends the same body to the invoice already in Xero, and never creates one', async () => {
    const res = await xeroInvoices.updateDraftInvoice(userId, tenantA, 'xero-existing-9', bill({ _invoiceStoreId: 'row-u1', subTotal: 100, taxAmount: 9 }));
    expect(res).toEqual({ invoiceID: 'xero-existing-9' });
    expect(mockApi.createInvoices).not.toHaveBeenCalled();

    const [sent] = updated();
    expect(updated()).toHaveLength(1);
    expect(sent).toMatchObject({ tenantId: tenantA, xeroId: 'xero-existing-9' });
    expect(sent.invoice).toMatchObject({
      type: 'ACCPAY', status: 'DRAFT', contact: { contactID: 'contact-acme' },
      invoiceNumber: 'A-100', currencyCode: 'SGD', lineAmountTypes: 'Exclusive',
    });
    expect(sent.invoice.lineItems.map(li => [li.description, li.unitAmount, li.taxType])).toEqual([['Widgets', 60, 'TX'], ['Gadgets', 40, 'TX']]);
    expect(sent.invoice).not.toHaveProperty('brandingThemeID');
  });

  test('a sales correction keeps its branding theme', async () => {
    answerContact('Globex Pte');
    await xeroInvoices.updateDraftInvoice(userId, tenantA, 'xero-sale-3', sale({ brandingThemeName: 'Standard' }));
    expect(updated()[0].invoice).toMatchObject({ type: 'ACCREC', brandingThemeID: 'theme-std' });
    expect(mockApi.createInvoices).not.toHaveBeenCalled();
  });

  test('a refused address on a correction is not fatal either', async () => {
    axios.post.mockRejectedValue(new Error('socket hang up'));
    await expect(xeroInvoices.updateDraftInvoice(userId, tenantA, 'xero-existing-4', bill({ contactAddress: '2 Short St' })))
      .resolves.toEqual({ invoiceID: 'xero-existing-4' });
    expect(mockApi.createInvoices).not.toHaveBeenCalled();
  });

  test('a correction Xero refuses is thrown — and still nothing is created in its place', async () => {
    mockApi.updateInvoice.mockRejectedValue(xeroValidationError('Invoice not of valid status for modification'));
    await expect(xeroInvoices.updateDraftInvoice(userId, tenantA, 'xero-approved-1', bill()))
      .rejects.toThrow(/Invoice not of valid status for modification/);
    expect(mockApi.createInvoices).not.toHaveBeenCalled();
  });
});

describe('submitInvoiceToXero — the row through a send, two orgs connected and a default', () => {
  // The row's status at the moment Xero is called.
  const statusDuringSend = id => {
    const seen = [];
    const record = () => seen.push(store.getById(id).status);
    mockApi.createInvoices.mockImplementation(async () => { record(); return { body: { invoices: [{ invoiceID: 'xero-new-1' }] } }; });
    mockApi.updateInvoice.mockImplementation(async (_t, xeroId) => { record(); return { body: { invoices: [{ invoiceID: xeroId }] } }; });
    return seen;
  };

  test('pending → submitting → posted, sent once and only to the default org, with both ids stored', async () => {
    addRow('send-1');
    const seen = statusDuringSend('send-1');
    await expect(handler.submitInvoiceToXero(userId, 'send-1')).resolves.toBe('xero-new-1');

    expect(seen).toEqual(['submitting']);
    expect(created().map(c => c.tenantId)).toEqual([tenantB]);
    expect(created()[0].invoice).toMatchObject({ type: 'ACCPAY', status: 'DRAFT', contact: { contactID: 'contact-acme' }, invoiceNumber: 'A-100' });
    expect(store.getById('send-1')).toMatchObject({ status: 'posted', xeroInvoiceId: 'xero-new-1', xeroTenantId: tenantB, errorMsg: null });
  });

  test('submitting → error with Xero\'s own reason when Xero refuses a new invoice', async () => {
    addRow('send-2');
    const seen = statusDuringSend('send-2');
    mockApi.createInvoices.mockImplementation(async () => { seen.push(store.getById('send-2').status); throw xeroValidationError("Account code '999' is not a valid code for this document."); });

    await expect(handler.submitInvoiceToXero(userId, 'send-2')).rejects.toThrow();
    expect(seen).toEqual(['submitting']);
    expect(store.getById('send-2')).toMatchObject({
      status: 'error', errorMsg: "Account code '999' is not a valid code for this document.", xeroInvoiceId: null,
    });
  });

  test('a row already in Xero is updated in its own org, never created again — even when the update fails', async () => {
    addRow('fix-1', { status: 'posted', xeroInvoiceId: 'xero-77', xeroTenantId: tenantA });
    const seen = statusDuringSend('fix-1');
    await expect(handler.submitInvoiceToXero(userId, 'fix-1')).resolves.toBe('xero-77');
    expect(seen).toEqual(['submitting']);
    expect(updated().map(u => [u.tenantId, u.xeroId])).toEqual([[tenantA, 'xero-77']]);
    expect(store.getById('fix-1')).toMatchObject({ status: 'posted', xeroInvoiceId: 'xero-77', xeroTenantId: tenantA });

    mockApi.updateInvoice.mockRejectedValue(xeroValidationError('Invoice not of valid status for modification'));
    await expect(handler.submitInvoiceToXero(userId, 'fix-1')).rejects.toThrow();
    expect(mockApi.createInvoices).not.toHaveBeenCalled();
    expect(store.getById('fix-1')).toMatchObject({
      status: 'posted', xeroInvoiceId: 'xero-77', errorMsg: 'Invoice not of valid status for modification',
    });
  });

  test('a refused address and a refused PDF still end posted, with the attachment noted on the row', async () => {
    addRow('send-3', { contactAddress: '1 Long Road', hasPdf: true, pdfFilename: 'acme-a-100.pdf' });
    pdfStore.forUser(userId).save('send-3', Buffer.from('%PDF-1.4 test bill'));
    axios.post.mockRejectedValue(new Error('Address rejected'));
    axios.put.mockRejectedValue(Object.assign(new Error('Request failed with status code 500'), {
      response: { status: 500, data: { Message: 'Xero is having a moment' } },
    }));

    await expect(handler.submitInvoiceToXero(userId, 'send-3')).resolves.toBe('xero-new-1');
    expect(axios.put).toHaveBeenCalledTimes(1);
    const [url, bytes, opts] = axios.put.mock.calls[0];
    expect(decodeURIComponent(url)).toMatch(/\/Invoices\/xero-new-1\/Attachments\/acme-a-100\.pdf$/);
    expect(bytes.toString()).toBe('%PDF-1.4 test bill');
    expect(opts.headers['Content-Type']).toBe('application/pdf');
    expect(store.getById('send-3')).toMatchObject({
      status: 'posted', xeroInvoiceId: 'xero-new-1', xeroTenantId: tenantB,
      errorMsg: 'Sent to Xero, but the attachment failed: Xero is having a moment.',
    });
  });
});
