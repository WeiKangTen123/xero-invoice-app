// The Xero submitter posts inline. It used to build a Bull queue whenever
// REDIS_URL was set; with no Redis on the box every submit sat in ioredis'
// offline queue and failed, and the reconnect loop wrote ~4,900 empty
// "Queue error" lines in 14 hours (14–15 Sep 2026).
jest.mock('../xero/invoices', () => ({
  createDraftInvoice: jest.fn(async () => ({ invoiceID: 'xero-1' })),
  updateDraftInvoice: jest.fn(async () => ({ invoiceID: 'xero-2' })),
}));
jest.mock('../utils/notify', () => ({ notifyInvoiceCreated: jest.fn(async () => {}), notifyError: jest.fn(async () => {}) }));
// The connected orgs and the account's chosen default, set per test.
let mockTenants = [{ tenant_id: 't-1', tenant_name: 'Demo' }];
let mockDefaultTenantId = null;
jest.mock('../utils/token-cache', () => ({
  forUser: () => ({ getAllTenants: async () => mockTenants }),
}));
jest.mock('../utils/settings-store', () => ({
  forUser: () => ({ get: key => ({ autoProcess: false, defaultTenantId: mockDefaultTenantId })[key] }),
}));

const { createDraftInvoice, updateDraftInvoice } = require('../xero/invoices');
const { notifyInvoiceCreated } = require('../utils/notify');
const { enqueueInvoice, CHOOSE_TENANT_MSG } = require('./processor');

const TWO = [{ tenant_id: 't-1', tenant_name: 'One' }, { tenant_id: 't-2', tenant_name: 'Two' }];

beforeEach(() => {
  createDraftInvoice.mockClear(); updateDraftInvoice.mockClear();
  mockTenants = [{ tenant_id: 't-1', tenant_name: 'Demo' }];
  mockDefaultTenantId = null;
});

test('posts inline and returns the Xero id and its org even when REDIS_URL is set', async () => {
  process.env.REDIS_URL = 'redis://localhost:1';
  try {
    const sent = await enqueueInvoice('u1', { invoiceNumber: 'INV-1', vendorName: 'Acme', totalAmount: 10 });
    expect(sent).toEqual({ xeroInvoiceId: 'xero-1', tenantId: 't-1' });
    expect(createDraftInvoice).toHaveBeenCalledWith('u1', 't-1', expect.objectContaining({ invoiceNumber: 'INV-1' }));
  } finally {
    delete process.env.REDIS_URL;
  }
});

test('an invoice that already has a Xero id is updated, not created again', async () => {
  const sent = await enqueueInvoice('u1', { invoiceNumber: 'INV-1', xeroInvoiceId: 'xero-2' });
  expect(sent.xeroInvoiceId).toBe('xero-2');
  expect(updateDraftInvoice).toHaveBeenCalledTimes(1);
  expect(createDraftInvoice).not.toHaveBeenCalled();
});

test('a Xero failure is thrown to the caller so the row can be marked error', async () => {
  createDraftInvoice.mockRejectedValueOnce(new Error('validation'));
  await expect(enqueueInvoice('u1', { invoiceNumber: 'INV-9' })).rejects.toThrow('validation');
});

test('no connected org: nothing is sent and null comes back', async () => {
  mockTenants = [];
  await expect(enqueueInvoice('u1', { invoiceNumber: 'INV-1' })).resolves.toBeNull();
  expect(createDraftInvoice).not.toHaveBeenCalled();
});

test('a failed notification after the bill is in Xero is not a failed send', async () => {
  notifyInvoiceCreated.mockRejectedValueOnce(new Error('slack down'));
  await expect(enqueueInvoice('u1', { invoiceNumber: 'INV-1' })).resolves.toEqual({ xeroInvoiceId: 'xero-1', tenantId: 't-1' });
});

// Every connected org used to get its own copy of every bill, and only the
// first one's Xero ID was kept — so a later correction sent that ID to every
// org. One invoice now goes to exactly one org.
describe('one Xero company per invoice', () => {
  test('two orgs and no default: nothing is posted, and the error says what to do', async () => {
    mockTenants = TWO;
    await expect(enqueueInvoice('u1', { invoiceNumber: 'INV-1' })).rejects.toThrow(CHOOSE_TENANT_MSG);
    expect(CHOOSE_TENANT_MSG).toBe('Choose a default Xero company in Setup before sending.');
    expect(createDraftInvoice).not.toHaveBeenCalled();
    expect(updateDraftInvoice).not.toHaveBeenCalled();
  });

  test('two orgs with a default: only the default is called', async () => {
    mockTenants = TWO;
    mockDefaultTenantId = 't-2';
    const sent = await enqueueInvoice('u1', { invoiceNumber: 'INV-1' });
    expect(sent).toEqual({ xeroInvoiceId: 'xero-1', tenantId: 't-2' });
    expect(createDraftInvoice).toHaveBeenCalledTimes(1);
    expect(createDraftInvoice).toHaveBeenCalledWith('u1', 't-2', expect.anything());
  });

  test('a default that is no longer connected is not used; with several orgs nothing is sent', async () => {
    mockTenants = TWO;
    mockDefaultTenantId = 't-gone';
    await expect(enqueueInvoice('u1', { invoiceNumber: 'INV-1' })).rejects.toThrow(CHOOSE_TENANT_MSG);
    expect(createDraftInvoice).not.toHaveBeenCalled();
  });

  test('a default that is gone, with one org left: that org', async () => {
    mockDefaultTenantId = 't-gone';
    const sent = await enqueueInvoice('u1', { invoiceNumber: 'INV-1' });
    expect(sent.tenantId).toBe('t-1');
  });

  test('an update goes only to the org the invoice is stored against, whatever the default', async () => {
    mockTenants = TWO;
    mockDefaultTenantId = 't-1';
    const sent = await enqueueInvoice('u1', { invoiceNumber: 'INV-1', xeroInvoiceId: 'xero-2', xeroTenantId: 't-2' });
    expect(sent).toEqual({ xeroInvoiceId: 'xero-2', tenantId: 't-2' });
    expect(updateDraftInvoice).toHaveBeenCalledTimes(1);
    expect(updateDraftInvoice).toHaveBeenCalledWith('u1', 't-2', 'xero-2', expect.anything());
    expect(createDraftInvoice).not.toHaveBeenCalled();
  });

  test('the stored org no longer connected: refused, never sent somewhere else', async () => {
    mockTenants = TWO;
    mockDefaultTenantId = 't-1';
    await expect(enqueueInvoice('u1', { invoiceNumber: 'INV-1', xeroInvoiceId: 'xero-2', xeroTenantId: 't-9' }))
      .rejects.toThrow(/no longer connected/);
    expect(updateDraftInvoice).not.toHaveBeenCalled();
    expect(createDraftInvoice).not.toHaveBeenCalled();
  });
});

test('bull and ioredis are no longer dependencies', () => {
  const pkg = require('../../package.json');
  expect(pkg.dependencies.bull).toBeUndefined();
  expect(pkg.dependencies.ioredis).toBeUndefined();
});
