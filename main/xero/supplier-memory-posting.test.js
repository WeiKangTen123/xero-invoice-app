// The account a bill is posted with, end to end: stored by the real intake
// handler, sent by the real submit path and built by the real buildLineItems.
// Intake no longer writes Setup's default onto the record, so the Xero
// contact's own default can apply; a record with nothing of its own must
// still land on Setup's default, never on no account. Nothing reaches Xero:
// the SDK class, axios, the contact lookup and the token cache are replaced,
// and the first test proves they are before anything is sent.
const mockApi = {
  createInvoices:        jest.fn(),
  getInvoiceAttachments: jest.fn(),
  getBrandingThemes:     jest.fn(),
  getTaxRates:           jest.fn(),
  getOrganisations:      jest.fn(),
  getAccounts:           jest.fn(),
};
jest.mock('xero-node', () => ({ AccountingApi: jest.fn(() => mockApi) }));
jest.mock('axios', () => ({ put: jest.fn(), post: jest.fn(async () => ({})), get: jest.fn() }));
jest.mock('./contacts', () => ({ ...jest.requireActual('./contacts'), resolveContact: jest.fn() }));
jest.mock('../utils/token-cache', () => {
  const mockState = { tenants: [], persisted: [] };
  return {
    forUser: () => ({ getAllTenants: () => mockState.tenants, getValidToken: async () => 'tok' }),
    getPersistedTenants: () => mockState.persisted,
    _state: mockState,
  };
});
jest.mock('./reconnect', () => ({ reconnectXero: jest.fn(async () => {}) }));
jest.mock('../utils/notify', () => ({ notifyError: jest.fn(async () => {}), notifyInvoiceCreated: jest.fn(async () => {}) }));

let handlerMod, store, users, tokenCache, resolveContact, userId, n = 0, seq = 0;

const CONTACT_WITH_DEFAULT = { contactID: 'c-1', purchasesDefaultAccountCode: '469', salesDefaultAccountCode: '201' };
const CONTACT_WITHOUT      = { contactID: 'c-2', purchasesDefaultAccountCode: null, salesDefaultAccountCode: null };

beforeEach(async () => {
  jest.resetModules();
  require('../db/migrate').run();
  handlerMod     = require('../utils/invoice-handler');
  users          = require('../utils/users');
  tokenCache     = require('../utils/token-cache');
  resolveContact = require('./contacts').resolveContact;
  const u = await users.createUser(`mempost${Date.now()}-${n++}@test.com`, 'password123', 'user');
  userId = u.id;
  store  = require('../utils/invoice-store').forUser(userId);
  // A tenant id per test: the tax-rate and branding caches are per tenant.
  const tenant = `t-mem-${++seq}`;
  tokenCache._state.tenants = [{ tenant_id: tenant, tenant_name: 'Only Co' }];
  tokenCache._state.persisted = [{ tenantId: tenant, tenantName: 'Only Co' }];

  for (const fn of Object.values(mockApi)) if (jest.isMockFunction(fn)) fn.mockReset();
  mockApi.createInvoices.mockImplementation(async () => ({ body: { invoices: [{ invoiceID: `xero-${++seq}` }] } }));
  mockApi.getInvoiceAttachments.mockResolvedValue({ body: { attachments: [] } });
  mockApi.getBrandingThemes.mockResolvedValue({ body: { brandingThemes: [] } });
  mockApi.getTaxRates.mockResolvedValue({ body: { taxRates: [] } });
  mockApi.getOrganisations.mockResolvedValue({ body: { organisations: [{ baseCurrency: 'SGD' }] } });
  mockApi.getAccounts.mockResolvedValue({ body: { accounts: [] } });
  resolveContact.mockReset().mockResolvedValue(CONTACT_WITH_DEFAULT);
});

// What the bill reader hands the handler: it reads no account from the page
// and puts the bill default (310 with nothing in Setup) on every document.
const parsed = (extra = {}) => ({
  vendorName: 'Landlord Pte Ltd', contactName: 'Landlord Pte Ltd', invoiceNumber: `R-${++seq}`, invoiceDate: '2026-09-01',
  totalAmount: 2000, subTotal: 2000, taxAmount: 0, currency: 'SGD', accountCode: '310', source: 'upload', invoiceType: 'ACCPAY',
  lineItems: [{ description: 'Rent', unitAmount: 2000, discountRate: 0 }], ...extra,
});

async function intakeAndSend(data) {
  const { id } = await handlerMod.createHandler(userId, { submitDelayMs: 1 }).onInvoiceEmail(data);
  mockApi.createInvoices.mockClear();
  await handlerMod.submitInvoiceToXero(userId, id);
  const sent = mockApi.createInvoices.mock.calls[0][1].invoices[0];
  return { id, accounts: sent.lineItems.filter(l => l.unitAmount).map(l => l.accountCode) };
}

test('the Xero SDK and axios are the mocks, before anything is sent', () => {
  expect(jest.isMockFunction(require('xero-node').AccountingApi)).toBe(true);
  expect(jest.isMockFunction(require('axios').put)).toBe(true);
  expect(jest.isMockFunction(require('axios').post)).toBe(true);
  expect(jest.isMockFunction(resolveContact)).toBe(true);
});

test('intake stores no account, and the contact\'s purchases default now applies', async () => {
  const { id, accounts } = await intakeAndSend(parsed());
  expect(store.getById(id)).toMatchObject({ status: 'posted', accountCode: '' });
  expect(accounts).toEqual(['469']);
});

test('a contact with no default still posts with Setup\'s default, never with nothing', async () => {
  resolveContact.mockResolvedValue(CONTACT_WITHOUT);
  const { accounts } = await intakeAndSend(parsed());
  expect(accounts).toEqual(['310']);
});

test('a configured Setup default is what that fallback uses', async () => {
  resolveContact.mockResolvedValue(CONTACT_WITHOUT);
  users.saveUserConfig(userId, { DEFAULT_ACCOUNT_CODE: '429' });
  const { id, accounts } = await intakeAndSend(parsed({ accountCode: '429' }));
  expect(store.getById(id).accountCode).toBe('');
  expect(accounts).toEqual(['429']);
});

test('supplier memory outranks the contact default; a document\'s own account outranks memory', async () => {
  const first = await intakeAndSend(parsed());
  store.update(first.id, { accountCode: '611' });   // a person re-coded the last bill

  const second = await intakeAndSend(parsed());
  expect(store.getById(second.id).prefilledFrom.accountCode.fromId).toBe(first.id);
  expect(second.accounts).toEqual(['611']);

  const third = await intakeAndSend(parsed({ accountCode: '720' }));
  expect(store.getById(third.id).prefilledFrom?.accountCode).toBeUndefined();
  expect(third.accounts).toEqual(['720']);
});

test('a sales invoice from the template posts to the customer\'s sales default, not the bill default the reader wrote', async () => {
  const { accounts } = await intakeAndSend(parsed({ invoiceType: 'ACCREC', source: 'email', vendorName: 'Customer Co', contactName: 'Customer Co' }));
  expect(accounts).toEqual(['201']);
  resolveContact.mockResolvedValue(CONTACT_WITHOUT);
  const again = await intakeAndSend(parsed({ invoiceType: 'ACCREC', source: 'email', vendorName: 'New Customer', contactName: 'New Customer' }));
  expect(again.accounts).toEqual(['200']);
});

test('a remembered company that has since been disconnected does not stop the send', async () => {
  const first = await intakeAndSend(parsed());
  const firstTenant = store.getById(first.id).xeroTenantId;
  const second = await handlerMod.createHandler(userId, { submitDelayMs: 1 }).onInvoiceEmail(parsed());
  expect(store.getById(second.id)).toMatchObject({ xeroTenantId: firstTenant });
  expect(store.getById(second.id).prefilledFrom.xeroTenantId.fromId).toBe(first.id);

  // The company is swapped for another before this one is sent.
  tokenCache._state.tenants = [{ tenant_id: 't-new', tenant_name: 'New Co' }];
  tokenCache._state.persisted = [{ tenantId: 't-new', tenantName: 'New Co' }];
  await handlerMod.submitInvoiceToXero(userId, second.id);
  const row = store.getById(second.id);
  expect(row).toMatchObject({ status: 'posted', xeroTenantId: 't-new' });
  expect(row.prefilledFrom?.xeroTenantId).toBeUndefined();
});
