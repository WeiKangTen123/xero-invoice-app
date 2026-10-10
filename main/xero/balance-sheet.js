const { withRetry }      = require('./xero-utils');
const logger             = require('../utils/logger');
const { _cacheGet, _cacheSet, _dedupe, _periodCacheTtl } = require('./report-cache');
const { _apiFor, _parseReportNumber, _getOrganisation, getAccounts } = require('./report-fetch');
const { _cents, _norm }  = require('./budget-variance');
const {
  _addDays, _dateFromParts, _fiscalYearStart, _fmtISODate, _lastDayOfMonth, _parseISODate, _todayPartsInTz,
  MIN_PERIOD_YEAR, MAX_PERIOD_YEAR, PeriodError,
} = require('./periods');

// The Balance Sheet tab: Xero's Reports/BalanceSheet as at a month end, with
// optional comparison columns, read into the groups a reader expects — assets,
// liabilities, equity — with nothing added up here.
//
// What was confirmed against the live endpoint, and shapes everything below:
//
//   * The report is ALWAYS as at the end of the month of `date`; it cannot do
//     a mid-month date. So every as-at date this module resolves is a month
//     end, and so is every comparison column.
//   * With no `periods` it still answers TWO columns — that month end and the
//     same month end a year earlier. Only the first is kept when no
//     comparison was asked for; a reader who asked for one column must not be
//     handed last year's figures beside it unlabelled as such.
//   * Columns come newest first, and the Header row names them as Xero
//     writes them ("30 Sep 2026"), which is the label the screen shows.
//   * The standard layout is a FLAT list of sibling sections, not a tree:
//     "Assets" (a title with no rows), then "Bank", "Current Assets", "Fixed
//     Assets" and so on each with their rows and a "Total …" SummaryRow, an
//     untitled section holding "Total Assets", then "Liabilities" the same
//     way, an untitled "Net Assets" row, and "Equity" with its rows and
//     "Total Equity". There is no "Total Liabilities and Equity". So which
//     group a section belongs to is read from its POSITION — a titled section
//     between "Assets" and "Total Assets" is an asset group whatever it is
//     called — never from a list of expected titles, which the regional
//     layouts and the organisation's own chart would soon fall outside.
//   * Cells are display-signed: liabilities and equity positive, an overdraft
//     negative. They are kept as shown. Account rows carry the AccountID as a
//     cell attribute, which is what joins them to the chart of accounts for
//     the account code.
//
// Needs accounting.reports.balancesheet.read, a granular scope asked for by
// the Web app consent only (see xero-utils OAUTH_SCOPES); a connection made
// before it was added gets the reconnect prompt, as the other reports did.

const BALANCE_PRESETS  = ['last-month-end', 'last-quarter-end', 'last-fy-end', 'this-month', 'month'];
// What each comparison means to Xero's `timeframe`; none sends no periods.
const BALANCE_COMPARES = { none: null, month: 'MONTH', quarter: 'QUARTER', year: 'YEAR' };
const BALANCE_BASES    = ['accrual', 'cash'];
// Xero's documented ceiling on comparison periods for this report.
const MAX_BALANCE_PERIODS = 11;

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Pure. The query string of /balance-sheet and /balance-check, checked, as the
// options getBalanceSheet takes: { preset, month, compare, periods, basis }.
// Throws PeriodError — a 400 in the routes, before any Xero call — for
// anything the report cannot be asked for. `month` is only read for the month
// preset and `periods` only for a comparison, and each is left undefined
// otherwise, so a request spelled with a stray one is the same request to the
// in-flight sharing and the cache as one without it. A parameter given twice
// arrives as an array and is refused rather than read as one of them.
function _balanceQueryFromParams(query) {
  const q = query || {};
  const given = v => v !== undefined && v !== null && v !== '';
  const one = (v, name) => {
    if (typeof v !== 'string') throw new PeriodError(`${name} must be given once`);
    return v;
  };

  const preset = given(q.preset) ? one(q.preset, 'preset') : 'last-month-end';
  if (!BALANCE_PRESETS.includes(preset)) {
    throw new PeriodError(`Unknown preset "${preset.slice(0, 40)}" — use one of ${BALANCE_PRESETS.join(', ')}`);
  }

  let month;
  if (preset === 'month') {
    if (!given(q.month)) throw new PeriodError('preset=month needs month=YYYY-MM');
    month = one(q.month, 'month');
    const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
    if (!m || +m[1] < MIN_PERIOD_YEAR || +m[1] > MAX_PERIOD_YEAR) {
      throw new PeriodError(`month must be written YYYY-MM, between ${MIN_PERIOD_YEAR} and ${MAX_PERIOD_YEAR}`);
    }
  }

  const compare = given(q.compare) ? one(q.compare, 'compare') : 'none';
  if (!Object.prototype.hasOwnProperty.call(BALANCE_COMPARES, compare)) {
    throw new PeriodError(`Unknown comparison "${compare.slice(0, 40)}" — use compare=none, month, quarter or year`);
  }

  let periods;
  if (compare !== 'none') {
    const raw = given(q.periods) ? one(q.periods, 'periods') : '1';
    if (!/^\d{1,2}$/.test(raw) || +raw < 1 || +raw > MAX_BALANCE_PERIODS) {
      throw new PeriodError(`periods must be a whole number from 1 to ${MAX_BALANCE_PERIODS}`);
    }
    periods = +raw;
  }

  const basis = given(q.basis) ? one(q.basis, 'basis') : 'accrual';
  if (!BALANCE_BASES.includes(basis)) throw new PeriodError('basis must be accrual or cash');

  return { preset, month, compare, periods, basis };
}

// The last day of a month, with the month allowed to run past either end of
// the year (month 0 is December of the year before).
function _monthEnd(year, month) {
  const d = new Date(Date.UTC(year, month - 1, 1));
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  return { year: y, month: m, day: _lastDayOfMonth(y, m) };
}
const _longDate  = p => `${p.day} ${MONTHS_LONG[p.month - 1]} ${p.year}`;
const _shortDate = p => `${p.day} ${MONTHS_SHORT[p.month - 1]} ${p.year}`;

// Pure. The as-at date a preset names, in the reader's own calendar (`today`
// is already in their timezone) and against the organisation's year end for
// last-fy-end: { iso, label, preset, inProgress }. Always a month end, since
// that is the only date the report can be as at.
//
// `inProgress` says the date has not yet passed: the balances shown for it
// can still move. That is every this-month, and the month preset for the
// month in progress — which is accepted; a month after it is refused, since
// Xero would answer with balances as at a date with nothing booked to it.
function _resolveAsAt({ preset, month } = {}, today, fiscalYearEnd) {
  let end;
  switch (preset) {
    case 'last-month-end':   end = _monthEnd(today.year, today.month - 1); break;
    // The previous calendar quarter: the month before this quarter's first.
    case 'last-quarter-end': end = _monthEnd(today.year, today.month - ((today.month - 1) % 3) - 1); break;
    // The day before the current financial year's first day, which
    // _fiscalYearStart gives as the 1st of a month, so this is a month end.
    case 'last-fy-end':      end = _addDays(_fiscalYearStart(today, fiscalYearEnd), -1); break;
    case 'this-month':       end = _monthEnd(today.year, today.month); break;
    case 'month': {
      const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
      if (!m) throw new PeriodError('preset=month needs month=YYYY-MM');
      end = _monthEnd(+m[1], +m[2]);
      if (end.year * 12 + end.month > today.year * 12 + today.month) {
        throw new PeriodError(`${MONTHS_LONG[end.month - 1]} ${end.year} has not started yet`);
      }
      break;
    }
    default: throw new PeriodError(`Unknown preset "${String(preset).slice(0, 40)}"`);
  }
  return {
    iso:        _fmtISODate(end),
    label:      _longDate(end),
    preset,
    inProgress: _dateFromParts(end) >= _dateFromParts(today),
  };
}

// Pure. The month-end dates of the report's columns, newest first: the as-at
// date, then one `timeframe` step back for each comparison period, each
// clamped to its own month's last day (a step back from 31 March is 28 or 29
// February, not 3 March). One column when there is no comparison.
function _columnDates(asAtISO, periods, timeframe) {
  const step = { MONTH: 1, QUARTER: 3, YEAR: 12 }[timeframe] || 0;
  const n    = step ? (periods || 0) + 1 : 1;
  const end  = _parseISODate(asAtISO);
  return Array.from({ length: n }, (_, i) => _fmtISODate(_monthEnd(end.year, end.month - i * step)));
}

// ── Reading the tree ────────────────────────────────────────────────────────
const GROUP_ORDER  = ['assets', 'liabilities', 'equity'];
const GROUP_TITLES = { assets: 'Assets', liabilities: 'Liabilities', equity: 'Equity' };
// After a group's total, the next titled section belongs to the next group
// along, whether or not Xero printed that group's title section.
const NEXT_GROUP   = { assets: 'liabilities', liabilities: 'equity', equity: 'equity' };

// Which group a section title names, or null when it is an ordinary section.
// Equity is the one group whose title section carries its own rows, and the
// one whose title varies by region ("Owner's Equity", "Shareholders'
// Equity"), so any one-word qualifier is allowed in front of it.
function _groupOf(title) {
  const t = _norm(title);
  if (/^assets$/.test(t))      return 'assets';
  if (/^liabilities$/.test(t)) return 'liabilities';
  if (/^(?!total )(\S+ )?equity$/.test(t)) return 'equity';
  return null;
}
// Which group a "Total …" line closes, or null.
function _totalGroupOf(label) {
  const m = /^total (.+)$/.exec(_norm(label));
  return m ? _groupOf(m[1]) : null;
}

// Pure. Xero's report rows → { columns, groups, netAssets, notes }, with
// `columns` the dates from _columnDates labelled as the Header row labels
// them, and every figure rounded to the cent (see budget-variance _cents).
//
// A section is placed by position: a titled one is a subgroup of the group
// whose title section came last — or, once that group's total has been seen,
// of the next group along — and before any title at all it is an asset
// group. An untitled section's SummaryRow is the open group's total and its
// plain row is Net Assets, by name where Xero names them and by position
// otherwise. A line that fits none of this is not dropped: it goes under the
// open group in a subgroup with no title, and a note says so, since a balance
// sheet missing a line is worse than one with an odd line in it.
//
// `codes` maps AccountID → account code from the chart of accounts; a row
// whose account is not in it carries null, as does one without an AccountID.
function _buildBalanceSheet(reportRows, { columns = [], codes = new Map() } = {}) {
  const n      = columns.length;
  const notes  = [];
  const groups = new Map();   // key → group, in the order first placed into
  const group  = key => {
    if (!groups.has(key)) groups.set(key, { key, title: GROUP_TITLES[key], subgroups: [], total: null });
    return groups.get(key);
  };
  let current   = null;   // the group sections are being placed into
  let closed    = null;   // a group whose total has been seen (see NEXT_GROUP)
  let netAssets = null;
  let header    = null;
  let short     = 0;

  const open   = () => current || 'assets';
  const label  = row => String(row.cells?.[0]?.value ?? '').trim();
  const values = row => {
    const vals = (row.cells || []).slice(1, n + 1).map(c => _cents(_parseReportNumber(c?.value)));
    if (vals.length < n) { short++; while (vals.length < n) vals.push(0); }
    return vals;
  };
  const accountIdOf = row => {
    for (const c of row.cells || []) {
      for (const a of c?.attributes || []) if (a.id === 'account' && a.value) return String(a.value);
    }
    return null;
  };
  const line = row => {
    const accountId = accountIdOf(row);
    return { label: label(row), accountId, code: accountId ? (codes.get(accountId) ?? null) : null, values: values(row) };
  };

  // A row Xero printed outside any titled section.
  const loose = row => {
    const l = label(row);
    if (!l) return;
    if (/^net (assets|liabilities)$/.test(_norm(l))) { netAssets = { label: l, values: values(row) }; return; }
    const tg = _totalGroupOf(l);
    if (tg) {
      current = tg;
      group(tg).total = { label: l, values: values(row) };
      closed = tg;
      return;
    }
    const g = group(open());
    if (row.rowType === 'SummaryRow' && !g.total) {
      g.total = { label: l, values: values(row) };
      closed = g.key;
      return;
    }
    let sub = g.subgroups.find(s => s.title === '' && s.loose);
    if (!sub) { sub = { title: '', rows: [], total: null, loose: true }; g.subgroups.push(sub); }
    sub.rows.push(line(row));
    notes.push(`Xero's report has a line this app did not expect, "${l}"; it is shown under ${g.title} without a subtotal.`);
  };

  const subgroup = (g, title, rows) => {
    const sub = { title, rows: [], total: null };
    for (const r of rows || []) {
      if (r.rowType === 'Header') continue;
      if (r.rowType === 'Section') { section(r); continue; }
      const l = label(r);
      if (!l) continue;
      if (r.rowType === 'SummaryRow') {
        if (!sub.total) { sub.total = { label: l, values: values(r) }; continue; }
        const tg = _totalGroupOf(l);
        if (tg) { group(tg).total = { label: l, values: values(r) }; closed = tg; continue; }
        notes.push(`Xero's report has a second total in ${title}, "${l}"; it is shown as a line of that section.`);
      }
      sub.rows.push(line(r));
    }
    g.subgroups.push(sub);
  };

  function section(row) {
    const title = String(row.title || '').trim();
    const rows  = row.rows || [];
    const gk    = _groupOf(title);
    if (gk) {
      current = gk; closed = null;
      const g = group(gk);
      g.title = title;
      if (rows.some(r => r.rowType !== 'Header')) subgroup(g, title, rows);
      return;
    }
    if (!title) { for (const r of rows) (r.rowType === 'Section' ? section(r) : loose(r)); return; }
    if (closed) { current = NEXT_GROUP[closed]; closed = null; }
    subgroup(group(open()), title, rows);
  }

  for (const row of reportRows || []) {
    if (row.rowType === 'Header') { header = header || row; continue; }
    if (row.rowType === 'Section') section(row);
    else loose(row);
  }
  if (short) logger.warn('Balance Sheet lines have fewer columns than asked for; missing columns read as nil', { lines: short, columns: n });

  for (const g of groups.values()) for (const s of g.subgroups) delete s.loose;
  return {
    columns: columns.map((iso, i) => {
      const fromXero = String(header?.cells?.[i + 1]?.value ?? '').trim();
      return { iso, label: fromXero || _shortDate(_parseISODate(iso)) };
    }),
    groups:  GROUP_ORDER.filter(k => groups.has(k)).map(k => groups.get(k)),
    netAssets,
    notes,
  };
}

async function _getBalanceSheetRaw(userId, tenantId, {
  force = false, timezone = 'UTC', preset = 'last-month-end', month, compare = 'none', periods, basis = 'accrual',
} = {}) {
  const org           = await _getOrganisation(userId, tenantId, force);
  const fiscalYearEnd = { month: org.financialYearEndMonth || 12, day: org.financialYearEndDay || 31 };
  const today         = _todayPartsInTz(timezone);
  const asAt          = _resolveAsAt({ preset, month }, today, fiscalYearEnd);
  const timeframe     = BALANCE_COMPARES[compare] || null;
  const n             = timeframe ? (periods || 1) : undefined;

  // The date, the comparison and the basis are the report; the preset is only
  // how the date was named. this-month and month=<this month> are the same
  // report and share an entry, so the name and whether the date has passed
  // are stamped on the way out rather than stored with it.
  const key    = `balsheet:${userId}:${tenantId}:${asAt.iso}:${n || 0}:${timeframe || '-'}:${basis}`;
  const stamp  = data => ({ ...data, asAt: { ...data.asAt, preset: asAt.preset, inProgress: asAt.inProgress } });
  const cached = _cacheGet(key, force);
  if (cached) return stamp(cached);

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  // standardLayout, as on every report call: the organisation's own layout
  // need not have the sections this reads by position. paymentsOnly is
  // Xero's name for the cash basis, and is left unsent on accrual rather than
  // sent as false. The two tracking slots stay empty.
  const [res, codes] = await Promise.all([
    withRetry(() => api.getReportBalanceSheet(
      tenantId, asAt.iso, n, timeframe || undefined, undefined, undefined, true, basis === 'cash' ? true : undefined)),
    // Directory data, cached for hours, so on a warm cache this costs
    // nothing; and never the report's failure — without it rows carry no code.
    getAccounts(userId, tenantId, { force })
      .then(a => new Map((a.accounts || []).map(x => [x.accountId, x.code || null])))
      .catch(err => {
        logger.warn('Chart of accounts unavailable; Balance Sheet rows carry no account codes', { userId, tenantId, error: err.message });
        return new Map();
      }),
  ]);

  const built = _buildBalanceSheet(res.body.reports?.[0]?.rows || [], { columns: _columnDates(asAt.iso, n, timeframe), codes });
  logger.info('Balance Sheet fetched', {
    userId, tenantId, asAt: asAt.iso, compare, periods: n || 0, basis, groups: built.groups.map(g => g.key), notes: built.notes.length,
  });

  return stamp(_cacheSet(key, {
    organisation: { name: org.name || org.legalName || 'Organisation', currency: org.baseCurrency || '' },
    asAt:         { iso: asAt.iso, label: asAt.label, preset: asAt.preset, inProgress: asAt.inProgress },
    basis,
    compare:      { type: compare, periods: n || 0 },
    ...built,
  }, _periodCacheTtl([{ endISO: asAt.iso }], today)));
}

// Bound through the one in-flight map in ./report-cache, with the defaults
// named so a request spelled with them and one without are one fetch (see
// _dedupe). The check (./balance-check) asks through this too.
const getBalanceSheet = _dedupe('getBalanceSheet', _getBalanceSheetRaw,
  { force: false, timezone: 'UTC', preset: 'last-month-end', compare: 'none', basis: 'accrual' });

module.exports = {
  getBalanceSheet,
  _balanceQueryFromParams, _resolveAsAt, _columnDates, _buildBalanceSheet, _groupOf,
  BALANCE_PRESETS, BALANCE_COMPARES, BALANCE_BASES, MAX_BALANCE_PERIODS,
};
