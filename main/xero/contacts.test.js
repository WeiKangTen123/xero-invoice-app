// getContacts(tenant, ifModifiedSince, where, order, iDs, page, includeArchived, summaryOnly, searchTerm).
// The call passed eight undefineds then true, which landed in searchTerm.
const mockGetContacts    = jest.fn();
const mockCreateContacts = jest.fn();
jest.mock('xero-node', () => ({ AccountingApi: jest.fn(() => ({ getContacts: mockGetContacts, createContacts: mockCreateContacts })) }));
jest.mock('../utils/token-cache', () => ({ forUser: () => ({ getValidToken: async () => 'tok' }) }));
jest.mock('./xero-utils', () => ({ withRetry: fn => fn() }));
const { getOrCreateContact } = require('./contacts');

beforeEach(() => { mockGetContacts.mockReset(); mockCreateContacts.mockReset(); });

test('searches by exact name with summaryOnly, no search term', async () => {
  mockGetContacts.mockResolvedValue({ body: { contacts: [{ contactID: 'c-1' }] } });
  const id = await getOrCreateContact('u1', 't-1', { vendorName: 'Acme', invoiceType: 'ACCPAY' });
  expect(id).toBe('c-1');
  const args = mockGetContacts.mock.calls[0];
  expect(args[2]).toBe('Name=="Acme"');
  expect(args[7]).toBe(true);        // summaryOnly
  expect(args[8]).toBeUndefined();   // searchTerm
  expect(mockCreateContacts).not.toHaveBeenCalled();
});

test('a failed search is not an excuse to create a duplicate', async () => {
  mockGetContacts.mockRejectedValue(new Error('rate limited'));
  await expect(getOrCreateContact('u1', 't-1', { vendorName: 'Acme', invoiceType: 'ACCPAY' })).rejects.toThrow('rate limited');
  expect(mockCreateContacts).not.toHaveBeenCalled();
});

test('no match creates the contact as a supplier for a bill', async () => {
  mockGetContacts.mockResolvedValue({ body: { contacts: [] } });
  mockCreateContacts.mockResolvedValue({ body: { contacts: [{ contactID: 'c-new' }] } });
  const id = await getOrCreateContact('u1', 't-1', { vendorName: 'Acme', invoiceType: 'ACCPAY' });
  expect(id).toBe('c-new');
  expect(mockCreateContacts.mock.calls[0][1].contacts[0]).toMatchObject({ name: 'Acme', isSupplier: true, isCustomer: false });
});

// A claim with no merchant reached here as null and crashed on null.replace;
// a name that cleaned to nothing went to a shared "Unknown Vendor" contact.
test('no name at all is refused with a clear message, and Xero is never asked', async () => {
  for (const vendorName of [null, undefined, '', '   ', '<b></b>']) {
    await expect(getOrCreateContact('u1', 't-1', { vendorName, invoiceType: 'ACCPAY' }))
      .rejects.toThrow(/no supplier, customer or payee name/);
  }
  expect(mockGetContacts).not.toHaveBeenCalled();
  expect(mockCreateContacts).not.toHaveBeenCalled();
});

test('resolveContact hands back the contact\'s default tax types when Xero has them', async () => {
  const { resolveContact } = require('./contacts');
  mockGetContacts.mockResolvedValue({ body: { contacts: [{ contactID: 'c-1', accountsPayableTaxType: 'IM' }] } });
  await expect(resolveContact('u1', 't-1', { vendorName: 'Acme', invoiceType: 'ACCPAY' }))
    .resolves.toEqual({ contactID: 'c-1', accountsPayableTaxType: 'IM', accountsReceivableTaxType: null });
});
