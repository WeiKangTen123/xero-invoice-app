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
// the check against Xero reads; the banner (live.js) asks for both at once,
// and this file only has to know which one the tab itself cannot do without.
const BALANCE_SHEET_SCOPE = 'accounting.reports.balancesheet.read';

// Comparison columns at most, as Xero's own report allows.
const MAX_PERIODS = 11;
// Month ends offered under "Month end…": three years is as far back as anyone
// has asked to look, and keeps the list readable.
const MONTH_ENDS_OFFERED = 36;

// The date the sheet is drawn at, in the order the select offers them. The
// month ends come first because a balance sheet is read at a close; "this
// month so far" is the live view, and a month of one's own comes last.
export function datePresets() {
  return [
    { key: 'last-month-end',   label: 'End of last month' },
    { key: 'last-quarter-end', label: 'End of last quarter' },
    { key: 'last-fy-end',      label: 'End of last financial year' },
    { key: 'this-month',       label: 'This month so far' },
    { key: 'month',            label: 'Month end…' },
  ];
}

export function compareOptions() {
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
// the sheet an accountant asks for first.
export function defaultControls() {
  return { preset: 'last-month-end', month: '', compare: 'none', periods: 1, basis: 'accrual' };
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

// The comparison count as a whole number from 1 to 11; anything else is one.
export function clampPeriods(n) {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(v, MAX_PERIODS);
}

// The controls as the query the report, the check and the exports all take,
// so a PDF is the sheet on screen. Only what the server needs is sent: the
// month only under "Month end…", the comparison only when there is one, and
// the organisation only once it is known.
export function queryFor(state = {}) {
  const q = { preset: state.preset || 'last-month-end' };
  if (q.preset === 'month' && state.month) q.month = state.month;
  if (state.compare && state.compare !== 'none') {
    q.compare = state.compare;
    q.periods = String(clampPeriods(state.periods));
  }
  q.basis = state.basis === 'cash' ? 'cash' : 'accrual';
  if (state.tenantId) q.tenantId = state.tenantId;
  return q;
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

// The sheet's subtitle: "As at 30 September 2026 · Accrual basis". A sheet for
// the month in progress is dated at the month's end but holds everything
// dated in the month as Xero holds it on the day it was read, so it says so;
// the footnote under the table spells out what that means.
export function captionFor(d) {
  if (!d?.asAt) return '';
  const day = longDay(d.asAt.iso) || d.asAt.label || '';
  return `As at ${day}${d.asAt.inProgress ? ' (this month so far)' : ''} · ${basisLabel(d.basis)}`;
}

// The column headings, newest left as the server sends them: '30 Sep 2026'.
// The first column of a sheet for the month in progress is not a month end's
// figure, and is marked so beside the closed months next to it.
export function columnLabels(d) {
  return (d?.columns || []).map((c, i) => {
    const label = shortDay(c.iso) || c.label || '';
    return i === 0 && d.asAt?.inProgress ? `${label} so far` : label;
  });
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
// keeps its code for the tab to show on request.
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
        line('account', r.label, r.values, 2, { code: r.code || '', accountId: r.accountId || '' });
      }
      if (s.total) line('subtotal', s.total.label, s.total.values, 1);
    }
    if (g.total) line('total', g.total.label, g.total.values, 0);
  }
  // A sheet with no equity group still has net assets to show, at the end.
  if (d?.netAssets && !groups.some(g => g.key === 'equity')) net();
  return out;
}

// Whether Xero refused this app the Balance Sheet permission outright, as
// /api/xero/connection reports it. That is not a scope a reconnect can add,
// so the tab must not send the reader to Setup for it.
export function balanceRefused(connection) {
  const refused = Array.isArray(connection?.refusedScopes) ? connection.refusedScopes : [];
  return refused.includes(BALANCE_SHEET_SCOPE);
}

// What the tab says over a failed load. A 403 is the connection lacking the
// scope, and the server's own message is a reconnect prompt, so the way to
// Setup is offered with it — unless Xero refused the app the permission
// itself, when a reconnect changes nothing and the reader is told that
// instead. Any other failure is said as the server said it.
export function errorNotice(balance, connection) {
  const text = balance?.error || '';
  if (balance?.errorStatus !== 403) return { text, reconnect: false };
  if (balanceRefused(connection)) {
    return { text: 'Xero refused the Balance Sheet permission for this app, so the report cannot be read. Reconnecting will not add it.', reconnect: false };
  }
  return { text, reconnect: true };
}
