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

function _todayPartsInTz(timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
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

const RANGE_PRESETS = new Set(['day', 'week', 'month', 'year', 'all', 'custom']);

// "All time" has no real org-inception date available without an extra
// lookup, so it uses a fixed anchor far enough back that no real Xero org
// predates it — functionally identical to "since inception" as a filter
// bound, without needing to query for the actual first transaction date.
const ALL_TIME_START = { year: 2000, month: 1, day: 1 };

// The org's fiscal year doesn't necessarily run Jan-Dec (Xero's own "Year to
// date" dashboard widget uses it, not the calendar year) — defaults to a
// calendar year (Dec 31 end) when the caller doesn't have fiscal-year-end
// info to hand, which reproduces the old hardcoded Jan-1 behavior exactly.
function _fiscalYearStart(today, fiscalYearEnd) {
  const feMonth = fiscalYearEnd?.month || 12;
  const feDay   = fiscalYearEnd?.day   || 31;
  const thisCalendarYearEnd = { year: today.year, month: feMonth, day: feDay };
  // "Today" is inside the fiscal year that ends on the NEXT occurrence of the
  // fiscal-year-end date — so if that date (this calendar year) hasn't
  // happened yet, the current fiscal year started the year before.
  const endYear = _dateFromParts(today) <= _dateFromParts(thisCalendarYearEnd) ? today.year - 1 : today.year;
  return _addDays({ year: endYear, month: feMonth, day: feDay }, 1);
}

// Pure. Returns { preset, fromISO, toISO, where, days } — `where` is a ready-to-use
// Xero filter clause; `toExclusive` never leaks out since every caller only needs
// an inclusive display range or the filter string. `fiscalYearEnd` (optional
// { month, day }) only affects the 'year' preset.
function computeRange(preset, timezone, customFrom, customTo, fiscalYearEnd) {
  const today = _todayPartsInTz(timezone || 'UTC');
  const usePreset = RANGE_PRESETS.has(preset) ? preset : 'month';

  let from, toExclusive;
  if (usePreset === 'day') {
    from = today; toExclusive = _addDays(today, 1);
  } else if (usePreset === 'week') {
    from = _addDays(today, -_weekdayMon0(today)); toExclusive = _addDays(today, 1);
  } else if (usePreset === 'year') {
    from = _fiscalYearStart(today, fiscalYearEnd); toExclusive = _addDays(today, 1);
  } else if (usePreset === 'all') {
    from = ALL_TIME_START; toExclusive = _addDays(today, 1);
  } else if (usePreset === 'custom') {
    const f = _parseISODate(customFrom), t = _parseISODate(customTo);
    if (!f || !t) throw new Error('Custom range requires valid "from" and "to" dates (YYYY-MM-DD)');
    if (_dateFromParts(f) > _dateFromParts(t)) throw new Error('"from" must not be after "to"');
    from = f; toExclusive = _addDays(t, 1);
  } else { // month
    from = { year: today.year, month: today.month, day: 1 }; toExclusive = _addDays(today, 1);
  }

  const toInclusive = _addDays(toExclusive, -1);
  const days = Math.round((_dateFromParts(toExclusive) - _dateFromParts(from)) / 86400000);

  return {
    preset:  usePreset,
    fromISO: _fmtISODate(from),
    toISO:   _fmtISODate(toInclusive),
    where:   `Date >= ${_fmtXeroDate(from)} && Date < ${_fmtXeroDate(toExclusive)}`,
    days,
  };
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
// is an obvious intent, not an error worth blocking on.
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

// Pure. Resolves what the user asked for into an explicit month list.
//
// Presets are computed from the ORG's own fiscal year end, never a hardcoded
// one: "financial year to date" is Apr-to-now for a March year end and
// Jan-to-now for a December one, without either org configuring anything. That
// matters because different organisations connect to this app.
//
// Any span is allowed. Twelve months is the ceiling of a single Xero call pair,
// not of a period — a longer one is fetched as several pairs (see _chunkMonths).
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

module.exports = { _actualThroughIndex, _addDays, _chunkMonths, _closedCount, _dateFromParts, _fiscalYearMonths, _fiscalYearStart, _fmtISODate, _fmtXeroDate, _monthKeyOfDate, _monthMeta, _monthsBetween, _monthsFrom, _parseISODate, _partsFromDate, _resolvePeriod, _resolveWindow, _todayPartsInTz, _weekdayMon0, computeRange };
