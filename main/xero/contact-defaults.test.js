// The account a line is posted to: the document's own when it has one, then
// the default the contact carries in Xero (purchases for a bill or claim,
// sales for an invoice), then Setup's default. Nothing here reaches Xero: the
// SDK class, the contact lookup and the stores are replaced.
const mockApi = {
  createInvoices:        jest.fn(),
  getInvoiceAttachments: jest.fn(),
  getBrandingThemes:     jest.fn(),
  getTaxRates:           jest.fn(),
  getOrganisations:      jest.fn(),
  getAccounts:           jest.fn(),
};
jest.mock('xero-node', () => ({ AccountingApi: jest.fn(() => mockApi) }));
jest.mock('axios', () => ({ put: jest.fn(), post: jest.fn(async () => ({})) }));
jest.mock('./contacts', () => ({ ...jest.requireActual('./contacts'), resolveContact: jest.fn() }));
jest.mock('../utils/token-cache', () => ({ forUser: () => ({ getValidToken: async () => 'tok' }) }));
jest.mock('../utils/pdf-store', () => ({ forUser: () => ({ getPath: () => null }) }));
jest.mock('../utils/receipt-store', () => ({ forUser: () => ({ read: () => null }), extensionFor: () => null }));
jest.mock('../utils/users', () => ({
  getUserConfig: () => ({}),
  defaultsFrom:  () => ({ zeroTaxRate: 'NONE', accountCode: { claim: '429', bill: '429', invoice: '200' }, currency: 'SGD' }),
}));
jest.mock('../utils/invoice-store', () => ({ forUser: () => ({ addPostingNote: jest.fn() }) }));

const { resolveContact } = require('./contacts');
const { createDraftInvoice, buildLineItems } = require('./invoices');

let seq = 0;
const newTenant = () => `tenant-defaults-${++seq}`;
const doc = (extra = {}) => ({
  _invoiceStoreId: `row-${seq}`, invoiceType: 'ACCPAY', vendorName: 'Landlord Pte Ltd', contactName: 'Landlord Pte Ltd',
  invoiceNumber: 'R-1', invoiceDate: '2026-09-01', dueDate: '2026-09-30', currency: 'SGD',
  totalAmount: 2000, subTotal: 2000, taxAmount: 0,
  lineItems: [{ description: 'September rent', unitAmount: 2000 }], ...extra,
});
const sentLines = () => mockApi.createInvoices.mock.calls[0][1].invoices[0].lineItems;
const CONTACT = {
  contactID: 'c-landlord', purchasesDefaultAccountCode: '469', salesDefaultAccountCode: '201',
  accountsPayableTaxType: null, accountsReceivableTaxType: null,
};

beforeEach(() => {
  for (const fn of Object.values(mockApi)) if (jest.isMockFunction(fn)) fn.mockReset();
  mockApi.createInvoices.mockResolvedValue({ body: { invoices: [{ invoiceID: 'xero-1' }] } });
  mockApi.getInvoiceAttachments.mockResolvedValue({ body: { attachments: [] } });
  mockApi.getBrandingThemes.mockResolvedValue({ body: { brandingThemes: [] } });
  mockApi.getTaxRates.mockResolvedValue({ body: { taxRates: [] } });
  mockApi.getOrganisations.mockResolvedValue({ body: { organisations: [{ baseCurrency: 'SGD' }] } });
  mockApi.getAccounts.mockResolvedValue({ body: { accounts: [] } });
  resolveContact.mockReset().mockResolvedValue(CONTACT);
});

test('a bill with no account of its own goes to the supplier\'s purchases default', async () => {
  await createDraftInvoice('u1', newTenant(), doc({ accountCode: '' }));
  expect(sentLines().map(l => l.accountCode)).toEqual(['469']);
});

test('the document\'s own account still wins over the contact\'s default', async () => {
  await createDraftInvoice('u1', newTenant(), doc({ accountCode: '310' }));
  expect(sentLines().map(l => l.accountCode)).toEqual(['310']);
});

test('a sales invoice uses the customer\'s sales default, not the purchases one', async () => {
  await createDraftInvoice('u1', newTenant(), doc({ invoiceType: 'ACCREC', accountCode: null }));
  expect(sentLines().map(l => l.accountCode)).toEqual(['201']);
});

test('a contact with no default falls back to Setup\'s default', async () => {
  resolveContact.mockResolvedValue({ contactID: 'c-new', purchasesDefaultAccountCode: null, salesDefaultAccountCode: null });
  await createDraftInvoice('u1', newTenant(), doc({ accountCode: undefined }));
  expect(sentLines().map(l => l.accountCode)).toEqual(['429']);
});

test('buildLineItems: the contact default fills every line, including the single fallback line', async () => {
  const api = { getTaxRates: jest.fn(async () => ({ body: { taxRates: [] } })) };
  const lines = await buildLineItems(
    { lineItems: [], description: 'Rent', subTotal: 100, taxAmount: 0, totalAmount: 100 },
    {}, api, newTenant(), { contactAccountCode: '469' });
  expect(lines).toEqual([{ description: 'Rent', quantity: 1, unitAmount: 100, accountCode: '469', taxType: 'NONE' }]);
});
