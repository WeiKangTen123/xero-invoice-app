const { withRetry }                     = require('./xero-utils');
const logger                            = require('../utils/logger');
const { _cacheGet, _cacheSet, _dedupe } = require('./report-cache');
const { _apiFor }                       = require('./report-fetch');
const { getBudgetVariance, _reportLines, _norm, _cents } = require('./budget-variance');
const { _monthMeta }                    = require('./periods');

// Check against Xero: proof that the Budget vs Actual grid is what Xero holds.
//
// The grid (./budget-variance) is built from two reports that answer in
// opposite column orders, anchored on opposite ends, with the P&L's anchor
// chosen for its day count and a short last month fetched on its own. Each of
// those steps was confirmed against live data, but each is also a place a
// column could land under the wrong month with nothing on screen to show it.
// So this asks Xero the same questions another way — calls that use no
// comparison periods at all, where there is no anchor and no order to get
// wrong — and compares line by line:
//
//   1. the closed months as ONE span, from the first month's start to the last
//      closed month's end, against the sum of those monthly actual columns;
//   2. the last closed month ALONE, by its own dates, against that column;
//   3. the Overall Budget by QUARTER, against the sum of each quarter's three
//      monthly budget columns.
//
// At most three read-only calls, cached ten minutes. Nothing here changes the
// grid; it says whether Xero agrees with it, and where not. A failure to reach
// Xero is a failure — never an "agrees" built on a missing answer.

// Ten minutes: a repeat click inside that is the same verdict, and the Refresh
// control passes force=true to bypass it as it does for the grid.
const CHECK_TTL_MS = 10 * 60 * 1000;

const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// A line is its section and its name, as the grid matches them
// (budget-variance.js#_lineKey). The name half is repeated here rather than
// imported, since budget-variance exports only _norm: Xero names the bottom
// lines by their sign, so "Net Loss" in one report is "Net Profit" in the
// other, and each pair reads as one line.
function _lineName(label) {
  const l = _norm(label);
  if (/^net (profit|loss)$/.test(l))   return 'net profit';
  if (/^gross (profit|loss)$/.test(l)) return 'gross profit';
  return l;
}
const _lineKey = (section, label) => `${_norm(section)}\u0000${_lineName(label)}`;

// 'Jan – Sep 2026' for two months of one year, 'Oct 2025 – Sep 2026' across
// years, and the month alone when the two are one. Month labels are the
// grid's own ('Sep 2026'), so the check names months as the screen does.
function _rangeLabel(a, b) {
  if (a.key === b.key) return a.label;
  const [ma, ya] = a.label.split(' '), [mb, yb] = b.label.split(' ');
  return ya === yb ? `${ma} – ${mb} ${ya}` : `${a.label} – ${b.label}`;
}
const _monthFull = m => MONTH_FULL[Number(m.key.split('-')[1]) - 1] || m.label;

// A grid row's figure summed over months `from`..`to` of one field.
const _sumOf = (row, from, to, field) => _cents(row.monthly.slice(from, to + 1).reduce((s, m) => s + (m[field] || 0), 0));
const _nonNil = vals => vals.some(v => Math.abs(v) >= 0.01);

// Pure. One check's verdict: Xero's lines against the grid's rows, column by
// column. `columns` are what is compared — one for a report with a single
// value column, one per quarter for the budget — each giving the grid's figure
// for a row; Xero's is the line's value in that position.
//
// Lines are matched by section and name. The one wording the two reports are
// known to differ on is a section's total ("Total Operating Expenses" in the
// budget, "Total Expenses" in the P&L), so a subtotal that misses by name is
// taken as its section's only unclaimed subtotal, as the grid takes it.
//
// Xero leaves out an account with nothing in it, and the grid carries lines
// one report has and the other does not: a budget-only account has no line in
// the P&L, an unbudgeted account none in the budget. A line on one side only
// is therefore a finding only when its figure there is not nil; a nil line
// missing from the other side is that side's nil, and counts as agreed.
//
// `diff` is the app's figure less Xero's, so a positive difference means the
// app shows more than Xero does.
function _compareLines(rows, xeroLines, columns) {
  const byKey = new Map();
  for (const r of rows) if (!byKey.has(r.key)) byKey.set(r.key, r);
  const claimed = new Set();
  const differences = [], onlyInXero = [];
  let lines = 0, matched = 0;

  for (const line of xeroLines) {
    let r = byKey.get(_lineKey(line.section, line.label));
    if (r && claimed.has(r)) r = null;
    if (!r && line.kind === 'subtotal') {
      const subs = rows.filter(x => x.row.kind === 'subtotal' && !claimed.has(x) && _norm(x.row.section) === _norm(line.section));
      if (subs.length === 1) r = subs[0];
    }
    const xero = columns.map((_, i) => _cents(line.values[i] || 0));
    if (!r) {
      if (_nonNil(xero)) onlyInXero.push(line.label);
      continue;
    }
    claimed.add(r);
    lines++;
    let agrees = true;
    columns.forEach((col, i) => {
      const app  = _cents(col.app(r.row));
      const diff = _cents(app - xero[i]);
      if (Math.abs(diff) < 0.01) return;
      agrees = false;
      differences.push({ section: r.row.section, label: r.row.label, ...(col.label ? { column: col.label } : {}), app, xero: xero[i], diff });
    });
    if (agrees) matched++;
  }

  const onlyInApp = [];
  for (const r of rows) {
    if (claimed.has(r)) continue;
    if (_nonNil(columns.map(col => _cents(col.app(r.row))))) onlyInApp.push(r.row.label);
    else { lines++; matched++; }
  }
  return { lines, matched, differences, onlyInXero, onlyInApp };
}

async function _getBudgetCheckRaw(userId, tenantId, { force = false, timezone = 'UTC', period } = {}) {
  // The grid under check, through its own cache and in-flight sharing: the
  // screen behind the button has just loaded it, so this costs nothing new.
  const grid   = await getBudgetVariance(userId, tenantId, { timezone, period, force });
  // The grid's months carry key and label; their dates are rebuilt from the
  // key, which is how the grid built them (periods.js#_monthMeta).
  const months = grid.months.map(m => { const [y, mo] = m.key.split('-').map(Number); return { ...m, ..._monthMeta(y, mo) }; });
  const n      = months.length;
  // The last closed month, as the grid counted it: its elapsed months are the
  // leading ones, so the count less one is the index.
  const closedIdx = (grid.kpis?.monthsElapsed || 0) - 1;

  // The span and the closed month are the key, as for the grid: the same
  // months with one more closed is a different check, not a stale hit.
  const key    = `budgetcheck:${userId}:${tenantId}:${months[0].key}:${months[n - 1].key}:${closedIdx}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  const rows = grid.rows
    .filter(r => r.kind !== 'section' && Array.isArray(r.monthly))
    .map(r => ({ row: r, key: _lineKey(r.section, r.label) }));

  // One value column: from and to only, no `periods` and so no timeframe, and
  // standardLayout as on every P&L call, since the grid's lines are named by
  // that layout. The slots between are the tracking filters, left empty.
  const pnl = (fromISO, toISO) => withRetry(() => api.getReportProfitAndLoss(
    tenantId, fromISO, toISO, undefined, undefined, undefined, undefined, undefined, undefined, true));

  const checks = {};
  const skip = (k, label, reason) => { checks[k] = { key: k, label, skipped: true, reason, calls: 0 }; };
  const plan = [];

  if (closedIdx < 0) {
    const reason = `No month of ${grid.period.label} has closed yet, so there is no actual figure to check; the closed-span and single-month checks run once a month has closed.`;
    skip('span', 'closed span', reason);
    skip('month', 'last closed month', reason);
  } else {
    const last  = months[closedIdx];
    const range = _rangeLabel(months[0], last);
    plan.push({
      key: 'span', label: closedIdx === 0 ? `${_monthFull(last)} alone` : `closed span ${range}`,
      call: () => pnl(months[0].startISO, last.endISO),
      columns: [{ app: r => _sumOf(r, 0, closedIdx, 'actual') }],
      proves: `${range} asked for in one call, with no comparison periods, against the sum of the grid's monthly actuals over those months. Agreement means no month was cut short or shifted when the grid read its columns newest-first off an anchor month.`,
    });
    // One closed month is the span itself; a second call would repeat the first.
    if (closedIdx === 0) {
      skip('month', 'last closed month', `Only ${last.label} has closed, so the closed span is that month alone and a second call would repeat the first.`);
    } else {
      plan.push({
        key: 'month', label: `${_monthFull(last)} alone`,
        call: () => pnl(last.startISO, last.endISO),
        columns: [{ app: r => r.monthly[closedIdx].actual }],
        proves: `${last.label} asked for by its own dates, against the grid's ${last.label} column. Agreement means the last closed month — the column the anchor's day count would clip first — is the month Xero holds.`,
      });
    }
  }

  // Whole quarters only. A trailing month or two is not a quarter Xero can be
  // asked for, and asking for the next whole one would fetch budget months
  // outside the period with nothing in the grid to compare them to.
  const quarters = Math.floor(n / 3);
  if (quarters === 0) {
    skip('quarters', 'budget by quarter', `${grid.period.label} is shorter than a quarter, so there is no whole quarter to check the budget against.`);
  } else {
    const tail = n % 3 ? ` ${_rangeLabel(months[quarters * 3], months[n - 1])} does not make a full quarter and is not in this check.` : '';
    plan.push({
      key: 'quarters', label: 'budget by quarter', quarters,
      // Anchored on the first month as the grid's monthly call is; timeframe 3
      // is a quarter (1 = month, 3 = quarter, 12 = year), counted forward.
      call: () => withRetry(() => api.getReportBudgetSummary(tenantId, months[0].endISO, quarters, 3)),
      columns: Array.from({ length: quarters }, (_, q) => ({
        label: _rangeLabel(months[3 * q], months[3 * q + 2]),
        app:   r => _sumOf(r, 3 * q, 3 * q + 2, 'budget'),
      })),
      proves: `Xero's Overall Budget by quarter, counted forward from ${months[0].label}, against the sum of each quarter's three monthly budget columns. Agreement means the budget columns sit under the right months.${tail}`,
    });
  }

  // Side by side: three at most, under Xero's five concurrent calls per
  // organisation, and the grid's own calls have finished. A rejection is the
  // caller's answer — nothing below is reached, and nothing is cached.
  const results = await Promise.all(plan.map(async p => {
    const res   = await p.call();
    const lines = _reportLines(res.body.reports?.[0]?.rows || [], { n: p.columns.length });
    const cmp   = _compareLines(rows, lines, p.columns);
    return {
      key: p.key, label: p.label, skipped: false, ...(p.quarters ? { quarters: p.quarters } : {}),
      ...cmp, calls: 1, proves: p.proves,
      ok: cmp.differences.length === 0 && cmp.onlyInXero.length === 0 && cmp.onlyInApp.length === 0,
    };
  }));
  for (const r of results) checks[r.key] = r;

  const ordered = ['span', 'month', 'quarters'].map(k => checks[k]);
  const ran     = ordered.filter(c => !c.skipped);
  // Agreement needs something to have been checked: a period with nothing to
  // check is not one Xero agreed with.
  const ok      = ran.length > 0 && ran.every(c => c.ok);
  const notes   = [
    ...ordered.map(c => (c.skipped ? c.reason : c.proves)),
    'These checks read Xero\'s standard layout on the accrual basis, as the grid does. They do not check a custom report layout, the cash basis, a tracking-category budget, or whether what Xero holds is itself complete.',
  ];

  const closedLast = closedIdx >= 0 ? months[closedIdx] : null;
  const cm         = grid.kpis?.currentMonth || null;
  logger.info('Budget check against Xero', {
    userId, tenantId, range: `${months[0].key}..${months[n - 1].key}`, closedMonths: closedIdx + 1,
    calls: ran.length, ok, differences: ran.reduce((s, c) => s + c.differences.length + c.onlyInXero.length + c.onlyInApp.length, 0),
  });

  return _cacheSet(key, {
    ok,
    checkedAt: new Date().toISOString(),
    calls:     ran.length,
    checks:    ordered,
    notes,
    currency:  grid.organisation?.currency || '',
    period: {
      key: grid.period.key, label: grid.period.label, months: n,
      fromKey: months[0].key, toKey: months[n - 1].key,
      toDateLabel:      grid.period.toDateLabel,
      closedMonths:     closedIdx + 1,
      closedFromLabel:  closedLast ? months[0].label : null,
      closedToLabel:    closedLast ? closedLast.label : null,
      closedThroughISO: closedLast ? closedLast.endISO : null,
      // The month in progress, with its end: the date to give Xero's own
      // report to see the "so far" column.
      current: cm ? { key: cm.key, label: cm.label, endISO: months.find(m => m.key === cm.key)?.endISO || null } : null,
    },
  }, CHECK_TTL_MS);
}

// Bound through the one in-flight map in ./report-cache, as every report
// fetcher is, so two clicks in flight are one set of calls.
const getBudgetCheck = _dedupe('getBudgetCheck', _getBudgetCheckRaw, { force: false, timezone: 'UTC' });

module.exports = { getBudgetCheck, CHECK_TTL_MS, _compareLines, _lineName, _rangeLabel };
