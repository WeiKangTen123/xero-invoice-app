const { withRetry }      = require('./xero-utils');
const logger             = require('../utils/logger');
const { _cacheGet, _cacheSet, _dedupe, _periodCacheTtl } = require('./report-cache');
const { _apiFor, _parseReportNumber, getAccounts } = require('./report-fetch');
const { _cents, _norm, _mapWithConcurrency } = require('./budget-variance');
const { _fmtISODate, _lastDayOfMonth, _parseISODate, _todayPartsInTz } = require('./periods');

// Xero's Trial Balance, read into balances per account, and those balances
// laid out as a balance sheet in the shape ./balance-sheet sends.
//
// Why it exists: Xero's Balance Sheet report can only be as at the end of a
// month (see ./balance-sheet). The Trial Balance takes any date, so it is the
// one way to show a balance sheet as at today or as at the 14th. It is not a
// balance sheet, though, so the layout is this module's: every balance-sheet
// account is placed by its Account Type from the chart of accounts, and the
// profit and loss accounts become Current Year Earnings. Nothing built here
// is shown until ./balance-sheet has proved, for the company and basis in
// question, that the same construction at the last month end gives the
// figures Xero's own Balance Sheet gives (the gate, getExactDates there).
//
// The report's shape, from Xero's OpenAPI example and the live layout:
//
//   * a Header row naming the columns: Account, Debit, Credit, YTD Debit,
//     YTD Credit. Debit and Credit are the movement in the month of the date;
//     YTD Debit and YTD Credit are the balance — for a balance-sheet account
//     everything ever posted to it, for a profit and loss account the
//     financial year to the date. So only the YTD pair is a balance, and the
//     columns are found by their names rather than assumed by position.
//   * a Section per class — Revenue, Expenses, Assets, Liabilities, Equity —
//     each holding a Row per account, its first cell "Name (Code)" with the
//     AccountID as an attribute, then an untitled section with the Total.
//   * each account has a figure in one of the two YTD cells and nothing in
//     the other, written as Xero writes report numbers.
//
// The sign rule turns the two columns into the balance the Balance Sheet
// prints: an asset is debit-positive (YTD Debit less YTD Credit), a liability
// or equity account credit-positive (YTD Credit less YTD Debit), so an
// overdrawn bank account comes out negative as it does there. Current Year
// Earnings is revenue less expenses for the year to date, which in debits and
// credits is YTD Credit less YTD Debit summed over every profit and loss
// account.
//
// Needs accounting.reports.trialbalance.read, which the consent asks for with
// the Balance Sheet scope (xero-utils OPTIONAL_SCOPE_GROUPS.balance).

// The columns of the Header row, by the name Xero gives them.
const TB_COLUMNS = { debit: 'debit', credit: 'credit', ytdDebit: 'ytd debit', ytdCredit: 'ytd credit' };
// Where they sit when a report comes without a Header row at all.
const TB_POSITIONS = { debit: 1, credit: 2, ytdDebit: 3, ytdCredit: 4 };

// Where Xero's standard Balance Sheet layout puts each Account Type, as
// [group, subgroup]. PAYGLIABILITY and SUPERANNUATIONLIABILITY are the
// Australian payroll liabilities, which that layout lists with the current
// liabilities.
const TYPE_PLACE = {
  BANK:       ['assets', 'Bank'],
  CURRENT:    ['assets', 'Current Assets'],
  INVENTORY:  ['assets', 'Current Assets'],
  PREPAYMENT: ['assets', 'Current Assets'],
  FIXED:      ['assets', 'Fixed Assets'],
  NONCURRENT: ['assets', 'Non-current Assets'],
  CURRLIAB:   ['liabilities', 'Current Liabilities'],
  LIABILITY:  ['liabilities', 'Current Liabilities'],
  PAYGLIABILITY:           ['liabilities', 'Current Liabilities'],
  SUPERANNUATIONLIABILITY: ['liabilities', 'Current Liabilities'],
  TERMLIAB:   ['liabilities', 'Non-current Liabilities'],
  EQUITY:     ['equity', 'Equity'],
};
// The profit and loss types, whose year to date is Current Year Earnings.
const PNL_TYPES = new Set(['REVENUE', 'SALES', 'OTHERINCOME', 'EXPENSE', 'DIRECTCOSTS', 'OVERHEADS', 'DEPRECIATN', 'WAGESEXPENSE', 'SUPERANNUATIONEXPENSE']);
// An account whose type the chart does not give (or gives as something new)
// is placed by the Trial Balance section it sits in, in that group's first
// ordinary subgroup, and a note names it.
const SECTION_PLACE = {
  assets:      ['assets', 'Current Assets'],
  liabilities: ['liabilities', 'Current Liabilities'],
  equity:      ['equity', 'Equity'],
};
const SUBGROUP_ORDER = {
  assets:      ['Bank', 'Current Assets', 'Fixed Assets', 'Non-current Assets'],
  liabilities: ['Current Liabilities', 'Non-current Liabilities'],
  equity:      ['Equity'],
};
const GROUP_TITLES = { assets: 'Assets', liabilities: 'Liabilities', equity: 'Equity' };
const EARNINGS_LABEL = 'Current Year Earnings';

// The most columns an exact-date sheet has: the date and four earlier ones,
// each its own Trial Balance call.
const MAX_EXACT_PERIODS = 4;
// Trial Balance calls in flight at once for one sheet. Xero allows five
// concurrent calls per organisation, and the page has other reads out.
const TB_CONCURRENCY = 3;

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const _shortDate = p => `${p.day} ${MONTHS_SHORT[p.month - 1]} ${p.year}`;

// Whole cents, so sums of many balances cannot pick up float noise.
const _c = v => Math.round(Number(v || 0) * 100);

// The class a Trial Balance section title names: 'pnl' for revenue and
// expenses, a group key for the balance-sheet classes, or null.
function _sectionClass(title) {
  const t = _norm(title);
  if (!t) return null;
  if (/revenue|income|sales|expense|cost/.test(t)) return 'pnl';
  if (/^assets?$/.test(t))       return 'assets';
  if (/^liabilit(y|ies)$/.test(t)) return 'liabilities';
  if (/equity/.test(t))          return 'equity';
  return null;
}

// "Sales (400)" → { name: 'Sales', code: '400' }. Only a short parenthesised
// tail with no spaces is taken for a code, so "Loan (Director)" keeps its
// name; the chart of accounts gives the real name and code anyway when it
// knows the account.
function _splitLabel(label) {
  const s = String(label || '').trim();
  const m = /^(.*\S)\s*\(([^\s()]{1,10})\)$/.exec(s);
  return m ? { name: m[1], code: m[2] } : { name: s, code: null };
}

// Pure. Xero's Trial Balance rows → { accounts: [{ accountId, label, code,
// section, debit, credit, ytdDebit, ytdCredit, balance }] }, in the order
// Xero lists them. `balance` follows the section's sign rule (assets
// debit-positive, everything else credit-positive); the sheet below re-signs
// by Account Type, which is the same thing whenever the section and the type
// agree. The Total row, and any other summary, is not an account and is left
// out. A report without the YTD columns cannot give a balance at all, and is
// refused rather than read as nil.
function _parseTrialBalance(reportRows) {
  const rows   = reportRows || [];
  const header = rows.find(r => r?.rowType === 'Header');
  let at = { ...TB_POSITIONS };
  if (header) {
    const names = (header.cells || []).map(c => _norm(c?.value));
    at = {};
    for (const [k, name] of Object.entries(TB_COLUMNS)) {
      const i = names.indexOf(name);
      at[k] = i > 0 ? i : null;
    }
  }
  if (at.ytdDebit === null || at.ytdCredit === null) {
    throw new Error("Xero's Trial Balance came without its YTD Debit and YTD Credit columns, so no balance could be read from it");
  }

  const num = (row, i) => (i === null || i === undefined ? 0 : _cents(_parseReportNumber(row.cells?.[i]?.value)));
  const accountIdOf = row => {
    for (const c of row.cells || []) {
      for (const a of c?.attributes || []) if (a?.id === 'account' && a.value) return String(a.value);
    }
    return null;
  };

  const accounts = [];
  const walk = (list, section) => {
    for (const r of list || []) {
      if (r?.rowType === 'Section') { walk(r.rows, String(r.title || '').trim() || section); continue; }
      if (r?.rowType !== 'Row') continue;
      const raw = String(r.cells?.[0]?.value ?? '').trim();
      if (!raw) continue;
      const { name, code } = _splitLabel(raw);
      const ytdDebit = num(r, at.ytdDebit), ytdCredit = num(r, at.ytdCredit);
      accounts.push({
        accountId: accountIdOf(r), label: name, code, section,
        debit: num(r, at.debit), credit: num(r, at.credit), ytdDebit, ytdCredit,
        balance: _cents(_sectionClass(section) === 'assets' ? ytdDebit - ytdCredit : ytdCredit - ytdDebit),
      });
    }
  };
  walk(rows.filter(r => r?.rowType !== 'Header'), '');
  return { accounts };
}

// Pure. Trial Balances, one per column and newest first, → { columns, groups,
// netAssets, notes } in the shape ./balance-sheet#_buildBalanceSheet gives,
// so the tab, the exports and the check read either the same way: assets,
// liabilities and equity, each a list of subgroups with rows and a total,
// Equity one subgroup of its own name holding Current Year Earnings first,
// and Net Assets after. Every total is summed here in whole cents from the
// rows above it.
//
// `chart` is the chart of accounts (report-fetch getAccounts) in its own
// order, which is the order rows are listed in; it gives each account's
// name, code and type. An account in no column has no row; an account in
// some columns only is nil in the others.
function _sheetFromTrialBalances(trialBalances, { columns = [], chart = [] } = {}) {
  const n     = columns.length;
  const byId  = new Map((chart || []).map((a, i) => [a.accountId, { ...a, order: i }]));
  const lines = new Map();   // account key → row being built, values in cents
  const earnings = new Array(n).fill(0);
  const notes = [];
  const noted = new Set();
  const note  = (key, text) => { if (!noted.has(key)) { noted.add(key); notes.push(text); } };

  (trialBalances || []).slice(0, n).forEach((tb, col) => {
    for (const a of tb?.accounts || []) {
      const known = a.accountId ? byId.get(a.accountId) : null;
      const type  = String(known?.type || '').toUpperCase();
      let place = TYPE_PLACE[type] || null;
      let cls   = place ? place[0] : (PNL_TYPES.has(type) ? 'pnl' : null);
      if (!cls) {
        const bySection = _sectionClass(a.section);
        if (bySection === 'pnl') cls = 'pnl';
        else if (bySection) {
          cls = bySection; place = SECTION_PLACE[bySection];
          note(`place:${a.accountId || a.label}`, `${a.label} has ${type ? `the account type ${type}` : 'no account type in the chart of accounts'}, which this app does not place; it is shown under ${place[1]}, where Xero's Trial Balance lists it with the ${GROUP_TITLES[bySection].toLowerCase()}.`);
        } else {
          note(`skip:${a.accountId || a.label}`, `Xero's Trial Balance lists ${a.label} under "${a.section || 'no heading'}", which this app does not recognise; it is left out of the sheet.`);
          continue;
        }
      }
      if (cls === 'pnl') { earnings[col] += _c(a.ytdCredit) - _c(a.ytdDebit); continue; }

      const key = a.accountId || `label:${_norm(a.label)}`;
      if (!lines.has(key)) {
        lines.set(key, {
          place, label: known?.name || a.label, accountId: a.accountId || null,
          code: known ? (known.code || null) : (a.code || null),
          order: known ? known.order : Number.MAX_SAFE_INTEGER, cents: new Array(n).fill(0),
        });
      }
      const debitPositive = cls === 'assets';
      lines.get(key).cents[col] += debitPositive ? _c(a.ytdDebit) - _c(a.ytdCredit) : _c(a.ytdCredit) - _c(a.ytdDebit);
    }
  });

  const toValues = cents => cents.map(c => _cents(c / 100));
  const sumCents = list => Array.from({ length: n }, (_, i) => list.reduce((s, v) => s + (v[i] || 0), 0));
  const sortRows = rows => rows.sort((x, y) => x.order - y.order || x.label.localeCompare(y.label));

  const groups = [];
  const groupCents = {};
  for (const gk of ['assets', 'liabilities', 'equity']) {
    const mine = [...lines.values()].filter(l => l.place[0] === gk);
    const subgroups = [];
    const subCents  = [];
    for (const title of SUBGROUP_ORDER[gk]) {
      const rows = sortRows(mine.filter(l => l.place[1] === title));
      const isEquity = gk === 'equity';
      if (!rows.length && !isEquity) continue;
      const rowCents = rows.map(r => r.cents);
      if (isEquity) rowCents.unshift(earnings);
      const total = sumCents(rowCents);
      subCents.push(total);
      subgroups.push({
        title,
        rows: [
          ...(isEquity ? [{ label: EARNINGS_LABEL, accountId: null, code: null, values: toValues(earnings) }] : []),
          ...rows.map(r => ({ label: r.label, accountId: r.accountId, code: r.code, values: toValues(r.cents) })),
        ],
        total: { label: `Total ${title}`, values: toValues(total) },
      });
    }
    groupCents[gk] = sumCents(subCents);
    // Equity's total is its one subgroup's, printed inside it, as Xero does.
    groups.push({
      key: gk, title: GROUP_TITLES[gk], subgroups,
      total: gk === 'equity' ? null : { label: `Total ${GROUP_TITLES[gk]}`, values: toValues(groupCents[gk]) },
    });
  }

  return {
    columns: columns.map(iso => ({ iso, label: _shortDate(_parseISODate(iso)) })),
    groups,
    netAssets: { label: 'Net Assets', values: toValues(groupCents.assets.map((v, i) => v - groupCents.liabilities[i])) },
    notes,
  };
}

// Pure. The dates of an exact-date sheet's columns, newest first: the date,
// then one `timeframe` step back for each comparison period, each the same
// day of its month clamped to that month's length — a month back from 31
// March is 28 or 29 February, and two months back is 31 January again, since
// every column is stepped from the date itself, not from the column before.
// At most MAX_EXACT_PERIODS earlier dates.
function _exactColumnDates(iso, periods, timeframe) {
  const step  = { MONTH: 1, QUARTER: 3, YEAR: 12 }[timeframe] || 0;
  const count = step ? Math.min(Math.max(periods || 0, 0), MAX_EXACT_PERIODS) + 1 : 1;
  const d     = _parseISODate(iso);
  return Array.from({ length: count }, (_, i) => {
    const idx   = d.year * 12 + (d.month - 1) - i * step;
    const year  = Math.floor(idx / 12), month = (idx % 12) + 1;
    return _fmtISODate({ year, month, day: Math.min(d.day, _lastDayOfMonth(year, month)) });
  });
}

// A group's total as a sheet carries it: its own line, or — for Equity,
// which Xero prints inside its section — its one subgroup's.
function _totalOf(sheet, key) {
  const g = (sheet?.groups || []).find(x => x.key === key);
  if (!g) return null;
  if (g.total) return g.total;
  return g.subgroups?.length === 1 ? g.subgroups[0].total : null;
}

// Pure. Two sheets for the same date compared line by line, in the shape the
// check panel reads: `app` is the first sheet's figure, `xero` the second's,
// `diff` app less xero. Compared are every account (by AccountID, or by name
// for a line without one, such as Current Year Earnings — an account in one
// sheet only is set against nil), Total Assets, Total Liabilities, Total
// Equity and Net Assets, and each subtotal both sheets name alike — which is
// what catches an account placed under the wrong heading, since the totals
// of both headings then move. Each difference says whether it is an
// account's or a total's (`kind`), so a reader can be pointed at the account. `colApp` and `colXero` say which column of each
// is the date.
function _compareSheets(app, xero, { colApp = 0, colXero = 0 } = {}) {
  const column = xero?.columns?.[colXero]?.label || app?.columns?.[colApp]?.label || '';
  const rowsOf = sheet => {
    const out = [];
    for (const g of sheet?.groups || []) for (const s of g.subgroups || []) for (const r of s.rows || []) out.push(r);
    return out;
  };
  const lines = [];
  const xeroRows = rowsOf(xero);
  const used = new Set();
  const findXero = r => {
    let i = r.accountId ? xeroRows.findIndex((x, k) => !used.has(k) && x.accountId === r.accountId) : -1;
    if (i < 0) i = xeroRows.findIndex((x, k) => !used.has(k) && _norm(x.label) === _norm(r.label) && (!x.accountId || !r.accountId));
    return i;
  };
  for (const r of rowsOf(app)) {
    const i = findXero(r);
    if (i >= 0) used.add(i);
    lines.push({ kind: 'account', label: r.label, app: r.values?.[colApp] || 0, xero: i >= 0 ? (xeroRows[i].values?.[colXero] || 0) : 0 });
  }
  xeroRows.forEach((x, k) => { if (!used.has(k)) lines.push({ kind: 'account', label: x.label, app: 0, xero: x.values?.[colXero] || 0 }); });

  const groupTotals = new Set();
  for (const key of ['assets', 'liabilities', 'equity']) {
    const a = _totalOf(app, key), x = _totalOf(xero, key);
    if (!a && !x) continue;
    const label = x?.label || a?.label;
    groupTotals.add(_norm(label));
    lines.push({ kind: 'total', label, app: a?.values?.[colApp] || 0, xero: x?.values?.[colXero] || 0 });
  }
  if (app?.netAssets || xero?.netAssets) {
    lines.push({ kind: 'total', label: xero?.netAssets?.label || app?.netAssets?.label || 'Net Assets',
                 app: app?.netAssets?.values?.[colApp] || 0, xero: xero?.netAssets?.values?.[colXero] || 0 });
  }
  const subtotals = sheet => {
    const m = new Map();
    for (const g of sheet?.groups || []) for (const s of g.subgroups || []) {
      if (s.total && !groupTotals.has(_norm(s.total.label))) m.set(_norm(s.total.label), s.total);
    }
    return m;
  };
  const appSubs = subtotals(app), xeroSubs = subtotals(xero);
  for (const [k, x] of xeroSubs) {
    const a = appSubs.get(k);
    if (a) lines.push({ kind: 'total', label: x.label, app: a.values?.[colApp] || 0, xero: x.values?.[colXero] || 0 });
  }

  const differences = [];
  let matched = 0;
  for (const l of lines) {
    const appV = _cents(l.app), xeroV = _cents(l.xero), diff = _cents(appV - xeroV);
    if (Math.abs(diff) < 0.01) { matched++; continue; }
    differences.push({ label: l.label, column, app: appV, xero: xeroV, diff, kind: l.kind });
  }
  return { lines: lines.length, matched, differences };
}

async function _getTrialBalanceRaw(userId, tenantId, { date, basis = 'accrual', force = false, timezone = 'UTC' } = {}) {
  const key    = `trialbal:${userId}:${tenantId}:${date}:${basis}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  // paymentsOnly is Xero's name for the cash basis, and is left unsent on
  // accrual rather than sent as false, as on the Balance Sheet call.
  const res    = await withRetry(() => api.getReportTrialBalance(tenantId, date, basis === 'cash' ? true : undefined));
  const parsed = _parseTrialBalance(res.body.reports?.[0]?.rows || []);
  logger.info('Trial Balance fetched', { userId, tenantId, date, basis, accounts: parsed.accounts.length });
  // A past date settles as a closed month does; today is still moving.
  return _cacheSet(key, { date, basis, ...parsed }, _periodCacheTtl([{ endISO: date }], _todayPartsInTz(timezone)));
}

// One Trial Balance, cached under `trialbal:u:t:date:basis` and shared while
// in flight, as every report fetch is.
const getTrialBalance = _dedupe('getTrialBalance', _getTrialBalanceRaw, { basis: 'accrual', force: false, timezone: 'UTC' });

// A balance sheet built from Trial Balances, one per date in `dates` (newest
// first), with the chart of accounts that places each account. `calls` is the
// Trial Balance calls that went to Xero rather than to the cache, which the
// check reports. A chart that cannot be read fails the sheet: without the
// Account Types nothing can be placed.
async function getTrialBalanceSheet(userId, tenantId, { dates = [], basis = 'accrual', force = false, timezone = 'UTC' } = {}) {
  const [chart, tbs] = await Promise.all([
    getAccounts(userId, tenantId, { force }).then(a => a.accounts || []),
    _mapWithConcurrency(dates, TB_CONCURRENCY, date => getTrialBalance(userId, tenantId, { date, basis, force, timezone })),
  ]);
  return {
    ..._sheetFromTrialBalances(tbs, { columns: dates, chart }),
    calls:     tbs.filter(t => !t.cached).length,
    cached:    tbs.every(t => t.cached),
    // The oldest read among the columns, which is how old the sheet is.
    fetchedAt: Math.min(...tbs.map(t => t.fetchedAt)),
  };
}

module.exports = {
  getTrialBalance, getTrialBalanceSheet,
  _parseTrialBalance, _sheetFromTrialBalances, _exactColumnDates, _compareSheets, _totalOf, _sectionClass, _splitLabel,
  TYPE_PLACE, PNL_TYPES, MAX_EXACT_PERIODS, EARNINGS_LABEL,
};
