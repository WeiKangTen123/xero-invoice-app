// Date, month and period arithmetic for the Xero reports layer.
//
// Pulled out of reports.js, which had grown to 2,475 lines covering caching,
// date maths, report parsing, six report builders and two AI features. This is
// the part with no dependency on Xero, on the cache, or on anything else here:
// given a timezone and a fiscal year end it answers which months a period
// covers, which of them are closed, and how to format a date for the Xero API.
//
// Every function is pure. All of them were already tested through reports.js
// and remain so — reports.js re-exports them unchanged.

// Short month labels for period headings.
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A stored timezone the runtime does not know used to throw here, inside every
// report that read it — one bad Setup value and the whole Insights page was a
// 500 until it was corrected. Setup now refuses such a value, but one saved
// before that check (or by hand) is still read as UTC, said once in the log
// rather than on every report.
const _warnedTimezones = new Set();
function _todayPartsInTz(timeZone) {
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit' };
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone, ...opts });
  } catch {
    if (!_warnedTimezones.has(timeZone)) {
      _warnedTimezones.add(timeZone);
      require('../utils/logger').warn('Unknown timezone; reports are dated in UTC', { timeZone });
    }
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', ...opts });
  }
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}
function _dateFromParts({ year, month, day }) { return new Date(Date.UTC(year, month - 1, day)); }
function _partsFromDate(d) { return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }; }
function _addDays(parts, n) { const d = _dateFromParts(parts); d.setUTCDate(d.getUTCDate() + n); return _partsFromDate(d); }
function _weekdayMon0(parts) { return (_dateFromParts(parts).getUTCDay() + 6) % 7; } // 0=Mon..6=Sun
function _fmtXeroDate(p) { return `DateTime(${p.year},${p.month},${p.day})`; }
function _fmtISODate(p) { return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; }
function _parseISODate(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [year, month, day] = s.split('-').map(Number);
  return { year, month, day };
}



// The org's fiscal year doesn't necessarily run Jan-Dec (Xero's own "Year to
// date" dashboard widget uses it, not the calendar year) — defaults to a
// calendar year (Dec 31 end) when the caller doesn't have fiscal-year-end
// info to hand, which reproduces the old hardcoded Jan-1 behavior exactly.
//
// The year starts on the 1st of the month AFTER the year-end month, never the
// day after the year-end date. Every period here is built from whole months,
// and "the day after" broke on February: a 28 Feb year end in a leap year made
// 29 Feb the first day, so on that day the year ran Feb 2028 – Jan 2029, a
// month out of step with every other year.
//
// Which year today falls in is decided against the year-end day, capped at the
// last day of that month in that year — a 29 Feb year end means 28 Feb in a
// common year, where Date.UTC would otherwise read it as 1 March and keep
// 1 March in the old year. A February year end on the 28th is read as the end
// of February in every year: it is the only way to say "end of February" in a
// common year, and it keeps 29 Feb inside the year whose last month it is —
// otherwise "financial year to date" on that day would open on the March after
// it and run backwards.
//
// A year end that is not the last day of its month (5 April, as in the UK) is
// the exception: in whole months its year has to open in the SAME month, since
// most of that month is on the new year's side of the date. Starting it the
// month after, as for a month-end year end, put every April outside both
// years — on 20 April "financial year to date" opened on 1 May, a month that
// had not begun. The whole month goes to the new year, the first days before
// the year-end date included, because a month can only be in one year and the
// year must always contain today.
function _fiscalYearStart(today, fiscalYearEnd) {
  const feMonth = fiscalYearEnd?.month || 12;
  const feDay   = fiscalYearEnd?.day   || 31;
  if (!_isMonthEndYearEnd(feMonth, feDay)) {
    return { year: today.month >= feMonth ? today.year : today.year - 1, month: feMonth, day: 1 };
  }
  const monthEnd = _lastDayOfMonth(today.year, feMonth);
  const endDay   = feMonth === 2 && feDay >= 28 ? monthEnd : Math.min(feDay, monthEnd);
  // "Today" is inside the fiscal year that ends on the NEXT occurrence of the
  // fiscal-year-end date — so if that date (this calendar year) hasn't
  // happened yet, the current fiscal year started the year before.
  const endYear = _dateFromParts(today) <= _dateFromParts({ year: today.year, month: feMonth, day: endDay })
    ? today.year - 1 : today.year;
  return feMonth === 12
    ? { year: endYear + 1, month: 1, day: 1 }
    : { year: endYear, month: feMonth + 1, day: 1 };
}

// Whether a year end falls on the last day of its month. February's is the
// 28th or 29th, read as the month's end in every year (see _fiscalYearStart);
// any other month is measured against its fixed length.
function _isMonthEndYearEnd(feMonth, feDay) {
  return feDay >= (feMonth === 2 ? 28 : _lastDayOfMonth(2001, feMonth));
}

function _lastDayOfMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }

// Pure. What a to-date figure over `months` is called. "Year to date" only
// when it really is one: the period opens the financial year that `today` is
// in, stays inside that year, and runs at least to the last closed month — so
// its to-date figure is the year's. Anything else is a period to date: a
// quarter, a rolling twelve months, a span crossing a year end, and also last
// year, next year, or this year's first quarter read in October, each of
// which opens on a financial year's first month but whose to-date figure is
// not the year's so far. Calling those a year would tell the reader the wrong
// thing about what was added up. Without `today` there is no telling, so it
// is a period.
function _toDateLabel(months, fiscalYearEnd, today) {
  const n = months?.length || 0;
  if (!today || !n || n > 12) return 'Period to date';
  const key = p => `${p.year}-${String(p.month).padStart(2, '0')}`;
  const fyStart   = _fiscalYearStart(today, fiscalYearEnd);
  const lastClosed = _partsFromDate(new Date(Date.UTC(today.year, today.month - 2, 1)));
  return months[0].key === key(fyStart) && months[n - 1].key >= key(lastClosed) ? 'Year to date' : 'Period to date';
}


// Pure. Buckets invoices dated within the range into a trend series — daily
// buckets for anything a month or shorter (a week or a month both read fine as
// individual days), monthly buckets for anything longer (a year of daily points
// would be an unreadable chart).

function _monthMeta(year, month) {
  const d = new Date(Date.UTC(year, month - 1, 1));
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // computed, so February is right in leap years
  return {
    key:      `${y}-${String(m).padStart(2, '0')}`,
    label:    `${MONTH_NAMES[m - 1]} ${y}`,
    startISO: _fmtISODate({ year: y, month: m, day: 1 }),
    endISO:   _fmtISODate({ year: y, month: m, day: lastDay }),
  };
}

function _monthsFrom(start, n = 12) {
  return Array.from({ length: n }, (_, i) => _monthMeta(start.year, start.month + i));
}

// Pure. Every month from `fromKey` to `toKey` inclusive, any span. Reversed
// inputs are swapped rather than rejected — a from/to the user dragged backwards
// is an obvious intent, not an error worth blocking on. The span is not capped
// here: this is plain arithmetic, and the cap belongs where a span turns into
// Xero calls, which is _resolvePeriod (see _checkRange).
function _monthsBetween(fromKey, toKey) {
  const parse = k => { const m = /^(\d{4})-(\d{1,2})$/.exec(String(k || '')); return m ? { year: +m[1], month: +m[2] } : null; };
  let a = parse(fromKey), b = parse(toKey);
  if (!a || !b) return null;
  const idx = p => p.year * 12 + (p.month - 1);
  if (idx(a) > idx(b)) [a, b] = [b, a];
  const n = idx(b) - idx(a) + 1;
  return Array.from({ length: n }, (_, i) => _monthMeta(a.year, a.month + i));
}

// Pure. Splits a month list into consecutive chunks of at most `size`.
// Twelve is the ceiling of a single Xero call pair, so a longer period simply
// becomes several pairs rather than being refused.
function _chunkMonths(months, size = 12) {
  const out = [];
  for (let i = 0; i < months.length; i += size) out.push(months.slice(i, i + size));
  return out;
}

// Pure. The 12 months of the fiscal year containing `today`.
function _fiscalYearMonths(today, fiscalYearEnd) {
  return _monthsFrom(_fiscalYearStart(today, fiscalYearEnd));
}

// ── Which periods may be asked for ──────────────────────────────────────────
// Every 12 months of a period costs a pair of Xero calls, and nothing bounded
// the span: from=1900-01&to=2100-12 was about 400 calls, against a budget of 60
// a minute per app (shared with real invoice posting) and a daily allowance
// per organisation — 5,000, or 1,000 for Xero apps created after 2 March 2026.
// One request could spend a tenant's day.
//
// 132 months is the widest span the period picker can produce (it offers
// eleven years), so no real reader is refused, and the worst one request can
// cost is eleven call pairs. The year bounds are generous on purpose, since an
// organisation can import a long history, but they stop nonsense years —
// including 0 to 99, which Date.UTC quietly reads as 1900 to 1999.
const MAX_PERIOD_MONTHS = 132;
const MIN_PERIOD_YEAR   = 1990;
const MAX_PERIOD_YEAR   = 2100;

// The named periods _resolvePeriod knows. Anything else used to fall back to
// year to date without a word, which on a budget report quietly turned a
// requested twelve months into however many had elapsed.
const PERIOD_PRESETS = new Set([
  'this-month', 'last-month', 'this-quarter', 'last-quarter',
  'fy-ytd', 'cy-ytd', 'fy', 'prev-fy', 'next-fy', 'cy',
  'rolling', 'last-12', 'last-6', 'last-3',
]);

// A period that cannot be served. Its own type so a route can answer 400 — the
// request is wrong, and sending it again will not help — rather than the 500
// every other failure here becomes.
class PeriodError extends Error {
  constructor(message) {
    super(message);
    this.name   = 'PeriodError';
    this.status = 400;
  }
}
// By name rather than instanceof: a test runner's module registry can hand the
// route and reports.js two different copies of this file.
function _isPeriodError(err) { return !!err && err.name === 'PeriodError'; }

// Pure. 'YYYY-MM' with a real month and a year inside the bounds, else null.
// Stricter than _monthsBetween, which takes a one-digit month: this is the gate
// on what a request may say, not on what the arithmetic can cope with.
function _parseMonthKey(k) {
  const m = typeof k === 'string' ? /^(\d{4})-(0[1-9]|1[0-2])$/.exec(k) : null;
  if (!m) return null;
  const year = +m[1], month = +m[2];
  return year >= MIN_PERIOD_YEAR && year <= MAX_PERIOD_YEAR ? { year, month } : null;
}

// Throws PeriodError unless from/to name a span this app will fetch. A reversed
// range is fine (_monthsBetween swaps it), so the size is measured either way.
function _checkRange(from, to) {
  const a = _parseMonthKey(from), b = _parseMonthKey(to);
  if (!a || !b) {
    throw new PeriodError(`from and to must be months written YYYY-MM, between ${MIN_PERIOD_YEAR} and ${MAX_PERIOD_YEAR}`);
  }
  const n = Math.abs((b.year * 12 + b.month) - (a.year * 12 + a.month)) + 1;
  if (n > MAX_PERIOD_MONTHS) {
    throw new PeriodError(`Period too long — at most ${MAX_PERIOD_MONTHS} months (this one is ${n})`);
  }
}

// Throws PeriodError unless `p` is a preset _resolvePeriod knows, or the legacy
// YYYY-MM window (the twelve months ending there) held to the same years as a
// range.
function _checkPreset(p) {
  if (typeof p === 'string' && (PERIOD_PRESETS.has(p) || _parseMonthKey(p))) return;
  throw new PeriodError(`Unknown period "${String(p).slice(0, 40)}" — use a preset such as fy or fy-ytd, or from=YYYY-MM&to=YYYY-MM`);
}

// Pure. The period a request's query string asks for, checked, in the shape
// _resolvePeriod takes: { from, to } or { preset }. `fallback` when the query
// names no period. Throws PeriodError for anything that is not a period.
//
// One gate for every route that takes a period, so the next route added cannot
// forget the cap. An explicit range wins over a preset, as in _resolvePeriod,
// and a preset it overrides goes unchecked because it goes unused. Half a range
// is refused rather than swapped for the default: whoever sent from= without
// to= asked for something, and it was not the default. An empty value counts
// as absent, which is how the routes always read one.
function _periodFromQueryParams(query, fallback) {
  const q = query || {};
  const given = v => v !== undefined && v !== null && v !== '';
  if (given(q.from) || given(q.to)) {
    if (!given(q.from) || !given(q.to)) throw new PeriodError('A custom period needs both from and to (YYYY-MM)');
    _checkRange(q.from, q.to);
    return { from: q.from, to: q.to };
  }
  // `window` is the older name for a preset, still sent by older links.
  const preset = given(q.preset) ? q.preset : q.window;
  if (given(preset)) {
    _checkPreset(preset);
    return { preset };
  }
  return fallback;
}

// Pure. Resolves what the user asked for into an explicit month list.
//
// Presets are computed from the ORG's own fiscal year end, never a hardcoded
// one: "financial year to date" is Apr-to-now for a March year end and
// Jan-to-now for a December one, without either org configuring anything. That
// matters because different organisations connect to this app.
//
// Twelve months is the ceiling of a single Xero call pair, not of a period — a
// longer one is fetched as several pairs (see _chunkMonths). The ceiling of a
// period is MAX_PERIOD_MONTHS. The routes check it, and it is checked again
// here so that nothing reaching Xero through this can ask for more: an explicit
// range that breaks the rules throws PeriodError.
function _resolvePeriod(spec, today, fiscalYearEnd) {
  const s = typeof spec === 'string' ? { preset: spec } : (spec || {});
  const fyStart = _fiscalYearStart(today, fiscalYearEnd);
  const nowKey  = `${today.year}-${String(today.month).padStart(2, '0')}`;
  const shift   = (parts, n) => _partsFromDate(new Date(Date.UTC(parts.year, parts.month - 1 + n, 1)));
  const key     = p => `${p.year}-${String(p.month).padStart(2, '0')}`;
  const span    = (a, b, label, k) => ({ key: k, label, months: _monthsBetween(key(a), key(b)) });
  const quarterStart = m => m - ((m - 1) % 3);

  // An explicit range always wins — it is the most specific thing the user can say.
  if (s.from && s.to) {
    _checkRange(s.from, s.to);
    const months = _monthsBetween(s.from, s.to);
    if (months) return { key: 'custom', label: `${months[0].label} – ${months[months.length - 1].label}`, months };
  }

  const P = String(s.preset || 'fy-ytd');
  switch (P) {
    case 'this-month':   return span(today, today, 'This month', P);
    case 'last-month':   { const m = shift(today, -1); return span(m, m, 'Last month', P); }
    case 'this-quarter': { const q = { ...today, month: quarterStart(today.month) }; return span(q, shift(q, 2), 'This quarter', P); }
    case 'last-quarter': { const q = shift({ ...today, month: quarterStart(today.month) }, -3); return span(q, shift(q, 2), 'Last quarter', P); }
    case 'fy-ytd':       return span(fyStart, today, 'Financial year to date', P);
    case 'cy-ytd':       return span({ year: today.year, month: 1 }, today, 'Calendar year to date', P);
    case 'fy':           return span(fyStart, shift(fyStart, 11), 'This financial year', P);
    case 'prev-fy':      { const f = shift(fyStart, -12); return span(f, shift(f, 11), 'Previous financial year', P); }
    case 'next-fy':      { const f = shift(fyStart, 12);  return span(f, shift(f, 11), 'Next financial year', P); }
    case 'cy':           return span({ year: today.year, month: 1 }, { year: today.year, month: 12 }, `Calendar year ${today.year}`, P);
    case 'rolling':
    case 'last-12':      return span(shift(today, -11), today, 'Last 12 months', P);
    case 'last-6':       return span(shift(today, -5),  today, 'Last 6 months', P);
    case 'last-3':       return span(shift(today, -2),  today, 'Last 3 months', P);
    default: break;
  }

  // Legacy YYYY-MM window: the 12 months ENDING at that month.
  const m = /^(\d{4})-(\d{2})$/.exec(P);
  if (m && +m[2] >= 1 && +m[2] <= 12) {
    const end = { year: +m[1], month: +m[2] };
    const months = _monthsBetween(key(shift(end, -11)), key(end));
    return { key: P, label: `12 months to ${months[11].label}`, months };
  }

  // Unrecognised input must not blank the dashboard.
  return span(fyStart, today, 'Financial year to date', 'fy-ytd');
}

// Back-compat shim. The older window keys always meant a 12-month span, and the
// Budget tabs still use them — so an unrecognised value must fall back to the
// full fiscal year here, NOT to the new year-to-date default. A budget report
// silently switching from 12 months to 5 would be a real reporting error.
function _resolveWindow(key, today, fiscalYearEnd) {
  const k = String(key || '');
  if (k === 'rolling') return _resolvePeriod('last-12', today, fiscalYearEnd);
  if (['fy', 'prev-fy', 'next-fy'].includes(k)) return _resolvePeriod(k, today, fiscalYearEnd);
  const m = /^(\d{4})-(\d{2})$/.exec(k);
  if (m && +m[2] >= 1 && +m[2] <= 12) return _resolvePeriod(k, today, fiscalYearEnd);
  return _resolvePeriod('fy', today, fiscalYearEnd);
}

// Pure. Index of the last FULLY elapsed month, or -1 if none has completed.
//
// A partially elapsed month must read as budget, not actual: confirmed live that
// Aug 2026 already had 52,000 of real sales but zero booked costs, so showing it
// as "actual" mid-month invents a profit spike. This is the same rule Xero's own
// custom layout uses.
function _actualThroughIndex(months, today) {
  const todayDate = _dateFromParts(today);
  let idx = -1;
  for (let i = 0; i < months.length; i++) {
    if (_dateFromParts(_parseISODate(months[i].endISO)) < todayDate) idx = i;
  }
  return idx;
}

// Pure. label -> 12 monthly values. `reverse` flips ProfitAndLoss's newest-first
// columns into the oldest-first order the month list uses.

function _closedCount(months, today) {
  if (!months || !months.length) return 0;
  if (!today) return months.length;
  const key = `${today.year}-${String(today.month).padStart(2, '0')}`;
  const i = months.findIndex(m => m.key === key);
  if (i >= 0) return i;                              // months strictly before this one
  return months[0].key > key ? 0 : months.length;    // wholly future / wholly past
}

// Pure. Null — not Infinity, not 100% — when the base is zero or negative.
// Growth from nothing is undefined, and any number invented here is one someone
// will later quote in a meeting as though it were measured.

function _monthKeyOfDate(d) {
  if (!d) return null;
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? null : `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Pure. Splits real cash movement into where it came from and where it went.
// Customer receipts are kept apart from other receipts deliberately: a business
// living on injected capital and one collecting from customers look identical
// on a single "cash in" line, and they are not remotely the same business.

module.exports = {
  _actualThroughIndex, _addDays, _chunkMonths, _closedCount, _dateFromParts, _fiscalYearMonths, _fiscalYearStart, _fmtISODate, _fmtXeroDate, _lastDayOfMonth, _monthKeyOfDate, _monthMeta, _monthsBetween, _monthsFrom, _parseISODate, _partsFromDate, _resolvePeriod, _resolveWindow, _toDateLabel, _todayPartsInTz, _weekdayMon0,
  MAX_PERIOD_MONTHS, MIN_PERIOD_YEAR, MAX_PERIOD_YEAR, PERIOD_PRESETS, PeriodError, _isPeriodError, _checkRange, _checkPreset, _periodFromQueryParams,
};
