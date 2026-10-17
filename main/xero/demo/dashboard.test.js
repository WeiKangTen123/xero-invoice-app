// Every dashboard tab and every check, run as the app runs them, for a demo
// account: a real user (users.is_demo), the real token cache minting its
// 'demo:<userId>' token, the real api-client handing the report modules the
// facade, the real cache and database. Nothing is mocked but the model client
// the AI commentary would reach for, and no test here can reach Xero: a demo
// account has no token to reach it with.
//
// What is asserted is what the brief asks of the Demo Company: every report
// answers in full — nothing unavailable, nothing "could not be read", no nil
// where a figure belongs — every tie-out ties, the budget is there for this
// year and not for 2031, the P&L of a month is the ledger's, the Balance
// Sheet balances, the Bank Summary closes on the ledger's balance, and the
// figures are the same twice over.
jest.mock('../../utils/gemini-client', () => ({ callGemini: jest.fn().mockRejectedValue(new Error('no model in tests')), GEMINI_MODELS: [] }));

require('../../db/migrate').run();
const users   = require('../../utils/users');
const reports = require('../reports');
const { getBudgetCheck } = require('../budget-check');
const { getCashMonthly } = require('../cash-monthly');
const { _cache } = require('../report-cache');
const { _netRow } = require('../budget-variance');
const { DEMO_TENANT } = require('./api');
const { demoCompany } = require('./company');

const T = DEMO_TENANT.tenantId;
const TZ = 'Asia/Singapore';
const NOW = new Date('2026-10-17T06:00:00Z');   // 14:00 in Singapore: today is 17 Oct 2026
const TODAY = '2026-10-17';
const REAL = ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance'];

let U, co;
beforeAll(async () => {
  const demo = await users.createUser(`demo-dashboard-${Date.now()}@test.com`, 'password123', 'user', { demo: true });
  U = demo.id;
  jest.useFakeTimers({ now: NOW, doNotFake: REAL });
  co = demoCompany(TODAY);
});
afterAll(() => jest.useRealTimers());
beforeEach(() => _cache.clear());

// Every path in a payload at which `available` is false, or a note says
// something could not be read.
function unavailable(obj, path = '', out = []) {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) { obj.forEach((v, i) => unavailable(v, `${path}[${i}]`, out)); return out; }
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'available' && v === false) out.push(path || '.');
    if (typeof v === 'string' && /could not be read|unavailable|not yet reconnected/i.test(v) && /notes|reason|message/i.test(k + path)) out.push(`${path}.${k}: ${v.slice(0, 80)}`);
    else unavailable(v, `${path}.${k}`, out);
  }
  return out;
}
const sumLedger = (from, to, pred) => { let s = 0; for (const l of co.lines) { if (l.date < from || l.date > to) continue; if (pred(l)) s += l.cents; } return s / 100; };
const ledgerNet = (from, to) => -sumLedger(from, to, l => co.byCode.get(l.code).isPnl);
const ledgerBalance = (code, to) => sumLedger('0000-00-00', to, l => l.code === code);
const stripStamps = x => JSON.parse(JSON.stringify(x, (k, v) => (['fetchedAt', 'cached', 'checkedAt', 'calls'].includes(k) ? undefined : v)));

describe('the Dashboard header: getSummary and the ageing', () => {
  let summary;
  beforeAll(async () => { summary = await reports.getSummary(U, T, { timezone: TZ }); });

  test('the organisation, the open invoices and bills, what is overdue, the credits netted', () => {
    expect(summary.organisation).toEqual({ name: 'Demo Company Pte Ltd', country: 'SG', currency: 'SGD', yearEnd: '31/12' });
    expect(summary.kpis.totalReceivables).toBeGreaterThan(100000);
    expect(summary.kpis.totalPayables).toBeGreaterThan(20000);
    expect(summary.kpis.receivablesCount).toBeGreaterThanOrEqual(6);
    expect(summary.kpis.receivablesCount).toBeLessThanOrEqual(14);
    expect(summary.kpis.payablesCount).toBeGreaterThanOrEqual(5);
    expect(summary.kpis.overdueReceivablesCount).toBeGreaterThanOrEqual(3);
    expect(summary.kpis.overdueReceivables).toBeGreaterThan(0);
    expect(summary.kpis.creditsNetted).toEqual({ receivables: 1635, payables: 2289 });
    expect(summary.kpis.creditsUnavailable).toBe(false);
    expect(summary.invoices).toHaveLength(50);
    expect(summary.invoices[0]).toMatchObject({ currency: 'SGD', type: expect.stringMatching(/^(Sale|Bill)$/), status: expect.stringMatching(/^(paid|awaiting|overdue)$/) });
    expect(Object.keys(summary.raisedByMonth).length).toBeGreaterThan(40);
    expect(summary.raisedByMonth['2025-06'].sales).toBeGreaterThan(100000);
    expect(unavailable(summary)).toEqual([]);
  });

  test('the receivables ageing is the same invoices by age, one of them over sixty days, the credit note subtracted', async () => {
    const ag = await reports.getAgeing(U, T, { side: 'receivables', timezone: TZ });
    expect(ag.asOf).toBe(TODAY);
    expect(ag.count).toBe(summary.kpis.receivablesCount);
    expect(ag.total).toBeCloseTo(summary.kpis.totalReceivables, 2);
    expect(ag.credits).toEqual({ netted: true, count: 1, amount: 1635 });
    expect(ag.buckets.find(b => b.key === 'd61_90').amount).toBeGreaterThan(0);
    expect(ag.contacts.find(c => c.name === 'Orchid Grove Clinics').buckets.d61_90).toBeGreaterThan(0);
    expect(ag.contacts.length).toBeGreaterThanOrEqual(4);
    expect(ag.incomplete).toBe(false);
    expect(ag.notes.join(' ')).not.toMatch(/could not be read/);
    expect(ag.contacts.every(c => c.invoices.length > 0)).toBe(true);
  });

  test('the payables ageing likewise', async () => {
    const ag = await reports.getAgeing(U, T, { side: 'payables', timezone: TZ });
    expect(ag.count).toBe(summary.kpis.payablesCount);
    expect(ag.total).toBeCloseTo(summary.kpis.totalPayables, 2);
    expect(ag.credits).toEqual({ netted: true, count: 1, amount: 2289 });
    expect(ag.contacts.length).toBeGreaterThanOrEqual(3);
    expect(ag.notes.join(' ')).not.toMatch(/could not be read/);
  });

  test('the same figures on a second read, and after a refresh', async () => {
    const again = await reports.getSummary(U, T, { timezone: TZ });
    expect(stripStamps(again)).toEqual(stripStamps(summary));
    _cache.clear();
    const forced = await reports.getSummary(U, T, { timezone: TZ, force: true });
    expect(stripStamps(forced)).toEqual(stripStamps(summary));
  });
});

describe('Budget vs Actual: getBudgetVariance and its check', () => {
  test('the financial year: a budget on every account, nine closed months, October current, the net of a month equal to the ledger\'s', async () => {
    const bv = await reports.getBudgetVariance(U, T, { timezone: TZ, period: { preset: 'fy' } });
    expect(bv.organisation).toEqual({ name: 'Demo Company Pte Ltd', currency: 'SGD' });
    expect(bv.fiscalYear).toMatchObject({ fromISO: '2026-01-01', toISO: '2026-12-31', label: 'For the year ended 31 December 2026' });
    expect(bv.budgetMissing).toBe(false);
    expect(bv.budgets).toEqual([{ id: expect.any(String), type: 'OVERALL', description: 'Overall Budget' }]);
    expect(bv.kpis.monthsElapsed).toBe(9);
    expect(bv.months[9]).toMatchObject({ key: '2026-10', source: 'budget', current: true });
    const sales = bv.rows.find(r => r.label === 'Sales');
    expect(sales).toMatchObject({ kind: 'account', section: 'Income', unbudgeted: false });
    expect(sales.monthly.slice(0, 9).every(m => m.actual > 100000 && m.budget > 100000)).toBe(true);
    expect(sales.monthly.slice(0, 9).some(m => m.variance > 0)).toBe(true);
    expect(sales.monthly.slice(0, 9).some(m => m.variance < 0)).toBe(true);
    // Every account that mattered last year is budgeted; an account that saw
    // nothing last year and something this year is unbudgeted, as in Xero.
    for (const label of ['Sales', 'Cost of Goods Sold', 'Rent', 'Wages and Salaries', 'CPF Contributions', 'Depreciation', 'Interest Income']) {
      expect(bv.rows.find(r => r.label === label)).toMatchObject({ kind: 'account', unbudgeted: false });
    }
    expect(bv.rows.filter(r => r.kind === 'account' && r.unbudgeted).length).toBeLessThanOrEqual(3);
    const net = _netRow(bv.rows);
    for (const [i, key] of ['2026-03', '2026-06', '2026-09'].map(k => [bv.months.findIndex(m => m.key === k), k])) {
      expect(net.monthly[i].actual).toBeCloseTo(ledgerNet(`${key}-01`, `${key}-31`), 2);
    }
    expect(net.actualToDate).toBeCloseTo(ledgerNet('2026-01-01', '2026-09-30'), 2);
    expect(bv.kpis.currentMonth).toMatchObject({ key: '2026-10', asOf: TODAY });
    expect(bv.kpis.currentMonth.actualNet).toBeCloseTo(ledgerNet('2026-10-01', '2026-10-31'), 2);
    const wages = bv.rows.find(r => r.label === 'Wages and Salaries');
    expect(wages).toMatchObject({ section: 'Less Operating Expenses', expense: true });
  });

  test('a custom span longer than a year is fetched in chunks and lines up month for month', async () => {
    const bv = await reports.getBudgetVariance(U, T, { timezone: TZ, period: { from: '2024-11', to: '2026-10' } });
    expect(bv.period).toMatchObject({ key: 'custom', months: 24, chunks: 2, fromKey: '2024-11', toKey: '2026-10' });
    expect(bv.budgetMissing).toBe(false);
    const net = _netRow(bv.rows);
    for (const key of ['2024-12', '2025-02', '2025-07', '2026-01', '2026-09']) {
      const i = bv.months.findIndex(m => m.key === key);
      expect(net.monthly[i].actual).toBeCloseTo(ledgerNet(`${key}-01`, `${key}-31`), 2);
    }
    // The budget covers 2026 and not 2025, so last year's columns are nil budget.
    const sales = bv.rows.find(r => r.label === 'Sales');
    expect(sales.monthly[bv.months.findIndex(m => m.key === '2025-06')].budget).toBe(0);
    expect(sales.monthly[bv.months.findIndex(m => m.key === '2026-06')].budget).toBeGreaterThan(0);
  });

  test('2031 has no budget, and says so', async () => {
    const bv = await reports.getBudgetVariance(U, T, { timezone: TZ, period: { from: '2031-01', to: '2031-12' } });
    expect(bv.budgetMissing).toBe(true);
    expect(bv.rows.filter(r => r.kind === 'account')).toEqual([]);
    expect(_netRow(bv.rows).total).toBe(0);
  });

  test('the Budget check against Xero passes: the closed span, the last month and the quarters', async () => {
    const check = await getBudgetCheck(U, T, { timezone: TZ, period: { preset: 'fy' } });
    expect(check.ok).toBe(true);
    expect(check.checks.map(c => [c.key, c.skipped, c.ok])).toEqual([['span', false, true], ['month', false, true], ['quarters', false, true]]);
    expect(check.checks.every(c => c.differences.length === 0 && c.onlyInXero.length === 0 && c.onlyInApp.length === 0)).toBe(true);
    expect(check.period).toMatchObject({ closedMonths: 9, closedToLabel: 'Sep 2026' });
  });
});

describe('the Overview and Revenue tabs: getPerformance', () => {
  let perf;
  beforeAll(async () => { perf = await reports.getPerformance(U, T, { timezone: TZ, window: 'fy', cashFlow: true, customers: true, compare: 'prior-year' }); });

  test('revenue, costs and profit as series; cash from the bank; nothing unavailable', () => {
    expect(perf.months).toHaveLength(12);
    expect(perf.actualThroughIdx).toBe(8);
    expect(perf.closedThroughIdx).toBe(8);
    const rev = perf.totals.revenue.actual;
    expect(rev.slice(0, 9).every(v => v > 100000)).toBe(true);
    expect(rev.slice(10).every(v => v === 0)).toBe(true);
    expect(perf.totals.cogs.actual[5] / rev[5]).toBeCloseTo(0.45, 1);
    expect(perf.totals.grossProfit.actual[5]).toBeCloseTo(rev[5] - perf.totals.cogs.actual[5], 2);
    expect(perf.totals.netProfit.actual.slice(0, 9).reduce((s, v) => s + v, 0)).toBeCloseTo(ledgerNet('2026-01-01', '2026-09-30'), 2);
    expect(perf.serviceLines.map(l => l.label)).toEqual(['Sales', 'Other Revenue', 'Interest Income']);
    expect(perf.expenseLines.some(l => l.label === 'Rent')).toBe(true);
    expect(perf.cash).toMatchObject({ available: true, currency: 'SGD', flowScope: 'period', baseOnly: false });
    expect(perf.cash.total).toBeCloseTo(ledgerBalance('090', TODAY) + ledgerBalance('091', TODAY), 2);
    expect(perf.cash.accounts.map(a => a.name)).toEqual(['Business Bank Account', 'Business Savings Account']);
    expect(perf.paymentDays).toMatchObject({ available: true, closedMonths: 9 });
    expect(perf.paymentDays.dso).toBeGreaterThan(15);
    expect(perf.paymentDays.dso).toBeLessThan(90);
    expect(perf.paymentDays.dpo).toBeGreaterThan(5);
    expect(perf.growth).toMatchObject({ available: true, closedMonths: 9 });
    expect(perf.watchList.filter(w => w.severity === 'warn')).toEqual([]);
    expect(unavailable(perf)).toEqual([]);
  });

  test('top customers and the quote pipeline', () => {
    expect(perf.customerRevenue.available).toBe(true);
    expect(perf.customerRevenue.count).toBeGreaterThanOrEqual(20);
    expect(perf.customerRevenue.customers[0].invoiced).toBeGreaterThan(perf.customerRevenue.customers.at(-1).invoiced);
    expect(perf.quotePipeline).toMatchObject({ available: true, counts: { sent: 2, accepted: 1 }, expired: { count: 1 } });
    expect(perf.quotePipeline.total).toBeGreaterThan(0);
  });

  test('the same months last year compare the nine closed months', () => {
    expect(perf.priorYear).toMatchObject({ available: true, compared: { count: 9, fromLabel: 'Jan 2026', toLabel: 'Sep 2026', priorFromLabel: 'Jan 2025' } });
    expect(perf.priorYear.totals.revenue.pct).toBeGreaterThan(0.05);
    expect(perf.priorYear.totals.revenue.pct).toBeLessThan(0.35);
    expect(perf.priorYear.totals.revenue.total).toBeCloseTo(-sumLedger('2025-01-01', '2025-09-30', l => l.code === '200'), 2);
  });
});

describe('the Cash Flow tab: getCashFlow', () => {
  test('receipts and payments from the records, tied to the bank, the forecast from the open invoices', async () => {
    const cf = await reports.getCashFlow(U, T, { timezone: TZ, period: { preset: 'fy' } });
    expect(cf.recordsAvailable).toBe(true);
    expect(cf.cash).toMatchObject({ available: true, currency: 'SGD', baseOnly: false });
    expect(cf.cash.closing).toBeCloseTo(ledgerBalance('090', '2026-12-31') + ledgerBalance('091', '2026-12-31'), 2);
    expect(cf.cash.transfersIn).toBe(20000);
    expect(cf.movement.customerReceipts).toBeGreaterThan(1000000);
    expect(cf.movement.supplierPayments).toBeGreaterThan(500000);
    expect(cf.waterfall.reconciles).toBe(true);
    expect(Math.abs(cf.waterfall.gap)).toBe(0);
    expect(cf.unreconciled).toMatchObject({ material: false, inGap: 0, outGap: 0, transfersIn: 20000, transfersOut: 20000 });
    expect(cf.runway.available).toBe(true);
    expect(cf.forecast.weeks).toHaveLength(13);
    expect(cf.forecast.openingAsOf).toBe(TODAY);
    expect(cf.forecast.weeks.some(w => w.receipts > 0)).toBe(true);
    expect(cf.workingCapital.receivable).toBeGreaterThan(100000);
    expect(cf.workingCapital.dso).toBeGreaterThan(0);
    expect(cf.supplierSpend).toMatchObject({ available: true });
    expect(cf.supplierSpend.count).toBeGreaterThanOrEqual(15);
    expect(cf.hygiene.issues).toEqual([]);
    expect(cf.alerts.alerts.map(a => a.code)).not.toContain('unreconciled');
    expect(unavailable(cf)).toEqual([]);
  });
});

describe('the Balance Sheet tab: getBalanceSheet, its exact dates and its check', () => {
  const balances = sheet => sheet.columns.map((_, i) => {
    const total = key => sheet.groups.find(g => g.key === key);
    const assets = total('assets').total.values[i], liabilities = total('liabilities').total.values[i], equity = total('equity').subgroups[0].total.values[i];
    return { assets, liabilities, equity, gap: Math.abs(Math.round((assets - liabilities - equity) * 100) / 100), net: sheet.netAssets.values[i] };
  });

  test('the month end with two comparison months: assets equal liabilities plus equity in every column, the gate passes', async () => {
    const sheet = await reports.getBalanceSheet(U, T, { timezone: TZ, preset: 'last-month-end', compare: 'month', periods: 2 });
    expect(sheet.asAt).toMatchObject({ iso: '2026-09-30', label: '30 September 2026', source: 'balance-sheet', inProgress: false });
    expect(sheet.columns.map(c => c.label)).toEqual(['30 Sep 2026', '31 Aug 2026', '31 Jul 2026']);
    expect(sheet.notes).toEqual([]);
    for (const b of balances(sheet)) {
      expect(b.gap).toBe(0);
      expect(b.net).toBeCloseTo(b.equity, 2);
      expect(b.assets).toBeGreaterThan(300000);
    }
    const bank = sheet.groups[0].subgroups.find(s => s.title === 'Bank');
    expect(bank.rows.map(r => [r.label, r.code])).toEqual([['Business Bank Account', '090'], ['Business Savings Account', '091']]);
    expect(bank.rows[0].values[0]).toBeCloseTo(ledgerBalance('090', '2026-09-30'), 2);
    expect(sheet.groups[1].subgroups.map(s => s.title)).toEqual(['Current Liabilities', 'Non-current Liabilities']);
    expect(sheet.groups[2].subgroups[0].rows.map(r => r.label)).toEqual(['Current Year Earnings', 'Owner A Drawings', 'Retained Earnings', 'Owner A Share Capital']);
    expect(sheet.exactDates).toMatchObject({ ok: true, reason: 'ok', at: '2026-09-30', differences: [] });
    expect(sheet.exactDates.lines).toBeGreaterThan(20);
    expect(sheet.exactDates.matched).toBe(sheet.exactDates.lines);
    // The change from a month earlier, as the screen shows it, is a real figure.
    const b = balances(sheet);
    expect(b[0].assets).not.toBe(b[1].assets);
  });

  test('today and a chosen day come from the Trial Balance, and balance too', async () => {
    const today = await reports.getBalanceSheet(U, T, { timezone: TZ, preset: 'today' });
    expect(today.asAt).toMatchObject({ iso: TODAY, source: 'trial-balance', inProgress: true });
    expect(balances(today)[0].gap).toBe(0);
    expect(today.groups[0].subgroups.find(s => s.title === 'Bank').rows[0].values[0]).toBeCloseTo(ledgerBalance('090', TODAY), 2);
    const day = await reports.getBalanceSheet(U, T, { timezone: TZ, preset: 'date', date: '2026-10-05', compare: 'month', periods: 2 });
    expect(day.columns.map(c => c.iso)).toEqual(['2026-10-05', '2026-09-05', '2026-08-05']);
    for (const b of balances(day)) expect(b.gap).toBe(0);
    expect(day.notes).toEqual([]);
  });

  test('the cash basis balances and passes its gate as well', async () => {
    const sheet = await reports.getBalanceSheet(U, T, { timezone: TZ, basis: 'cash' });
    expect(balances(sheet)[0].gap).toBe(0);
    expect(sheet.exactDates).toMatchObject({ ok: true, basis: 'cash' });
    // No debtors or creditors on a cash basis.
    const labels = sheet.groups.flatMap(g => g.subgroups.flatMap(s => s.rows.map(r => r.label)));
    expect(labels).not.toContain('Accounts Receivable');
    expect(labels).not.toContain('Accounts Payable');
  });

  test('the Balance Sheet check against Xero passes all four checks', async () => {
    const check = await reports.getBalanceCheck(U, T, { timezone: TZ, preset: 'last-month-end', compare: 'month', periods: 1 });
    expect(check.ok).toBe(true);
    expect(check.checks.map(c => [c.key, c.skipped, c.ok])).toEqual([['identity', false, true], ['subtotals', false, true], ['bank', false, true], ['trialbalance', false, true]]);
    expect(check.checks.every(c => c.differences.length === 0 && c.onlyInXero.length === 0 && c.onlyInApp.length === 0)).toBe(true);
    expect(check.checks.find(c => c.key === 'bank').excluded).toEqual([]);
    expect(check.checks.find(c => c.key === 'trialbalance').lines).toBeGreaterThan(20);
  });
});

describe('the Cash Flow Manager, the monthly forecast and their check', () => {
  let cm;
  beforeAll(async () => { cm = await reports.getCashManager(U, T, { timezone: TZ }); });

  test('today\'s balance from the bank, every open document placed, the last thirty days tied to the Bank Summary', () => {
    expect(cm.today).toBe(TODAY);
    expect(cm.bank).toMatchObject({ available: true, unavailableReason: null });
    expect(cm.bank.balance).toBeCloseTo(ledgerBalance('090', TODAY) + ledgerBalance('091', TODAY), 2);
    expect(cm.bank.accounts.map(a => [a.name, a.included, a.foreign])).toEqual([['Business Bank Account', true, false], ['Business Savings Account', true, false]]);
    expect(cm.actualsAvailable).toBe(true);
    expect(cm.actuals).toHaveLength(30);
    expect(cm.actuals.every(d => d.balance !== null)).toBe(true);
    expect(cm.actualsCheck).toMatchObject({ agrees: true });
    expect(cm.actualItems.length).toBeGreaterThan(20);
    const sources = new Set(cm.items.map(i => i.source));
    for (const s of ['invoice', 'bill', 'repeating', 'banktx']) expect(sources.has(s)).toBe(true);
    expect(cm.items.filter(i => i.source === 'invoice')).toHaveLength(cm.open.receivables.count);
    expect(cm.items.some(i => i.dateBasis === 'predicted')).toBe(true);
    expect(cm.items.some(i => i.dateBasis === 'expected')).toBe(true);
    expect(cm.items.some(i => i.dateBasis === 'planned')).toBe(true);
    // The slow payers are dated by their habit, so fewer read overdue here than in the ageing; some still do.
    expect(cm.items.filter(i => i.overdue).length).toBeGreaterThanOrEqual(1);
    expect(cm.tiles.overdue.in).toBeGreaterThan(0);
    expect(cm.items.some(i => i.source === 'invoice' && i.creditApplied > 0)).toBe(true);
    expect(cm.series).toHaveLength(91);
    expect(cm.series.every(d => d.balance !== null)).toBe(true);
    expect(cm.runwayDays).toBeNull();
    expect(cm.notes.join(' ')).not.toMatch(/could not be read|does not tie/);
    expect(cm.notes.join(' ')).toMatch(/2 approved repeating templates add/);
    expect(unavailable(cm)).toEqual([]);
  });

  test('the monthly forecast: six past months tying to the Bank Summary, this month, six ahead filled from the budget', async () => {
    const p = await getCashMonthly(U, T, { timezone: TZ, past: 6, future: 6 });
    expect(p.months.map(m => m.kind)).toEqual([...Array(6).fill('actual'), 'current', ...Array(6).fill('forecast')]);
    expect(p.currentMonth).toBe('2026-10');
    expect(p.ties).toHaveLength(6);
    expect(p.ties.every(t => t.agrees)).toBe(true);
    const rowsOf = Object.fromEntries(p.rows.map(r => [r.key, r]));
    for (const key of ['opening', 'closing', 'in_customer', 'in_total', 'out_supplier', 'out_wages', 'out_tax', 'out_total', 'net']) {
      expect(rowsOf[key].values.every(v => v !== null)).toBe(true);
    }
    const at = (key, month) => rowsOf[key].values[p.months.findIndex(m => m.key === month)];
    expect(at('closing', '2026-09')).toBeCloseTo(ledgerBalance('090', '2026-09-30') + ledgerBalance('091', '2026-09-30'), 2);
    expect(at('opening', '2026-10')).toBeCloseTo(at('closing', '2026-09'), 2);
    expect(at('out_wages', '2026-09')).toBeGreaterThan(40000);
    expect(at('out_tax', '2026-07')).toBeGreaterThan(0);
    expect(at('out_finance', '2026-09')).toBeGreaterThan(3000);
    expect(at('in_customer', '2026-12')).toBeGreaterThan(100000);
    expect(rowsOf.in_customer.sources[p.months.findIndex(m => m.key === '2027-02')]).toMatch(/budget/);
    expect(at('out_other', '2026-09')).toBe(0);
    expect(p.notes.join(' ')).not.toMatch(/could not be read|does not tie|does not add up|no Overall Budget/);
    expect(p.notes.join(' ')).toMatch(/Where the Overall Budget in Xero expects more/);
  });

  test('the Cash Flow Manager check against Xero passes all three checks', async () => {
    const check = await reports.getCashManagerCheck(U, T, { timezone: TZ });
    expect(check.ok).toBe(true);
    expect(check.checks.map(c => [c.key, c.skipped, c.ok])).toEqual([['balance', false, true], ['receivables', false, true], ['payables', false, true]]);
    expect(check.checks.every(c => c.differences.length === 0 && c.onlyInXero.length === 0 && c.onlyInApp.length === 0)).toBe(true);
  });
});

describe('the bank and the directory', () => {
  test('the Bank Summary closes on the ledger\'s balance, and lists both accounts with no movement', async () => {
    const bank = await reports.getBankSummary(U, T, { from: '2026-09-16', to: TODAY });
    expect(bank.accounts.map(a => a.name)).toEqual(['Business Bank Account', 'Business Savings Account']);
    expect(bank.accounts[0].closingBalance).toBeCloseTo(ledgerBalance('090', TODAY), 2);
    expect(bank.accounts[1].closingBalance).toBeCloseTo(ledgerBalance('091', TODAY), 2);
    for (const a of bank.accounts) expect(a.openingBalance + a.cashReceived - a.cashSpent).toBeCloseTo(a.closingBalance, 2);
    // A span wider than a year is split into windows and merged.
    const wide = await reports.getBankSummary(U, T, { from: '2024-01-01', to: TODAY });
    expect(wide.accounts[0].closingBalance).toBeCloseTo(ledgerBalance('090', TODAY), 2);
    expect(wide.cashIn).toBeGreaterThan(wide.cashOut);
  });

  test('the statement, the chart, the bank accounts and the contacts', async () => {
    const { bankAccounts } = await reports.getBankAccounts(U, T);
    expect(bankAccounts.map(a => [a.name, a.currency])).toEqual([['Business Bank Account', 'SGD'], ['Business Savings Account', 'SGD']]);
    const { transactions } = await reports.getBankTransactions(U, T, bankAccounts[0].accountId);
    expect(transactions.length).toBeGreaterThan(200);
    expect(new Set(transactions.map(t => t.source))).toEqual(new Set(['bank', 'payment']));
    expect(transactions.every(t => /^\d{4}-\d{2}-\d{2}$/.test(t.date))).toBe(true);
    const { accounts } = await reports.getAccounts(U, T);
    expect(accounts.find(a => a.code === '820')).toMatchObject({ systemAccount: 'GST', type: 'CURRLIAB' });
    const { contacts } = await reports.getContacts(U, T);
    expect(contacts.length).toBeGreaterThanOrEqual(50);
    expect(contacts.filter(c => c.isCustomer)).toHaveLength(25);
    expect(contacts.filter(c => c.isSupplier)).toHaveLength(20);
  });
});
