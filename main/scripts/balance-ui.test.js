const fs   = require('fs');
const path = require('path');

// The Balance Sheet tab on the screen side. There is no React test setup in
// this project, so this follows live-updates-ui.test.js: the decisions — what
// the controls ask for, how the sheet is captioned and its columns headed,
// which rows show and in what order, what a failed load says — are plain
// functions in balance.js, a file with no imports, loaded whole and run here;
// the wiring (the tab's place on the page, that it takes part in live
// updates, the check against Xero and the exports) is checked in the source.
const UI = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function loadHelpers(rel) {
  const src = read(rel);
  // The whole point of the file having no imports: it runs as it is.
  expect(src).not.toMatch(/^import /m);
  const names = [...src.matchAll(/^export function (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}
const h     = loadHelpers('pages/xero-insights/balance.js');
const check = loadHelpers('pages/xero-insights/xero-check.js');

// A sheet as the server sends it on 11 Oct 2026: the last month end with two
// earlier month ends beside it. Petty cash is nil throughout; the receivable
// is a hair off nil in July, which prints as nil.
const sheet = {
  connected: true,
  organisation: { name: 'Nexsoss Pte Ltd', currency: 'SGD' },
  asAt: { iso: '2026-09-30', label: '30 September 2026', preset: 'last-month-end', inProgress: false },
  basis: 'accrual',
  compare: { type: 'month', periods: 2 },
  columns: [{ iso: '2026-09-30', label: '30 Sep 2026' }, { iso: '2026-08-31', label: '31 Aug 2026' }, { iso: '2026-07-31', label: '31 Jul 2026' }],
  groups: [
    { key: 'assets', title: 'Assets', subgroups: [
      { title: 'Bank', rows: [
        { label: 'Aspire SGD account', accountId: 'a1', code: '090', values: [135491, 120250, 118900] },
        { label: 'Petty cash',         accountId: 'a2', code: '091', values: [0, 0, 0] },
      ], total: { label: 'Total Bank', values: [135491, 120250, 118900] } },
      { title: 'Current Assets', rows: [
        { label: 'Accounts Receivable', accountId: 'a3', code: '610', values: [1200, 0, 0.004] },
      ], total: { label: 'Total Current Assets', values: [1200, 0, 0.004] } },
    ], total: { label: 'Total Assets', values: [136691, 120250, 118900] } },
    { key: 'liabilities', title: 'Liabilities', subgroups: [
      { title: 'Current Liabilities', rows: [
        { label: 'Accounts Payable', accountId: 'l1', code: '800', values: [-500, 0, 0] },
      ], total: { label: 'Total Current Liabilities', values: [-500, 0, 0] } },
    ], total: { label: 'Total Liabilities', values: [-500, 0, 0] } },
    { key: 'equity', title: 'Equity', subgroups: [
      { title: '', rows: [
        { label: 'Current Year Earnings', accountId: 'e1', code: '',    values: [37191, 20250, 18900] },
        { label: 'Owner A Share Capital', accountId: 'e2', code: '970', values: [100000, 100000, 100000] },
      ], total: null },
    ], total: { label: 'Total Equity', values: [137191, 120250, 118900] } },
  ],
  netAssets: { label: 'Net Assets', values: [137191, 120250, 118900] },
  notes: [],
  cached: false,
  fetchedAt: 1760000000000,
};

describe('the month ends offered', () => {
  test('the last 36 that have passed, newest first, as YYYY-MM', () => {
    const months = h.monthOptions('2026-10-11');
    expect(months).toHaveLength(36);
    expect(months[0]).toBe('2026-09');
    expect(months[1]).toBe('2026-08');
    expect(months[35]).toBe('2023-10');
    expect(months).not.toContain('2026-10');
  });

  test('crosses a year boundary, and reads a Date in local time', () => {
    expect(h.monthOptions('2026-01-15').slice(0, 2)).toEqual(['2025-12', '2025-11']);
    expect(h.monthOptions(new Date(2026, 9, 11))[0]).toBe('2026-09');
    expect(h.monthOptions('2026-03', 3)).toEqual(['2026-02', '2026-01', '2025-12']);
  });

  test('a month is labelled for the select', () => {
    expect(h.monthLabel('2026-09')).toBe('Sep 2026');
    expect(h.monthLabel('2026-13')).toBe('');
    expect(h.monthLabel('')).toBe('');
  });
});

describe('the query the controls make', () => {
  test('opens on the last month end, alone, on the accrual basis', () => {
    expect(h.defaultControls()).toEqual({ preset: 'last-month-end', month: '', compare: 'none', periods: 1, basis: 'accrual' });
    expect(h.queryFor({ ...h.defaultControls(), tenantId: 't1' })).toEqual({ preset: 'last-month-end', basis: 'accrual', tenantId: 't1' });
    expect(h.queryFor(h.defaultControls())).toEqual({ preset: 'last-month-end', basis: 'accrual' });
  });

  test('the month is sent only under "Month end…"', () => {
    expect(h.queryFor({ preset: 'month', month: '2026-06', compare: 'none', basis: 'accrual' })).toEqual({ preset: 'month', month: '2026-06', basis: 'accrual' });
    expect(h.queryFor({ preset: 'this-month', month: '2026-06', compare: 'none', basis: 'accrual' })).toEqual({ preset: 'this-month', basis: 'accrual' });
  });

  test('the comparison and its count are sent together, the count kept to 1–11', () => {
    expect(h.queryFor({ preset: 'last-fy-end', compare: 'quarter', periods: 3, basis: 'accrual' }))
      .toEqual({ preset: 'last-fy-end', compare: 'quarter', periods: '3', basis: 'accrual' });
    expect(h.queryFor({ preset: 'last-fy-end', compare: 'year', periods: 12, basis: 'accrual' }).periods).toBe('11');
    expect(h.queryFor({ preset: 'last-fy-end', compare: 'month', periods: 0, basis: 'accrual' }).periods).toBe('1');
    expect(h.queryFor({ preset: 'last-fy-end', compare: 'none', periods: 3, basis: 'accrual' })).toEqual({ preset: 'last-fy-end', basis: 'accrual' });
    expect([0, -1, 'x', undefined, 3.7, 11, 12].map(h.clampPeriods)).toEqual([1, 1, 1, 1, 3, 11, 11]);
  });

  test('the basis is cash or accrual, nothing else', () => {
    expect(h.queryFor({ preset: 'last-month-end', basis: 'cash' }).basis).toBe('cash');
    expect(h.queryFor({ preset: 'last-month-end', basis: 'other' }).basis).toBe('accrual');
    expect(h.queryFor({}).preset).toBe('last-month-end');
  });

  test('every control the tab offers is named', () => {
    expect(h.datePresets().map(p => p.key)).toEqual(['last-month-end', 'last-quarter-end', 'last-fy-end', 'this-month', 'month']);
    expect(h.datePresets().map(p => p.label)).toEqual(['End of last month', 'End of last quarter', 'End of last financial year', 'This month so far', 'Month end…']);
    expect(h.compareOptions().map(c => c.key)).toEqual(['none', 'month', 'quarter', 'year']);
    expect(h.basisOptions().map(b => b.key)).toEqual(['accrual', 'cash']);
  });
});

describe('the caption and the columns', () => {
  test('say the date and the basis', () => {
    expect(h.captionFor(sheet)).toBe('As at 30 September 2026 · Accrual basis');
    expect(h.captionFor({ ...sheet, basis: 'cash' })).toBe('As at 30 September 2026 · Cash basis');
  });

  test('a sheet for the month in progress says so', () => {
    const live = { ...sheet, asAt: { iso: '2026-10-31', label: '31 October 2026', preset: 'this-month', inProgress: true } };
    expect(h.captionFor(live)).toBe('As at 31 October 2026 (this month so far) · Accrual basis');
  });

  test('without a sheet there is no caption; without a readable date the server\'s label stands', () => {
    expect(h.captionFor(null)).toBe('');
    expect(h.captionFor({})).toBe('');
    expect(h.captionFor({ asAt: { iso: '', label: 'end of September' }, basis: 'accrual' })).toBe('As at end of September · Accrual basis');
  });

  test('the columns are headed by their dates, newest left, and the live column is marked', () => {
    expect(h.columnLabels(sheet)).toEqual(['30 Sep 2026', '31 Aug 2026', '31 Jul 2026']);
    const live = { ...sheet, asAt: { ...sheet.asAt, iso: '2026-10-31', inProgress: true },
                   columns: [{ iso: '2026-10-31' }, { iso: '2026-09-30' }] };
    expect(h.columnLabels(live)).toEqual(['31 Oct 2026 so far', '30 Sep 2026']);
    expect(h.columnLabels({ columns: [{ iso: 'bad', label: 'Sep' }] })).toEqual(['Sep']);
    expect(h.columnLabels({})).toEqual([]);
  });

  test('dates read from the string, so no timezone moves them', () => {
    expect(h.longDay('2026-09-30')).toBe('30 September 2026');
    expect(h.shortDay('2027-02-01')).toBe('1 Feb 2027');
    expect(h.longDay(null)).toBe('');
  });
});

describe('which rows show', () => {
  test('a row is nil when every column prints as nil', () => {
    expect(h.isZeroRow({ values: [0, 0, 0] })).toBe(true);
    expect(h.isZeroRow({ values: [0, 0, 0.004] })).toBe(true);
    expect(h.isZeroRow({ values: [1200, 0, 0] })).toBe(false);
    expect(h.isZeroRow({ values: [-0.01] })).toBe(false);
    expect(h.isZeroRow({})).toBe(true);
  });

  test('nil rows are hidden unless asked for, from a subgroup or a list', () => {
    const bank = sheet.groups[0].subgroups[0];
    expect(h.visibleRows(bank).map(r => r.label)).toEqual(['Aspire SGD account']);
    expect(h.visibleRows(bank, { zeroRows: true }).map(r => r.label)).toEqual(['Aspire SGD account', 'Petty cash']);
    expect(h.visibleRows(bank.rows, { zeroRows: false })).toHaveLength(1);
    expect(h.visibleRows(null)).toEqual([]);
  });

  test('and counted, for the footnote that says so', () => {
    expect(h.hiddenRowCount(sheet)).toBe(1);
    expect(h.hiddenRowCount(null)).toBe(0);
  });
});

describe('the sheet as lines to print', () => {
  const kinds = rows => rows.map(r => `${r.kind}:${r.label}`);

  test('groups, subgroups, accounts and totals in Xero\'s order, with net assets before equity', () => {
    expect(kinds(h.sheetRows(sheet))).toEqual([
      'section:Assets',
      'heading:Bank', 'account:Aspire SGD account', 'subtotal:Total Bank',
      'heading:Current Assets', 'account:Accounts Receivable', 'subtotal:Total Current Assets',
      'total:Total Assets',
      'section:Liabilities',
      'heading:Current Liabilities', 'account:Accounts Payable', 'subtotal:Total Current Liabilities',
      'total:Total Liabilities',
      'net:Net Assets',
      'section:Equity',
      'account:Current Year Earnings', 'account:Owner A Share Capital',
      'total:Total Equity',
    ]);
  });

  test('zero rows come back on request; a subgroup with every row hidden keeps its title and total', () => {
    expect(kinds(h.sheetRows(sheet, { zeroRows: true })).slice(1, 5))
      .toEqual(['heading:Bank', 'account:Aspire SGD account', 'account:Petty cash', 'subtotal:Total Bank']);
    const onlyNil = { groups: [{ key: 'assets', title: 'Assets', subgroups: [
      { title: 'Bank', rows: [{ label: 'Petty cash', values: [0] }], total: { label: 'Total Bank', values: [0] } },
    ], total: { label: 'Total Assets', values: [0] } }] };
    expect(kinds(h.sheetRows(onlyNil))).toEqual(['section:Assets', 'heading:Bank', 'subtotal:Total Bank', 'total:Total Assets']);
  });

  test('an equity subgroup named like its group prints one heading, not two', () => {
    const equity = { groups: [{ key: 'equity', title: 'Equity', subgroups: [
      { title: 'Equity', rows: [{ label: 'Owner A Share Capital', values: [100000] }], total: { label: 'Total Equity', values: [100000] } },
    ], total: null }], netAssets: { label: 'Net Assets', values: [100000] } };
    expect(kinds(h.sheetRows(equity))).toEqual(['net:Net Assets', 'section:Equity', 'account:Owner A Share Capital', 'subtotal:Total Equity']);
  });

  test('an account line carries its values, code, id and indent; a title line none', () => {
    const rows = h.sheetRows(sheet);
    expect(rows[2]).toEqual({ kind: 'account', label: 'Aspire SGD account', values: [135491, 120250, 118900], depth: 2, code: '090', accountId: 'a1' });
    expect(rows[0]).toEqual({ kind: 'section', label: 'Assets', values: [], depth: 0 });
    expect(rows[1].depth).toBe(1);
    expect(rows.find(r => r.kind === 'subtotal').depth).toBe(1);
    expect(rows.find(r => r.kind === 'total').depth).toBe(0);
    expect(rows.find(r => r.kind === 'net').values).toEqual([137191, 120250, 118900]);
  });

  test('net assets close a sheet with no equity group, and a sheet without them has no such line', () => {
    const noEquity = { ...sheet, groups: sheet.groups.slice(0, 2) };
    const rows = h.sheetRows(noEquity);
    expect(rows[rows.length - 1].kind).toBe('net');
    expect(kinds(h.sheetRows({ ...sheet, netAssets: null }))).not.toContainEqual(expect.stringMatching(/^net:/));
    expect(h.sheetRows(null)).toEqual([]);
    expect(h.sheetRows({ groups: [], netAssets: { values: [1] } })).toEqual([{ kind: 'net', label: 'Net Assets', values: [1], depth: 0 }]);
  });
});

describe('what a failed load says', () => {
  const SCOPE = 'accounting.reports.balancesheet.read';
  const reconnect = 'This needs a wider Xero connection than you have — reconnect in Setup to grant access to bank transactions and reports.';

  test('any failure but a 403 is said as the server said it', () => {
    expect(h.errorNotice({ error: 'HTTP 500', errorStatus: 500 }, null)).toEqual({ text: 'HTTP 500', reconnect: false });
    expect(h.errorNotice({ error: 'Bad month', errorStatus: 400 }, { refusedScopes: [SCOPE] })).toEqual({ text: 'Bad month', reconnect: false });
    expect(h.errorNotice(null, null)).toEqual({ text: '', reconnect: false });
  });

  test('a 403 is the server\'s reconnect prompt, with the way to Setup', () => {
    expect(h.errorNotice({ error: reconnect, errorStatus: 403 }, null)).toEqual({ text: reconnect, reconnect: true });
    expect(h.errorNotice({ error: reconnect, errorStatus: 403 }, { refusedScopes: ['accounting.attachments'] }).reconnect).toBe(true);
    expect(h.errorNotice({ error: reconnect, errorStatus: 403 }, { missingScopes: [SCOPE] }).reconnect).toBe(true);
  });

  test('unless Xero refused the app the permission, when no reconnect is offered', () => {
    const n = h.errorNotice({ error: reconnect, errorStatus: 403 }, { missingScopes: [SCOPE], refusedScopes: [SCOPE] });
    expect(n.reconnect).toBe(false);
    expect(n.text).toMatch(/^Xero refused the Balance Sheet permission for this app/);
    expect(h.balanceRefused({ refusedScopes: [SCOPE] })).toBe(true);
    expect(h.balanceRefused({ refusedScopes: ['accounting.reports.trialbalance.read'] })).toBe(false);
    expect(h.balanceRefused(undefined)).toBe(false);
  });
});

describe('the check panel\'s wording for the sheet', () => {
  test('says what the check does for each report, the budget by default', () => {
    expect(check.checkIntro('balance-check')).toBe('The sheet checked against Xero\'s Trial Balance, read separately, account by account. Read-only.');
    expect(check.checkIntro('budget-check')).toBe('The grid asked for again without comparison periods, line by line. Read-only; up to three Xero calls.');
    expect(check.checkIntro(undefined)).toBe(check.checkIntro('budget-check'));
  });

  test('how to see the same balances in Xero: the report, the basis, and a date per column', () => {
    expect(check.balanceHowTo({ basis: 'accrual', columns: sheet.columns })).toEqual([
      'In Xero: Reports → Balance Sheet. Accounting basis: accrual. Compare with: none.',
      'Date = 30 Sep 2026 matches the app\'s first column.',
      'Date = 31 Aug 2026 or 31 Jul 2026 matches the comparison column of that date.',
    ]);
    expect(check.balanceHowTo({ basis: 'cash', asAt: { iso: '2026-09-30' } })).toEqual([
      'In Xero: Reports → Balance Sheet. Accounting basis: cash. Compare with: none.',
      'Date = 30 Sep 2026 matches the app\'s first column.',
    ]);
    expect(check.balanceHowTo({})).toHaveLength(1);
  });
});

describe('the page is wired to the tab', () => {
  const page = read('pages/XeroInsights.jsx');

  test('the tab sits between Banking and Budget vs Actual, and is not a performance tab', () => {
    expect(page).toMatch(/\{ key: 'banking',\s+label: 'Banking' \},[\s\S]*?\{ key: 'balance',\s+label: 'Balance Sheet' \},[\s\S]*?\{ key: 'budget',\s+label: 'Budget vs Actual' \}/);
    expect(page).toMatch(/const PERF_TABS = \['overview', 'revenue', 'banking', 'profit', 'analysis', 'cashflow'\];/);
    expect(page).toMatch(/import BalanceSheetTab from '\.\/xero-insights\/BalanceSheetTab';/);
    expect(page).toMatch(/import \{ defaultControls, queryFor \} from '\.\/xero-insights\/balance';/);
  });

  test('it has its own state, counter and fetch, with the query from the controls and the organisation', () => {
    expect(page).toMatch(/const \[balance, setBalance\] = useState\(BALANCE_IDLE\);/);
    expect(page).toMatch(/const \[balanceControls, setBalanceControls\] = useState\(defaultControls\);/);
    expect(page).toMatch(/const seq = useRef\(\{[^}]*\bbalance: 0\b/);
    expect(page).toMatch(/return queryFor\(\{ \.\.\.balanceControls, \.\.\.\(controls \|\| \{\}\), tenantId: activeTenantId \|\| '' \}\);/);
    expect(page).toMatch(/api\.get\(`\/xero-reports\/balance-sheet\?\$\{params\.toString\(\)\}`\)/);
    expect(page).toMatch(/if \(n === seq\.current\.balance\) setBalance\(\{ status: 'done', data: d, error: '' \}\);/);
    // A change of control is asked for at once, with the new values.
    expect(page).toMatch(/setBalanceControls\(next\);\s+fetchBalance\(\{ controls: next \}\);/);
  });

  test('it is fetched on opening, re-asked after a change seen in Xero, and reset on a switch of organisation', () => {
    expect(page).toMatch(/if \(tab === 'balance'\) \{\s+if \(balance\.status === 'idle'\) fetchBalance\(\);\s+else if \(staleOnOpen\('balance', balance\.data\?\.fetchedAt\)\) fetchBalance\(\{ quiet: true \}\);/);
    const refetch = page.slice(page.indexOf('async function refetchShown()'), page.indexOf('function staleOnOpen('));
    expect(refetch).toMatch(/if \(tab === 'balance'\)\s+jobs\.push\(fetchBalance\(\{ quiet: true \}\)\);/);
    expect(page).toMatch(/if \(tab === 'balance'\) \{ setBalance\(BALANCE_IDLE\); fetchBalance\(\); \}\s+else \{ seq\.current\.balance\+\+; setBalance\(BALANCE_IDLE\); \}/);
    expect(page).toMatch(/if \(tab === 'balance'\) fetchBalance\(\{ force: true \}\);/);
  });

  test('a quiet fetch keeps the sheet and says nothing; a failure keeps its status for the tab to word', () => {
    expect(page).toMatch(/if \(!opts\.quiet\) setBalance\(/);
    expect(page).toMatch(/if \(opts\.quiet\) setBalance\(s => \(s\.status === 'done' \? s : \{ \.\.\.s, status: 'done' \}\)\);/);
    expect(page).toMatch(/setBalance\(s => \(\{ status: 'done', data: s\.data, error: err\.message, errorStatus: err\.status \}\)\)/);
  });

  test('the status line counts the sheet among the reads on screen, and the tab gets the export query', () => {
    expect(page).toMatch(/if \(tab === 'balance' && !balance\.error\)\s+reads\.push\(balance\.data\?\.fetchedAt\);/);
    expect(page).toMatch(/<BalanceSheetTab balance=\{balance\} controls=\{balanceControls\} onControls=\{changeBalanceControls\}[\s\S]*?exportQuery=\{balanceQuery\(\)\}/);
  });
});

describe('the tab, the panel and the banner are wired to these helpers', () => {
  const tab    = read('pages/xero-insights/BalanceSheetTab.jsx');
  const panel  = read('pages/xero-insights/XeroCheckPanel.jsx');
  const banner = read('components/layout/XeroConnectionBanner.jsx');

  test('the tab lays out the helpers\' decisions and offers every control', () => {
    for (const name of ['captionFor', 'columnLabels', 'sheetRows', 'hiddenRowCount', 'monthOptions', 'queryFor|datePresets', 'errorNotice', 'clampPeriods']) {
      expect(tab).toMatch(new RegExp(`import \\{[^}]*\\b(${name})\\b[^}]*\\} from '\\./balance'`, 's'));
    }
    expect(tab).toMatch(/datePresets\(\)\.map/);
    expect(tab).toMatch(/compareOptions\(\)\.map/);
    expect(tab).toMatch(/basisOptions\(\)\.map/);
    expect(tab).toMatch(/controls\.compare !== 'none' &&/);
    expect(tab).toMatch(/controls\.preset === 'month' &&/);
    expect(tab).toMatch(/Show account codes/);
    expect(tab).toMatch(/Show zero-balance rows/);
    expect(tab).toMatch(/if \(next\.preset === 'month' && !next\.month\) next\.month = months\[0\];/);
    expect(tab).toMatch(/This month so far&rdquo; includes everything dated in the month\./);
    // Sideways scroll with the account column pinned, as the budget grid.
    expect(tab).toMatch(/overflowX: 'auto'/);
    expect(tab).toMatch(/position: 'sticky', left: 0/);
  });

  test('the tab exports, checks and words a failure as the helpers say', () => {
    expect(tab).toMatch(/<BudgetExport kind="balance" query=\{exportQuery\} disabled=\{!ready\} \/>/);
    expect(tab).toMatch(/<XeroCheckPanel key=\{JSON\.stringify\(exportQuery\)\} query=\{exportQuery\} endpoint="balance-check" howTo=\{balanceHowTo\}/);
    expect(tab).toMatch(/Check against Xero/);
    expect(tab).toMatch(/const notice = errorNotice\(balance, connection\);/);
    expect(tab).toMatch(/\{notice\.reconnect && <> <Link to="\/setup"/);
    // The connection is asked for only after a 403.
    expect(tab).toMatch(/if \(balance\.errorStatus !== 403\) return undefined;\s+let alive = true;\s+api\.get\('\/xero\/connection'\)/);
  });

  test('the panel takes the route and the how-to from the tab, and keeps the budget ones by default', () => {
    expect(panel).toMatch(/export function XeroCheckPanel\(\{ query, onClose, endpoint = 'budget-check', howTo = xeroHowTo \}\)/);
    expect(panel).toMatch(/api\.get\(`\/xero-reports\/balance-check\?\$\{params\.toString\(\)\}`\)/);
    expect(panel).toMatch(/api\.get\(`\/xero-reports\/budget-check\?\$\{params\.toString\(\)\}`\)/);
    expect(panel).toMatch(/\{checkIntro\(endpoint\)\}/);
    expect(panel).toMatch(/\{howTo\(d\)\.map\(/);
  });

  test('the banner does not ask for a reconnect over a scope Xero refused', () => {
    expect(banner).toMatch(/const refused = Array\.isArray\(c\.refusedScopes\) \? c\.refusedScopes : \[\];/);
    expect(banner).toMatch(/\.filter\(s => !refused\.includes\(s\)\);/);
  });
});
