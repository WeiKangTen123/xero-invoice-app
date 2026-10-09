const fs   = require('fs');
const path = require('path');

// The "Check against Xero" panel on the screen side. There is no React test
// setup in this project, so this follows budget-tabs-ui.test.js: the wording
// — the one-line verdict, which checks have findings, how to see the same
// figures in Xero — is plain functions in xero-check.js, a file with no
// imports, loaded whole and run here against a payload shaped as the server
// sends it (see xero/budget-check.js); the wiring is checked in the source.
const UI = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');
const HELPERS = 'pages/xero-insights/xero-check.js';

function loadHelpers() {
  const src = read(HELPERS);
  // The whole point of the file having no imports: it runs as it is.
  expect(src).not.toMatch(/^import /m);
  const names = [...src.matchAll(/^export function (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}
const h = loadHelpers();

const check = (key, label, extra = {}) => ({
  key, label, skipped: false, lines: 34, matched: 34, differences: [], onlyInXero: [], onlyInApp: [], calls: 1, ok: true, ...extra,
});
// A verdict on 9 Oct 2026 over Jan–Dec 2026: Jan–Sep closed, October in progress.
const agreed = {
  ok: true, checkedAt: '2026-10-09T09:58:00.000Z', calls: 3,
  checks: [check('span', 'closed span Jan – Sep 2026'), check('month', 'September alone'), check('quarters', 'budget by quarter', { quarters: 3 })],
  notes: ['what the span proves'],
  currency: 'SGD',
  period: {
    key: 'fy', label: 'This financial year', toDateLabel: 'Year to date',
    closedThroughISO: '2026-09-30', closedFromLabel: 'Jan 2026', closedToLabel: 'Sep 2026', closedMonths: 9,
    current: { key: '2026-10', label: 'Oct 2026', endISO: '2026-10-31' },
  },
};

describe('the one-line verdict', () => {
  test('on agreement it names every check that ran, what each covered, the calls and the time', () => {
    expect(h.checkSummary(agreed, '09:58')).toBe(
      'Xero agrees on every line: closed span Jan – Sep 2026 (34 lines), September alone (34 lines), budget by quarter (3 quarters) · 3 Xero calls · checked 09:58');
  });

  test('a skipped check is not claimed, and one call is singular', () => {
    const d = {
      ...agreed, calls: 1,
      checks: [
        { key: 'span', label: 'closed span', skipped: true, reason: 'No month has closed yet', calls: 0 },
        { key: 'month', label: 'last closed month', skipped: true, reason: 'No month has closed yet', calls: 0 },
        check('quarters', 'budget by quarter', { quarters: 4 }),
      ],
    };
    expect(h.checkSummary(d, '09:58')).toBe('Xero agrees on every line: budget by quarter (4 quarters) · 1 Xero call · checked 09:58');
  });

  test('on a difference it counts the lines Xero differs on, once each', () => {
    const d = {
      ...agreed, ok: false,
      checks: [
        check('span', 'closed span Jan – Sep 2026', { ok: false, matched: 33, differences: [{ section: 'Income', label: 'Sales', app: 10800, xero: 12600, diff: -1800 }] }),
        check('month', 'September alone', { ok: false, matched: 33, differences: [{ section: 'Income', label: 'Sales', app: 0, xero: 1800, diff: -1800 }], onlyInApp: ['Wages'] }),
        check('quarters', 'budget by quarter', { quarters: 3, ok: false, differences: [
          { section: 'Income', label: 'Fees', column: 'Jan – Mar 2026', app: 1, xero: 2, diff: -1 },
          { section: 'Income', label: 'Fees', column: 'Apr – Jun 2026', app: 1, xero: 2, diff: -1 },
        ] }),
      ],
    };
    // One line in the span, two in the month (Sales and the one only in the
    // app), one in the budget however many quarters it differs in.
    expect(h.checkSummary(d, '09:58')).toBe(
      'Xero differs on 4 lines: closed span Jan – Sep 2026 (34 lines), September alone (34 lines), budget by quarter (3 quarters) · 3 Xero calls · checked 09:58');
    expect(h.findings(d).map(c => c.key)).toEqual(['span', 'month', 'quarters']);
    expect(h.lineTitle(d.checks[2].differences[0])).toBe('Fees · Jan – Mar 2026');
    expect(h.lineTitle(d.checks[0].differences[0])).toBe('Sales');
  });

  test('nothing checked is said as such, never as agreement', () => {
    const d = { ...agreed, ok: false, calls: 0, checks: agreed.checks.map(c => ({ ...c, skipped: true, reason: 'too short' })) };
    expect(h.checkSummary(d, '')).toBe('Nothing could be checked for this period yet · 0 Xero calls');
    expect(h.findings(d)).toEqual([]);
  });

  test('the time is the clock time Xero was asked at', () => {
    expect(h.checkedTime('2026-10-09T09:58:00.000Z', { timeZone: 'UTC', hour12: false })).toBe('09:58');
    expect(h.checkedTime(undefined)).toBe('');
    expect(h.checkedTime('not a date')).toBe('');
  });
});

describe('how to see the same figures in Xero', () => {
  test('names the report, the budget and the basis, then the two dates and what each matches', () => {
    expect(h.xeroHowTo(agreed)).toEqual([
      'In Xero: Reports → Budget Variance. Budget: Overall Budget. Accounting basis: accrual.',
      'Date = 30 Sep 2026 matches the app\'s "Year to date" view.',
      'Date = 31 Oct 2026 matches the app with "Oct 2026 · so far" selected.',
    ]);
  });

  test('a period with no closed month, or no month in progress, leaves that line out', () => {
    const noClosed = { ...agreed, period: { ...agreed.period, closedThroughISO: null } };
    expect(h.xeroHowTo(noClosed)).toHaveLength(2);
    expect(h.xeroHowTo(noClosed)[1]).toMatch(/^Date = 31 Oct 2026/);
    const past = { ...agreed, period: { ...agreed.period, current: null } };
    expect(h.xeroHowTo(past)).toHaveLength(2);
    expect(h.xeroHowTo(past)[1]).toMatch(/^Date = 30 Sep 2026/);
    expect(h.xeroHowTo({})).toHaveLength(1);
  });

  test('a quarter or a custom range is called what the server calls it, not a year', () => {
    const quarter = { ...agreed, period: { ...agreed.period, toDateLabel: 'Period to date' } };
    expect(h.xeroHowTo(quarter)[1]).toBe('Date = 30 Sep 2026 matches the app\'s "Period to date" view.');
  });

  test('dates read from the string, so no timezone moves them', () => {
    expect(h.isoDay('2026-09-30')).toBe('30 Sep 2026');
    expect(h.isoDay('2027-02-01')).toBe('1 Feb 2027');
    expect(h.isoDay(null)).toBe('');
  });
});

describe('the tabs and the panel are wired to these helpers', () => {
  const variance = read('pages/xero-insights/VarianceTab.jsx');
  const budget   = read('pages/xero-insights/BudgetTab.jsx');
  const panel    = read('pages/xero-insights/XeroCheckPanel.jsx');

  test('both budget tabs have the button beside Refresh and open the panel with the period on screen', () => {
    for (const src of [variance, budget]) {
      expect(src).toMatch(/import \{ XeroCheckPanel \} from '\.\/XeroCheckPanel'/);
      expect(src).toMatch(/Check against Xero/);
      expect(src).toMatch(/<XeroCheckPanel key=\{JSON\.stringify\(exportQuery\)\} query=\{exportQuery\}/);
      // Beside Refresh: the same button row.
      expect(src).toMatch(/Refresh\s*<\/button>\s*<button[^>]*onClick=\{\(\) => setChecking/);
    }
  });

  test('the panel asks the check route with the query, says it is asking, and words the verdict with the helpers', () => {
    expect(panel).toMatch(/api\.get\(`\/xero-reports\/budget-check\?\$\{params\.toString\(\)\}`\)/);
    expect(panel).toMatch(/Asking Xero…/);
    expect(panel).toMatch(/import \{[^}]*\bcheckSummary\b[^}]*\} from '\.\/xero-check'/);
    expect(panel).toMatch(/import \{[^}]*\bxeroHowTo\b[^}]*\} from '\.\/xero-check'/);
    expect(panel).toMatch(/alert-success/);
    // An error replaces the last verdict rather than sitting beside it.
    expect(panel).toMatch(/data: null, error: err\.message/);
  });
});
