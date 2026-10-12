const fs   = require('fs');
const path = require('path');

// The Dashboard's cards on the screen side: the Revenue tab's top customers
// and quotes, Banking's cash flow, the "Analysis up to date" stamp, the three
// headline cards and the Revenue and Profitability tiles. There is no React
// test setup in this project, so this follows live-updates-ui.test.js and
// dashboard-figures-ui.test.js: the decisions are plain functions, loaded
// whole from files with no imports or lifted out of primitives.jsx, and run
// here; the page's wiring is checked in its source.
const UI = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

// A file with no imports, run as it is, its exports handed back.
function loadHelpers(rel) {
  const src = read(rel);
  expect(src).not.toMatch(/^import /m);
  const names = [...src.matchAll(/^export function (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}

// The source of `export function NAME(...) { ... }`, by matching braces from
// its first one, evaluated with whatever it uses handed in by name.
function functionSource(src, name) {
  const start = src.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1).replace(/^export /, '');
}
function lift(rel, name, deps = {}) {
  const body = `${functionSource(read(rel), name)}\nreturn ${name};`;
  return new Function(...Object.keys(deps), body)(...Object.values(deps));
}

const fmtMoney = (v, c) => `${c ? `${c} ` : ''}${Number(v || 0).toFixed(2)}`;
const fmtPct   = (v, d) => `${(v * 100).toFixed(d)}%`;

const req  = loadHelpers('pages/xero-insights/perf-requests.js');
const head = loadHelpers('pages/xero-insights/headline.js');
const P = 'components/performance/primitives.jsx';
const closedSpan       = lift(P, 'closedSpan');
const closedSum        = lift(P, 'closedSum');
const recurringRunRate = lift(P, 'recurringRunRate', { closedSpan, closedSum });
const recurringTile    = lift(P, 'recurringTile', { fmtMoney, fmtPct });
const extrasState      = lift(P, 'extrasState');
const quoteCard        = lift(P, 'quoteCard', { extrasState, fmtMoney });
const grossProfitFoot  = lift(P, 'grossProfitFoot', { fmtMoney });
const lineBudgetText   = lift(P, 'lineBudgetText', { fmtMoney });

const page = read('pages/XeroInsights.jsx');
const done = data => ({ status: 'done', error: '', data });
// The Overview's report: no customers asked for, cash flow over 31 days.
const overviewReply = () => ({
  customerRevenue: { available: false, reason: 'not-asked' },
  quotePipeline:   { available: false, reason: 'not-asked' },
  cash: { flowScope: 'last31d' },
});

describe('the Revenue tab reached from Overview asks again for the top customers and quotes', () => {
  test('a report that never asked is asked again with them, once, and a re-ask of one that had them keeps them', () => {
    const d = overviewReply();
    expect(req.shouldReaskCustomers('revenue', done(d), null)).toBe(true);
    // A server from before the reason, or a report with none at all.
    expect(req.shouldReaskCustomers('revenue', done({ customerRevenue: { available: false } }), null)).toBe(true);
    expect(req.shouldReaskCustomers('revenue', done({}), null)).toBe(true);
    // Not on another tab, not while loading or failed, never for the reply to
    // a request that already asked, and not when they came back or failed.
    expect(req.shouldReaskCustomers('overview', done(d), null)).toBe(false);
    expect(req.shouldReaskCustomers('revenue', { status: 'loading', error: '', data: d }, null)).toBe(false);
    expect(req.shouldReaskCustomers('revenue', { status: 'done', error: 'boom', data: d }, null)).toBe(false);
    expect(req.shouldReaskCustomers('revenue', done(d), d)).toBe(false);
    expect(req.shouldReaskCustomers('revenue', done({ customerRevenue: { available: true } }), null)).toBe(false);
    expect(req.shouldReaskCustomers('revenue', done({ customerRevenue: { available: false, reason: 'failed' } }), null)).toBe(false);

    // What a request asks for: the open tab's, plus what figures on screen
    // already carried when it is a re-ask of them.
    const withCustomers = { customerRevenue: { available: true }, cash: { flowScope: 'last31d' } };
    expect(req.perfExtras('revenue')).toEqual({ customers: true, cashFlow: false });
    expect(req.perfExtras('overview', withCustomers)).toEqual({ customers: true, cashFlow: false });
    expect(req.perfExtras('overview', null)).toEqual({ customers: false, cashFlow: false });
    expect(req.perfExtras('overview', overviewReply())).toEqual({ customers: false, cashFlow: false });

    // The page: re-asks quietly from an effect, guarded by the reply, and a
    // compare or live re-ask passes the figures on screen.
    expect(page).toMatch(/shouldReaskCustomers\(tab, perf, customersReply\.current\)/);
    expect(page).toMatch(/if \(params\.has\('customers'\)\) customersReply\.current = d;/);
    expect(page).toMatch(/fetchPerf\(\{ quiet: true \}\);\s+\}, \[tab, perf\.status, perf\.data\]\);/);
    expect(page).toMatch(/perfExtras\(tab, opts\.figuresOnly \|\| opts\.quiet \? perf\.data : null\)/);
    expect(page).not.toMatch(/if \(tab === 'revenue'\) params\.set\('customers'/);
  });
});

describe('the Banking tab reached from Overview asks again for the period\'s cash flow', () => {
  test('cash in and out over the last 31 days are asked for again over the period, once', () => {
    const d = overviewReply();
    expect(req.shouldReaskCashFlow('banking', done(d), null)).toBe(true);
    expect(req.shouldReaskCashFlow('banking', done({}), null)).toBe(true);
    expect(req.shouldReaskCashFlow('banking', done(d), d)).toBe(false);
    expect(req.shouldReaskCashFlow('revenue', done(d), null)).toBe(false);
    expect(req.shouldReaskCashFlow('banking', done({ cash: { flowScope: 'period', available: false } }), null)).toBe(false);
    expect(req.perfExtras('banking')).toEqual({ customers: false, cashFlow: true });
    expect(req.perfExtras('profit', { cash: { flowScope: 'period' } })).toEqual({ customers: false, cashFlow: true });
    expect(page).toMatch(/shouldReaskCashFlow\(tab, perf, cashFlowReply\.current\)/);
    expect(page).toMatch(/if \(params\.has\('cashFlow'\)\) cashFlowReply\.current = d;/);
  });
});

describe('"Analysis up to date" only after the model answered', () => {
  test('stamped when the variance insights came back from the model, cleared otherwise', () => {
    const now = '2026-10-12T02:00:00.000Z';
    expect(req.analysedAt({ status: 'fulfilled', value: { insights: [] } }, now)).toBe(now);
    expect(req.analysedAt({ status: 'fulfilled', value: { insights: [], failed: 'unavailable' } }, now)).toBe(null);
    expect(req.analysedAt({ status: 'rejected', reason: new Error('502') }, now)).toBe(null);
    expect(req.analysedAt({ status: 'fulfilled', value: null }, now)).toBe(null);
    expect(req.analysedAt(undefined, now)).toBe(null);
    // The reply is handed on as it came, `failed` and all.
    expect(page).toMatch(/then\(d => \{ if \(fresh\(\)\) setInsights\(d\); return d; \}\)/);
    expect(page).toMatch(/setLastAnalysedAt\(analysedAt\(insightsOutcome, new Date\(\)\.toISOString\(\)\)\)/);
  });
});

describe('the headline cards', () => {
  test('say "Nothing" for none, leave out a side with none past due, and note credit notes', () => {
    expect(head.awaitingLine('receivables', 0)).toBe('Nothing awaiting payment');
    expect(head.awaitingLine('payables', 0)).toBe('Nothing awaiting payment');
    expect(head.awaitingLine('receivables', 1)).toBe('1 sales invoice awaiting payment');
    expect(head.awaitingLine('payables', 3)).toBe('3 bills awaiting payment');
    expect(head.awaitingLine('receivables', 2, true)).toBe('2 invoices');
    expect(head.awaitingLine('payables', 0, true)).toBe('Nothing owed');

    expect(head.overdueLine(0, 0)).toBe('Nothing past due');
    expect(head.overdueLine(0, 0, true)).toBe('Nothing past due');
    expect(head.overdueLine(2, 1)).toBe('2 invoices and 1 bill past due');
    expect(head.overdueLine(0, 2)).toBe('2 bills past due');
    expect(head.overdueLine(1, 0)).toBe('1 invoice past due');
    expect(head.overdueLine(3, 2, true)).toBe('3 inv · 2 bills');

    const fmt = v => fmtMoney(v, 'SGD');
    const kpis = { creditsNetted: { receivables: 120, payables: 0 } };
    expect(head.creditLine(kpis, 'receivables', fmt)).toBe('after SGD 120.00 of credit notes');
    expect(head.creditLine(kpis, 'payables', fmt)).toBe(null);
    expect(head.creditLine({}, 'receivables', fmt)).toBe(null);
    expect(head.creditLine({ creditsUnavailable: true, creditsNetted: { receivables: 0 } }, 'receivables', fmt)).toBe('credit notes not read');

    expect(page).not.toMatch(/sales invoice\$\{kpis\.receivablesCount/);
    expect(page).toMatch(/creditLine\(kpis, 'receivables', money, isMobile\)/);
    expect(page).toMatch(/creditLine\(kpis, 'payables', money, isMobile\)/);
  });
});

describe('the recurring run-rate counts the closed months only', () => {
  test('four closed months of a twelve-month year annualise from four, and none closed is no rate', () => {
    const months = Array.from({ length: 12 }, (_, i) => ({ label: `M${i + 1}` }));
    const recurring = [10, 10, 10, 10, 6, 0, 0, 0, 0, 0, 0, 0];
    const d = { months, closedThroughIdx: 3, split: { recurring: { actual: recurring } } };
    expect(recurringRunRate(d, 0, 11)).toEqual({ months: 4, total: 40, annual: 120 });
    // The old figure: everything booked, month in progress included, over twelve.
    expect((recurring.reduce((s, v) => s + v, 0) / 12) * 12).toBe(46);
    expect(recurringRunRate(d, 4, 11)).toMatchObject({ months: 0, annual: null });
    expect(recurringRunRate({ ...d, split: { recurring: { actual: Array(12).fill(0) } } }, 0, 11)).toMatchObject({ months: 4, annual: null });
    expect(read('components/performance/RevenuePanel.jsx')).not.toMatch(/monthsInPeriod/);
  });
});

describe('the quote card says why it is empty rather than vanishing', () => {
  test('failed, none, all expired and some are each told apart; a report that never asked shows nothing yet', () => {
    expect(quoteCard({ available: false, reason: 'not-asked' }, 'SGD')).toEqual({ state: 'hidden', message: null });
    expect(quoteCard(undefined, 'SGD').state).toBe('hidden');
    expect(quoteCard({ available: false, reason: 'failed' }, 'SGD'))
      .toEqual({ state: 'failed', message: 'Couldn\'t read quotes from Xero — Refresh to try again.' });
    expect(quoteCard({ available: true, total: 0, expired: { count: 0, total: 0 }, fromISO: '2026-04-01' }, 'SGD'))
      .toEqual({ state: 'none', message: 'No open quotes dated from 2026-04-01.' });
    expect(quoteCard({ available: true, total: 0, expired: { count: 2, total: 5000 }, fromISO: '2026-04-01' }, 'SGD').message)
      .toBe('No open quotes dated from 2026-04-01. 2 sent quotes have passed their expiry date (SGD 5000.00).');
    expect(quoteCard({ available: true, total: 0, expired: { count: 1, total: 50 }, fromISO: '2026-04-01' }, 'SGD').message)
      .toMatch(/1 sent quote has passed its expiry date/);
    expect(quoteCard({ available: true, total: 100, expired: { count: 0, total: 0 } }, 'SGD').state).toBe('some');

    expect(extrasState({ available: true })).toBe('ready');
    expect(extrasState({ available: false, reason: 'failed' })).toBe('failed');
    expect(extrasState({ available: false })).toBe('hidden');
    expect(read('components/performance/RevenuePanel.jsx')).toMatch(/Couldn&apos;t read invoices from Xero — Refresh to try again\./);
  });
});

describe('Profitability and Revenue wording for nothing booked or budgeted', () => {
  test('nil cost of sales, an unbudgeted line and no recurring account each say so', () => {
    expect(grossProfitFoot(0, 0, 'SGD')).toBe('no cost of sales booked');
    expect(grossProfitFoot(0, 1500, 'SGD')).toBe('no cost of sales booked (SGD 1500.00 budgeted)');
    expect(grossProfitFoot(0.001, 1500, 'SGD')).toBe('no cost of sales booked (SGD 1500.00 budgeted)');
    expect(grossProfitFoot(800, 1500, 'SGD')).toBe('after SGD 800.00 of costs');

    expect(lineBudgetText([0, 0, 0], 0, 2, 0, 'SGD')).toBe('not budgeted');
    expect(lineBudgetText(undefined, 0, 2, 0, 'SGD')).toBe('not budgeted');
    expect(lineBudgetText([0, 0, 100], 0, 2, 0, 'SGD')).toBe('SGD 0.00');
    expect(lineBudgetText([50, 50, 0], 0, 2, 100, 'SGD')).toBe('SGD 100.00');

    expect(recurringTile([{ recurring: false }], 0, 0, 'SGD'))
      .toEqual({ value: '—', meter: null, footLeft: 'No account is classed as recurring' });
    expect(recurringTile([], 0, null, 'SGD').footLeft).toBe('No account is classed as recurring');
    expect(recurringTile([{ recurring: true }], 250, 0.25, 'SGD'))
      .toEqual({ value: 'SGD 250.00', meter: 25, footLeft: '25% of revenue' });

    expect(read('components/performance/ProfitabilityPanel.jsx')).toMatch(/grossProfitFoot\(T\.cogs, T\.budgetClosed\.cogs, cur\)/);
    expect(read('components/performance/RevenuePanel.jsx')).toMatch(/lineBudgetText\(l\.budget, from, to, b, cur\)/);
  });
});
