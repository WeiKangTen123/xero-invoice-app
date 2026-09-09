const { hashBuffer, findDuplicate, sameAmount } = require('./claim-dedup');

// A duplicate is MARKED, never dropped — the invoice pipeline's existing
// behaviour — so it stays visible and reversible instead of a receipt that
// silently vanished.
const store = rows => ({
  getAll: () => rows,
  findByReceiptHash: h => rows.find(r => r.receiptHash === h && !['duplicate', 'error'].includes(r.status)) || null,
});
const rec = (id, over = {}) => ({ id, status: 'review-needed', vendorName: 'Grab', invoiceDate: '2026-02-23', totalAmount: 15.8, receiptHash: null, ...over });

describe('claims/claim-dedup', () => {
  describe('hashBuffer', () => {
    test('the same bytes hash the same, different bytes do not', () => {
      expect(hashBuffer(Buffer.from('abc'))).toBe(hashBuffer(Buffer.from('abc')));
      expect(hashBuffer(Buffer.from('abc'))).not.toBe(hashBuffer(Buffer.from('abd')));
    });
    test('nothing to hash is null, not a hash of nothing', () => {
      expect(hashBuffer(Buffer.alloc(0))).toBeNull();
      expect(hashBuffer(null)).toBeNull();
    });
  });

  describe('the image itself', () => {
    test('the same file already imported is found', () => {
      const h = hashBuffer(Buffer.from('receipt'));
      const s = store([rec('old', { receiptHash: h })]);
      const d = findDuplicate({ store: s, hash: h });
      expect(d.match.id).toBe('old');
      expect(d.reason).toMatch(/same receipt image/);
      // Byte-for-byte is a fact, so the caller may mark it 'duplicate' outright.
      expect(d.certain).toBe(true);
    });

    test('an earlier duplicate or error does not block a genuine re-import', () => {
      const h = hashBuffer(Buffer.from('receipt'));
      const s = store([rec('old', { receiptHash: h, status: 'duplicate' }), rec('bad', { receiptHash: h, status: 'error' })]);
      expect(findDuplicate({ store: s, hash: h })).toBeNull();
    });

    test('a record does not duplicate itself', () => {
      const h = hashBuffer(Buffer.from('receipt'));
      const s = store([rec('me', { receiptHash: h })]);
      expect(findDuplicate({ store: s, hash: h, excludeId: 'me' })).toBeNull();
    });
  });

  describe('vendor, date and amount', () => {
    test('all three matching is a duplicate', () => {
      const s = store([rec('old')]);
      const d = findDuplicate({ store: s, vendorName: 'GRAB', date: '2026-02-23', amount: 15.8 });
      expect(d.match.id).toBe('old');
      expect(d.reason).toMatch(/vendor, date and amount/);
      // Matching fields is only a suspicion. 'duplicate' is a locked status, so
      // acting on this alone would bury a real expense behind it.
      expect(d.certain).toBe(false);
    });

    test('the same vendor and amount on a DIFFERENT day is not', () => {
      // Two identical fares on different days are ordinary; merging them would
      // lose a real expense.
      const s = store([rec('old')]);
      expect(findDuplicate({ store: s, vendorName: 'Grab', date: '2026-04-09', amount: 15.8 })).toBeNull();
    });

    test('a different amount on the same day is not', () => {
      const s = store([rec('old')]);
      expect(findDuplicate({ store: s, vendorName: 'Grab', date: '2026-02-23', amount: 15.9 })).toBeNull();
    });

    test('any of the three missing means no match is attempted', () => {
      const s = store([rec('old')]);
      expect(findDuplicate({ store: s, vendorName: 'Grab', date: '2026-02-23' })).toBeNull();
      expect(findDuplicate({ store: s, vendorName: 'Grab', amount: 15.8 })).toBeNull();
      expect(findDuplicate({ store: s, date: '2026-02-23', amount: 15.8 })).toBeNull();
    });

    test('vendor comparison ignores case and punctuation', () => {
      const s = store([rec('old', { vendorName: 'CDG Zig' })]);
      expect(findDuplicate({ store: s, vendorName: 'cdg  zig.', date: '2026-02-23', amount: 15.8 }).match.id).toBe('old');
    });

    test('a timestamped date still compares by day', () => {
      const s = store([rec('old', { invoiceDate: '2026-02-23T10:00:00Z' })]);
      expect(findDuplicate({ store: s, vendorName: 'Grab', date: '2026-02-23', amount: 15.8 }).match.id).toBe('old');
    });
  });

  test('the image wins over the fields when both could match', () => {
    const h = hashBuffer(Buffer.from('r'));
    const s = store([rec('byFields'), rec('byHash', { receiptHash: h, vendorName: 'Other' })]);
    expect(findDuplicate({ store: s, hash: h, vendorName: 'Grab', date: '2026-02-23', amount: 15.8 }).match.id).toBe('byHash');
  });

  test('a pre-fetched candidate list avoids a query per receipt in a batch', () => {
    const s = { getAll: jest.fn(), findByReceiptHash: () => null };
    findDuplicate({ store: s, vendorName: 'Grab', date: '2026-02-23', amount: 15.8, candidates: [rec('old')] });
    expect(s.getAll).not.toHaveBeenCalled();
  });

  test('amounts compare to the cent', () => {
    expect(sameAmount(15.8, 15.80)).toBe(true);
    expect(sameAmount(15.8, 15.81)).toBe(false);
    expect(sameAmount(null, 1)).toBe(false);
  });
});
