// The model is never called from a test; what is under test is which receipts
// the boot catch-up chooses to read, and what it leaves alone.
jest.mock('../utils/receipt-parser', () => ({
  parseReceiptImage: jest.fn().mockResolvedValue(null),
  parseReceiptText:  jest.fn().mockResolvedValue(null),
}));
jest.mock('../claims/category-account', () => ({ resolveAccountCode: jest.fn().mockResolvedValue(null) }));

// A background read lives only in the process that started it. A restart in
// the seconds between an upload and the end of its read left the row unread
// for good, and the phone showing "Reading..." forever.
describe('routes/receipts — reads cut off by a restart', () => {
  let users, invoiceStore, receiptStore, parser, routes, newClaimRow, newId, user;
  let n = 0;

  const GRAB = { split: false, receipts: [{ merchant: 'Grab', total: 18.4, currency: 'SGD', date: '2026-08-24', confidence: 'high', lineItems: [] }] };
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users        = require('../utils/users');
    invoiceStore = require('../utils/invoice-store');
    receiptStore = require('../utils/receipt-store');
    parser       = require('../utils/receipt-parser');
    ({ newClaimRow } = require('../claims/claim-record'));
    ({ newId } = require('../utils/ids'));
    routes = require('./receipts');
    user = await users.createUser(`resume${Date.now()}${++n}@test.com`, 'password123', 'user');
  });

  // Every account in the database is scanned, so each test's account is
  // removed afterwards and the next test sees only its own rows.
  afterEach(() => { try { users.deleteUser(user.id); } catch (_) { /* already gone */ } });

  const store = () => invoiceStore.forUser(user.id);

  // A receipt as an upload leaves it the moment before its read: stored file,
  // row at review-needed, no parsedAt.
  function uploaded({ id = newId(), source = 'phone', extras = {} } = {}) {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ++n]);
    const receiptFile = receiptStore.forUser(user.id).save(id, bytes, 'image/jpeg');
    return store().add(newClaimRow({ userId: user.id, id, source, extras: {
      receiptFile, receiptMime: 'image/jpeg', receiptHash: `hash-${n}`, ...extras,
    } }));
  }

  async function resume(opts) {
    const out = await routes.resumeUnreadReceipts(opts);
    await routes._drain();
    return out;
  }

  test('a receipt whose read was cut off is read on boot', async () => {
    parser.parseReceiptImage.mockResolvedValue(GRAB);
    const row = uploaded();
    const out = await resume();

    expect(out.queued).toBe(1);
    expect(parser.parseReceiptImage).toHaveBeenCalledTimes(1);
    const after = store().getById(row.id);
    expect(after).toMatchObject({ vendorName: 'Grab', totalAmount: 18.4 });
    expect(after.parsedAt).toBeTruthy();
  });

  test('a read that finds nothing still ends marked as read, so the phone stops spinning', async () => {
    parser.parseReceiptImage.mockRejectedValue(new Error('model unavailable'));
    const row = uploaded({ source: 'upload' });
    await resume();
    const after = store().getById(row.id);
    expect(after.parsedAt).toBeTruthy();
    expect(after.vendorName).toBeFalsy();
  });

  test('a receipt that was already read is left alone', async () => {
    const at = '2026-08-01T00:00:00.000Z';
    const row = uploaded({ extras: { parsedAt: at } });
    await resume();
    expect(parser.parseReceiptImage).not.toHaveBeenCalled();
    expect(store().getById(row.id).parsedAt).toBe(at);
  });

  test('figures someone typed are never overwritten by a late read', async () => {
    parser.parseReceiptImage.mockResolvedValue(GRAB);
    const row = uploaded({ extras: { vendorName: 'Typed by hand', totalAmount: 12 } });
    const out = await resume();

    expect(parser.parseReceiptImage).not.toHaveBeenCalled();
    const after = store().getById(row.id);
    expect(after).toMatchObject({ vendorName: 'Typed by hand', totalAmount: 12 });
    expect(after.parsedAt).toBeTruthy();   // finished, so nothing shows "Reading..."
    expect(out.closed).toBe(1);
  });

  test('an upload that had already split is not split a second time', async () => {
    const rootId = newId();
    const root = uploaded({ id: rootId, extras: { receiptGroup: rootId, receiptBox: '[0,0,500,1000]' } });
    const sib = store().add(newClaimRow({ userId: user.id, source: 'phone', groupId: rootId, extras: {
      receiptFile: root.receiptFile, receiptMime: 'image/jpeg', receiptHash: root.receiptHash, receiptBox: '[500,0,1000,1000]',
    } }));
    await resume();

    expect(parser.parseReceiptImage).not.toHaveBeenCalled();
    expect(store().getReceiptGroup(rootId)).toHaveLength(2);
    expect(store().getById(root.id).parsedAt).toBeTruthy();
    expect(store().getById(sib.id).parsedAt).toBeTruthy();
  });

  test('a sibling left unmarked after its upload was marked is finished too', async () => {
    const rootId = newId();
    uploaded({ id: rootId, extras: { receiptGroup: rootId, parsedAt: '2026-08-01T00:00:00.000Z' } });
    const sib = store().add(newClaimRow({ userId: user.id, source: 'phone', groupId: rootId, extras: { receiptFile: `${rootId}.jpg`, receiptMime: 'image/jpeg' } }));
    await resume();
    expect(parser.parseReceiptImage).not.toHaveBeenCalled();
    expect(store().getById(sib.id).parsedAt).toBeTruthy();
  });

  test('an old unread receipt is marked finished rather than read', async () => {
    // A backlog of old rows must not become a burst of model calls at boot.
    const row = uploaded({ extras: { receivedAt: new Date(Date.now() - 30 * DAY).toISOString() } });
    await resume();
    expect(parser.parseReceiptImage).not.toHaveBeenCalled();
    expect(store().getById(row.id).parsedAt).toBeTruthy();
  });

  test('a receipt whose file is gone is marked finished rather than read', async () => {
    const row = uploaded();
    receiptStore.forUser(user.id).remove(row.receiptFile);
    await resume();
    expect(parser.parseReceiptImage).not.toHaveBeenCalled();
    expect(store().getById(row.id).parsedAt).toBeTruthy();
  });

  test('claim-import rows are not touched: the import read them itself', async () => {
    const row = uploaded({ source: 'claim' });
    await resume();
    expect(parser.parseReceiptImage).not.toHaveBeenCalled();
    expect(store().getById(row.id).parsedAt).toBeFalsy();
  });

  test('nothing is read for a disabled account', async () => {
    const row = uploaded();
    users.setDisabled(user.id, true);
    await resume();
    expect(parser.parseReceiptImage).not.toHaveBeenCalled();
    expect(store().getById(row.id).parsedAt).toBeFalsy();   // left for if it is enabled again
  });

  test('two catch-ups at once read a receipt only once', async () => {
    parser.parseReceiptImage.mockResolvedValue(GRAB);
    uploaded();
    await Promise.all([routes.resumeUnreadReceipts(), routes.resumeUnreadReceipts()]);
    await routes._drain();
    expect(parser.parseReceiptImage).toHaveBeenCalledTimes(1);
  });

  test('marking a read finished looks up its own rows, not every record the user has', async () => {
    // A read that finds nothing, so the only store work left is the stamp.
    // (A read that finds figures also runs the duplicate check, whose
    // field match in intake/dedup.js scans the user's records by design.)
    const row = uploaded();
    const real = invoiceStore.forUser;
    const getAll = jest.fn();
    const spy = jest.spyOn(invoiceStore, 'forUser').mockImplementation(uid => {
      const s = real(uid);
      const orig = s.getAll;
      s.getAll = (...args) => { getAll(); return orig(...args); };
      return s;
    });
    try {
      await resume();
    } finally {
      spy.mockRestore();
    }
    expect(parser.parseReceiptImage).toHaveBeenCalledTimes(1);
    expect(store().getById(row.id).parsedAt).toBeTruthy();
    expect(getAll).not.toHaveBeenCalled();
  });
});
