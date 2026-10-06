// Why a stored bill waits for a person instead of going to Xero. The old
// guard only held "no number AND no amount", and the model's number fallback
// was the PDF filename, so a misread PDF with total 0 could post a blank draft.
const { holdReason } = require('./invoice-handler');

test('a zero total is held for review whatever the invoice number says', () => {
  expect(holdReason({ invoiceNumber: 'Scan_0001', totalAmount: 0 })).toMatch(/amount/);
  expect(holdReason({ invoiceNumber: 'INV-1789367692013', totalAmount: 0 })).toMatch(/amount/);
  expect(holdReason({ invoiceNumber: 'A-1', totalAmount: null })).toMatch(/amount/);
});

test('an auto-generated number with a real total is held too', () => {
  expect(holdReason({ invoiceNumber: 'INV-1789367692013', totalAmount: 120 })).toMatch(/number/);
  expect(holdReason({ invoiceNumber: '—', totalAmount: 120 })).toMatch(/number/);
  expect(holdReason({ invoiceNumber: '', totalAmount: 120 })).toMatch(/number/);
});

test('a real number and a real total pass', () => {
  expect(holdReason({ invoiceNumber: 'A-1', totalAmount: 120 })).toBeNull();
});

// The last hold before Xero. Disabling an account stops its watcher and
// workers, but a submit queued moments earlier waits in the per-account chain;
// this decides whether it may still go.
describe('accountMayPost', () => {
  beforeEach(() => { jest.resetModules(); require('../db/migrate').run(); });

  test('an active account may post; a disabled or deleted one may not', async () => {
    const users = require('./users');
    const { accountMayPost } = require('./invoice-handler');
    const u = await users.createUser('post@test.com', 'password123', 'user');
    expect(accountMayPost(u.id)).toBe(true);
    users.setDisabled(u.id, true);
    expect(accountMayPost(u.id)).toBe(false);
    users.setDisabled(u.id, false);
    expect(accountMayPost(u.id)).toBe(true);
    users.deleteUser(u.id);
    expect(accountMayPost(u.id)).toBe(false);
  });
});

// ── Sending to Xero ──────────────────────────────────────────────────────────
// The Xero calls are stubbed at the edge (xero/invoices); the processor, the
// store and the handler run for real against the test database.
jest.mock('../xero/invoices', () => ({
  createDraftInvoice: jest.fn(),
  updateDraftInvoice: jest.fn(),
}));
jest.mock('./token-cache', () => {
  const mockState = { tenants: [] };
  return { forUser: () => ({ getAllTenants: () => mockState.tenants }), getPersistedTenants: () => [], _state: mockState };
});
jest.mock('../xero/reconnect', () => ({ reconnectXero: jest.fn(async () => {}) }));
jest.mock('./notify', () => ({ notifyError: jest.fn(async () => {}), notifyInvoiceCreated: jest.fn(async () => {}) }));

describe('sending to Xero', () => {
  const TWO = [{ tenant_id: 't-1', tenant_name: 'One' }, { tenant_id: 't-2', tenant_name: 'Two' }];
  let handlerMod, invoiceStore, settings, xero, tokenCache, store, userId, n = 0;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    xero         = require('../xero/invoices');
    tokenCache   = require('./token-cache');
    handlerMod   = require('./invoice-handler');
    invoiceStore = require('./invoice-store');
    settings     = require('./settings-store');
    const u = await require('./users').createUser(`send${Date.now()}-${n++}@test.com`, 'password123', 'user');
    userId = u.id;
    store  = invoiceStore.forUser(userId);
    tokenCache._state.tenants = [{ tenant_id: 't-1', tenant_name: 'One' }];
    let seq = 0;
    xero.createDraftInvoice.mockReset().mockImplementation(async () => ({ invoiceID: `xero-new-${++seq}` }));
    xero.updateDraftInvoice.mockReset().mockImplementation(async (_u, _t, id) => ({ invoiceID: id }));
  });

  const row = (id, extra = {}) => store.add({
    id, status: 'pending', vendorName: 'Acme Corp', invoiceNumber: 'A-1', invoiceDate: '2026-09-01',
    totalAmount: 120, processedAt: new Date().toISOString(), ...extra,
  });

  // Every connected org used to get a copy of every bill.
  test('two orgs and no default: nothing is posted, and the row says to choose one', async () => {
    tokenCache._state.tenants = TWO;
    row('two-none');
    await expect(handlerMod.submitInvoiceToXero(userId, 'two-none')).rejects.toThrow();
    expect(xero.createDraftInvoice).not.toHaveBeenCalled();
    expect(store.getById('two-none')).toMatchObject({
      status: 'error', errorMsg: 'Choose a default Xero company in Setup before sending.', xeroInvoiceId: null,
    });
  });

  test('with a default, only that org is called and its id is stored with the Xero ID', async () => {
    tokenCache._state.tenants = TWO;
    settings.forUser(userId).set({ defaultTenantId: 't-2' });
    row('two-default');
    await expect(handlerMod.submitInvoiceToXero(userId, 'two-default')).resolves.toBe('xero-new-1');
    expect(xero.createDraftInvoice).toHaveBeenCalledTimes(1);
    expect(xero.createDraftInvoice.mock.calls[0][1]).toBe('t-2');
    expect(store.getById('two-default')).toMatchObject({ status: 'posted', xeroInvoiceId: 'xero-new-1', xeroTenantId: 't-2' });
  });

  test('a correction goes only to the org the bill is in, whatever the default now says', async () => {
    tokenCache._state.tenants = TWO;
    settings.forUser(userId).set({ defaultTenantId: 't-1' });
    row('fix', { status: 'posted', xeroInvoiceId: 'xero-77', xeroTenantId: 't-2' });
    await handlerMod.submitInvoiceToXero(userId, 'fix');
    expect(xero.createDraftInvoice).not.toHaveBeenCalled();
    expect(xero.updateDraftInvoice).toHaveBeenCalledTimes(1);
    expect(xero.updateDraftInvoice.mock.calls[0].slice(1, 3)).toEqual(['t-2', 'xero-77']);
    expect(store.getById('fix')).toMatchObject({ status: 'posted', xeroInvoiceId: 'xero-77', xeroTenantId: 't-2' });
  });

  // A failed correction used to set 'error', and findPosted/findStored then
  // no longer saw a bill that is in Xero.
  test('a failed correction of a posted row keeps it posted, records why, and it is still found', async () => {
    row('fail', { status: 'posted', xeroInvoiceId: 'xero-88', xeroTenantId: 't-1' });
    xero.updateDraftInvoice.mockRejectedValueOnce(new Error('Invoice not of valid status for modification'));
    await expect(handlerMod.submitInvoiceToXero(userId, 'fail')).rejects.toThrow();
    expect(store.getById('fail')).toMatchObject({
      status: 'posted', xeroInvoiceId: 'xero-88', errorMsg: 'Invoice not of valid status for modification',
    });
    expect(store.findPosted('Acme Corp', 'A-1', '2026-09-01', 120)?.id).toBe('fail');
    expect(store.findStored('Acme Corp', 'A-1', '2026-09-01', 120)?.id).toBe('fail');
  });

  test('a failed first send of a new row is an error, as before', async () => {
    row('new-fail');
    xero.createDraftInvoice.mockRejectedValueOnce(new Error('validation'));
    await expect(handlerMod.submitInvoiceToXero(userId, 'new-fail')).rejects.toThrow('validation');
    expect(store.getById('new-fail')).toMatchObject({ status: 'error', errorMsg: 'validation' });
  });

  test('a failed reconnect does not leave the row stuck in submitting', async () => {
    tokenCache._state.tenants = [];
    require('../xero/reconnect').reconnectXero.mockRejectedValueOnce(new Error('refresh token expired'));
    row('reconnect');
    await expect(handlerMod.submitInvoiceToXero(userId, 'reconnect')).rejects.toThrow('refresh token expired');
    expect(store.getById('reconnect')).toMatchObject({ status: 'error', errorMsg: 'refresh token expired' });
  });

  // Bulk submit and the boot retry go through here. A row matching a bill
  // already in Xero must not be posted a second time.
  test('submitInvoiceToXero checks for a posted duplicate before claiming, and does not post it', async () => {
    row('orig', { status: 'reported', xeroInvoiceId: 'xero-orig' });
    row('copy');
    await expect(handlerMod.submitInvoiceToXero(userId, 'copy')).resolves.toBeNull();
    expect(xero.createDraftInvoice).not.toHaveBeenCalled();
    expect(store.getById('copy')).toMatchObject({ status: 'duplicate', duplicateOf: 'orig', xeroInvoiceId: null });
  });

  test('allowDuplicate sends it anyway, for a person who has seen the match', async () => {
    row('orig2', { status: 'posted', xeroInvoiceId: 'xero-orig2' });
    row('copy2');
    await expect(handlerMod.submitInvoiceToXero(userId, 'copy2', { allowDuplicate: true })).resolves.toBe('xero-new-1');
    expect(store.getById('copy2').status).toBe('posted');
  });

  // The automatic path's duplicate branch copied the other row's Xero ID onto
  // this one. The unique index on (user_id, xero_invoice_id) refused it, the
  // update threw, the row stayed pending, and Submit all or the next boot
  // posted the bill twice.
  test('the automatic path marks a duplicate without copying its Xero ID, and posts nothing', async () => {
    settings.forUser(userId).set({ autoProcess: true });
    const handler = handlerMod.createHandler(userId, { submitDelayMs: 10 });
    const result = await handler.onInvoiceEmail({
      vendorName: 'Acme Corp', invoiceNumber: 'A-9', invoiceDate: '2026-09-02', totalAmount: 50, source: 'email',
    });
    expect(result.status).toBe('pending');
    // Posted by another scan while this one waited its turn.
    row('other-scan', { status: 'posted', invoiceNumber: 'A-9', invoiceDate: '2026-09-02', totalAmount: 50, xeroInvoiceId: 'xero-other' });
    await handler.whenIdle();
    expect(xero.createDraftInvoice).not.toHaveBeenCalled();
    expect(store.getById(result.id)).toMatchObject({ status: 'duplicate', duplicateOf: 'other-scan', xeroInvoiceId: null });
    expect(store.getById('other-scan').xeroInvoiceId).toBe('xero-other');
  });

  test('the automatic path claims the row and stores the org with the Xero ID', async () => {
    settings.forUser(userId).set({ autoProcess: true });
    const handler = handlerMod.createHandler(userId, { submitDelayMs: 10 });
    const result = await handler.onInvoiceEmail({
      vendorName: 'Beta Ltd', invoiceNumber: 'B-1', invoiceDate: '2026-09-03', totalAmount: 75, source: 'email',
    });
    await handler.whenIdle();
    expect(xero.createDraftInvoice).toHaveBeenCalledTimes(1);
    expect(xero.createDraftInvoice.mock.calls[0][2]._invoiceStoreId).toBe(result.id);
    expect(store.getById(result.id)).toMatchObject({ status: 'posted', xeroInvoiceId: 'xero-new-1', xeroTenantId: 't-1' });
  });
});
