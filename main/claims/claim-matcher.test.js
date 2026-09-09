const { matchClaims, sameAmount, daysApart, textOverlap } = require('./claim-matcher');

// The design constraint these pin: matching must NOT lead on amount. If a
// receipt is paired with whichever row equals its total, an amount mismatch is
// undetectable by construction — and detecting exactly that is the point.
const row = (no, date, amount, description = '') => ({ no, date, amount, description });
const rcpt = (date, total, merchant = 'Grab') => ({ date, total, merchant });

describe('claims/claim-matcher', () => {
  test('pairs each claim line with its receipt', () => {
    const r = matchClaims(
      [row(1, '2026-02-23', 15.8), row(2, '2026-02-26', 56.7)],
      [rcpt('2026-02-26', 56.7), rcpt('2026-02-23', 15.8)],
    );
    expect(r.summary).toMatchObject({ total: 2, matched: 2, verified: 2, discrepancies: 0 });
    expect(r.matches.find(m => m.row.no === 1).receipt.total).toBe(15.8);
  });

  test('an amount mismatch is REPORTED, not re-matched away', () => {
    // The whole reason the feature exists. Matching on amount would have paired
    // this row with some other receipt and reported everything as fine.
    const r = matchClaims(
      [row(4, '2026-02-26', 30.6, 'Home to Apple')],
      [rcpt('2026-02-26', 36.0)],
    );
    expect(r.summary.discrepancies).toBe(1);
    expect(r.matches[0].discrepancy).toEqual({ claimed: 30.6, onReceipt: 36.0, difference: 5.4 });
  });

  test('identical amounts on different dates do not cross-match', () => {
    // The real form has 15.80 twice, months apart.
    const r = matchClaims(
      [row(1, '2026-02-23', 15.8), row(7, '2026-04-09', 15.8)],
      [rcpt('2026-04-09', 15.8), rcpt('2026-02-23', 15.8)],
    );
    expect(r.matches.find(m => m.row.no === 1).receipt.date).toBe('2026-02-23');
    expect(r.matches.find(m => m.row.no === 7).receipt.date).toBe('2026-04-09');
  });

  test('several rows on one date are separated by amount', () => {
    // The real form has three lines on 2026-02-26.
    const r = matchClaims(
      [row(2, '2026-02-26', 56.7), row(3, '2026-02-26', 81.7), row(4, '2026-02-26', 30.6)],
      [rcpt('2026-02-26', 30.6), rcpt('2026-02-26', 81.7), rcpt('2026-02-26', 56.7)],
    );
    expect(r.summary.verified).toBe(3);
    for (const m of r.matches) expect(m.receipt.total).toBe(m.row.amount);
  });

  test('a claim line with no receipt is reported, not force-matched', () => {
    // Better to say "no receipt" than to attach an unrelated one.
    const r = matchClaims(
      [row(1, '2026-02-23', 15.8), row(9, '2026-11-30', 500, 'Taxi to airport')],
      [rcpt('2026-02-23', 15.8)],
    );
    expect(r.summary.missingReceipts).toBe(1);
    expect(r.unmatchedRows[0].no).toBe(9);
  });

  test('a receipt nobody claimed for is reported too', () => {
    const r = matchClaims([row(1, '2026-02-23', 15.8)], [rcpt('2026-02-23', 15.8), rcpt('2026-07-01', 99)]);
    expect(r.summary.extraReceipts).toBe(1);
    expect(r.unmatchedReceipts[0].total).toBe(99);
  });

  test('a day either side still matches — posting dates drift', () => {
    const r = matchClaims([row(1, '2026-02-23', 15.8)], [rcpt('2026-02-24', 15.8)]);
    expect(r.summary.matched).toBe(1);
    expect(r.matches[0].reasons).toContain('a day apart');
  });

  test('a match on one weak signal is flagged for a human', () => {
    const r = matchClaims([row(1, '2026-02-23', 30.6)], [rcpt('2026-02-23', 99.9)]);
    expect(r.matches[0].weak).toBe(true);
    expect(r.matches[0].discrepancy).not.toBeNull();
  });

  test('an unreadable receipt with no date and no total matches nothing', () => {
    const r = matchClaims([row(1, '2026-02-23', 15.8)], [{ merchant: null, date: null, total: null }]);
    expect(r.summary.matched).toBe(0);
    expect(r.summary.missingReceipts).toBe(1);
  });

  test('the merchant name in the description breaks a tie', () => {
    const r = matchClaims(
      [row(1, '2026-02-23', 20, 'Grab to the office'), row(2, '2026-02-23', 20, 'Gojek to the airport')],
      [rcpt('2026-02-23', 20, 'Gojek'), rcpt('2026-02-23', 20, 'Grab')],
    );
    expect(r.matches.find(m => m.row.no === 1).receipt.merchant).toBe('Grab');
    expect(r.matches.find(m => m.row.no === 2).receipt.merchant).toBe('Gojek');
  });

  test('empty input is handled', () => {
    expect(matchClaims([], []).summary).toMatchObject({ total: 0, matched: 0 });
    expect(matchClaims().summary.total).toBe(0);
  });

  describe('helpers', () => {
    test('amounts agree to the cent', () => {
      expect(sameAmount(15.8, 15.80)).toBe(true);
      expect(sameAmount(15.8, 15.81)).toBe(false);
      expect(sameAmount(null, 15.8)).toBe(false);
    });
    test('daysApart handles missing dates', () => {
      expect(daysApart('2026-02-23', '2026-02-24')).toBe(1);
      expect(daysApart(null, '2026-02-24')).toBeNull();
    });
    test('textOverlap ignores short words', () => {
      expect(textOverlap('Grab to meeting', 'Grab')).toBe(true);
      expect(textOverlap('trip to the shop', 'CDG')).toBe(false);   // too short to be a signal
    });
  });
});
