// A claim line becomes a row. What is checked here is what reaches Xero later
// or explains why it cannot: the currency as a code, the form's exchange rate,
// and a receipt that could not be stored. The chart lookup is replaced; the
// store and the database are real.
jest.mock('./category-account', () => ({ resolveAccountCode: jest.fn(async () => null) }));

describe('claims/claim-record', () => {
  let createClaimRecord, newClaimRow, invoiceStore, userId;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    ({ createClaimRecord, newClaimRow } = require('./claim-record'));
    invoiceStore = require('../utils/invoice-store');
    const u = await require('../utils/users').createUser(`cr${Date.now()}${Math.random()}@test.com`, 'password123', 'user');
    userId = u.id;
  });

  const receipt = (extra = {}) => ({
    buffer: Buffer.from(`jpeg-${Math.random()}`), mime: 'image/jpeg', merchant: 'FairPrice',
    total: 12.5, date: '2026-09-01', ...extra,
  });
  const line = (extra = {}) => ({ no: '1', date: '2026-09-01', description: 'Pantry snacks', currency: 'SGD', amount: 12.5, ...extra });

  test('a receipt that cannot be stored leaves the claim, with a note saying so', async () => {
    const store = jest.fn(async () => { throw new Error('disk full'); });
    const rec = await createClaimRecord({ userId, groupId: 'g1', row: line(), receipt: receipt(), match: null, category: null, store });
    expect(rec).toBeTruthy();
    expect(rec.receiptFile).toBeNull();
    expect(rec.receiptMime).toBeNull();
    expect(rec.errorMsg).toBe('The receipt image could not be saved (disk full), so it will not be attached in Xero. Add the receipt to this claim again.');
    expect(invoiceStore.forUser(userId).getById(rec.id).errorMsg).toContain('could not be saved');
  });

  test('a stored receipt leaves no note and its file and type on the row', async () => {
    const store = jest.fn(async (uid, id) => `${id}.jpg`);
    const rec = await createClaimRecord({ userId, groupId: 'g1', row: line(), receipt: receipt(), match: null, category: null, store });
    expect(rec.receiptFile).toBe(`${rec.id}.jpg`);
    expect(rec.receiptMime).toBe('image/jpeg');
    expect(rec.errorMsg).toBeNull();
  });

  test('what the import was unsure of is kept on the claim as a "Please check" note', async () => {
    // A weak match or a suggested category used to reach only the import
    // summary, which is gone once the dialog closes.
    const store = jest.fn(async (uid, id) => `${id}.jpg`);
    const rec = await createClaimRecord({ userId, groupId: 'g1', row: line(), receipt: receipt(), match: null, category: null, store,
      reviewReason: 'the category "LOCAL TRAVEL COST (SGD)" was suggested, not chosen by the claimant — confirm it' });
    expect(rec.errorMsg).toBe('Please check: the category "LOCAL TRAVEL COST (SGD)" was suggested, not chosen by the claimant — confirm it.');
  });

  test('a review note follows a discrepancy, which stays first', async () => {
    const store = jest.fn(async (uid, id) => `${id}.jpg`);
    const match = { discrepancy: { claimed: 12.5, onReceipt: 10 } };
    const rec = await createClaimRecord({ userId, groupId: 'g1', row: line(), receipt: receipt(), match, category: null, store, reviewReason: 'second receipt found.' });
    expect(rec.errorMsg).toBe('Claimed 12.5 but the receipt says 10 Please check: second receipt found.');
  });

  test('the store failure is added after a discrepancy, which stays readable', async () => {
    const store = jest.fn(async () => { throw new Error('disk full'); });
    const match = { discrepancy: { claimed: 12.5, onReceipt: 10 } };
    const rec = await createClaimRecord({ userId, groupId: 'g1', row: line(), receipt: receipt(), match, category: null, store });
    expect(rec.errorMsg).toMatch(/^Claimed 12.5 but the receipt says 10 The receipt image could not be saved/);
  });

  test('the currency is a code, and the form\'s rate in Xero\'s terms is kept', async () => {
    const store = jest.fn(async (uid, id) => `${id}.jpg`);
    const rec = await createClaimRecord({
      userId, groupId: 'g2', row: line({ currency: 'US$', amount: 100, currencyRate: 0.740741 }),
      receipt: receipt({ total: 100 }), match: null, category: null, store,
    });
    expect(rec.currency).toBe('USD');
    expect(rec.currencyRate).toBe(0.740741);
  });

  test('a currency the form gave but no code could be read from is said, with what was used', async () => {
    const store = jest.fn(async (uid, id) => `${id}.jpg`);
    const rec = await createClaimRecord({
      userId, groupId: 'g3', row: line({ currency: null, currencyUnread: 'Baht' }),
      receipt: receipt({ currency: 'THB' }), match: null, category: null, store,
    });
    expect(rec.currency).toBe('THB');
    expect(rec.errorMsg).toBe('The claim form gives the currency as "Baht", which is not a currency code; THB was used. Check it before approving.');
  });

  test('newClaimRow cleans a symbol from any reader, and leaves the rate empty without a form', () => {
    expect(newClaimRow({ userId, source: 'upload', receipt: { currency: 'S$' } }).currency).toBe('SGD');
    expect(newClaimRow({ userId, source: 'upload', receipt: { currency: 'S$' } }).currencyRate).toBeNull();
  });
});
