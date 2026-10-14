// The Balance Sheet tab's decisions: which dates and comparisons the controls
// offer, the query they make, how the sheet is captioned and its columns
// headed, which rows a reader sees and in what order, and what to say when
// Xero will not give the report.
//
// Plain functions with no imports, so main/scripts/balance-ui.test.js can load
// and run them; the tab (BalanceSheetTab.jsx) and the page (XeroInsights.jsx)
// only lay them out.

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// The scope the report needs. Its companion, the Trial Balance scope, is what
// exact dates and the check against Xero read; the banner (live.js) asks for
// both at once, and this file only has to know which one the tab itself
// cannot do without.
const BALANCE_SHEET_SCOPE = 'accounting.reports.balancesheet.read';

// Comparison columns at most, as Xero's own report allows.
const MAX_PERIODS = 11;
// An exact date's columns are a Trial Balance call each, so fewer of them.
const MAX_EXACT_PERIODS = 4;
// Month ends offered under "Month end…": three years is as far back as anyone
// has asked to look, and keeps the list readable.
const MONTH_ENDS_OFFERED = 36;
// The earliest exact date the server takes.
export const EARLIEST_DATE = '1990-01-01';

const norm = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const money2 = v => Math.abs(Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The two presets that name a day rather than a month end. Xero's Balance
// Sheet report can only be as at a month end, so the server builds these from
// the Trial Balance, and offers them only once that construction has agreed
// with the report (the gate, xero/balance-sheet.js#getExactDates).
export function isExactPreset(preset) {
  return preset === 'today' || preset === 'date';
}

// The comparison count a preset allows.
export function maxPeriods(preset) {
  return isExactPreset(preset) ? MAX_EXACT_PERIODS : MAX_PERIODS;
}

// What the gate's outcome, as the sheet's payload carries it under
// `exactDates`, means for the Date menu: whether exact dates are known about
// at all yet (not before the first sheet has loaded), whether they can be
// picked, and if not, what to say and whether Setup is the way to fix it.
// `currency` names the difference a mismatch is worded with.
export function exactDatesState(gate, currency = '') {
  if (!gate || typeof gate !== 'object') return { known: false, available: false, reason: 'unknown', note: '', reconnect: false };
  if (gate.ok) return { known: true, available: true, reason: 'ok', note: '', reconnect: false };
  if (gate.reason === 'scope') {
    return { known: true, available: false, reason: 'scope', note: 'Exact dates unavailable: Reconnect Xero in Setup with Balance Sheet ticked.', reconnect: true };
  }
  if (gate.reason === 'mismatch') {
    // The server keeps the differences accounts first, largest first, so the
    // first is the line to look at.
    const worst  = (gate.differences || [])[0];
    const amount = worst ? [currency, money2(worst.diff)].filter(Boolean).join(' ') : '';
    return {
      known: true, available: false, reason: 'mismatch', reconnect: false,
      note: `Exact dates unavailable: Xero's Trial Balance does not reconcile with its Balance Sheet${worst ? ` (difference ${amount} on ${worst.label})` : ''}`,
    };
  }
  return { known: true, available: false, reason: 'error', reconnect: false, note: "Exact dates unavailable: Xero's Trial Balance could not be read just now. Refresh to try again." };
}

// The date the sheet is drawn at, in the order the select offers them. The
// month ends come first because a balance sheet is read at a close; "this
// month so far" is the live view, and a month of one's own comes last. Once
// it is known whether exact dates can be offered (`state`, exactDatesState),
// "Today" leads — it becomes the default when they can — and "Exact date…"
// closes the list; when they cannot, both are there but disabled, with the
// reason said under the controls. They are listed while the sheet asked for
// is one of them (`current`), so the select never shows a blank.
export function datePresets(state, current) {
  const monthEnds = [
    { key: 'last-month-end',   label: 'End of last month' },
    { key: 'last-quarter-end', label: 'End of last quarter' },
    { key: 'last-fy-end',      label: 'End of last financial year' },
    { key: 'this-month',       label: 'This month so far' },
    { key: 'month',            label: 'Month end…' },
  ];
  if (!state?.known && !isExactPreset(current)) return monthEnds;
  const disabled = !state?.available;
  return [
    { key: 'today', label: 'Today', disabled },
    ...monthEnds,
    { key: 'date',  label: 'Exact date…', disabled },
  ];
}

// The comparisons. For an exact date each is the same day in earlier months,
// quarters or years, and there can be at most four, since each is its own
// read of the Trial Balance; the menu says so rather than letting the count
// stop short without a word.
export function compareOptions(exact = false) {
  if (exact) {
    return [
      { key: 'none',    label: 'None' },
      { key: 'month',   label: `Same day, previous months (up to ${MAX_EXACT_PERIODS})` },
      { key: 'quarter', label: `Same day, previous quarters (up to ${MAX_EXACT_PERIODS})` },
      { key: 'year',    label: `Same day, previous years (up to ${MAX_EXACT_PERIODS})` },
    ];
  }
  return [
    { key: 'none',    label: 'None' },
    { key: 'month',   label: 'Previous months' },
    { key: 'quarter', label: 'Previous quarters' },
    { key: 'year',    label: 'Previous years' },
  ];
}

export function basisOptions() {
  return [{ key: 'accrual', label: 'Accrual' }, { key: 'cash', label: 'Cash' }];
}

// What the tab opens on: the last month end, alone, on the accrual basis —
// the sheet an accountant asks for first — or today, once exact dates are
// known to be available (`state`, exactDatesState). `chosen` records that the
// reader picked a date themselves, after which nothing moves it for them.
export function defaultControls(state) {
  return { preset: state?.available ? 'today' : 'last-month-end', month: '', date: '', compare: 'none', periods: 1, basis: 'accrual', chosen: false };
}

// The page opens on the last month end, since nothing is known about exact
// dates until a sheet has loaded. When that sheet says they are available and
// the reader has not picked a date, it moves to today: the new controls, or
// null for no move.
export function openOnToday(controls, data) {
  if (!controls || controls.chosen || controls.preset !== 'last-month-end') return null;
  if (!data?.exactDates?.ok || data?.asAt?.source === 'trial-balance') return null;
  return { ...controls, preset: 'today' };
}

// And back, once: a sheet for today the page chose by itself that then
// cannot be read (the gate stopped passing, or another organisation's never
// did) falls back to the last month end, marked as chosen so the two cannot
// take turns.
export function fallBackFromToday(controls, balance) {
  if (!controls || controls.chosen || !isExactPreset(controls.preset) || !balance?.error) return null;
  return { ...controls, preset: 'last-month-end', chosen: true };
}

// '2026-10-14' for a Date, in the reader's local calendar: the most an exact
// date may be.
export function todayISO(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The year and month `today` is in. A Date is read in local time, which is the
// reader's; a string ('2026-10-11' or '2026-10') is read as written, so no
// timezone can move the first of a month into the month before.
function yearMonth(today) {
  if (today instanceof Date) return { y: today.getFullYear(), m: today.getMonth() + 1 };
  const k = /^(\d{4})-(\d{2})/.exec(String(today || ''));
  if (k) return { y: Number(k[1]), m: Number(k[2]) };
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth() + 1 };
}

// The month ends that have passed, newest first, as 'YYYY-MM': on 11 Oct 2026
// the first is '2026-09'. The month in progress is left out — its end has not
// come, and "This month so far" is the way to look at it.
export function monthOptions(today, count = MONTH_ENDS_OFFERED) {
  const { y, m } = yearMonth(today);
  const out = [];
  for (let back = 1; back <= count; back++) {
    const idx = y * 12 + (m - 1) - back;
    out.push(`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`);
  }
  return out;
}

// '2026-09' -> 'Sep 2026', for the month select.
export function monthLabel(key) {
  const k = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
  return k && MONTH_ABBR[Number(k[2]) - 1] ? `${MONTH_ABBR[Number(k[2]) - 1]} ${k[1]}` : '';
}

// The comparison count as a whole number from 1 to `max` (11, or 4 for an
// exact date); anything else is one. The limit comes as an option, so the
// function can still be handed to .map, whose second argument is an index.
export function clampPeriods(n, { max = MAX_PERIODS } = {}) {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(v, max);
}

// The controls as the query the report, the check and the exports all take,
// so a PDF is the sheet on screen. Only what the server needs is sent: the
// month only under "Month end…", the day only under "Exact date…", the
// comparison only when there is one, and the organisation only once it is
// known.
export function queryFor(state = {}) {
  const q = { preset: state.preset || 'last-month-end' };
  if (q.preset === 'month' && state.month) q.month = state.month;
  if (q.preset === 'date' && state.date) q.date = state.date;
  if (state.compare && state.compare !== 'none') {
    q.compare = state.compare;
    q.periods = String(clampPeriods(state.periods, { max: maxPeriods(q.preset) }));
  }
  q.basis = state.basis === 'cash' ? 'cash' : 'accrual';
  if (state.tenantId) q.tenantId = state.tenantId;
  return q;
}

// How the reader has set the sheet out, as the export takes it: the file is
// laid out as the screen is. Sent as words, every time, so a default on one
// side cannot quietly differ from the other's.
export function viewQuery({ codes = false, zeroRows = false, decimals = true, change = false } = {}) {
  return { codes: String(!!codes), zeroRows: String(!!zeroRows), decimals: String(decimals !== false), change: String(!!change) };
}

// '2026-09-30' -> '30 September 2026' and '30 Sep 2026', read from the string
// so no timezone moves them. Same wording as bits.jsx#dayLabel, repeated here
// to keep this file free of imports.
export function longDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m && MONTH_FULL[Number(m[2]) - 1] ? `${Number(m[3])} ${MONTH_FULL[Number(m[2]) - 1]} ${m[1]}` : '';
}

export function shortDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m && MONTH_ABBR[Number(m[2]) - 1] ? `${Number(m[3])} ${MONTH_ABBR[Number(m[2]) - 1]} ${m[1]}` : '';
}

export function basisLabel(basis) {
  return basis === 'cash' ? 'Cash basis' : 'Accrual basis';
}

// Whether a sheet was built from the Trial Balance (an exact date) rather
// than read from Xero's Balance Sheet report (a month end).
export function fromTrialBalance(d) {
  return d?.asAt?.source === 'trial-balance';
}

// The sheet's subtitle: "As at 30 September 2026 · Accrual basis". A sheet for
// the month in progress is dated at the month's end but holds everything
// dated in the month as Xero holds it on the day it was read, so it says so;
// the footnote under the table spells out what that means. A sheet as at
// today holds what is dated up to today, and is called that.
export function captionFor(d) {
  if (!d?.asAt) return '';
  const day = longDay(d.asAt.iso) || d.asAt.label || '';
  const tag = d.asAt.inProgress ? (fromTrialBalance(d) ? ' (today)' : ' (this month so far)') : '';
  return `As at ${day}${tag} · ${basisLabel(d.basis)}`;
}

// The column headings, newest left as the server sends them: '30 Sep 2026'.
// The first column of a sheet for the month in progress is not a month end's
// figure, and is marked so beside the closed months next to it; nor is today's.
export function columnLabels(d) {
  return (d?.columns || []).map((c, i) => {
    const label = shortDay(c.iso) || c.label || '';
    if (i !== 0 || !d.asAt?.inProgress) return label;
    return fromTrialBalance(d) ? `${label} (today)` : `${label} so far`;
  });
}

// Where the figures come from, for the line under the title.
export function sourceLabel(d) {
  return fromTrialBalance(d) ? 'Xero Trial Balance report' : 'Xero Balance Sheet report';
}

// What the footnote says of a sheet built from the Trial Balance: how, and
// what licensed it. Empty for a month end, which is Xero's own report.
export function sourceNote(d) {
  if (!fromTrialBalance(d)) return '';
  const gate = d.exactDates;
  return 'Balances as at each date, built from Xero\'s Trial Balance, since Xero\'s Balance Sheet report can only be as at a month end.'
    + (gate?.ok && gate.atLabel ? ` Built the same way at ${gate.atLabel}, it agreed with Xero's Balance Sheet account by account.` : '');
}

// Whether there are two columns to set side by side for Change and %.
export function canShowChange(d) {
  return (d?.columns || []).length >= 2;
}

// The change between a line's first two columns, and that change as a
// fraction of the second column's size: null where the second column is nil,
// as no percentage of nothing means anything. Worked in cents, as the export
// works it (reports/balance-doc.js#changeOf), so the two agree.
export function changeOf(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const a = Number(values[0] || 0), b = Number(values[1] || 0);
  const change = Math.round((a - b) * 100) / 100 || 0;
  return { change, pct: nil(b) ? null : change / Math.abs(b) };
}

// The table's figure columns, left to right: one per date, and — when asked
// for and there are two dates — Change and % right after the first two, so
// the movement sits beside the figures it is the movement between.
export function displayColumns(d, { change = false } = {}) {
  const cols = columnLabels(d).map((label, index) => ({ kind: 'value', index, label }));
  if (!change || cols.length < 2) return cols;
  return [cols[0], cols[1], { kind: 'change', label: 'Change' }, { kind: 'pct', label: '%' }, ...cols.slice(2)];
}

// A line's figure under one of those columns: a balance, a change, or a
// fraction for %, null when there is none.
export function cellValue(row, col) {
  if (col.kind === 'value') return row?.values?.[col.index];
  const c = changeOf(row?.values);
  if (!c) return null;
  return col.kind === 'change' ? c.change : c.pct;
}

// A figure as the table prints it, the way the rest of the app prints report
// cells (utils/format.js#fmtCell): a dash for nil, brackets for a negative,
// two places — or whole units when the reader turned decimals off. Display
// only: every total is still the figure Xero or the server gave, rounded the
// same way, so a column can be a unit off the sum of its rounded lines.
export function figureText(v, decimals = true) {
  const n = Number(v || 0);
  const places = decimals ? 2 : 0;
  const scale  = 10 ** places;
  const r = Math.round(Math.abs(n) * scale) / scale;
  if (r === 0) return '-';
  const abs = r.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places });
  return n < 0 ? `(${abs})` : abs;
}

// A fraction as the % column prints it: '12.7%', or '—' where there is none.
export function pctText(fraction) {
  if (fraction === null || fraction === undefined || !Number.isFinite(Number(fraction))) return '—';
  const s = (Number(fraction) * 100).toFixed(1);
  return `${s === '-0.0' ? '0.0' : s}%`;
}

// Where a line leads, when it leads anywhere: a bank account's line to its
// statement on the Banking tab, and the receivables and payables lines to
// their ageing. The ageing is as at today whatever the sheet's date, so the
// link's title says so. Any other line stays plain.
export function drillTarget(row) {
  if (!row || row.kind !== 'account') return null;
  if (norm(row.subgroup) === 'bank' && row.accountId) {
    return { kind: 'bank', accountId: row.accountId, name: row.label, title: `Open the statement for ${row.label} on Banking` };
  }
  const label = norm(row.label);
  if (label === 'accounts receivable') return { kind: 'ageing', side: 'receivables', title: 'Open what customers owe, by age, as at today' };
  if (label === 'accounts payable')    return { kind: 'ageing', side: 'payables',    title: 'Open what is owed to suppliers, by age, as at today' };
  return null;
}

const nil = v => Math.round(Number(v || 0) * 100) === 0;

// A row whose every column prints as nil. Hidden unless asked for: a chart of
// accounts carries many lines with nothing in them, and Xero's own report
// leaves them out too.
export function isZeroRow(row) {
  return (row?.values || []).every(nil);
}

// The rows of a subgroup a reader sees. Subtotals are the caller's to print:
// they always show, so the sheet still adds up when its zero rows are hidden.
export function visibleRows(group, { zeroRows = false } = {}) {
  const rows = Array.isArray(group) ? group : (group?.rows || []);
  return zeroRows ? rows : rows.filter(r => !isZeroRow(r));
}

// How many account rows the zero-row setting hides, for the footnote that
// says so — a sheet with lines missing and nothing saying why reads as a
// sheet with lines missing.
export function hiddenRowCount(d) {
  let n = 0;
  for (const g of d?.groups || []) {
    for (const s of g.subgroups || []) n += (s.rows || []).filter(isZeroRow).length;
  }
  return n;
}

// The sheet as one list of lines to print, top to bottom: each group's title,
// its subgroups' titles, accounts and totals, the group's total, and net
// assets before equity, where Xero's own report puts it. The kinds are what
// the tab styles by; `depth` is how far a line is indented. An account line
// keeps its code for the tab to show on request, and its AccountID and the
// heading it sits under for drillTarget.
export function sheetRows(d, { zeroRows = false } = {}) {
  const out = [];
  const line = (kind, label, values, depth, extra = {}) => out.push({ kind, label: label || '', values: values || [], depth, ...extra });
  const net  = () => line('net', d.netAssets.label || 'Net Assets', d.netAssets.values, 0);
  const groups = d?.groups || [];
  for (const g of groups) {
    if (g.key === 'equity' && d.netAssets) net();
    line('section', g.title, null, 0);
    for (const s of g.subgroups || []) {
      // Xero prints Equity as one section whose total sits inside it, so the
      // server sends it as a group with a lone subgroup of the same name. One
      // "Equity" heading is what the reader expects, not two.
      const sameAsGroup = (s.title || '').trim().toLowerCase() === (g.title || '').trim().toLowerCase();
      if (s.title && !sameAsGroup) line('heading', s.title, null, 1);
      for (const r of visibleRows(s, { zeroRows })) {
        line('account', r.label, r.values, 2, { code: r.code || '', accountId: r.accountId || '', subgroup: s.title || '' });
      }
      if (s.total) line('subtotal', s.total.label, s.total.values, 1);
    }
    if (g.total) line('total', g.total.label, g.total.values, 0);
  }
  // A sheet with no equity group still has net assets to show, at the end.
  if (d?.netAssets && !groups.some(g => g.key === 'equity')) net();
  return out;
}

// What the connection says of the Balance Sheet permission, as
// /api/xero/connection reports it under `optional.balance`: 'granted',
// 'declined' (left unticked in Setup, by the person's choice), 'refused'
// (Xero will not let this app ask for it), 'missing' (never asked) or
// 'unknown'. An older server says only which scopes Xero refused and which
// are missing, and is read to the same answer.
export function balanceStatus(connection) {
  const s = connection?.optional?.balance?.status;
  if (['granted', 'declined', 'refused', 'missing', 'unknown'].includes(s)) return s;
  const refused = Array.isArray(connection?.refusedScopes) ? connection.refusedScopes : [];
  if (refused.includes(BALANCE_SHEET_SCOPE)) return 'refused';
  const missing = Array.isArray(connection?.missingScopes) ? connection.missingScopes : [];
  return missing.includes(BALANCE_SHEET_SCOPE) ? 'missing' : 'unknown';
}

// Whether Xero refused this app the Balance Sheet permission outright. That
// is not a scope a reconnect can add, so the tab must not send the reader to
// Setup for it.
export function balanceRefused(connection) {
  return balanceStatus(connection) === 'refused';
}

// What the tab says when what became of the permission is the reason it
// cannot read, or null when the server's own reconnect prompt is the right
// thing to show. Refused: nothing in Setup helps, so no way there is
// offered. Declined: the box in Setup does, so the reader is sent to it by
// name. Missing, or not known: the server's prompt, which asks for a
// reconnect, and a reconnect asks for the scope.
export function balanceOffMessage(connection) {
  const status = balanceStatus(connection);
  if (status === 'refused') {
    return { text: 'Xero does not allow this app the Balance Sheet permission, so the tab cannot be read. Reconnecting will not add it.', reconnect: false };
  }
  if (status === 'declined') {
    return { text: 'The Balance Sheet permission was not requested when Xero was connected. Tick \'Balance Sheet\' in Setup and connect again.', reconnect: true };
  }
  return null;
}

// What the tab says over a failed load. A 403 is the connection lacking the
// scope: what became of it decides the wording (balanceOffMessage), and
// failing that the server's own message, a reconnect prompt, is shown with
// the way to Setup. Any other failure is said as the server said it.
export function errorNotice(balance, connection) {
  const text = balance?.error || '';
  if (balance?.errorStatus !== 403) return { text, reconnect: false };
  return balanceOffMessage(connection) || { text, reconnect: true };
}
