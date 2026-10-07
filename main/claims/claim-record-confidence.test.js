// The receipt reader's confidence reaches the claim record. It was computed by
// receipt-parser.normalise and then dropped here, so the review list could not
// say which claims were read from a blurred photo.
jest.mock('./category-account', () => ({ resolveAccountCode: jest.fn(async () => null) }));

describe('claims/claim-record — confidence', () => {
  let claimRecord, invoiceStore, userId;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    claimRecord  = require('./claim-record');
    invoiceStore = require('../utils/invoice-store');
    const u = await require('../utils/users').createUser(`conf${Date.now()}${Math.random()}@test.com`, 'password123', 'user');
    userId = u.id;
  });

  const receipt = (extra = {}) => ({
    buffer: Buffer.from(`jpeg-${Math.random()}`), mime: 'image/jpeg', merchant: 'FairPrice',
    total: 12.5, date: '2026-09-01', confidence: 'low', ...extra,
  });
  const line = () => ({ no: '1', date: '2026-09-01', description: 'Pantry snacks', currency: 'SGD', amount: 12.5 });

  test('a new row carries the receipt read\'s confidence', () => {
    expect(claimRecord.newClaimRow({ userId, source: 'upload', receipt: receipt({ confidence: 'high' }) }).confidence).toBe('high');
    expect(claimRecord.newClaimRow({ userId, source: 'upload', receipt: receipt({ confidence: 'low' }) }).confidence).toBe('low');
  });

  test('no receipt, or no reading of one, is null — not a guess', () => {
    expect(claimRecord.newClaimRow({ userId, source: 'upload' }).confidence).toBeNull();
    expect(claimRecord.newClaimRow({ userId, source: 'upload', receipt: receipt({ confidence: undefined }) }).confidence).toBeNull();
    expect(claimRecord.newClaimRow({ userId, source: 'upload', receipt: receipt({ confidence: 'certain' }) }).confidence).toBeNull();
  });

  test('a re-read updates the confidence along with the figures', () => {
    const r = { merchant: 'Grab', total: 18.4, date: '2026-08-24', confidence: 'low', lineItems: [] };
    expect(claimRecord.claimPatch(r).confidence).toBe('low');
    expect(claimRecord.claimPatch({ ...r, confidence: 'high' }).confidence).toBe('high');
  });

  test('a reader that gave none leaves the stored confidence alone (undefined, the store\'s rule)', () => {
    expect(claimRecord.claimPatch({ merchant: 'Grab' }).confidence).toBeUndefined();
  });

  test('createClaimRecord hands the confidence to the store', async () => {
    const realForUser = invoiceStore.forUser;
    const added = [];
    jest.spyOn(invoiceStore, 'forUser').mockImplementation(uid => {
      const s = realForUser(uid);
      return { ...s, add: rec => { added.push(rec); return s.add(rec); } };
    });
    const store = jest.fn(async (uid, id) => `${id}.jpg`);
    const rec = await claimRecord.createClaimRecord({ userId, groupId: 'g1', row: line(), receipt: receipt({ confidence: 'low' }), match: null, category: null, store });
    expect(rec).toBeTruthy();
    expect(added).toHaveLength(1);
    expect(added[0].confidence).toBe('low');
  });
});
