// The Xero submitter posts inline. It used to build a Bull queue whenever
// REDIS_URL was set; with no Redis on the box every submit sat in ioredis'
// offline queue and failed, and the reconnect loop wrote ~4,900 empty
// "Queue error" lines in 14 hours (14–15 Sep 2026).
jest.mock('../xero/invoices', () => ({
  createDraftInvoice: jest.fn(async () => ({ invoiceID: 'xero-1' })),
  updateDraftInvoice: jest.fn(async () => ({ invoiceID: 'xero-2' })),
}));
jest.mock('../utils/notify', () => ({ notifyInvoiceCreated: jest.fn(async () => {}), notifyError: jest.fn(async () => {}) }));
jest.mock('../utils/token-cache', () => ({
  forUser: () => ({ getAllTenants: async () => [{ tenant_id: 't-1', tenant_name: 'Demo' }] }),
}));

const { createDraftInvoice, updateDraftInvoice } = require('../xero/invoices');
const { enqueueInvoice } = require('./processor');

beforeEach(() => { createDraftInvoice.mockClear(); updateDraftInvoice.mockClear(); });

test('posts inline and returns the Xero id even when REDIS_URL is set', async () => {
  process.env.REDIS_URL = 'redis://localhost:1';
  try {
    const id = await enqueueInvoice('u1', { invoiceNumber: 'INV-1', vendorName: 'Acme', totalAmount: 10 });
    expect(id).toBe('xero-1');
    expect(createDraftInvoice).toHaveBeenCalledWith('u1', 't-1', expect.objectContaining({ invoiceNumber: 'INV-1' }));
  } finally {
    delete process.env.REDIS_URL;
  }
});

test('an invoice that already has a Xero id is updated, not created again', async () => {
  const id = await enqueueInvoice('u1', { invoiceNumber: 'INV-1', xeroInvoiceId: 'xero-2' });
  expect(id).toBe('xero-2');
  expect(updateDraftInvoice).toHaveBeenCalledTimes(1);
  expect(createDraftInvoice).not.toHaveBeenCalled();
});

test('a Xero failure is thrown to the caller so the row can be marked error', async () => {
  createDraftInvoice.mockRejectedValueOnce(new Error('validation'));
  await expect(enqueueInvoice('u1', { invoiceNumber: 'INV-9' })).rejects.toThrow('validation');
});

test('bull and ioredis are no longer dependencies', () => {
  const pkg = require('../../package.json');
  expect(pkg.dependencies.bull).toBeUndefined();
  expect(pkg.dependencies.ioredis).toBeUndefined();
});
