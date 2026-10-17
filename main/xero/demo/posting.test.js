// Posting from a demo account, as the app posts: xero/invoices.js and
// xero/contacts.js as they are, against the facade, then the status
// read-back (xero/status-sync.js) finding the document in the Demo Company.
// Real users, token cache, invoice store and database; the SDK is never
// built, since a demo account's token is never a Xero token.
jest.mock('../../utils/notify', () => ({
  ...jest.requireActual('../../utils/notify'),
  notifyError: jest.fn(async () => {}), notifyInvoiceCreated: jest.fn(async () => {}),
}));

require('../../db/migrate').run();
const users        = require('../../utils/users');
const invoiceStore = require('../../utils/invoice-store');
const invoices     = require('../invoices');
const contacts     = require('../contacts');
const statusSync   = require('../status-sync');
const { demoApiFor, DEMO_TENANT } = require('./api');

const T = DEMO_TENANT.tenantId;
const REAL = ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance'];
let demo, store, facade;

beforeAll(async () => {
  demo   = await users.createUser(`demo-posting-${Date.now()}@test.com`, 'password123', 'user', { demo: true });
  store  = invoiceStore.forUser(demo.id);
  facade = demoApiFor(demo.id);
  jest.useFakeTimers({ now: new Date('2026-10-17T06:00:00Z'), doNotFake: REAL });
});
afterAll(() => jest.useRealTimers());

const bill = (extra = {}) => ({
  invoiceType: 'ACCPAY', vendorName: 'Pacific Trade Distributors Pte Ltd', contactName: 'Pacific Trade Distributors Pte Ltd',
  invoiceNumber: 'PTD-9001', invoiceDate: '2026-10-10', dueDate: '2026-11-09', description: 'Stock | October order',
  totalAmount: 1090, subTotal: 1000, taxAmount: 90, currency: 'SGD', accountCode: '310',
  lineItems: [{ description: 'Fittings', unitAmount: 600 }, { description: 'Control units', unitAmount: 400 }],
  ...extra,
});

describe('contacts', () => {
  test('a supplier the Demo Company already has is found, not made again; a new one is made once', async () => {
    const found = await contacts.resolveContact(demo.id, T, { vendorName: 'pacific trade distributors pte ltd', invoiceType: 'ACCPAY' });
    expect(found).toMatchObject({ contactID: expect.any(String), accountsPayableTaxType: 'INPUT', purchasesDefaultAccountCode: '310' });
    const before = (await facade.getContacts(T, undefined, undefined, undefined, undefined, undefined, true, false, 'pacific trade')).body.contacts;
    expect(before).toHaveLength(1);
    expect(before[0].contactID).toBe(found.contactID);

    const made = await contacts.resolveContact(demo.id, T, { vendorName: 'Acme Corp', email: 'ap@acme.example', invoiceType: 'ACCPAY' });
    expect(made.contactID).toEqual(expect.any(String));
    const again = await contacts.resolveContact(demo.id, T, { vendorName: 'ACME CORP', invoiceType: 'ACCPAY' });
    expect(again.contactID).toBe(made.contactID);
    const listed = (await facade.getContacts(T, undefined, undefined, undefined, undefined, undefined, true, false, 'acme corp')).body.contacts;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: 'Acme Corp', isSupplier: true, isCustomer: false, emailAddress: 'ap@acme.example' });
  });
});

describe('posting and the status read-back', () => {
  test('a bill goes to the Demo Company as a draft with its tax matched to the org\'s rate, and the status sync reads it back as it changes', async () => {
    const created = await invoices.createDraftInvoice(demo.id, T, { ...bill(), _invoiceStoreId: 'p1' });
    expect(created).toMatchObject({
      invoiceID: expect.any(String), invoiceNumber: 'PTD-9001', type: 'ACCPAY', status: 'DRAFT', total: 1090, subTotal: 1000, totalTax: 90, amountDue: 1090, amountPaid: 0,
      contact: { name: 'Pacific Trade Distributors Pte Ltd' }, reference: 'October order',
    });
    expect(created.lineItems.map(l => [l.description, l.accountCode, l.taxType, l.lineAmount])).toEqual([['Fittings', '310', 'INPUT', 600], ['Control units', '310', 'INPUT', 400]]);

    store.add({ id: 'p1', status: 'posted', ...bill(), xeroInvoiceId: created.invoiceID, xeroTenantId: T, processedAt: new Date().toISOString() });
    expect(await statusSync.syncUser(demo.id)).toEqual({ checked: 1, updated: 1, failedTenants: 0 });
    expect(store.getById('p1')).toMatchObject({ xeroStatus: 'DRAFT', xeroAmountDue: 1090, xeroAmountPaid: 0, xeroPaidOn: null });
    expect(statusSync.repostRefusal(store.getById('p1'))).toBeNull();

    // Approved in the Demo Company some minutes later: the next read, with
    // If-Modified-Since, brings it back and the row follows.
    jest.setSystemTime(new Date('2026-10-17T06:20:00Z'));
    await facade.updateInvoice(T, created.invoiceID, { invoices: [{ status: 'AUTHORISED' }] });
    jest.setSystemTime(new Date('2026-10-17T06:30:00Z'));
    expect(await statusSync.syncUser(demo.id)).toEqual({ checked: 1, updated: 1, failedTenants: 0 });
    expect(store.getById('p1')).toMatchObject({ xeroStatus: 'AUTHORISED', xeroAmountDue: 1090 });
    expect(statusSync.repostRefusal(store.getById('p1'))).toBe('Approved in Xero, so it can no longer be changed from here');

    // Nothing changed since: confirmed, not updated.
    jest.setSystemTime(new Date('2026-10-17T07:00:00Z'));
    expect(await statusSync.syncUser(demo.id)).toEqual({ checked: 1, updated: 0, failedTenants: 0 });
  });

  test('a correction updates the draft in place', async () => {
    const created = await invoices.createDraftInvoice(demo.id, T, { ...bill({ invoiceNumber: 'PTD-9002' }), _invoiceStoreId: 'p2' });
    const updated = await invoices.updateDraftInvoice(demo.id, T, created.invoiceID, {
      ...bill({ invoiceNumber: 'PTD-9002', totalAmount: 545, subTotal: 500, taxAmount: 45, lineItems: [{ description: 'Fittings', unitAmount: 500 }] }), _invoiceStoreId: 'p2',
    });
    expect(updated).toMatchObject({ invoiceID: created.invoiceID, status: 'DRAFT', total: 545, totalTax: 45 });
    const [listed] = (await facade.getInvoices(T, undefined, undefined, undefined, [created.invoiceID], undefined, undefined, undefined, undefined, undefined, undefined, undefined, true)).body.invoices;
    expect(listed).toMatchObject({ total: 545, amountDue: 545 });
  });

  test('a sales invoice with a branding theme, to a customer the Demo Company has', async () => {
    const created = await invoices.createDraftInvoice(demo.id, T, {
      invoiceType: 'ACCREC', contactName: 'Harbourline Logistics Pte Ltd', vendorName: 'Harbourline Logistics Pte Ltd', invoiceNumber: 'INV-NEW-1',
      invoiceDate: '2026-10-16', dueDate: '2026-11-15', description: 'Consulting', totalAmount: 2180, subTotal: 2000, taxAmount: 180, currency: 'SGD',
      brandingThemeName: 'Standard', lineItems: [{ description: 'Consulting services', unitAmount: 2000 }], _invoiceStoreId: 'p3',
    });
    expect(created).toMatchObject({ type: 'ACCREC', status: 'DRAFT', total: 2180, brandingThemeID: expect.any(String), contact: { name: 'Harbourline Logistics Pte Ltd' } });
    expect(created.lineItems[0]).toMatchObject({ accountCode: '200', taxType: 'OUTPUT', taxAmount: 180 });
  });

  test('a document in a currency the Demo Company is not subscribed to is refused, not relabelled', async () => {
    await expect(invoices.createDraftInvoice(demo.id, T, { ...bill({ invoiceNumber: 'PTD-9003', currency: 'USD' }), _invoiceStoreId: 'p4' }))
      .rejects.toThrow(/not subscribed to USD/);
  });
});
