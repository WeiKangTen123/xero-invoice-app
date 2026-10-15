const fs   = require('fs');
const path = require('path');

// The Monthly sub-tab of the Cash Flow Manager on the screen side. There is no
// React test setup in this project, so this follows cash-manager-ui.test.js:
// the decisions (the spans and fills offered, what is remembered, the
// columns' kinds and bands, the grid's rows, the colour of a closing balance,
// what hovering a figure says) are plain functions in cash-monthly.js, a file
// with no imports, loaded whole and run here against a payload shaped as the
// server sends it (main/xero/cash-monthly.js); the wiring (the sub-tab's
// place, the request, the refetch on a Refresh, the exports) is checked in
// the source.
const UI = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function loadHelpers(rel) {
  const src = read(rel);
  expect(src).not.toMatch(/^import /m);
  const names = [...src.matchAll(/^export function (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}
const h = loadHelpers('pages/xero-insights/cash-monthly.js');

const MONTHS = [
  { key: '2026-08', label: 'Aug 2026', kind: 'actual' },
  { key: '2026-09', label: 'Sep 2026', kind: 'actual' },
  { key: '2026-10', label: 'Oct 2026', kind: 'current' },
  { key: '2026-11', label: 'Nov 2026', kind: 'forecast' },
  { key: '2027-01', label: 'Jan 2027', kind: 'forecast' },
];
const row = (key, label, group, values, sources = values.map(() => '')) => ({ key, label, group, values, sources });
const payload = {
  organisation: { name: 'Org', currency: 'SGD' },
  today: '2026-10-14', currentMonth: '2026-10', overdraft: 1000,
  months: MONTHS,
  rows: [
    row('opening', 'Opening balance', 'balance', [1000, 3000, 3500, -500, -1500], ['bank', 'bank', 'bank', 'previous closing', 'previous closing']),
    row('in_customer', 'Customer receipts', 'in', [4000, null, 1000, 1000, 2000], ['payments', '', 'payments + open invoices', 'repeating', 'open invoices + budget']),
    row('in_total', 'Total cash in', 'in', [4000, null, 1000, 1000, 2000]),
    row('out_supplier', 'Supplier payments', 'out', [0, null, 100, 400, 400]),
    row('out_other', 'Other / unexplained', 'out', [2000, null, 200, 0, 0], ['unexplained', '', 'unexplained', '', '']),
    row('out_total', 'Total cash out', 'out', [2000, null, 300, 400, 400]),
    row('net', 'Net movement', 'net', [2000, 500, 700, 600, 1600]),
    row('closing', 'Closing balance', 'balance', [3000, 3500, -500, -1500.01, 0]),
    row('overdue', 'Overdue, not yet scheduled', 'info', [null, null, 420, null, null],
      ['', '', '2 overdue items: 500.00 to come in, 80.00 to go out', '', '']),
  ],
  notes: [],
};

describe('the controls and what is remembered', () => {
  test('the spans offered, and the fills', () => {
    expect(h.spanOptions().map(o => o.label)).toEqual([
      'Past 3 | Next 3', 'Past 6 | Next 6', 'Past 12 | Next 6', 'Past 6 | Next 12', 'Past 12 | Next 12', 'Past 0 | Next 12',
    ]);
    expect(h.spanOptions()[1]).toEqual({ key: '6-6', past: 6, future: 6, label: 'Past 6 | Next 6' });
    for (const o of h.spanOptions()) {
      expect(o.past).toBeGreaterThanOrEqual(0); expect(o.past).toBeLessThanOrEqual(12);
      expect(o.future).toBeGreaterThanOrEqual(1); expect(o.future).toBeLessThanOrEqual(12);
    }
    expect(h.fillOptions()).toEqual([{ key: 'budget', label: 'Budget' }, { key: 'none', label: 'Nothing' }]);
  });

  test('remembered choices are checked, a span not offered read as six and six', () => {
    expect(h.readMonthlyPrefs(null)).toEqual({ past: 6, future: 6, fill: 'budget' });
    expect(h.readMonthlyPrefs('not json')).toEqual({ past: 6, future: 6, fill: 'budget' });
    expect(h.readMonthlyPrefs(JSON.stringify({ past: 12, future: 6, fill: 'none' }))).toEqual({ past: 12, future: 6, fill: 'none' });
    expect(h.readMonthlyPrefs({ past: 40, future: 6, fill: 'forecast' })).toEqual({ past: 6, future: 6, fill: 'budget' });
  });

  test('the route and the exports are asked for the organisation, the span and the fill on screen', () => {
    const q = h.monthlyQueryFor({ tenantId: 't1', past: 0, future: 12, fill: 'none' });
    expect(q).toEqual({ tenantId: 't1', past: '0', future: '12', fill: 'none' });
    expect(h.monthlySearch(q)).toBe('tenantId=t1&past=0&future=12&fill=none');
    expect(h.monthlySearch(q, { force: true })).toBe('tenantId=t1&past=0&future=12&fill=none&force=true');
    expect(h.monthlyQueryFor({})).toEqual({ past: '6', future: '6', fill: 'budget' });
  });
});

describe('the columns', () => {
  test('each month is a column of its kind, headed month over year, this one starred', () => {
    expect(h.columnsOf(payload).map(c => [c.key, c.kind, c.month, c.year, c.current])).toEqual([
      ['2026-08', 'actual', 'Aug', '2026', false],
      ['2026-09', 'actual', 'Sep', '2026', false],
      ['2026-10', 'current', 'Oct*', '2026', true],
      ['2026-11', 'forecast', 'Nov', '2026', false],
      ['2027-01', 'forecast', 'Jan', '2027', false],
    ]);
    expect(h.columnsOf({})).toEqual([]);
  });

  test('banded actual, actual and forecast, forecast, each over its months, and shaded apart', () => {
    expect(h.bandsOf(payload)).toEqual([
      { kind: 'actual', label: 'Actual', span: 2 },
      { kind: 'current', label: 'Actual + forecast', span: 1 },
      { kind: 'forecast', label: 'Forecast', span: 2 },
    ]);
    expect(h.bandsOf({ months: [{ key: '2026-10', kind: 'current' }, { key: '2026-11', kind: 'forecast' }] }).map(b => b.kind)).toEqual(['current', 'forecast']);
    expect(h.columnShade('actual')).toBe('var(--bg-secondary)');
    expect(h.columnShade('current')).toBe('var(--warning-subtle)');
    expect(h.columnShade('forecast')).toBeUndefined();
  });

  test('the star is explained', () => {
    expect(h.currentFootnote(payload)).toBe('* Oct 2026 = actual to 14 Oct 2026 + forecast for the rest of the month');
    expect(h.currentFootnote({ months: [] })).toBe('');
  });
});

describe('the colour of a closing balance', () => {
  test('red below the overdraft limit, orange below zero within it, none at or above zero or with no figure', () => {
    expect(h.closingTone(100, 1000)).toBeNull();
    expect(h.closingTone(0, 1000)).toBeNull();
    expect(h.closingTone(-0.001, 0)).toBeNull();
    expect(h.closingTone(-500, 1000)).toBe('warning');
    expect(h.closingTone(-1000, 1000)).toBe('warning');
    expect(h.closingTone(-1000.01, 1000)).toBe('danger');
    expect(h.closingTone(-1, 0)).toBe('danger');
    expect(h.closingTone(null, 1000)).toBeNull();
    expect(h.toneColour('danger')).toBe('var(--danger)');
    expect(h.toneColour('warning')).toBe('var(--warning)');
    expect(h.toneColour(null)).toBeUndefined();
  });
});

describe('the rows and what a figure was made of', () => {
  test('a heading before each group; lines indented, totals and balances bold, overdue muted; closing coloured', () => {
    const rows = h.gridRows(payload);
    expect(rows.map(r => (r.type === 'heading' ? `# ${r.label}` : r.label))).toEqual([
      'Opening balance', '# Cash in', 'Customer receipts', 'Total cash in', '# Cash out', 'Supplier payments', 'Other / unexplained',
      'Total cash out', 'Net movement', 'Closing balance', 'Overdue, not yet scheduled',
    ]);
    const by = key => rows.find(r => r.key === key);
    expect([by('in_customer').indent, by('in_total').indent, by('opening').indent]).toEqual([true, false, false]);
    expect([by('in_total').strong, by('closing').strong, by('in_customer').strong, by('overdue').info]).toEqual([true, true, false, true]);
    expect(by('closing').cells.map(c => c.tone)).toEqual([null, null, 'warning', 'danger', null]);
    expect(by('opening').cells.map(c => c.tone)).toEqual([null, null, null, null, null]);
    expect(by('in_customer').cells.map(c => c.value)).toEqual([4000, null, 1000, 1000, 2000]);
    expect(by('in_customer').cells.map(c => c.kind)).toEqual(['actual', 'actual', 'current', 'forecast', 'forecast']);
  });

  test('hovering a figure names the line, the month and its kind, and each source in words', () => {
    const r = payload.rows.find(x => x.key === 'in_customer');
    expect(h.sourcesText(r, 2, payload)).toBe([
      'Customer receipts, Oct 2026 (actual + forecast), from:',
      '• payments: payments recorded in Xero against invoices and bills',
      '• open invoices: sales invoices still owed, on their expected dates',
    ].join('\n'));
    expect(h.sourcesText(r, 4, payload)).toMatch(/budget: the Overall Budget in Xero, less what is already scheduled/);
    const u = payload.rows.find(x => x.key === 'out_other');
    expect(h.sourcesText(u, 0, payload)).toMatch(/Other \/ unexplained, Aug 2026 \(actual\), from:\n• unexplained: .*pay runs and journals the app cannot read/);
    // Nothing named, nothing said.
    expect(h.sourcesText(r, 1, payload)).toBe('');
    // The overdue line's source is its own sentence.
    expect(h.sourcesText(payload.rows.find(x => x.key === 'overdue'), 2, payload))
      .toBe('Overdue, not yet scheduled, Oct 2026 (actual + forecast): 2 overdue items: 500.00 to come in, 80.00 to go out');
    expect(h.gridRows(payload).find(x => x.key === 'in_customer').cells[2].title).toBe(h.sourcesText(r, 2, payload));
  });

  test('Spend/Receive Money dated ahead and your bank adjustments are named in words, whatever their case', () => {
    const r = row('out_overheads', 'Overheads', 'out', [null, null, 300, 640, 0],
      ['', '', 'Spend/Receive Money dated ahead', 'spend/receive money dated ahead + open bills', '']);
    expect(h.sourcesText(r, 2, payload)).toBe([
      'Overheads, Oct 2026 (actual + forecast), from:',
      '• Spend/Receive Money dated ahead: Spend Money and Receive Money transactions entered in Xero with a later date',
    ].join('\n'));
    expect(h.sourcesText(r, 3, payload)).toMatch(/• spend\/receive money dated ahead: Spend Money .*\n• open bills: bills still owed/);
    expect(h.sourcesText(row('adjustment', 'Your bank adjustments', 'balance', [null, null, 250, null, null], ['', '', 'opening adjustment', '', '']), 2, payload))
      .toMatch(/• opening adjustment: the opening adjustment set in the bank options/);
  });
});

describe('your bank adjustments, and figures the server does not have', () => {
  // The server's newer rows: the adjustment between Net and Closing, with a
  // figure in this month only, and months it could not read left null.
  const rows = [...payload.rows];
  rows.splice(rows.findIndex(r => r.key === 'closing'), 0,
    row('adjustment', 'Your bank adjustments', 'balance', [null, null, 250, null, null], ['', '', 'opening adjustment', '', '']));
  const withAdj = { ...payload, rows: rows.map(r => (r.key === 'opening' ? { ...r, values: [1000, null, 3500, -500, -1500] } : r)) };
  const grid = h.gridRows(withAdj);
  const by = key => grid.find(r => r.key === key);

  test('it sits between Net and Closing, under no heading, not indented and lighter than the balances', () => {
    const order = grid.map(r => (r.type === 'heading' ? `# ${r.label}` : r.key));
    expect(order.slice(order.indexOf('net'))).toEqual(['net', 'adjustment', 'closing', 'overdue']);
    expect(by('adjustment')).toMatchObject({ label: 'Your bank adjustments', group: 'balance', indent: false, strong: false, info: false });
    expect([by('opening').strong, by('closing').strong]).toEqual([true, true]);
    expect(by('adjustment').cells.map(c => c.value)).toEqual([null, null, 250, null, null]);
    expect(by('adjustment').cells.map(c => c.tone)).toEqual([null, null, null, null, null]);
  });

  test('a cell with no figure is blank, never nil, and says nothing on hover', () => {
    expect(by('opening').cells[1]).toMatchObject({ value: null, tone: null, title: '' });
    // A source named for a cell the server left without a figure is not shown.
    expect(by('in_customer').cells[1]).toMatchObject({ value: null, title: '' });
    const odd = h.gridRows({ ...payload, rows: [row('closing', 'Closing balance', 'balance', ['n/a', undefined, '', -500, 0], ['bank', 'bank', 'bank', 'bank', 'bank'])] });
    expect(odd[0].cells.map(c => c.value)).toEqual([null, null, null, -500, 0]);
    expect(odd[0].cells.map(c => c.tone)).toEqual([null, null, null, 'warning', null]);
    expect(odd[0].cells.map(c => c.title === '')).toEqual([true, true, true, false, false]);
    expect(h.closingTone('n/a', 0)).toBeNull();
  });
});

describe('the wiring', () => {
  const tab = read('pages/xero-insights/CashManagerTab.jsx');
  const monthly = read('pages/xero-insights/CashMonthly.jsx');

  test('Monthly is a sub-tab beside Overview and the two lists, on the Cash Flow Manager\'s organisation', () => {
    expect(tab).toMatch(/\{ key: 'overview', label: 'Overview' \},\s*\{ key: 'in',\s+label: 'Manage cash in' \},\s*\{ key: 'out',\s+label: 'Manage cash out' \},\s*\{ key: 'monthly',\s+label: 'Monthly' \}/);
    expect(tab).toMatch(/import CashMonthly from '\.\/CashMonthly'/);
    expect(tab).toMatch(/section === 'monthly' && tid && \(\s*<CashMonthly tenantId=\{tid\} refreshedAt=\{d\?\.fetchedAt\}/);
    // The lists are the two list sections only, not every section but Overview.
    expect(tab).toMatch(/ready && \(section === 'in' \|\| section === 'out'\) && \(\s*<CashList/);
  });

  test('it asks the route for its own figures, and again past the caches when the Cash Flow Manager is read again', () => {
    expect(monthly).toMatch(/api\.get\(`\/cash-manager\/monthly\?\$\{monthlySearch\(query, \{ force \}\)\}`\)/);
    expect(monthly).toMatch(/\}, \[tenantId, prefs\.past, prefs\.future, prefs\.fill\]\)/);
    expect(monthly).toMatch(/if \(before !== null && before !== undefined\) load\(\{ force: true \}\);\s*\}, \[refreshedAt\]\)/);
    // A slow answer for an earlier span cannot land over a later one.
    expect(monthly).toMatch(/if \(n === seq\.current\) setState/);
  });

  test('the exports go through BudgetExport as cashmonthly, with the span and fill on screen', () => {
    expect(monthly).toMatch(/<BudgetExport kind="cashmonthly" query=\{query\}/);
    expect(monthly).toMatch(/const query = monthlyQueryFor\(\{ tenantId, \.\.\.prefs \}\)/);
  });

  test('the row labels are pinned while the months scroll sideways on a phone; a figure\'s sources are its hover text', () => {
    expect(monthly).toMatch(/overflowX: 'auto'/);
    expect(monthly).toMatch(/position: 'sticky', left: 0/);
    expect(monthly).toMatch(/title=\{cell\.title \|\| undefined\}/);
    expect(monthly).toMatch(/color: toneColour\(cell\.tone\)/);
    // No figure is blank, never fmtCell's dash for nil.
    expect(monthly).toMatch(/\{cell\.value === null \? '' : fmtCell\(cell\.value\)\}/);
  });

  test('it asks for the organisation the Cash Flow Manager has checked is still connected', () => {
    expect(tab).toMatch(/const tid = connectedTenant\(tenantId, d\);/);
    expect(monthly).toMatch(/if \(!tenantId\) return;/);
  });

  test('quarterly is a repeat an entry can have, for GST and BAS', () => {
    const cm = loadHelpers('pages/xero-insights/cash-manager.js');
    expect(cm.repeatOptions().map(o => o.key)).toContain('quarterly');
    expect(cm.validateEntry({ direction: 'out', description: 'GST', amount: '900', date: '2026-10-28', frequency: 'quarterly' })).toEqual({});
    expect(cm.entryForm({ direction: 'out', description: 'GST', amount: 900, date: '2026-10-28', frequency: 'quarterly' }).frequency).toBe('quarterly');
    expect(read('pages/xero-insights/CashManagerModals.jsx')).toMatch(/repeatOptions\(\)\.map/);
  });
});
