// The figure guard and the variance figures it guards. Pure functions, so no
// Xero token and no model: what the model may say back is the whole safety
// argument, and it is tested here directly.
const ai = require('./ai-insights');

describe('the figure guard reads figures the way they are written', () => {
  test('k, M and bn amounts are read at full size', () => {
    expect(ai._largeNumbersIn('SGD 45.2k vs plan')).toEqual([45200]);
    expect(ai._largeNumbersIn('$2.4M in sales')).toEqual([2400000]);
    expect(ai._largeNumbersIn('USD 1.2bn')).toEqual([1200000000]);
    expect(ai._largeNumbersIn('about 12 thousand')).toEqual([12000]);
  });

  test('an amount with a currency is checked whatever its size', () => {
    expect(ai._largeNumbersIn('a fee of S$ 45')).toEqual([45]);
    expect(ai._largeNumbersIn('RM 50 and £7.20')).toEqual([50, 7.2]);
    expect(ai._largeNumbersIn('a 999 variance')).toEqual([]);   // no currency, under 1,000: a count
  });

  test('percentages are read', () => {
    expect(ai._percentsIn('down 12% on last month, 3.5 per cent on plan')).toEqual([12, 3.5]);
  });

  test('dates, times, years and references are not figures', () => {
    expect(ai._figuresIn('INV-2026099 dated 2026-04-21 at 12:01, FY2026, #1042, Q3, PayNow 202016196Z, 21/04/2026, in 2026')).toEqual([]);
  });

  test('a lone "m" is months unless a currency says otherwise', () => {
    expect(ai._largeNumbersIn('3m of runway')).toEqual([]);
    expect(ai._largeNumbersIn('SGD 3m of revenue')).toEqual([3000000]);
  });
});

describe('the figure guard checks every figure it reads', () => {
  const allowed = new Set([45213, 2412345, 12, 109330]);

  test('a figure written shorter still matches the figure it stands for', () => {
    expect(ai._insightIsGrounded('Revenue is SGD 45.2k ahead of plan.', allowed)).toBe(true);
    expect(ai._insightIsGrounded('Sales reached $2.4M.', allowed)).toBe(true);
    expect(ai._insightIsGrounded('You invoiced SGD 109,330.', allowed)).toBe(true);
  });

  test('an invented k/M amount or percentage no longer passes', () => {
    expect(ai._insightIsGrounded('Revenue is SGD 47.9k ahead of plan.', allowed)).toBe(false);
    expect(ai._insightIsGrounded('Sales reached $3.1M.', allowed)).toBe(false);
    expect(ai._insightIsGrounded('Costs rose 19%.', allowed)).toBe(false);
    expect(ai._insightIsGrounded('Costs rose 12%.', allowed)).toBe(true);
    expect(ai._insightIsGrounded('A fee of SGD 45 was charged.', allowed)).toBe(false);
  });

  test('counts of days, months and alerts stay free', () => {
    expect(ai._insightIsGrounded('Three of your 5 alerts share one cause over 4 months.', allowed)).toBe(true);
  });

  test('variance commentary may quote the k text it was given, and the share of budget', () => {
    const categories = [{ key: 'revenue', title: 'Revenue', actual: 85000, budget: 100000, variance: -15000, deltaText: '-SGD 15.0k vs plan', topDrivers: [{ name: 'Consulting', actual: 1000, budget: 2234, variance: -1234 }], defaultReason: 'd' }];
    const reply = JSON.stringify({ categories: [{ key: 'revenue', reason: 'Revenue is SGD 15.0k (15%) behind plan, reaching 85% of budget; Consulting is 1,234 short.' }], reasons: [] });
    expect(ai._parseInsights(reply, categories, []).categories[0].reason).toMatch(/15\.0k/);

    const invented = JSON.stringify({ categories: [{ key: 'revenue', reason: 'Revenue is 22% behind plan.' }], reasons: [] });
    expect(ai._parseInsights(invented, categories, []).categories[0].reason).toBe('d');
  });

  test('a percentage from an alert may be quoted back in the narrative', () => {
    const f = ai._narrativeFacts({ alerts: { alerts: [{ title: 'Most receivables are overdue', detail: '52% is past due' }] } });
    expect(ai._groundNarrative('Over half — 52% — is past due.', f.allowed).dropped).toBe(0);
    expect(ai._groundNarrative('Over half — 61% — is past due.', f.allowed).dropped).toBe(1);
  });
});

describe('_groundMarkdown — the same check on a chat reply, keeping its layout', () => {
  const allowed = new Set([109330, 26000]);

  test('a table row with an invented figure goes; the rest of the table stays', () => {
    const reply = 'Here are your figures:\n\n| Figure | Value |\n|---|---|\n| Invoiced | SGD 109,330 |\n| Margin | SGD 48,200 |\n| Collected | SGD 26,000 |';
    const r = ai._groundMarkdown(reply, allowed);
    expect(r.dropped).toBe(1);
    expect(r.text).toBe('Here are your figures:\n\n| Figure | Value |\n|---|---|\n| Invoiced | SGD 109,330 |\n| Collected | SGD 26,000 |');
  });

  test('prose is checked sentence by sentence, list markers kept', () => {
    const r = ai._groundMarkdown('- You invoiced SGD 109,330. Margin was 31%.\n- Collected SGD 26,000.', allowed);
    expect(r.text).toBe('- You invoiced SGD 109,330.\n- Collected SGD 26,000.');
    expect(r.dropped).toBe(1);
  });

  test('a grounded reply is returned unchanged', () => {
    const text = 'You invoiced **SGD 109,330** and collected SGD 26,000.\n\nAsk me about overdue invoices next.';
    expect(ai._groundMarkdown(text, allowed)).toMatchObject({ text, dropped: 0 });
  });
});

// ── Variance under a full-year period compares closed months only ─────────
// The series run the whole period: the month in progress has a few days of
// actuals, the months after it none, and every month has a full budget.
// Summing all twelve called most of the year's budget an "unfavourable" gap.
describe('variance commentary compares closed months only, as the budget tab does', () => {
  // Four closed months (index 0-3), the current part-month (4), seven to come.
  const months = (closed, part) => Array.from({ length: 12 }, (_, i) => (i < 4 ? closed : i === 4 ? part : 0));
  const budgets = () => Array(12).fill(1000);
  const perf = {
    organisation: { currency: 'SGD' },
    actualThroughIdx: 3, closedThroughIdx: 3,
    totals: {
      revenue: { actual: months(1100, 300), budget: budgets() },
      cogs:    { actual: months(0, 0),      budget: Array(12).fill(0) },
      opex:    { actual: months(900, 200),  budget: budgets() },
    },
    serviceLines: [{ label: 'Consulting', actual: months(1100, 300), budget: budgets() }],
    expenseLines: [{ label: 'Rent', kind: 'opex', actual: months(900, 200), budget: budgets() }],
  };

  test('category variances sum the closed months only', () => {
    const [rev, , opex] = ai._buildCategoryVariances(perf, null);
    expect(rev).toMatchObject({ actual: 4400, budget: 4000, variance: 400, status: 'favorable' });
    expect(opex).toMatchObject({ actual: 3600, budget: 4000, variance: -400, status: 'favorable' });
    expect(rev.topDrivers[0]).toMatchObject({ name: 'Consulting', variance: 400 });
  });

  test('account candidates sum the closed months only', () => {
    const c = ai._varianceCandidates(perf);
    expect(c.find(x => x.account === 'Consulting')).toMatchObject({ actual: 4400, budget: 4000, variance: 400 });
    expect(c.find(x => x.account === 'Rent')).toMatchObject({ actual: 3600, budget: 4000, variance: -400 });
  });

  test('the smaller of the two closed markers wins', () => {
    expect(ai._closedMonthCount({ actualThroughIdx: 4, closedThroughIdx: 3 })).toBe(4);
    expect(ai._closedMonthCount({})).toBeNull();
  });

  test('with no month closed, nothing is compared and the reason says so', () => {
    const cats = ai._buildCategoryVariances({ ...perf, actualThroughIdx: -1, closedThroughIdx: -1 }, null);
    expect(cats[0]).toMatchObject({ actual: 0, budget: 0, variance: 0 });
    expect(cats[0].defaultReason).toMatch(/No month of this period has closed yet/);
  });

  test('a perf without closed markers keeps the whole series, as before', () => {
    const bare = { ...perf };
    delete bare.actualThroughIdx;
    delete bare.closedThroughIdx;
    const [rev] = ai._buildCategoryVariances(bare, null);
    expect(rev.budget).toBe(12000);
  });

  // The cash card compared the period's receipts with the period's revenue
  // while the three beside it compared the closed months', so the four cards
  // did not describe the same months.
  const cf = {
    movement: { customerReceipts: 4200, monthly: { customerReceipts: months(1000, 200) } },
    reconciliation: { revenueAccrual: 4700, customerReceipts: 4200 },
  };
  const cashOf = (p, c) => ai._buildCategoryVariances(p, c).find(x => x.key === 'cash');

  test('the cash category is on the closed months too: receipts from the monthly series, revenue the closed months\'', () => {
    expect(cashOf(perf, cf)).toMatchObject({ actual: 4000, budget: 4400, variance: -400, status: 'unfavorable' });
  });

  test('without a monthly series both sides stay the period totals, on one basis', () => {
    const totalsOnly = { reconciliation: cf.reconciliation };
    expect(cashOf(perf, totalsOnly)).toMatchObject({ actual: 4200, budget: 4700, variance: -500 });
  });

  test('a perf without closed markers keeps the period totals for cash as well', () => {
    const bare = { ...perf };
    delete bare.actualThroughIdx;
    delete bare.closedThroughIdx;
    expect(cashOf(bare, cf)).toMatchObject({ actual: 4200, budget: 4700 });
  });

  test('with no month closed, cash compares nothing either', () => {
    expect(cashOf({ ...perf, actualThroughIdx: -1, closedThroughIdx: -1 }, cf)).toMatchObject({ actual: 0, budget: 0, variance: 0 });
  });
});
