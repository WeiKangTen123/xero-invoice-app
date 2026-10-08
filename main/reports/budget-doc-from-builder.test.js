// The exports and the report are tested apart: budget-doc.test.js hand-writes
// its payloads, and reports.test.js never renders one. Between them sits the
// contract that matters most — that a figure printed in a PDF or a workbook is
// the figure on screen, which is the one getBudgetVariance built. So here the
// real builder's output, from the live-captured fixture in reports.test.js, is
// fed to both document definitions and both workbooks, and every figure in
// them is read back against the payload, row by row and cell by cell. Nothing
// in an export may add, round or pick differently from the payload: that is
// how a report and its export start telling different stories.

// budget-variance.js reaches the SDK through report-fetch.js. Nothing here
// calls it, and the mock makes sure nothing could.
jest.mock('xero-node', () => ({ AccountingApi: jest.fn() }));

const { AccountingApi } = require('xero-node');
const { _buildBudgetVariance } = require('../xero/budget-variance');
const { _fiscalYearMonths, _actualThroughIndex } = require('../xero/periods');
const doc    = require('./budget-doc');
const render = require('./budget-render');

beforeAll(() => expect(jest.isMockFunction(AccountingApi)).toBe(true));

// ── The fixture, as reports.test.js has it ──────────────────────────────────
// The real shapes a live Xero org returned (FY Apr 2026 – Mar 2027), read on
// 17 August: April to July closed, August in progress. ProfitAndLoss answers
// NEWEST-first and omits any account with no actuals; BudgetSummary answers
// OLDEST-first. Copied rather than shared, so that a change to either test is
// a deliberate one.
function cell(value) { return { value }; }
function row(title, cells, rowType = 'Row') { return { rowType, title, cells: cells.map(cell) }; }
function section(title, rows) { return { rowType: 'Section', title, rows }; }

const FY_END = { month: 3, day: 31 };
const TODAY  = { year: 2026, month: 8, day: 17 };

const BUDGET = [
  ['Sales - Implementation',          [0,0,0,57330,37000,0,0,0,54500,0,27000,27500]],
  ['Sales - Maintenance (Recurring)', [0,0,0,0,15000,0,0,0,0,0,10000,15000]],
  ['Total Income',                    [0,0,0,57330,52000,0,0,0,54500,0,37000,42500]],
  ['Cost of Goods Sold',              [0,0,0,0,7330,1030,1030,1030,1030,1030,7630,7930]],
  ['Total Cost of Sales',             [0,0,0,0,7330,1030,1030,1030,1030,1030,7630,7930]],
  ['Gross Profit',                    [0,0,0,57330,44670,-1030,-1030,-1030,53470,-1030,29370,34570]],
  ['Other Income - Grant',            [0,0,0,0,0,16667,8333,8333,8333,8333,0,0]],
  ['Total Other Income',              [0,0,0,0,0,16667,8333,8333,8333,8333,0,0]],
  ['Bank Fees',                       [0,0,0,0,10,10,10,10,10,10,10,10]],
  ['Consulting & Accounting',         [0,0,0,0,500,500,500,500,500,500,500,500]],
  ['Insurance',                       [0,0,0,0,800,800,800,800,800,1400,1400,1400]],
  ['Legal expenses',                  [0,0,0,0,1000,1000,1000,1000,1000,1000,1000,1000]],
  ['Subscriptions',                   [0,0,0,0,142,142,142,142,142,642,642,642]],
  ['Wages and Salaries',              [0,0,0,24603,24603,24603,24603,24603,24603,24603,24603,24603]],
  ['Total Operating Expenses',        [0,0,0,24603,27055,27055,27055,27055,27055,28155,28155,28155]],
  ['Net Profit',                      [0,0,0,32727,17615,-11418,-19752,-19752,34748,-20852,1215,6415]],
];
const money = v => (v === 0 ? '0.00' : String(v.toFixed(2)));
const bRow  = (label, vals, rowType = 'Row') => row(label, [label, ...vals.map(money)], rowType);
const pick  = label => BUDGET.find(([l]) => l === label)[1];

const budgetRows = [
  { rowType: 'Header', cells: ['Account','Apr-26','May-26','Jun-26','Jul-26','Aug-26','Sep-26','Oct-26','Nov-26','Dec-26','Jan-27','Feb-27','Mar-27'].map(cell) },
  section('Income', [
    bRow('Sales - Implementation', pick('Sales - Implementation')),
    bRow('Sales - Maintenance (Recurring)', pick('Sales - Maintenance (Recurring)')),
    bRow('Total Income', pick('Total Income'), 'SummaryRow'),
  ]),
  section('Less Cost of Sales', [
    bRow('Cost of Goods Sold', pick('Cost of Goods Sold')),
    bRow('Total Cost of Sales', pick('Total Cost of Sales'), 'SummaryRow'),
  ]),
  section('', [bRow('Gross Profit', pick('Gross Profit'), 'SummaryRow')]),
  section('Other Income', [
    bRow('Other Income - Grant', pick('Other Income - Grant')),
    bRow('Total Other Income', pick('Total Other Income'), 'SummaryRow'),
  ]),
  section('Less Operating Expenses', [
    bRow('Bank Fees', pick('Bank Fees')),
    bRow('Consulting & Accounting', pick('Consulting & Accounting')),
    bRow('Insurance', pick('Insurance')),
    bRow('Legal expenses', pick('Legal expenses')),
    bRow('Subscriptions', pick('Subscriptions')),
    bRow('Wages and Salaries', pick('Wages and Salaries')),
    bRow('Total Operating Expenses', pick('Total Operating Expenses'), 'SummaryRow'),
  ]),
  section('', [bRow('Net Profit', pick('Net Profit'), 'SummaryRow')]),
];

const pnlNewestFirst = {
  'Sales - Implementation':          [0,0,0,0,0,0,0,37000,-17670,0,0,0],
  'Sales - Maintenance (Recurring)': [0,0,0,0,0,0,0,15000,75000,0,0,0],
  'Total Income':                    [0,0,0,0,0,0,0,52000,57330,0,0,0],
  'Gross Profit':                    [0,0,0,0,0,0,0,52000,57330,0,0,0],
  'Wages and Salaries':              [0,0,0,0,0,0,0,0,24603,0,0,0],
  'Total Operating Expenses':        [0,0,0,0,0,0,0,0,24603,0,0,0],
  'Net Profit':                      [0,0,0,0,0,0,0,52000,32727,0,0,0],
};
const p = label => row(label, [label, ...pnlNewestFirst[label].map(money)]);
const pnlRows = [
  { rowType: 'Header', cells: ['','31 Mar 27','28 Feb 27','31 Jan 27','31 Dec 26','30 Nov 26','31 Oct 26','30 Sep 26','31 Aug 26','31 Jul 26','30 Jun 26','31 May 26','30 Apr 26'].map(cell) },
  section('Income', [p('Sales - Implementation'), p('Sales - Maintenance (Recurring)'), row('Total Income', ['Total Income', ...pnlNewestFirst['Total Income'].map(money)], 'SummaryRow')]),
  section('', [p('Gross Profit')]),
  section('Less Operating Expenses', [p('Wages and Salaries'), row('Total Operating Expenses', ['Total Operating Expenses', ...pnlNewestFirst['Total Operating Expenses'].map(money)], 'SummaryRow')]),
  section('', [p('Net Profit')]),
];

// ── The payload, built for real ─────────────────────────────────────────────
const months           = _fiscalYearMonths(TODAY, FY_END);
const actualThroughIdx = _actualThroughIndex(months, TODAY);          // 3: July is the last closed month
const currentIdx       = months.findIndex(m => m.key === '2026-08'); // 4: August is in progress
const AS_OF            = '2026-08-17';

const built = _buildBudgetVariance({ budgetRows, pnlRows, months, actualThroughIdx, currentIdx, asOfISO: AS_OF });

// What getBudgetVariance wraps around the builder's output before caching it:
// the organisation, the period's names, and the month list with each month's
// source and whether it is the one in progress. The rows, KPIs and
// budgetMissing flag are the builder's, untouched.
const payload = {
  organisation: { name: 'Test Org', currency: 'SGD' },
  fiscalYear:   { label: 'For the year ended 31 March 2027', fromISO: months[0].startISO, toISO: months[11].endISO },
  budgets:      [],
  period: {
    key: 'fy', label: 'This financial year', months: 12, chunks: 1, fromKey: '2026-04', toKey: '2027-03',
    toDateLabel: 'Year to date', closedFromLabel: 'Apr 2026', closedToLabel: 'Jul 2026', closedThroughISO: '2026-07-31',
  },
  months: months.map((m, i) => ({ key: m.key, label: m.label, source: i <= actualThroughIdx ? 'actual' : 'budget', current: i === currentIdx })),
  ...built,
  fetchedAt: Date.UTC(2026, 7, 17, 2, 0),
};
const OPTS = { generatedAt: Date.UTC(2026, 7, 17, 2, 5), timezone: 'Asia/Singapore' };

const dataRows = payload.rows.filter(r => r.kind !== 'section');
const net      = payload.rows.find(r => r.label === 'Net Profit');

// Finding things in a document definition and in a sheet.
const tableOf = d => d.content.find(c => c.table).table;
const pdfRow  = (d, label) => tableOf(d).body.find(r => r[0] && r[0].text === label);
const texts   = cells => cells.map(c => c.text);
const sheetRow = (wb, name, label) => {
  const ws = wb.getWorksheet(name);
  let hit = null;
  ws.eachRow((r, n) => { if (hit === null && r.getCell(1).value === label) hit = n; });
  return hit === null ? null : ws.getRow(hit);
};
// A heading row's cells, found by what they say rather than where they are,
// so a column that moved would be followed and a column that vanished would be
// missed loudly: the month at index i is wherever its label is, Total is
// wherever "Total" is, and the one heading that is none of those (nor Account)
// is the booked-so-far column of the month in progress.
function columnsOf(headings) {
  const isMonth = t => payload.months.some(m => m.label === t);
  const total   = headings.indexOf('Total');
  const soFar   = headings.findIndex((t, c) => c > 0 && c !== total && !isMonth(t));
  return { month: i => headings.indexOf(payload.months[i].label), total, soFar };
}

describe('the payload is the builder\'s, as reports.test.js pins it', () => {
  test('sixteen lines, four closed months, August in progress, and the bottom line of the org\'s own Xero PDF', () => {
    expect(dataRows).toHaveLength(16);
    expect(payload.months.map(m => m.source)).toEqual([...Array(4).fill('actual'), ...Array(8).fill('budget')]);
    expect(net.cells).toEqual([0, 0, 0, 32727, 17615, -11418, -19752, -19752, 34748, -20852, 1215, 6415]);
    expect(net.total).toBe(20946);
    expect(net).toMatchObject({ actualToDate: 32727, budgetToDate: 32727, variance: 0 });
    expect(net.monthly[currentIdx]).toMatchObject({ actual: 52000, budget: 17615, variance: 34385 });
    expect(payload.kpis).toMatchObject({
      monthsElapsed: 4, ytdActualNet: 32727, forecastNet: 20946,
      currentMonth: { key: '2026-08', asOf: AS_OF, actualNet: 52000, budgetNet: 17615 },
    });
    expect(payload.budgetMissing).toBe(false);
  });
});

describe('Budget vs Actual (the grid) — the PDF definition', () => {
  const d   = doc.budgetVsActualDoc(payload, OPTS);
  const col = columnsOf(texts(tableOf(d).body[1]));

  test('every month of every line sits under its own heading, Total is the payload\'s, and so is what is booked so far', () => {
    expect(col.total).toBeGreaterThan(0);
    expect(col.soFar).toBeGreaterThan(0);
    for (const r of dataRows) {
      const cells = pdfRow(d, r.label);
      expect(cells).toBeTruthy();
      payload.months.forEach((_, i) => {
        expect([r.label, i, cells[col.month(i)].text]).toEqual([r.label, i, doc._cell(r.cells[i])]);
      });
      expect([r.label, cells[col.total].text]).toEqual([r.label, doc._cell(r.total)]);
      expect([r.label, cells[col.soFar].text]).toEqual([r.label, doc._cell(r.monthly[currentIdx].actual)]);
    }
  });

  test('the bottom line reads as the org\'s PDF, with August\'s booked figure beside its budget and outside Total', () => {
    const cells = pdfRow(d, 'Net Profit');
    expect(payload.months.map((_, i) => cells[col.month(i)].text)).toEqual([
      '-', '-', '-', '32,727.00', '17,615.00', '(11,418.00)', '(19,752.00)', '(19,752.00)', '34,748.00', '(20,852.00)', '1,215.00', '6,415.00',
    ]);
    expect(cells[col.soFar].text).toBe('52,000.00');
    expect(cells[col.total].text).toBe('20,946.00');
    expect(cells[col.total].text).toBe(doc._cell(payload.kpis.forecastNet));
    // Not re-summed across the printed columns, which would count August twice.
    expect(cells[col.total].text).not.toBe(doc._cell(net.total + net.monthly[currentIdx].actual));
  });
});

describe('Budget vs Actual (the grid) — the workbook', () => {
  const NAME = 'Budget vs Actual';
  const wb   = render.budgetVsActualWorkbook(payload, OPTS);
  const head = sheetRow(wb, NAME, 'Account');
  // Sheet columns count from 1; the heading list below counts from 0.
  const col  = columnsOf(head.values.slice(1));
  const at   = (line, c) => line.getCell(c + 1).value;

  test('every figure is the payload\'s, written as a number under its own heading', () => {
    expect(col.total).toBeGreaterThan(0);
    expect(col.soFar).toBeGreaterThan(0);
    for (const r of dataRows) {
      const line = sheetRow(wb, NAME, r.label);
      expect(line).not.toBeNull();
      payload.months.forEach((_, i) => expect([r.label, i, at(line, col.month(i))]).toEqual([r.label, i, r.cells[i]]));
      expect([r.label, at(line, col.total)]).toEqual([r.label, r.total]);
      expect([r.label, at(line, col.soFar)]).toEqual([r.label, r.monthly[currentIdx].actual]);
    }
  });

  test('the bottom line is the payload\'s cells, booked figure and total', () => {
    const line = sheetRow(wb, NAME, 'Net Profit');
    expect(payload.months.map((_, i) => at(line, col.month(i)))).toEqual(net.cells);
    expect(at(line, col.soFar)).toBe(52000);
    expect(at(line, col.total)).toBe(20946);
  });
});

// The four cells of one column group, as the documents print a row's figures.
// The percentage goes through the document's own rule (a dash for a nil
// variance or for no budget to divide by), which is formatting, not arithmetic:
// the fraction itself is the payload's.
const printed = v => [doc._cell(v.actual), doc._cell(v.budget), doc._cell(v.variance), doc._pctCell(v)];
const written = v => {
  const text = doc._pctCell(v);
  return [v.actual, v.budget, v.variance, text === '-' ? '-' : text === '0.00%' ? 0 : v.variancePct];
};
const toDate  = r => ({ actual: r.actualToDate, budget: r.budgetToDate, variance: r.variance, variancePct: r.variancePct });
const GROUP   = ['Actual', 'Budget', 'Variance', 'Variance %'];

describe('Budget Variance — the PDF definition', () => {
  test('the to-date rollup is each line\'s actualToDate, budgetToDate and variance, and the bottom line is the YTD KPI', () => {
    const d = doc.budgetVarianceDoc(payload, { ...OPTS, month: 'ytd' });
    expect(texts(tableOf(d).body[1])).toEqual(['Account', ...GROUP]);
    for (const r of dataRows) {
      expect([r.label, ...texts(pdfRow(d, r.label).slice(1))]).toEqual([r.label, ...printed(toDate(r))]);
    }
    const bottom = texts(pdfRow(d, 'Net Profit').slice(1));
    expect(bottom).toEqual(['32,727.00', '32,727.00', '-', '-']);
    expect(bottom[0]).toBe(doc._cell(payload.kpis.ytdActualNet));
  });

  test('a closed month is that month\'s figures beside its running total, both from the payload', () => {
    const d = doc.budgetVarianceDoc(payload, { ...OPTS, month: '2026-07' });
    expect(texts(tableOf(d).body[1])).toEqual(['Account', ...GROUP, ...GROUP]);
    for (const r of dataRows) {
      expect([r.label, ...texts(pdfRow(d, r.label).slice(1))]).toEqual([r.label, ...printed(r.monthly[3]), ...printed(r.cumulative[3])]);
    }
    // July's implementation sales were a credit against a 57,330 budget; by
    // July nothing else had been booked on the line, so the running total is
    // the same figure.
    expect(texts(pdfRow(d, 'Sales - Implementation').slice(1))).toEqual([
      '(17,670.00)', '57,330.00', '(75,000.00)', '-130.82%',
      '(17,670.00)', '57,330.00', '(75,000.00)', '-130.82%',
    ]);
  });

  test('the month in progress is what has been booked against its budget, and the running total includes it', () => {
    const d = doc.budgetVarianceDoc(payload, { ...OPTS, month: '2026-08' });
    for (const r of dataRows) {
      expect([r.label, ...texts(pdfRow(d, r.label).slice(1))]).toEqual([r.label, ...printed(r.monthly[currentIdx]), ...printed(r.cumulative[currentIdx])]);
    }
    // 52,000 booked against 17,615: the 195.20% Xero's own report shows.
    expect(texts(pdfRow(d, 'Net Profit').slice(1))).toEqual([
      '52,000.00', '17,615.00', '34,385.00', '195.20%',
      '84,727.00', '50,342.00', '34,385.00', '68.30%',
    ]);
  });
});

describe('Budget Variance — the workbook', () => {
  const NAME = 'Budget Variance';
  const values = (wb, label) => sheetRow(wb, NAME, label).values.slice(2);

  test('the to-date rollup is written from the same fields, as numbers', () => {
    const wb = render.budgetVarianceWorkbook(payload, { ...OPTS, month: 'ytd' });
    expect(sheetRow(wb, NAME, 'Account').values.slice(1)).toEqual(['Account', ...GROUP]);
    for (const r of dataRows) expect([r.label, ...values(wb, r.label)]).toEqual([r.label, ...written(toDate(r))]);
    expect(values(wb, 'Net Profit')).toEqual([32727, 32727, 0, '-']);
  });

  test('a month and its running total are the payload\'s monthly and cumulative figures', () => {
    const wb = render.budgetVarianceWorkbook(payload, { ...OPTS, month: '2026-08' });
    expect(sheetRow(wb, NAME, 'Account').values.slice(1)).toEqual(['Account', ...GROUP, ...GROUP]);
    for (const r of dataRows) {
      expect([r.label, ...values(wb, r.label)]).toEqual([r.label, ...written(r.monthly[currentIdx]), ...written(r.cumulative[currentIdx])]);
    }
    const bottom = values(wb, 'Net Profit');
    expect(bottom.slice(0, 3)).toEqual([52000, 17615, 34385]);
    expect(bottom[3]).toBe(net.monthly[currentIdx].variancePct);       // the fraction, exactly as the payload holds it
    expect(bottom.slice(4, 7)).toEqual([84727, 50342, 34385]);
    expect(bottom[7]).toBe(net.cumulative[currentIdx].variancePct);
  });
});
