const logger = require('../utils/logger');
const { _cacheGet, _cacheSet, _dedupe } = require('./report-cache');
const { getBalanceSheet }  = require('./balance-sheet');
const { getBankSummary, _bankAccountList } = require('./bank');
const { _cents, _norm }    = require('./budget-variance');
const { _addDays, _fmtISODate, _parseISODate } = require('./periods');

// Check against Xero: proof that the Balance Sheet tab is what Xero holds.
//
// The tab (./balance-sheet) reads a flat list of sections by position and
// keeps every figure as Xero printed it, so the places it could go wrong are
// a section landing under the wrong group, a total read as a row, or a column
// sliding. Each of those shows up in one of three checks, the same shape as
// the Budget vs Actual check (./budget-check):
//
//   1. identity — Net Assets equals Total Assets less Total Liabilities, and
//      equals Total Equity, in every column, from the payload alone;
//   2. subtotals — every subgroup's total is the sum of its rows and every
//      group's total the sum of its subgroups, again from the payload alone;
//   3. bank — each line of the Bank section against the closing balance the
//      Bank Summary report gives that account at the same date: one
//      read-only call, over the month to the as-at date, cached.
//
// The first two cost nothing and prove the tree was read right — a row
// misplaced or a total doubled breaks the arithmetic Xero's own figures obey.
// The third asks Xero a different question and proves the figures are the
// account balances it holds. Cached ten minutes; a failure to reach Xero is
// a failure, never an "agrees".

const CHECK_TTL_MS = 10 * 60 * 1000;
// The Bank Summary is a movement report with a closing balance, so it is read
// over a short window ending on the as-at date; the window's length does not
// change the closing figure. A month, so the call is the same one the Cash
// Flow tab may already have cached for that month.
const BANK_WINDOW_DAYS = 31;

const _sum = (vals, i) => _cents(vals.reduce((s, v) => s + (v.values[i] || 0), 0));
const _skip = (key, label, reason) => ({ key, label, skipped: true, reason, calls: 0 });

// A group's total as the tab carries it: the untitled "Total Assets" line,
// or — for Equity, where Xero prints the total inside the section itself —
// its one subgroup's total.
function _groupTotal(g) {
  if (!g) return null;
  if (g.total) return g.total;
  return g.subgroups.length === 1 ? g.subgroups[0].total : null;
}

// Pure. `app` is the figure as shown on the tab, `xero` what it is checked
// against, and `diff` app less xero, so a positive difference means the tab
// shows more. Each line is compared in every column.
function _compareLines(lines, columns) {
  const differences = [];
  let matched = 0;
  for (const line of lines) {
    let agrees = true;
    columns.forEach((col, i) => {
      const app = _cents(line.app[i] || 0), xero = _cents(line.xero[i] || 0);
      const diff = _cents(app - xero);
      if (Math.abs(diff) < 0.01) return;
      agrees = false;
      differences.push({ label: line.label, column: col.label, app, xero, diff });
    });
    if (agrees) matched++;
  }
  return { lines: lines.length, matched, differences };
}

const IDENTITY_LABEL = 'Net Assets against the totals';
function _identityCheck(sheet) {
  const net = sheet.netAssets;
  if (!net) return _skip('identity', IDENTITY_LABEL, "Xero's report has no Net Assets line, so there is no identity to check.");
  const total = key => _groupTotal(sheet.groups.find(g => g.key === key));
  const assets = total('assets'), liabilities = total('liabilities'), equity = total('equity');
  const lines = [];
  if (assets && liabilities) {
    lines.push({ label: `${net.label} = ${assets.label} − ${liabilities.label}`, app: net.values,
                 xero: sheet.columns.map((_, i) => assets.values[i] - liabilities.values[i]) });
  }
  if (equity) lines.push({ label: `${net.label} = ${equity.label}`, app: net.values, xero: equity.values });
  if (!lines.length) return _skip('identity', IDENTITY_LABEL, "Xero's report has no Total Assets and Total Liabilities, and no Total Equity, to set Net Assets against.");
  const cmp = _compareLines(lines, sheet.columns);
  return {
    key: 'identity', label: IDENTITY_LABEL, skipped: false, ok: cmp.differences.length === 0,
    ...cmp, onlyInXero: [], onlyInApp: [], calls: 0,
    proves: `${net.label} set against ${lines.map(l => l.label.replace(`${net.label} = `, '')).join(' and against ')} in every column, all as Xero printed them. Agreement means the totals were read under the right groups and no line was counted twice.`,
  };
}

const SUBTOTALS_LABEL = 'subtotals against their lines';
function _subtotalsCheck(sheet) {
  const cols  = sheet.columns;
  const lines = [];
  for (const g of sheet.groups) {
    const parts = [];   // what the group's total should add up from
    for (const s of g.subgroups) {
      const rows = cols.map((_, i) => _sum(s.rows, i));
      if (s.total) {
        lines.push({ label: s.total.label, app: rows, xero: s.total.values });
        parts.push({ values: s.total.values });
      } else {
        parts.push({ values: rows });
      }
    }
    if (g.total) lines.push({ label: g.total.label, app: cols.map((_, i) => _sum(parts, i)), xero: g.total.values });
  }
  if (!lines.length) return _skip('subtotals', SUBTOTALS_LABEL, "Xero's report has no total lines to add up to.");
  const cmp = _compareLines(lines, cols);
  return {
    key: 'subtotals', label: SUBTOTALS_LABEL, skipped: false, ok: cmp.differences.length === 0,
    ...cmp, onlyInXero: [], onlyInApp: [], calls: 0,
    proves: `Each section's total against the sum of its lines, and each group's total against the sum of its sections, in every column (${lines.length} totals). Agreement means every line sits in the section Xero printed it in and no total was read as a line.`,
  };
}

const BANK_LABEL = 'bank balances against the Bank Summary';
async function _bankCheck(userId, tenantId, sheet, force) {
  const bank = (sheet.groups.find(g => g.key === 'assets')?.subgroups || []).find(s => _norm(s.title) === 'bank');
  if (!bank || !bank.rows.length) return _skip('bank', BANK_LABEL, "Xero's report has no Bank section, so there is no bank balance to check.");

  const to   = sheet.asAt.iso;
  const from = _fmtISODate(_addDays(_parseISODate(to), -(BANK_WINDOW_DAYS - 1)));
  const [summary, list] = await Promise.all([
    getBankSummary(userId, tenantId, { from, to, force }),
    _bankAccountList(userId, tenantId, force),
  ]);
  const base       = sheet.organisation?.currency || '';
  const currencyOf = new Map(list.map(a => [_norm(a.name), a.currency || '']));
  const byName     = new Map((summary.accounts || []).map(a => [_norm(a.name), a]));
  const column     = sheet.columns[0];

  // A foreign-currency account is shown in base currency on the Balance
  // Sheet and in its own currency on the Bank Summary, so the two figures
  // are not the same thing and are not compared. A line with no Bank
  // Summary line of the same name cannot be matched, which is said rather
  // than counted as a difference.
  const excluded = [], lines = [], claimed = new Set();
  for (const row of bank.rows) {
    const name = _norm(row.label);
    const currency = currencyOf.get(name);
    if (currency && base && currency !== base) {
      excluded.push({ label: row.label, reason: `${row.label} is held in ${currency}; the Balance Sheet shows it in ${base}, so the two reports cannot be compared.` });
      continue;
    }
    const acc = byName.get(name);
    if (!acc) {
      excluded.push({ label: row.label, reason: `No line of the Bank Summary is named "${row.label}", so it could not be matched.` });
      continue;
    }
    claimed.add(name);
    lines.push({ label: row.label, app: [row.values[0]], xero: [acc.closingBalance] });
  }
  const onlyInXero = (summary.accounts || [])
    .filter(a => !claimed.has(_norm(a.name)) && !excluded.some(e => _norm(e.label) === _norm(a.name)) && Math.abs(a.closingBalance) >= 0.01)
    .map(a => a.name);

  if (!lines.length) {
    return {
      ..._skip('bank', BANK_LABEL, `None of the ${bank.rows.length} bank lines could be checked: ${excluded.map(e => e.reason).join(' ')}`),
      excluded, calls: 1,
    };
  }
  const cmp = _compareLines(lines, [column]);
  return {
    key: 'bank', label: BANK_LABEL, skipped: false, ok: cmp.differences.length === 0 && onlyInXero.length === 0,
    ...cmp, onlyInXero, onlyInApp: [], excluded, calls: 1,
    proves: `Each line of the Bank section against the closing balance Xero's Bank Summary gives that account at ${column.label}, read in one call over the month to that date.${excluded.length ? ` ${excluded.length} line${excluded.length === 1 ? '' : 's'} left out: ${excluded.map(e => e.reason).join(' ')}` : ''} Agreement means the bank figures are the balances Xero holds, not a column from another date.`,
  };
}

async function _getBalanceCheckRaw(userId, tenantId, {
  force = false, timezone = 'UTC', preset = 'last-month-end', month, compare = 'none', periods, basis = 'accrual',
} = {}) {
  // The tab under check, through its own cache and in-flight sharing: the
  // screen behind the button has just loaded it, so this costs nothing new.
  const sheet = await getBalanceSheet(userId, tenantId, { timezone, preset, month, compare, periods, basis, force });

  const key    = `balcheck:${userId}:${tenantId}:${sheet.asAt.iso}:${sheet.compare.periods || 0}:${sheet.compare.type}:${sheet.basis}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  // A rejection from the bank call is the caller's answer — nothing is cached.
  const checks = [_identityCheck(sheet), _subtotalsCheck(sheet), await _bankCheck(userId, tenantId, sheet, force)];
  const ran    = checks.filter(c => !c.skipped);
  // Agreement needs something to have been checked.
  const ok     = ran.length > 0 && ran.every(c => c.ok);
  const notes  = [
    ...checks.map(c => (c.skipped ? c.reason : c.proves)),
    `These checks read Xero's standard layout on the ${sheet.basis} basis, as the tab does. The bank check compares the as-at column only, and none of them checks a custom report layout or whether what Xero holds is itself complete.`,
  ];
  const end = _parseISODate(sheet.asAt.iso);

  logger.info('Balance Sheet check against Xero', {
    userId, tenantId, asAt: sheet.asAt.iso, calls: ran.reduce((s, c) => s + c.calls, 0), ok,
    differences: ran.reduce((s, c) => s + c.differences.length + c.onlyInXero.length + c.onlyInApp.length, 0),
  });

  return _cacheSet(key, {
    ok,
    checkedAt: new Date().toISOString(),
    calls:     checks.reduce((s, c) => s + (c.calls || 0), 0),
    checks,
    notes,
    currency:  sheet.organisation?.currency || '',
    period: {
      asAtLabel: sheet.asAt.label,
      asAtISO:   sheet.asAt.iso,
      basis:     sheet.basis,
      compare:   sheet.compare,
      // The date in progress, when it is: the balances can still move.
      current: sheet.asAt.inProgress
        ? { key: `${end.year}-${String(end.month).padStart(2, '0')}`, label: sheet.columns[0]?.label || sheet.asAt.label, endISO: sheet.asAt.iso }
        : null,
    },
  }, CHECK_TTL_MS);
}

// Bound through the one in-flight map in ./report-cache, as every report
// fetcher is, so two clicks in flight are one set of calls.
const getBalanceCheck = _dedupe('getBalanceCheck', _getBalanceCheckRaw,
  { force: false, timezone: 'UTC', preset: 'last-month-end', compare: 'none', basis: 'accrual' });

module.exports = { getBalanceCheck, CHECK_TTL_MS, BANK_WINDOW_DAYS, _identityCheck, _subtotalsCheck, _groupTotal, _compareLines };
