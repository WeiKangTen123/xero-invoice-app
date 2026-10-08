const { isScopeError }   = require('./xero-utils');
const logger             = require('../utils/logger');
const { _dedupe }        = require('./report-cache');
const { _apiFor, _allInvoices, _allPages } = require('./report-fetch');
const { getSummary }     = require('./summary');
const { getBankSummary, _bankAccountList } = require('./bank');
const { getBudgetVariance, _sectionKind, _norm, _cents, _netRow } = require('./budget-variance');
const { _bankByCurrency, _buildPaymentDays } = require('./cash-flow');
const { _toBase, _foreignCurrency } = require('./currency');
const {
  _addDays,
  _closedCount,
  _fmtISODate,
  _fmtXeroDate,
  _isPeriodError,
  _monthMeta,
  _parseISODate,
  _todayPartsInTz,
} = require('./periods');

// The dashboard figures: revenue, costs and profit as monthly series, the
// recurring split, growth, the watch list, customers and the quote pipeline.
//
// getPerformance keeps no cache entry of its own. It is built from
// getBudgetVariance's rows, getBankSummary's balances and getSummary's totals,
// each cached where it is fetched — so the Cash Flow tab and the AI
// commentary, which both start from it, read those same entries.

// ── Performance overview (Dashboard → Overview + Revenue) ───────────────────
// Composed entirely from data already fetched elsewhere: getBudgetVariance
// supplies 12 months of per-account actuals AND budget in one cached pair of
// calls, and getBankSummary supplies cash. No new Xero scope, and the monthly
// series are returned whole so the frontend's month-range slider can re-slice
// without another request.

// Pure. A P&L total, found the way the lines above it are found: by the section
// it closes, never by its own label.
//
// Totals were looked up by exact label ("Total Income", "Total Operating
// Expenses") while their sections were matched by pattern, which also accepts
// "Trading Income" and "Less Overheads". Under those headings Xero names the
// totals "Total Trading Income" and "Total Overheads", the lookups found
// nothing, and revenue and overheads came out as zero for the whole period —
// while the lines beneath them were shown correctly.
//
// Each section of the kind contributes its own subtotal, or the sum of its
// accounts if it has none. Summed across sections rather than taking the first,
// because a heading one report words differently from the other can leave the
// budget's figures and the actuals in two sections of the same kind, each with
// half of the total. Null when no section of the kind exists.
function _sectionTotal(rows, kind, n) {
  const groups = new Map();
  for (const r of rows) {
    if (r.kind !== 'subtotal' && r.kind !== 'account') continue;
    if (_sectionKind(r.section) !== kind) continue;
    const k = _norm(r.section);
    if (!groups.has(k)) groups.set(k, { subtotals: [], accounts: [] });
    groups.get(k)[r.kind === 'subtotal' ? 'subtotals' : 'accounts'].push(r);
  }
  if (!groups.size) return null;
  const actual = _zeros(n), budget = _zeros(n);
  for (const g of groups.values()) {
    for (const r of (g.subtotals.length ? g.subtotals : g.accounts)) {
      (r.monthly || []).forEach((m, i) => {
        if (i >= n) return;
        actual[i] += Number(m.actual || 0);
        budget[i] += Number(m.budget || 0);
      });
    }
  }
  return { actual: actual.map(_cents), budget: budget.map(_cents) };
}

// Recurring revenue is a business concept Xero doesn't record — there's no flag
// on an account saying "this is subscription income". The account NAME is the
// only signal available, and it's a good one when people name these accounts
// deliberately ("Sales - Maintenance (Recurring)"). Every classified account
// is reported back so the UI can show its working rather than assert it, and
// the person can correct any of them (see _recurringFor).
//
// Only words that mean recurring on their own. The pattern used to accept any
// "manage", "support" or "licence", which made "Project Management Fees",
// "Management Consulting" and "Software Licence Sale" recurring — one-off work
// read as the steadiest revenue the business has. "Managed services" and a
// support contract or plan still count; plain management or support does not.
const RECURRING_PATTERN = /recurring|subscription|maintenance|retainer|hosting|saas|\bmanaged\s+(\w+\s+)?services?\b|\bsupport\s+(contracts?|plans?|agreements?|subscriptions?)\b/i;
// A licence is recurring when it is licensing, and not when it is sold once.
const LICENCE_PATTERN  = /\blicen[cs](e|es|ing)\b/i;
const ONE_OFF_LICENCE  = /\blicen[cs]es?\s+sales?\b|\bsales?\s+of\b.*\blicen[cs]|\bperpetual\b|\bone[-\s]?off\b/i;
function _isRecurringName(label) {
  const s = String(label || '');
  if (RECURRING_PATTERN.test(s)) return true;
  return LICENCE_PATTERN.test(s) && !ONE_OFF_LICENCE.test(s);
}

// Whether a revenue account counts as recurring: the person's own answer when
// they have given one, otherwise the guess from its name. `override` holds the
// labels they marked each way (settings-store recurringAccounts and
// notRecurringAccounts), matched on the label with case and spacing ignored,
// as report lines are. Marked per account rather than as one whole list, so an
// account nobody has looked at yet, or another connected organisation's, still
// gets the name-based guess.
function _recurringFor(label, override) {
  const byName = _isRecurringName(label);
  const k = _norm(label);
  if (override?.notRecurring?.some(l => _norm(l) === k)) return { recurring: false, byName, source: 'set' };
  if (override?.recurring?.some(l => _norm(l) === k))    return { recurring: true,  byName, source: 'set' };
  return { recurring: byName, byName, source: 'name' };
}

// The person's recurring/not-recurring marks, or null. Never fails a report:
// a missing column or table (a database the migration has not reached yet)
// means no marks, and every account falls back to its name.
function _recurringOverride(userId) {
  try {
    const s = require('../utils/settings-store').forUser(userId).recurringOverrides();
    return { recurring: s.recurringAccounts || [], notRecurring: s.notRecurringAccounts || [] };
  } catch (err) {
    logger.info('Recurring account marks unavailable; classifying by name', { userId, error: err.message });
    return null;
  }
}

const _zeros = n => Array(n).fill(0);
const _sum   = a => a.reduce((s, v) => s + v, 0);

// Pure. Reshapes budget-variance rows into the series the dashboard charts need.
// `recurringOverride` is the person's own marks (see _recurringFor).
function _buildPerformance({ months, rows, cash, recurringOverride = null }) {
  const n = months.length;
  // A section Xero didn't emit (this org books no cost of sales, so there is no
  // cost-of-sales section at all) must read as a flat zero series, not undefined.
  const seriesOf = row => ({
    actual: row ? row.monthly.map(m => m.actual) : _zeros(n),
    budget: row ? row.monthly.map(m => m.budget) : _zeros(n),
  });
  const sectionSeries = kind => _sectionTotal(rows, kind, n) || seriesOf(null);
  // A floating line, named by its sign like Net Profit: "Gross Loss" in a
  // month or report where it is negative.
  const grossRow = rows.find(r => r.kind !== 'section' && /^gross (profit|loss)$/i.test(String(r.label || '').trim()));

  const totals = {
    revenue:     sectionSeries('revenue'),
    otherIncome: sectionSeries('otherIncome'),
    cogs:        sectionSeries('cogs'),
    grossProfit: seriesOf(grossRow),
    opex:        sectionSeries('opex'),
    netProfit:   seriesOf(_netRow(rows)),
  };

  // One entry per revenue account — this is what drives "Revenue by service line"
  // and the recurring/project split.
  const serviceLines = rows
    .filter(r => r.kind === 'account' && ['revenue', 'otherIncome'].includes(_sectionKind(r.section)))
    .map(r => {
      const rec = _recurringFor(r.label, recurringOverride);
      return {
        label:       r.label,
        section:     r.section,
        otherIncome: _sectionKind(r.section) === 'otherIncome',
        recurring:   rec.recurring,
        // What the name alone suggests, and whether the person decided
        // instead ('set') — so the screen can say which, and offer the guess
        // back when they clear their mark.
        recurringByName: rec.byName,
        recurringSource: rec.source,
        actual:      r.monthly.map(m => m.actual),
        budget:      r.monthly.map(m => m.budget),
      };
    });

  // Recurring vs project, summed from the classified accounts rather than a
  // separate Xero figure — Xero has no such split.
  const pick = (want, field) => months.map((_, i) =>
    _sum(serviceLines.filter(l => !l.otherIncome && l.recurring === want).map(l => l[field][i])));
  const split = {
    recurring: { actual: pick(true,  'actual'), budget: pick(true,  'budget') },
    project:   { actual: pick(false, 'actual'), budget: pick(false, 'budget') },
  };

  const expenseLines = rows
    .filter(r => r.kind === 'account' && ['cogs', 'opex'].includes(_sectionKind(r.section)))
    .map(r => ({ label: r.label, section: r.section, kind: _sectionKind(r.section),
                 actual: r.monthly.map(m => m.actual), budget: r.monthly.map(m => m.budget) }));

  return { totals, serviceLines, split, expenseLines, cash };
}

// Pure. Data-quality flags, computed from the figures rather than asserted.
// Deliberately rule-based: every line is traceable to a number on screen, so
// nothing here can say something the data doesn't support.
// Pure. How many months of a series are FULLY elapsed. The current month is
// partial, and comparing a partial month against a complete one is the single
// most common way a dashboard invents a collapse that never happened — so every
// rate, growth figure and run rate below is computed on closed months only.
function _growthPct(curr, prev) {
  const c = Number(curr), p = Number(prev);
  if (prev === null || prev === undefined) return null;
  if (!Number.isFinite(c) || !Number.isFinite(p) || p <= 0) return null;
  return (c - p) / p;
}

// Pure. Revenue momentum: month-on-month, year-on-year, and the trailing trend.
// Every comparison is closed-month to closed-month.
function _buildGrowth({ series = [], months = [], today } = {}) {
  const n = Math.min(_closedCount(months, today), series.length);
  if (n < 1) return { available: false, closedMonths: 0 };

  const closed = series.slice(0, n);
  const at = i => (i >= 0 && i < n ? closed[i] : null);
  const labelAt = i => (i >= 0 && i < months.length ? months[i].label : null);

  const steps = [];
  for (let i = 1; i < n; i++) {
    const g = _growthPct(closed[i], closed[i - 1]);
    if (g !== null) steps.push(g);
  }
  const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

  // Three-month means rather than a fitted line: with twelve points at most, a
  // regression is false precision, and a mean survives one freak month.
  let trend = null;
  if (n >= 6) {
    const recent = mean(closed.slice(n - 3));
    const prior  = mean(closed.slice(n - 6, n - 3));
    trend = _growthPct(recent, prior);
  }

  return {
    available: true,
    closedMonths: n,
    latest: at(n - 1),          latestLabel:   labelAt(n - 1),
    previous: at(n - 2),        previousLabel: labelAt(n - 2),
    yoyBase: n >= 13 ? at(n - 13) : null,
    yoyLabel: n >= 13 ? labelAt(n - 13) : null,
    mom: _growthPct(at(n - 1), at(n - 2)),
    // Needs 13 closed months to compare like month with like month. Below that
    // it is absent rather than approximated from a shorter span.
    yoy: n >= 13 ? _growthPct(at(n - 1), at(n - 13)) : null,
    avgMoM: mean(steps),
    trend,
    series: closed,
  };
}

function _buildWatchList({ months, totals, actualThroughIdx }) {
  const out = [];
  const rev = totals.revenue.actual, cogs = totals.cogs.actual, opex = totals.opex.actual;
  const elapsed = actualThroughIdx + 1;

  // Scanned across ALL months, not just closed ones. Booked actual revenue is
  // evidence of real transactions whether or not the month has ended, and the
  // current open month is precisely where costs lag invoicing. A month with no
  // actuals at all has rev[i] === 0, so it can never trip this on its own.
  for (let i = 0; i < months.length; i++) {
    if (rev[i] > 0 && cogs[i] === 0 && opex[i] === 0) {
      out.push({ severity: 'warn', text: `${months[i].label} booked ${Math.round(rev[i]).toLocaleString()} of revenue but no costs at all — expenses may not be recorded yet, which overstates profit.` });
    }
  }

  const firstActive = rev.findIndex(v => v !== 0);
  if (firstActive > 0) {
    out.push({ severity: 'info', text: `No activity recorded before ${months[firstActive].label} — trend comparisons over the earlier months are not meaningful.` });
  }

  const ytdRev  = _sum(rev);
  const ytdCogs = _sum(cogs);
  if (ytdRev > 0 && ytdCogs === 0) {
    out.push({ severity: 'warn', text: 'No cost of sales has been booked this year, so gross margin reads 100%. It is not a pricing signal.' });
  }
  // Said as it is: the actuals on screen are what has been booked so far, and
  // the period may be a single month in progress rather than a financial
  // year. This used to claim every figure shown was budget.
  if (elapsed === 0) out.push({ severity: 'info', text: 'No month of this period has closed yet — figures are what has been booked so far; budget comparisons start when a month closes.' });
  return out;
}

// Pure. Groups sales invoices by customer, biggest first.
//
// Deliberately called "invoiced", not "revenue": these are invoice TOTALS, which
// include tax, whereas the P&L figures elsewhere on this page are net. For an
// org whose sales accounts are zero-rated the two agree, but they will not in
// general — so the UI must not present this as the same number.
function _buildCustomerRevenue(invoices, baseCurrency = '') {
  const byContact = new Map();
  for (const inv of invoices || []) {
    const name  = inv.contact?.name || 'Unknown';
    // Base currency, not the invoice's own — otherwise a USD customer and an
    // SGD customer are ranked against each other on unlike numbers.
    const total = _toBase(inv, inv.total, baseCurrency);
    if (!byContact.has(name)) byContact.set(name, { name, invoiced: 0, invoices: 0 });
    const c = byContact.get(name);
    c.invoiced += total;
    c.invoices += 1;
  }
  const customers = [...byContact.values()].sort((a, b) => b.invoiced - a.invoiced);
  const total = customers.reduce((s, c) => s + c.invoiced, 0);
  return {
    customers,
    total,
    count: customers.length,
    currency: _foreignCurrency(invoices, baseCurrency),
    // Undefined rather than zero when nobody was invoiced — an average of no
    // customers is not 0, it is meaningless.
    average: customers.length ? total / customers.length : null,
    available: true,
  };
}

// The calendar day of a Xero date, as YYYY-MM-DD. xero-node turns Xero's
// "/Date(ms)/" into a Date object for some fields and leaves others as an ISO
// string with no offset; the string's own day is taken as written, since
// parsing it would read it in the server's timezone.
function _xeroDay(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const iso = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    if (iso) return iso[1];
    const ms = /^\/Date\((-?\d+)/.exec(value);
    if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10);
  }
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Pure. Work quoted but not yet invoiced — revenue that exists commercially and
// nowhere in the accounts. SENT and ACCEPTED are the live pipeline; INVOICED has
// already become an invoice and would be double-counted, and DRAFT was never
// put in front of the customer.
//
// A SENT quote whose expiry date has passed is an offer the customer can no
// longer take up, and it used to be counted as live pipeline indefinitely. It
// is left out, and counted under `expired` so the screen can say how much was.
// It expires at the end of its expiry day: one expiring today still counts.
// An ACCEPTED quote stays whatever its expiry date — the customer agreed, and
// the work is still to be invoiced.
function _buildQuotePipeline(quotes = [], baseCurrency = '', { todayISO = new Date().toISOString().slice(0, 10) } = {}) {
  const live = { sent: 0, accepted: 0 };
  const counts = { sent: 0, accepted: 0 };
  const expired = { count: 0, total: 0 };
  const counted = [];
  for (const q of quotes) {
    const status = String(q.status || '').toUpperCase();
    const total  = _toBase(q, q.total, baseCurrency);
    if (status === 'SENT') {
      const expiry = _xeroDay(q.expiryDateString || q.expiryDate);
      if (expiry && expiry < todayISO) { expired.count++; expired.total += total; continue; }
      live.sent += total; counts.sent++; counted.push(q);
    }
    if (status === 'ACCEPTED') { live.accepted += total; counts.accepted++; counted.push(q); }
  }
  return {
    sent: live.sent, accepted: live.accepted,
    total: live.sent + live.accepted,
    counts,
    expired,
    // Only the quotes in the total: an expired one in another currency is not
    // a currency the figure on screen was built from.
    currency: _foreignCurrency(counted, baseCurrency),
    available: true,
  };
}

// ── Same months last year (Overview + Profitability) ────────────────────────
// Year on year in _buildGrowth needs thirteen closed months inside the period,
// and every preset is twelve or fewer, so it never had a figure to show. This
// compares the period with the same calendar months a year earlier instead,
// read through getBudgetVariance like this year's: a past period there is
// cached for hours (see _periodCacheTtl) and shared in flight like any other.
//
// Like with like, three ways. Only months that have CLOSED this year are
// compared, each against the same month last year: a part-booked current month
// set against a whole one reads as a collapse that is only the calendar. Months
// last year before anything at all was recorded in Xero are left out as well,
// so an organisation that began trading in May is not shown growth from
// nothing for January to April. And last year's totals are found by
// _buildPerformance, the way this year's are, so a heading worded differently
// cannot count in one year and not the other.

const PRIOR_YEAR = 'prior-year';
const PRIOR_MEASURES = ['revenue', 'grossProfit', 'opex', 'netProfit'];

// A 'YYYY-MM' month twelve months earlier, as { key, label }.
function _yearEarlier(key) {
  const [y, m] = String(key).split('-').map(Number);
  const { key: k, label } = _monthMeta(y - 1, m);
  return { key: k, label };
}

// Pure. The months to fetch for last year: this period's, a year earlier,
// less any that this period already holds. A period longer than twelve months
// overlaps itself shifted back a year, and the overlapping months' figures are
// already in hand — so whatever its length, the comparison costs one call pair
// at most, rather than repeating the ten more a 132-month period would.
function _priorYearSpan(months) {
  const n = Math.min(months.length, 12);
  return { from: _yearEarlier(months[0].key).key, to: _yearEarlier(months[n - 1].key).key };
}

// One month's figure from a set of totals. Gross profit falls back to revenue
// less cost of sales where the report carries no gross line, which is how the
// Overview reads it too (useRangeTotals), so the two cannot disagree.
function _measureAt(totals, measure, i) {
  if (measure !== 'grossProfit') return Number(totals[measure].actual[i] || 0);
  return Number(totals.grossProfit.actual[i] || 0)
      || Number(totals.revenue.actual[i] || 0) - Number(totals.cogs.actual[i] || 0);
}

// Whether anything at all was recorded in a month: income, a cost, or a
// bottom line. A month with none of them is a month with no books, not a
// month of zero trading.
function _activityAt(totals, i) {
  return ['revenue', 'otherIncome', 'cogs', 'opex', 'netProfit'].some(k => Number(totals[k].actual[i] || 0) !== 0);
}

// Pure. The comparison, index for index with this period's months.
//
// `current` is this period's totals and `prior` the totals of the months
// fetched for last year, which start twelve months before `months` and may be
// fewer of them (see _priorYearSpan): a month past them is read from this
// period's own figures, twelve months back. `closed` is how many of this
// period's months have closed, and `priorClosed` how many of last year's, as
// _closedCount counts them. A month last year still open (only possible when
// the period runs a year ahead) has no figure yet, and nor has one before
// anything was recorded: both are null, not a zero nobody booked.
//
// Sums and differences are over the compared months only, and the percentage
// follows _growthPct: null, never invented, when last year's figure is zero or
// negative. The amount difference is still given, so there is always
// something true to show.
function _buildPriorYear({ months, current, prior, closed, priorClosed }) {
  const n = months.length;
  const shifted = months.map(m => _yearEarlier(m.key));
  const fetched = prior.revenue.actual.length;
  const source = i => (i >= priorClosed ? null
    : i < fetched ? { totals: prior, j: i }
    : { totals: current, j: i - 12 });

  let firstActive = -1;
  for (let i = 0; i < n && firstActive < 0; i++) {
    const s = source(i);
    if (s && _activityAt(s.totals, s.j)) firstActive = i;
  }
  const compared = months.map((_, i) => firstActive >= 0 && i >= firstActive && i < closed);
  const idx = compared.flatMap((c, i) => (c ? [i] : []));
  const monthsOut = shifted.map((m, i) => ({ ...m, compared: compared[i] }));
  if (!idx.length) return { available: false, reason: 'no-data', months: monthsOut, compared: null, totals: null };

  const totals = {};
  for (const measure of PRIOR_MEASURES) {
    const monthly = months.map((_, i) => {
      const s = source(i);
      return s && i >= firstActive ? _cents(_measureAt(s.totals, measure, s.j)) : null;
    });
    const thisYearMonthly = months.map((_, i) => _cents(_measureAt(current, measure, i)));
    const total         = _cents(_sum(idx.map(i => monthly[i])));
    const thisYearTotal = _cents(_sum(idx.map(i => thisYearMonthly[i])));
    totals[measure] = {
      monthly, thisYearMonthly, total, thisYearTotal,
      change: _cents(thisYearTotal - total),
      pct:    _growthPct(thisYearTotal, total),
    };
  }

  const first = idx[0], last = idx[idx.length - 1];
  return {
    available: true,
    reason:    null,
    months:    monthsOut,
    // Which months were compared, named once here so no screen has to work it
    // out: this year's, last year's, and where last year's records begin when
    // that cut the comparison short.
    compared: {
      count:          idx.length,
      keys:           idx.map(i => months[i].key),
      fromLabel:      months[first].label,
      toLabel:        months[last].label,
      priorFromLabel: shifted[first].label,
      priorToLabel:   shifted[last].label,
      firstActivityLabel: firstActive > 0 ? shifted[firstActive].label : null,
    },
    totals,
  };
}

// Last year's figures for the period `perf` covers. Never fails the report it
// is added to: a failed fetch, a period whose year-earlier months fall outside
// the years periods.js allows, and nothing recorded then each come back as
// available:false with the reason, and the figures above it stand.
async function _priorYear(userId, tenantId, perf, { timezone, force }) {
  const closed = perf.closedThroughIdx + 1;
  const unavailable = reason => ({
    available: false, reason,
    months: perf.months.map(m => ({ ..._yearEarlier(m.key), compared: false })),
    compared: null, totals: null,
  });
  // No month has closed, so there is nothing to compare and nothing is fetched.
  if (closed < 1) return unavailable('no-closed-month');

  let pbv;
  try {
    // Asked for exactly as the /budget-variance route asks for a custom range,
    // so the two share a request and a cache entry. The range goes through
    // the same period checks as any other (see _resolvePeriod).
    pbv = await getBudgetVariance(userId, tenantId, { timezone, force, period: _priorYearSpan(perf.months) });
  } catch (err) {
    if (_isPeriodError(err)) return unavailable('out-of-range');
    logger.warn('Performance: last year\'s figures unavailable for the comparison', { userId, tenantId, error: err.message });
    return unavailable('unavailable');
  }
  const shifted = perf.months.map(m => _yearEarlier(m.key));
  const built = _buildPriorYear({
    months: perf.months,
    current: perf.totals,
    prior: _buildPerformance({ months: pbv.months, rows: pbv.rows, cash: null }).totals,
    closed,
    priorClosed: _closedCount(shifted, _todayPartsInTz(timezone)),
  });
  logger.info('Performance: same months last year compared', {
    userId, tenantId, available: built.available, compared: built.compared?.count || 0, cached: pbv.cached,
  });
  return { ...built, cached: pbv.cached, fetchedAt: pbv.fetchedAt };
}

async function _getPerformanceRaw(userId, tenantId, { timezone = 'UTC', force = false, window = 'fy', period, cashFlow = false, customers = false } = {}) {
  // Reuses the budget-variance fetch and its cache — on a warm cache this whole
  // endpoint costs one Xero call (the bank summary) rather than three.
  //
  // Asked for exactly as the /budget-variance route asks for it. `window` only
  // means anything when there is no period, and passing it alongside one made
  // this a different in-flight request from the route's identical one, so the
  // two fetched the same report from Xero side by side.
  const bv = await getBudgetVariance(userId, tenantId, period ? { timezone, force, period } : { timezone, force, window });
  // Started now, read below for debtor and creditor days, so it overlaps the
  // bank summary instead of queueing behind it. Asked for exactly as the
  // /summary route asks, so it shares that request and its cache entry. The
  // catch is attached here so a failure is never an unhandled rejection.
  const summaryP = getSummary(userId, tenantId, { force }).catch(err => {
    logger.warn('Performance: summary unavailable for debtor and creditor days', { userId, tenantId, error: err.message });
    return null;
  });

  const todayParts = _todayPartsInTz(timezone);
  const today = _fmtISODate(todayParts);
  // Every invoice/quote figure below is converted to this before being summed or
  // compared with a report figure. See _toBase.
  const baseCurrency = bv.organisation?.currency || '';
  // Overview needs only the CLOSING BALANCE, which is "as of today" whatever
  // window you ask for — so it reads a short recent window (one Xero call).
  // Cash in/out genuinely is period-scoped, but only Banking shows it, and over
  // a long range getBankSummary splits into 365-day windows: a 32-month period
  // cost three calls to produce one number. Banking opts in explicitly.
  const balanceFrom = _fmtISODate(_addDays(_todayPartsInTz(timezone), -31));
  const from = cashFlow ? bv.fiscalYear.fromISO : balanceFrom;
  let cash = {
    total: 0, cashIn: 0, cashOut: 0, net: 0, accounts: [], foreignAccounts: [], baseOnly: false,
    currency: baseCurrency, available: false, flowScope: cashFlow ? 'period' : 'last31d',
  };
  try {
    const [bank, bankAccounts] = await Promise.all([
      getBankSummary(userId, tenantId, { from, to: today, force }),
      _bankAccountList(userId, tenantId, force),
    ]);
    // Every total here is base-currency accounts only; an account in another
    // currency is listed under foreignAccounts in its own (see _bankByCurrency).
    const byCur = _bankByCurrency(bank, bankAccounts, baseCurrency);
    const line = a => ({ name: a.name, currency: a.currency, balance: a.closingBalance, cashIn: a.cashReceived, cashOut: a.cashSpent });
    cash = {
      total:     byCur.closing,
      // Cash movement, not just the closing position — the Banking tab renders
      // this, which is why the old standalone Cash In/Out fetch could go.
      cashIn:    byCur.cashIn,
      cashOut:   byCur.cashOut,
      net:       byCur.net,
      accounts:  byCur.accounts.map(line),
      foreignAccounts: byCur.foreignAccounts.map(line),
      baseOnly:  byCur.baseOnly,
      currency:  baseCurrency,
      available: true,
      flowScope: cashFlow ? 'period' : 'last31d',
    };
  } catch (err) {
    // Cash is one card out of many — a bank-scope problem shouldn't blank the
    // whole dashboard, so it degrades to "—" instead.
    if (!isScopeError(err)) logger.warn('Performance: bank summary failed', { userId, tenantId, error: err.message });
    else logger.info('Performance: bank summary skipped — scope not granted', { userId, tenantId });
  }

  // Only the Revenue tab shows this, so Overview never pays for the extra call.
  let customerRevenue = { customers: [], total: 0, count: 0, average: null, available: false };
  let quotePipeline   = { sent: 0, accepted: 0, total: 0, counts: { sent: 0, accepted: 0 }, expired: { count: 0, total: 0 }, available: false };
  if (customers) {
    try {
      const tokenCache = require('../utils/token-cache').forUser(userId);
      const api = _apiFor(await tokenCache.getValidToken(tenantId));
      const start = _parseISODate(bv.fiscalYear.fromISO);
      const endEx = _addDays(_parseISODate(bv.fiscalYear.toISO), 1); // Xero's upper bound is exclusive
      const where = `Type=="ACCREC" && Date >= ${_fmtXeroDate(start)} && Date < ${_fmtXeroDate(endEx)}`;
      const fyInvoices = await _allInvoices(api, tenantId, { where, order: 'Date DESC', statuses: ['AUTHORISED', 'PAID'] });
      customerRevenue = _buildCustomerRevenue(fyInvoices, baseCurrency);

      // Quoted-but-not-invoiced work exists commercially and nowhere in the
      // accounts, so the forward view otherwise stops at issued invoices.
      try {
        // The period rule: quotes DATED on or after the first day of the period
        // on screen, with no upper bound, and judged live or expired as of
        // today. The pipeline is what is open now, so a quote raised after the
        // period still counts; the lower bound is a cost bound, because an
        // unfiltered call returned every quote the org ever raised. A quote
        // raised before the period that is still open is therefore not
        // counted, which is why the payload says where the window starts.
        // Paged like every other list (see _allPages).
        const quotes = await _allPages(page => api.getQuotes(
          tenantId, undefined, bv.fiscalYear.fromISO, undefined, undefined, undefined, undefined, undefined, page,
        ), 'quotes', { what: 'Quote', tenantId });
        quotePipeline = { ..._buildQuotePipeline(quotes, baseCurrency, { todayISO: today }), fromISO: bv.fiscalYear.fromISO };
      } catch (qErr) {
        logger.warn('Performance: quotes unavailable', { userId, tenantId, error: qErr.message });
      }
    } catch (err) {
      // One card out of many — a failure here must not blank the tab.
      logger.warn('Performance: customer revenue unavailable', { userId, tenantId, error: err.message });
    }
  }

  const actualThroughIdx = bv.months.filter(m => m.source === 'actual').length - 1;
  const built = _buildPerformance({ months: bv.months, rows: bv.rows, cash, recurringOverride: _recurringOverride(userId) });
  const watchList = _buildWatchList({ months: bv.months, totals: built.totals, actualThroughIdx });
  // Momentum, not just level — a dashboard that shows revenue but never whether
  // it is rising makes the reader do the differencing in their head.
  const growth = _buildGrowth({ series: built.totals.revenue.actual, months: bv.months, today: todayParts });

  // Debtor and creditor days, worked out here once for the period. The
  // Overview shows this figure, and getCashFlow passes the same one to its tab,
  // its alerts and the AI commentary, so no two places can disagree about it.
  // Read from the summary, which already holds every invoice and which the page
  // loads first, so on a normal visit this is a cache hit rather than another
  // invoice fetch. One card out of many: a failure leaves it unavailable.
  let paymentDays = { available: false, reason: 'unavailable', dso: null, dpo: null, closedMonths: 0 };
  try {
    const summary = await summaryP;
    if (summary?.kpis) {
      paymentDays = _buildPaymentDays({
        receivable: summary.kpis.totalReceivables, payable: summary.kpis.totalPayables,
        raisedByMonth: summary.raisedByMonth || {}, months: bv.months, today: todayParts,
      });
    }
  } catch (err) {
    logger.warn('Performance: debtor and creditor days unavailable', { userId, tenantId, error: err.message });
  }

  logger.info('Performance overview built', { userId, tenantId, serviceLines: built.serviceLines.length, actualMonths: actualThroughIdx + 1 });

  return {
    organisation:     bv.organisation,
    fiscalYear:       bv.fiscalYear,
    period:           bv.period,
    months:           bv.months,
    actualThroughIdx,
    // Last FULLY elapsed month. actualThroughIdx includes the current one, which
    // is partial — anything comparing month against month needs this instead, or
    // it reports a collapse that is only the calendar.
    closedThroughIdx: _closedCount(bv.months, todayParts) - 1,
    ...built,
    growth,
    paymentDays,
    customerRevenue,
    quotePipeline,
    watchList,
    // Surfaced so the UI can show which accounts were treated as recurring —
    // a guess made from names should never be invisible. The person's own
    // marks are applied; each service line says whether it was theirs.
    recurringAccounts: built.serviceLines.filter(l => l.recurring).map(l => l.label),
    cached:    bv.cached,
    fetchedAt: bv.fetchedAt,
  };
}

// Names its defaults for the reason given at getBudgetVariance. Bound after
// the declaration, through the one in-flight map in ./report-cache, so the Cash
// Flow tab and the commentary, which ask for it in turn, go through the same
// in-flight map as the /performance route.
const _getPerformanceShared  = _dedupe('getPerformance', _getPerformanceRaw,
  { timezone: 'UTC', force: false, window: 'fy', cashFlow: false, customers: false });

// The dashboard figures, with the same months last year added when `compare`
// is 'prior-year' (see _priorYear). Anything else, or nothing, is the report
// exactly as it was.
//
// Added outside the shared fetch rather than inside it, so asking for the
// comparison still shares the figures in flight with the Cash Flow tab and
// the commentary, which never ask for it. The only extra work is last year's
// report, and that is shared and cached in its own right.
async function getPerformance(userId, tenantId, opts = {}) {
  const { compare, ...rest } = opts || {};
  const perf = await _getPerformanceShared(userId, tenantId, rest);
  if (compare !== PRIOR_YEAR) return perf;
  const { timezone = 'UTC', force = false } = rest;
  return { ...perf, priorYear: await _priorYear(userId, tenantId, perf, { timezone, force }) };
}

module.exports = {
  getPerformance, PRIOR_YEAR,
  _sectionTotal, _isRecurringName, _recurringFor, _buildPerformance, _growthPct, _buildGrowth,
  _buildWatchList, _buildCustomerRevenue, _xeroDay, _buildQuotePipeline,
  _buildPriorYear, _priorYearSpan, _yearEarlier,
};
