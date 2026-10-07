// What goes to Xero in the invoice body, and what is said on the row when Xero's
// answer disagrees with the document. Nothing here reaches Xero: the SDK
// class, the contact lookup and the store are replaced.
const mockApi = {
  createInvoices:        jest.fn(),
  updateInvoice:         jest.fn(),
  getInvoiceAttachments: jest.fn(async () => ({ body: { attachments: [] } })),
  getBrandingThemes:     jest.fn(),
  getTaxRates:           jest.fn(),
  getOrganisations:      jest.fn(),
  getAccounts:           jest.fn(),
};
jest.mock('xero-node', () => ({ AccountingApi: jest.fn(() => mockApi) }));
jest.mock('axios', () => ({ put: jest.fn(), post: jest.fn(async () => ({})) }));
jest.mock('./contacts', () => ({
  ...jest.requireActual('./contacts'),
  resolveContact: jest.fn(),
}));
jest.mock('../utils/token-cache', () => ({ forUser: () => ({ getValidToken: async () => 'tok' }) }));
jest.mock('../utils/pdf-store', () => ({ forUser: () => ({ getPath: () => null }) }));
jest.mock('../utils/receipt-store', () => ({ forUser: () => ({ read: () => null }), extensionFor: () => null }));

let mockConfig = {};
jest.mock('../utils/users', () => ({
  getUserConfig: () => mockConfig,
  defaultsFrom:  () => ({ zeroTaxRate: 'NONE', accountCode: { claim: '429', bill: '429', invoice: '200' }, currency: 'SGD' }),
}));
const mockAddNote = jest.fn();
jest.mock('../utils/invoice-store', () => ({ forUser: () => ({ addPostingNote: mockAddNote }) }));

const { resolveContact } = require('./contacts');
const { createDraftInvoice, buildLineItems, resolveTaxType, NO_MERCHANT_MSG } = require('./invoices');

// Each test its own org, so the per-org caches in invoices.js never carry over.
let seq = 0;
const newTenant = () => `tenant-body-${++seq}`;

// A Singapore org: four expense-side rates at 9%.
const rate = (taxType, name, pct = 9) => ({
  taxType, name, status: 'ACTIVE', displayTaxRate: pct, canApplyToExpenses: true, canApplyToRevenue: false,
});
const SG_RATES = [rate('TX', 'Standard-Rated Purchases'), rate('IM', 'Imports'), rate('BL', 'Blocked Input Tax'), rate('TXCA', 'Customer Accounting Purchases')];
const OUTPUT = { taxType: 'SR', name: 'Standard-Rated Supplies', status: 'ACTIVE', displayTaxRate: 9, canApplyToExpenses: false, canApplyToRevenue: true };

const bill = (extra = {}) => ({
  _invoiceStoreId: 'row-1', invoiceType: 'ACCPAY', vendorName: 'Acme', contactName: 'Acme',
  contactEmail: 'ap@acme.test', invoiceNumber: 'A-1', invoiceDate: '2026-09-01', dueDate: '2026-09-30',
  totalAmount: 109, subTotal: 100, taxAmount: 9, currency: 'SGD',
  lineItems: [{ description: 'Widgets', unitAmount: 100 }], ...extra,
});
const claim = (extra = {}) => ({
  _invoiceStoreId: 'claim-1', invoiceType: 'EXPENSE', vendorName: 'FairPrice', invoiceNumber: 'EXP-1',
  invoiceDate: '2026-09-01', dueDate: '2026-09-01', totalAmount: 12.5, subTotal: 12.5, taxAmount: 0,
  currency: 'SGD', lineItems: [], description: 'Pantry snacks', ...extra,
});
const sentBody = () => mockApi.createInvoices.mock.calls[0][1].invoices[0];

beforeEach(() => {
  for (const fn of Object.values(mockApi)) if (jest.isMockFunction(fn)) fn.mockReset();
  mockApi.createInvoices.mockResolvedValue({ body: { invoices: [{ invoiceID: 'xero-1' }] } });
  mockApi.getInvoiceAttachments.mockResolvedValue({ body: { attachments: [] } });
  mockApi.getBrandingThemes.mockResolvedValue({ body: { brandingThemes: [{ name: 'Special Projects', brandingThemeID: 'theme-9' }] } });
  mockApi.getTaxRates.mockResolvedValue({ body: { taxRates: [...SG_RATES, OUTPUT] } });
  mockApi.getOrganisations.mockResolvedValue({ body: { organisations: [{ baseCurrency: 'SGD' }] } });
  mockApi.getAccounts.mockResolvedValue({ body: { accounts: [] } });
  resolveContact.mockReset().mockResolvedValue({ contactID: 'contact-1' });
  mockAddNote.mockReset();
  mockConfig = {};
});

describe('tax inclusive / exclusive and the branding theme', () => {
  test('a row stored as Inclusive is sent as Inclusive; anything else as Exclusive', async () => {
    await createDraftInvoice('u1', newTenant(), bill({ lineAmountTypes: 'Inclusive', totalAmount: 100 }));
    expect(sentBody().lineAmountTypes).toBe('Inclusive');
    mockApi.createInvoices.mockClear();
    await createDraftInvoice('u1', newTenant(), bill({ lineAmountTypes: null }));
    expect(sentBody().lineAmountTypes).toBe('Exclusive');
  });

  test('a sales invoice\'s branding theme is looked up and sent; a bill sends none', async () => {
    await createDraftInvoice('u1', newTenant(), bill({ invoiceType: 'ACCREC', brandingThemeName: 'special projects' }));
    expect(sentBody().brandingThemeID).toBe('theme-9');
    mockApi.createInvoices.mockClear();
    await createDraftInvoice('u1', newTenant(), bill({ brandingThemeName: 'Special Projects' }));
    expect(sentBody().brandingThemeID).toBeUndefined();
  });

  test('Inclusive lines already hold the tax: no flat tax line, and a single line carries the total', async () => {
    const api = { getTaxRates: jest.fn(async () => ({ body: { taxRates: [] } })) };
    const lines = await buildLineItems(
      { lineItems: [{ description: 'A', unitAmount: 1090 }], subTotal: 1000, taxAmount: 90, totalAmount: 1090, lineAmountTypes: 'Inclusive', accountCode: '400' },
      {}, api, newTenant());
    expect(lines).toHaveLength(1);
    expect(lines[0].unitAmount).toBe(1090);

    const single = await buildLineItems(
      { lineItems: [], description: 'Dinner', subTotal: 100, taxAmount: 9, totalAmount: 109, lineAmountTypes: 'Inclusive', accountCode: '400' },
      {}, { getTaxRates: jest.fn(async () => ({ body: { taxRates: SG_RATES } })) }, newTenant());
    expect(single).toEqual([{ description: 'Dinner', quantity: 1, unitAmount: 109, accountCode: '400', taxType: 'TX' }]);
  });

  test('a row with no itemised lines gets one line, from the total when there is no subtotal', async () => {
    const api = { getTaxRates: jest.fn(async () => ({ body: { taxRates: [] } })) };
    const lines = await buildLineItems({ lineItems: [], description: 'Taxi', subTotal: 0, taxAmount: 0, totalAmount: 23.4, accountCode: '493' }, {}, api, newTenant());
    expect(lines).toEqual([{ description: 'Taxi', quantity: 1, unitAmount: 23.4, accountCode: '493', taxType: 'NONE' }]);
  });
});

describe('choosing between org tax rates at the same percentage', () => {
  const doc = { subTotal: 100, taxAmount: 9, invoiceType: 'ACCPAY' };
  const api = (accountTaxType = null) => ({
    getTaxRates: jest.fn(async () => ({ body: { taxRates: SG_RATES } })),
    getAccounts: jest.fn(async () => ({ body: { accounts: accountTaxType ? [{ code: '429', taxType: accountTaxType }] : [] } })),
  });

  test('the contact\'s default tax type wins over the first listed', async () => {
    const a = api('BL');
    const r = await resolveTaxType(a, newTenant(), doc, 'NONE', { contactTaxType: 'IM', accountCode: '429' });
    expect(r.taxType).toBe('IM');
    expect(a.getAccounts).not.toHaveBeenCalled();   // the contact settled it
  });

  test('with no contact default, the account\'s default tax type wins', async () => {
    const r = await resolveTaxType(api('TXCA'), newTenant(), doc, 'NONE', { accountCode: '429' });
    expect(r.taxType).toBe('TXCA');
  });

  test('a default that is not among the tied rates is ignored; the first listed stands', async () => {
    const r = await resolveTaxType(api('ZP'), newTenant(), doc, 'NONE', { contactTaxType: 'OUTPUT', accountCode: '429' });
    expect(r.taxType).toBe('TX');
  });

  test('the contact\'s Xero default reaches the lines of a real send', async () => {
    resolveContact.mockResolvedValue({ contactID: 'contact-1', accountsPayableTaxType: 'IM' });
    await createDraftInvoice('u1', newTenant(), bill());
    expect(sentBody().lineItems[0].taxType).toBe('IM');
  });

  test('a sales invoice reads the contact\'s receivable default, not its payable one', async () => {
    const r = await resolveTaxType({ getTaxRates: jest.fn(async () => ({ body: { taxRates: [OUTPUT] } })) },
      newTenant(), { ...doc, invoiceType: 'ACCREC' }, 'NONE', { contactTaxType: 'SR' });
    expect(r.taxType).toBe('SR');
  });
});

describe('Xero\'s total against the document\'s', () => {
  test('a difference over one cent leaves a note on the row; the document stays sent', async () => {
    mockApi.createInvoices.mockResolvedValue({ body: { invoices: [{ invoiceID: 'xero-1', total: 100 }] } });
    const created = await createDraftInvoice('u1', newTenant(), bill());
    expect(created.invoiceID).toBe('xero-1');
    expect(mockAddNote).toHaveBeenCalledWith('row-1',
      'Sent to Xero, but Xero\'s total is SGD 100.00 where the document says SGD 109.00. Check the lines and tax in Xero.');
  });

  test('within a cent is the same total, and nothing is noted', async () => {
    mockApi.createInvoices.mockResolvedValue({ body: { invoices: [{ invoiceID: 'xero-1', total: 109.01 }] } });
    await createDraftInvoice('u1', newTenant(), bill());
    expect(mockAddNote).not.toHaveBeenCalled();
  });
});

describe('expense claims: who the money is owed to', () => {
  test('with a payee name set, the claim goes to the claimant and the merchant moves into the lines', async () => {
    mockConfig = { CLAIM_PAYEE_NAME: '  Jane Tan ' };
    await createDraftInvoice('u1', newTenant(), claim({
      lineItems: [{ description: 'Chips', unitAmount: 5 }, { description: 'FairPrice drinks', unitAmount: 7.5 }],
      contactEmail: 'shop@fairprice.test',
    }));
    const details = resolveContact.mock.calls[0][2];
    expect(details.vendorName).toBe('Jane Tan');
    expect(details.email).toBeUndefined();           // the shop's email is not the claimant's
    const lines = sentBody().lineItems;
    expect(lines[0].description).toBe('FairPrice: Chips');
    expect(lines[1].description).toBe('FairPrice drinks');  // already names it
  });

  test('a claim with no itemised lines names the merchant in its single line', async () => {
    mockConfig = { CLAIM_PAYEE_NAME: 'Jane Tan' };
    await createDraftInvoice('u1', newTenant(), claim());
    expect(sentBody().lineItems).toEqual([expect.objectContaining({ description: 'FairPrice: Pantry snacks', unitAmount: 12.5 })]);
  });

  test('without a payee name, today\'s behaviour: the merchant is the contact', async () => {
    await createDraftInvoice('u1', newTenant(), claim());
    expect(resolveContact.mock.calls[0][2].vendorName).toBe('FairPrice');
    expect(sentBody().lineItems[0].description).toBe('Pantry snacks');
  });

  test('no merchant and no payee name: refused with a clear message, nothing sent', async () => {
    await expect(createDraftInvoice('u1', newTenant(), claim({ vendorName: null }))).rejects.toThrow(NO_MERCHANT_MSG);
    expect(resolveContact).not.toHaveBeenCalled();
    expect(mockApi.createInvoices).not.toHaveBeenCalled();
  });

  test('no merchant but a payee name: sent to the claimant', async () => {
    mockConfig = { CLAIM_PAYEE_NAME: 'Jane Tan' };
    await createDraftInvoice('u1', newTenant(), claim({ vendorName: null }));
    expect(resolveContact.mock.calls[0][2].vendorName).toBe('Jane Tan');
  });

  test('a bill with no name at all is refused the same way, not posted to a made-up contact', async () => {
    await expect(createDraftInvoice('u1', newTenant(), bill({ vendorName: null, contactName: '' }))).rejects.toThrow(/no supplier, customer or payee name/);
  });
});

describe('currency and the claim form\'s exchange rate', () => {
  test('a claim in another currency carries the form\'s rate as Xero\'s currencyRate', async () => {
    await createDraftInvoice('u1', newTenant(), claim({ currency: 'USD', currencyRate: 0.740741 }));
    expect(sentBody()).toMatchObject({ currencyCode: 'USD', currencyRate: 0.740741 });
  });

  test('a claim in the org\'s own currency sends no rate', async () => {
    await createDraftInvoice('u1', newTenant(), claim({ currency: 'SGD', currencyRate: 1 }));
    expect(sentBody().currencyRate).toBeUndefined();
  });

  test('when the org\'s currency cannot be read, no rate is sent and Xero uses its own', async () => {
    mockApi.getOrganisations.mockRejectedValue(new Error('down'));
    await createDraftInvoice('u1', newTenant(), claim({ currency: 'USD', currencyRate: 0.74 }));
    expect(sentBody().currencyRate).toBeUndefined();
  });

  test('a currency symbol is refused before anything is sent', async () => {
    await expect(createDraftInvoice('u1', newTenant(), claim({ currency: 'S$' }))).rejects.toThrow(/not a three-letter currency code/);
    expect(mockApi.createInvoices).not.toHaveBeenCalled();
  });
});
