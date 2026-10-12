// The Cash Flow tab's pure arithmetic, pinned after an audit found two
// figures that read as measurements of nothing:
//
//   * the runway averaged months in which no money moved at all and called
//     the result "0.00/mo, Taking in more than it spends" and "Self-funding";
//   * working capital counted every invoice it was handed, paid ones too, so
//     "Owed to you (2 sales invoices)" sat over an amount of 0.00.
const { _buildRunway, _buildWorkingCapital } = require('./cash-flow');

describe('the runway when no cash moved', () => {
  const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08'].map(key => ({ key }));
  const today = { year: 2026, month: 8, day: 26 };
  const zero = [0, 0, 0, 0, 0];

  test('nothing in and nothing out over the closed months is no figure, with the reason, never cash-positive', () => {
    const r = _buildRunway({ months, monthly: { in: zero, out: zero, customerReceipts: zero }, closing: 5000, today });
    expect(r).toMatchObject({ available: false, reason: 'No cash moved in the closed months' });
    expect(r.burning).toBeUndefined();
    expect(r.avgNet).toBeUndefined();
    expect(r.operatingNet).toBeUndefined();
    // Float dust is still nothing.
    expect(_buildRunway({ months, monthly: { in: [0.001, 0, 0, 0, 0], out: zero }, closing: 0, today }).available).toBe(false);
  });

  test('a first month with nothing moved yet says so; any movement at all is a figure', () => {
    expect(_buildRunway({ months: [{ key: '2026-08' }], monthly: { in: [0], out: [0] }, closing: 0, today }))
      .toMatchObject({ available: false, reason: 'No cash moved this month yet' });
    expect(_buildRunway({ months: [], monthly: { in: [], out: [] }, closing: 0, today }))
      .toMatchObject({ available: false, reason: 'No closed month yet' });
    expect(_buildRunway({ months, monthly: { in: zero, out: [0, 0, 0, 40, 0] }, closing: 100, today }))
      .toMatchObject({ available: true, burning: true, avgCashOut: 10 });
  });
});

describe('working capital counts only what is still owed', () => {
  const today = { year: 2026, month: 8, day: 26 };

  test('a paid invoice or bill adds to what was invoiced, not to the count owed', () => {
    const wc = _buildWorkingCapital({ today, invoices: [
      { type: 'ACCREC', total: 500, amountDue: 0,   dueDate: '2026-07-01' },
      { type: 'ACCREC', total: 300, amountDue: 0,   dueDate: '2026-07-15' },
      { type: 'ACCREC', total: 200, amountDue: 120, dueDate: '2026-09-15' },
      { type: 'ACCPAY', total: 90,  amountDue: 0,   dueDate: '2026-07-31' },
    ] });
    expect(wc.counts).toEqual({ receivable: 1, payable: 0 });
    expect(wc).toMatchObject({ receivable: 120, payable: 0, invoiced: 1000, collected: 880 });
  });

  test('two paid invoices owe nothing and count none', () => {
    const wc = _buildWorkingCapital({ today, invoices: [
      { type: 'ACCREC', total: 500, amountDue: 0, dueDate: '2026-07-01' },
      { type: 'ACCREC', total: 300, amountDue: 0, dueDate: '2026-07-15' },
    ] });
    expect(wc.counts.receivable).toBe(0);
    expect(wc.receivable).toBe(0);
  });
});
