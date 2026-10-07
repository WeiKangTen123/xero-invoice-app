// getContacts(tenant, ifModifiedSince, where, order, iDs, page, includeArchived, summaryOnly, searchTerm).
// The lookup is Xero's case-insensitive searchTerm with archived contacts
// included and full records (not summaryOnly), and the exact name is picked
// out of the results here. It used to be an exact `Name==` filter that missed
// any difference in case and lost a name containing a quote.
const mockGetContacts    = jest.fn();
const mockCreateContacts = jest.fn();
jest.mock('xero-node', () => ({ AccountingApi: jest.fn(() => ({ getContacts: mockGetContacts, createContacts: mockCreateContacts })) }));
jest.mock('../utils/token-cache', () => ({ forUser: () => ({ getValidToken: async () => 'tok' }) }));
jest.mock('./xero-utils', () => ({ withRetry: fn => fn() }));
let mockConfig = {};
let mockUser   = null;
jest.mock('../utils/users', () => ({ getUserConfig: () => mockConfig, findById: () => mockUser }));
const { getOrCreateContact, resolveContact } = require('./contacts');

beforeEach(() => {
  mockGetContacts.mockReset();
  mockCreateContacts.mockReset();
  mockConfig = {};
  mockUser   = null;
});

const found = (...contacts) => ({ body: { contacts } });
const createdAs = (contact = { contactID: 'c-new' }) => mockCreateContacts.mockResolvedValue({ body: { contacts: [contact] } });
const createdContact = () => mockCreateContacts.mock.calls[0][1].contacts[0];

describe('finding the contact', () => {
  test('searches with searchTerm, archived included, full records, and no where filter', async () => {
    mockGetContacts.mockResolvedValue(found({ contactID: 'c-1', name: 'Acme' }));
    const id = await getOrCreateContact('u1', 't-1', { vendorName: 'Acme', invoiceType: 'ACCPAY' });
    expect(id).toBe('c-1');
    const args = mockGetContacts.mock.calls[0];
    expect(args[0]).toBe('t-1');
    expect(args[2]).toBeUndefined();   // where
    expect(args[6]).toBe(true);        // includeArchived
    expect(args[7]).toBe(false);       // summaryOnly: the summary hides the defaults
    expect(args[8]).toBe('Acme');      // searchTerm
    expect(mockCreateContacts).not.toHaveBeenCalled();
  });

  test('matches the name ignoring case, and only the whole name', async () => {
    // searchTerm is a contains-search across several fields: the near misses
    // come back too and must not be taken for the supplier.
    mockGetContacts.mockResolvedValue(found(
      { contactID: 'c-holdings', name: 'Acme Pte Ltd Holdings' },
      { contactID: 'c-email',    name: 'Someone Else', emailAddress: 'ap@acmepteltd.test' },
      { contactID: 'c-acme',     name: 'ACME PTE  LTD' },
    ));
    const id = await getOrCreateContact('u1', 't-1', { vendorName: 'Acme Pte Ltd', invoiceType: 'ACCPAY' });
    expect(id).toBe('c-acme');
    expect(mockCreateContacts).not.toHaveBeenCalled();
  });

  test('an archived contact is found rather than duplicated; an active one with the same name wins', async () => {
    mockGetContacts.mockResolvedValue(found({ contactID: 'c-old', name: 'Acme', contactStatus: 'ARCHIVED' }));
    expect(await getOrCreateContact('u1', 't-1', { vendorName: 'acme', invoiceType: 'ACCPAY' })).toBe('c-old');
    expect(mockCreateContacts).not.toHaveBeenCalled();

    mockGetContacts.mockResolvedValue(found(
      { contactID: 'c-old', name: 'Acme', contactStatus: 'ARCHIVED' },
      { contactID: 'c-live', name: 'Acme', contactStatus: 'ACTIVE' },
    ));
    expect(await getOrCreateContact('u1', 't-1', { vendorName: 'Acme', invoiceType: 'ACCPAY' })).toBe('c-live');
  });

  test('a failed search is not an excuse to create a duplicate', async () => {
    mockGetContacts.mockRejectedValue(new Error('rate limited'));
    await expect(getOrCreateContact('u1', 't-1', { vendorName: 'Acme', invoiceType: 'ACCPAY' })).rejects.toThrow('rate limited');
    expect(mockCreateContacts).not.toHaveBeenCalled();
  });

  test('no match creates the contact as a supplier for a bill', async () => {
    mockGetContacts.mockResolvedValue(found());
    createdAs();
    const id = await getOrCreateContact('u1', 't-1', { vendorName: 'Acme', invoiceType: 'ACCPAY' });
    expect(id).toBe('c-new');
    expect(createdContact()).toMatchObject({ name: 'Acme', isSupplier: true, isCustomer: false });
  });

  test('a create that loses a race finds the winner with the same search', async () => {
    mockGetContacts
      .mockResolvedValueOnce(found())
      .mockResolvedValueOnce(found({ contactID: 'c-raced', name: 'ACME' }));
    mockCreateContacts.mockRejectedValue(new Error('The contact name Acme is already assigned to another contact'));
    expect(await getOrCreateContact('u1', 't-1', { vendorName: 'Acme', invoiceType: 'ACCPAY' })).toBe('c-raced');
    expect(mockGetContacts.mock.calls[1][8]).toBe('Acme');
  });
});

describe('a name containing quotes', () => {
  const NAME = 'Joe\'s "Best" Coffee Roasters';

  test('is created with its quotes, and found again by the same name on the next post', async () => {
    // First post: nothing there yet, so it is created exactly as named.
    mockGetContacts.mockResolvedValueOnce(found());
    createdAs({ contactID: 'c-joe', name: NAME });
    await getOrCreateContact('u1', 't-1', { vendorName: NAME, invoiceType: 'ACCPAY' });
    expect(createdContact().name).toBe(NAME);

    // Second post: Xero returns the contact as created, and it is matched —
    // the old lookup stripped the quotes from the search and never found it.
    mockGetContacts.mockResolvedValueOnce(found({ contactID: 'c-joe', name: NAME }));
    mockCreateContacts.mockClear();
    expect(await getOrCreateContact('u1', 't-1', { vendorName: NAME, invoiceType: 'ACCPAY' })).toBe('c-joe');
    expect(mockCreateContacts).not.toHaveBeenCalled();
  });

  test('the search term is the longest stretch of the name without a quote', async () => {
    mockGetContacts.mockResolvedValue(found({ contactID: 'c-joe', name: NAME }));
    await getOrCreateContact('u1', 't-1', { vendorName: NAME, invoiceType: 'ACCPAY' });
    expect(mockGetContacts.mock.calls[0][8]).toBe('Coffee Roasters');
  });
});

describe('what comes back', () => {
  test('the contact\'s default tax types and account codes, when Xero has them', async () => {
    mockGetContacts.mockResolvedValue(found({
      contactID: 'c-1', name: 'Acme', accountsPayableTaxType: 'IM',
      purchasesDefaultAccountCode: '493', salesDefaultAccountCode: '200',
    }));
    await expect(resolveContact('u1', 't-1', { vendorName: 'Acme', invoiceType: 'ACCPAY' })).resolves.toEqual({
      contactID: 'c-1',
      accountsPayableTaxType: 'IM', accountsReceivableTaxType: null,
      purchasesDefaultAccountCode: '493', salesDefaultAccountCode: '200',
    });
  });

  test('a new contact has no defaults', async () => {
    mockGetContacts.mockResolvedValue(found());
    createdAs();
    await expect(resolveContact('u1', 't-1', { vendorName: 'Acme', invoiceType: 'ACCPAY' })).resolves.toEqual({
      contactID: 'c-new',
      accountsPayableTaxType: null, accountsReceivableTaxType: null,
      purchasesDefaultAccountCode: null, salesDefaultAccountCode: null,
    });
  });
});

// A forwarded bill's sender is whoever forwarded it. New suppliers were given
// that forwarding mailbox as their email in Xero.
describe('the email a new contact is created with', () => {
  beforeEach(() => { mockGetContacts.mockResolvedValue(found()); createdAs(); });

  test('never the email\'s sender', async () => {
    await getOrCreateContact('u1', 't-1', { vendorName: 'Acme', invoiceType: 'ACCPAY', sourceEmail: 'Accounts <accounts@ourco.test>' });
    expect(createdContact()).not.toHaveProperty('emailAddress');
  });

  test('never one of this account\'s own addresses: sign-in, mailbox or forwarder', async () => {
    mockUser   = { id: 'u1', email: 'owner@ourco.test' };
    mockConfig = { IMAP_USER: 'bills@ourco.test', IMAP_FILTER_FROM: 'Forwarder@OurCo.test' };
    for (const email of ['owner@ourco.test', 'BILLS@ourco.test', 'Forwarder <forwarder@ourco.test>']) {
      mockCreateContacts.mockClear();
      await getOrCreateContact('u1', 't-1', { vendorName: 'Acme', invoiceType: 'ACCPAY', email });
      expect(createdContact()).not.toHaveProperty('emailAddress');
    }
  });

  test('the supplier\'s own address from the document is kept, as a plain address', async () => {
    mockConfig = { IMAP_USER: 'bills@ourco.test' };
    await getOrCreateContact('u1', 't-1', { vendorName: 'Acme', invoiceType: 'ACCPAY', email: 'Acme AR <AR@Acme.test>' });
    expect(createdContact().emailAddress).toBe('ar@acme.test');
  });

  test('something that is not an email address is not sent', async () => {
    await getOrCreateContact('u1', 't-1', { vendorName: 'Acme', invoiceType: 'ACCPAY', email: 'see attached' });
    expect(createdContact()).not.toHaveProperty('emailAddress');
  });
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
