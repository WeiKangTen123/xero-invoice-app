// Wording for the "Check against Xero" panel: what the check does for the
// report it sits under, the one-line verdict, which checks found something,
// and how to see the same figures in Xero itself.
//
// Plain functions with no imports, so main/scripts/xero-check-ui.test.js and
// main/scripts/balance-ui.test.js can load and run them against a payload;
// the panel (XeroCheckPanel.jsx) only lays them out.

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// '2026-09-30' -> '30 Sep 2026', read from the string so no timezone moves
// it. Same wording as bits.jsx#dayLabel, repeated here to keep this file
// free of imports.
export function isoDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${Number(m[3])} ${MONTH_ABBR[Number(m[2]) - 1]} ${m[1]}` : '';
}

// When Xero was asked, as a clock time in the reader's locale: "09:58". The
// date is left off because a verdict older than today is never shown — the
// server keeps one for ten minutes.
export function checkedTime(iso, opts = {}) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...opts });
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The line under the panel's title: what the check does for this report, so
// "agrees" is read against the right proof. The budget grid is asked for
// again without the comparison periods its columns are matched off; the
// Balance Sheet is read a second way, from the Trial Balance, which carries
// the same closing balances with no layout to get wrong.
export function checkIntro(endpoint) {
  if (endpoint === 'balance-check') {
    return 'The sheet checked against Xero\'s Trial Balance, read separately, account by account. Read-only.';
  }
  return 'The grid asked for again without comparison periods, line by line. Read-only; up to three Xero calls.';
}

// What a check covered: the lines it compared, or for the budget the quarters.
export function countOf(check) {
  return check.quarters !== undefined ? plural(check.quarters, 'quarter') : plural(check.lines || 0, 'line');
}

// The lines a check disagrees on: a line differing in two quarters is one
// line, and a line only on one side counts once.
function linesFound(check) {
  const names = new Set((check.differences || []).map(x => `${x.section}\u0000${x.label}`));
  return names.size + (check.onlyInXero || []).length + (check.onlyInApp || []).length;
}

// The verdict in one line. On agreement it names every check that ran with
// what it covered, so "agrees" is never read as more than was checked:
// "Xero agrees on every line: closed span Jan – Sep 2026 (34 lines), September
// alone (34 lines), budget by quarter (3 quarters) · 3 Xero calls · checked
// 09:58". `time` is checkedTime's output, formatted by the panel.
export function checkSummary(d, time) {
  const ran   = (d.checks || []).filter(c => !c.skipped);
  const parts = ran.map(c => `${c.label} (${countOf(c)})`).join(', ');
  const tail  = ` · ${plural(d.calls || 0, 'Xero call')}${time ? ` · checked ${time}` : ''}`;
  if (!ran.length) return `Nothing could be checked for this period yet${tail}`;
  if (d.ok) return `Xero agrees on every line: ${parts}${tail}`;
  const n = ran.reduce((s, c) => s + linesFound(c), 0);
  return `Xero differs on ${plural(n, 'line')}: ${parts}${tail}`;
}

// The checks with something to show, in the server's order.
export function findings(d) {
  return (d.checks || []).filter(c => !c.skipped && !c.ok);
}

// A difference's line as the table names it: the label, and for the budget
// the quarter it is in.
export function lineTitle(x) {
  return x.column ? `${x.label} · ${x.column}` : x.label;
}

// How to see the same figures in Xero, as steps a reader can follow. The
// closed-through date reproduces the app's to-date view and the current
// month's end its "so far" view; each is left out when the period has no
// such month. "Year to date" is the server's own label for the view, so a
// quarter or a custom range is not called a year here.
export function xeroHowTo(d) {
  const p = d.period || {};
  const lines = ['In Xero: Reports → Budget Variance. Budget: Overall Budget. Accounting basis: accrual.'];
  if (p.closedThroughISO) {
    lines.push(`Date = ${isoDay(p.closedThroughISO)} matches the app's "${p.toDateLabel || 'To date'}" view.`);
  }
  if (p.current?.endISO) {
    lines.push(`Date = ${isoDay(p.current.endISO)} matches the app with "${p.current.label} · so far" selected.`);
  }
  return lines;
}

// The same for the Balance Sheet. Xero's report is one date at a time, so
// each column of the app's sheet is a date to set there; the basis is named
// because a cash-basis sheet carries different balances under the same
// headings. The columns are read off the check's payload (the server echoes
// the sheet's), falling back to the as-at date alone.
export function balanceHowTo(d) {
  const basis = d.basis === 'cash' ? 'cash' : 'accrual';
  const lines = [`In Xero: Reports → Balance Sheet. Accounting basis: ${basis}. Compare with: none.`];
  const cols  = (d.columns || []).filter(c => c?.iso);
  const dates = cols.length ? cols.map(c => c.iso) : (d.asAt?.iso ? [d.asAt.iso] : []);
  if (dates.length) lines.push(`Date = ${isoDay(dates[0])} matches the app's first column.`);
  if (dates.length > 1) {
    lines.push(`Date = ${dates.slice(1).map(isoDay).join(' or ')} matches the comparison column of that date.`);
  }
  return lines;
}
