const { withRetry }      = require('./xero-utils');
const logger             = require('../utils/logger');
const { _cacheGet, _cacheSet, _dedupe, _periodCacheTtl } = require('./report-cache');
const { _apiFor, _parseReportNumber, _getOrganisation } = require('./report-fetch');
const {
  _actualThroughIndex,
  _chunkMonths,
  _fmtISODate,
  _parseISODate,
  _resolvePeriod,
  _resolveWindow,
  _toDateLabel,
  _todayPartsInTz,
} = require('./periods');

// Budget vs Actual: the monthly grid, and the per-account actual and budget
// series that every other P&L figure on the Insights page is read from.
//
// The foundation the other reports stand on: getPerformance reshapes these
// rows, and the Cash Flow tab and both pieces of AI commentary build on
// getPerformance. So this depends on none of them, and the helpers they share
// with it (_sectionKind, _cents, _netRow, _norm) live here.

// ── Budget vs Actual (monthly grid) ─────────────────────────────────────────
// Reproduces Xero's "Current financial year by month – actual and budget" custom
// layout, which the API can't return directly (custom report layouts aren't
// exposed). Built by merging two report endpoints column-for-column.
//
// Everything below was confirmed against live Xero data, not inferred from docs —
// the two endpoints disagree in ways that would silently misalign every column:
//
//   ProfitAndLoss   anchor = LAST  month of the FY, periods=11 → NEWEST-first
//   BudgetSummary   anchor = FIRST month of the FY, periods=12 → OLDEST-first
//
// Opposite anchors AND opposite order. periods=13 is rejected by BudgetSummary,
// so 12 is the ceiling — exactly one fiscal year. Their column headers are also
// formatted differently ("31 Aug 26" vs "Aug-26"), so columns are matched
// POSITIONALLY off the known anchor, never by parsing header text.
//
// The P&L anchor must be a 31-day month: Xero gives every comparison period the
// anchor's day count, so a short anchor month truncates the months before it.
// A span ending in a short month is therefore fetched in two P&L calls — see
// _pnlCallPlan.


// Runs `fn` over `items` with at most `limit` in flight, preserving input order.
// Used for report chunks: strictly sequential wastes latency, unbounded parallel
// would burst against a 60/min budget shared with real invoice submission.
//
// Once any item fails no further item is started — the result is lost either
// way, and the remaining chunks would only spend more of that budget on calls
// nobody will read. Items already in flight are left to finish, so no Xero
// call is abandoned mid-way, and the first failure is what the caller sees.
async function _mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  let failure = null;   // boxed, so a thrown `undefined` still counts as one
  const worker = async () => {
    while (!failure && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        if (!failure) failure = { err };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.err;
  return out;
}
const REPORT_CHUNK_CONCURRENCY = 2;

// The ProfitAndLoss calls that cover one chunk of months, as a pure plan.
//
// Twelve months is a per-CALL limit, not a fiscal-year limit: ProfitAndLoss caps
// `periods` at 11 (12 columns) and BudgetSummary at 12, but both anchor on an
// arbitrary date. So any 12 consecutive months cost one BudgetSummary call and
// one or two ProfitAndLoss calls — which is what lets the window slide off the
// fiscal year entirely.
//
// Why sometimes two: Xero applies the anchor's DATE RANGE to every comparison
// period, not "the same month, earlier" (documented under ProfitAndLoss
// `periods`: with a 30-day anchor each prior period includes only its first 30
// days). Anchored on September, every 31-day month before it silently lost its
// 31st; anchored on February, the 29th to the 31st. So a chunk ending in a
// month shorter than 31 days is anchored on the month before it — always 31
// days, since no two short months are adjacent — and its last month is asked
// for on its own, with exact dates. A chunk ending in a 31-day month stays one
// call.
//
// Each entry says what to send and which months of the chunk the answer covers
// (`offset`, `n`), so the pieces line up column for column when merged.
function _pnlCallPlan(chunk) {
  const n = chunk.length;
  // A single month has no comparison periods at all, so `periods` is omitted
  // rather than passed as 0, which the endpoint rejects.
  const alone = i => ({ fromISO: chunk[i].startISO, toISO: chunk[i].endISO, periods: undefined, offset: i, n: 1 });
  if (n === 1) return [alone(0)];
  const last = chunk[n - 1];
  if (_parseISODate(last.endISO).day === 31) {
    return [{ fromISO: last.startISO, toISO: last.endISO, periods: n - 1, offset: 0, n }];
  }
  const prev = chunk[n - 2];
  const head = n === 2 ? alone(0) : { fromISO: prev.startISO, toISO: prev.endISO, periods: n - 2, offset: 0, n: n - 1 };
  return [head, alone(n - 1)];
}

// Pure. Every labelled line of a report, in Xero's reading order:
// { section, label, kind, values }.
//
// A line under a titled section is an 'account', or a 'subtotal' where Xero
// marks it a SummaryRow. A line in an untitled section is a floating 'summary'
// — Gross Profit, Total Expenses, Net Profit — which is exactly how they sit in
// Xero's layout. `reverse` flips ProfitAndLoss's newest-first columns into the
// oldest-first order the month list uses.
//
// `n` is how many columns the report was asked for. A line with fewer is
// padded to it rather than left short, because columns are matched by
// position and a short line would otherwise put its figures under the wrong
// months: the P&L answers newest-first, so what it leaves out is the OLDEST
// columns, and after the flip its values sit at the end with the zeros in
// front; the budget answers oldest-first and is padded at the end. Said once
// per report in the log, not per line, since every line of a short report is
// short.
function _reportLines(reportRows, { reverse = false, n } = {}) {
  const out = [];
  let short = 0;
  (function walk(rows, title) {
    for (const row of rows || []) {
      if (row.rowType === 'Header') continue;
      if (row.rowType === 'Section' || row.rows?.length) {
        walk(row.rows, (row.title || '').trim() || title);
        continue;
      }
      const label = (row.cells?.[0]?.value || '').trim();
      if (!label) continue;
      let values = (row.cells || []).slice(1).map(c => _parseReportNumber(c?.value));
      if (reverse) values.reverse();
      if (n > values.length) {
        short++;
        const pad = Array(n - values.length).fill(0);
        values = reverse ? [...pad, ...values] : [...values, ...pad];
      }
      out.push({
        section: title,
        label,
        kind: !title ? 'summary' : (row.rowType === 'SummaryRow' ? 'subtotal' : 'account'),
        values,
      });
    }
  })(reportRows, '');
  if (short) logger.warn('Report lines have fewer columns than months asked for; missing months read as nil', { lines: short, of: out.length, columns: n, newestFirst: reverse });
  return out;
}

// A line's identity is its section AND its label. The label alone is not one:
// a name can sit in two sections (an income "Consulting" and an expense
// "Consulting"), and matching on it alone dropped one of them or gave it the
// other's figures. Case and spacing are ignored, and Xero names the bottom lines
// by their sign — "Net Loss" in one report is "Net Profit" in the other — so
// each of those pairs reads as one line.
const _norm = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
function _lineName(label) {
  const l = _norm(label);
  if (/^net (profit|loss)$/.test(l))   return 'net profit';
  if (/^gross (profit|loss)$/.test(l)) return 'gross profit';
  return l;
}
const _lineKey = (section, label) => `${_norm(section)}\u0000${_lineName(label)}`;

const _sectionIndex = (layout, title) => layout.findIndex(r => r.kind === 'section' && _norm(r.label) === _norm(title));

// Index just past the section that row `i` sits in: the next heading or
// floating summary line, or the end.
function _sectionEnd(layout, i) {
  let j = i + 1;
  while (j < layout.length && layout[j].kind !== 'section' && layout[j].kind !== 'summary') j++;
  return j;
}

// Where something that follows `prev` in its own report goes: straight after a
// floating summary line, or after the whole section an ordinary line sits in.
function _placeAfter(layout, prev) {
  if (!prev) return 0;
  const p = layout.indexOf(prev);
  return prev.kind === 'summary' ? p + 1 : _sectionEnd(layout, p);
}

// The one subtotal of the section titled `title` that this report has not
// claimed yet, or null when the section has none or more than one.
function _onlyFreeSubtotal(layout, title, claimed) {
  const h = _sectionIndex(layout, title);
  if (h < 0) return null;
  const subs = layout.slice(h + 1, _sectionEnd(layout, h)).filter(r => r.kind === 'subtotal' && !claimed.has(r));
  return subs.length === 1 ? subs[0] : null;
}

// Whether two section titles are on the same side of the P&L: both income,
// both costs, or either one unclassified. A label the two reports share is
// only the same account when its sections agree on this; an expense
// "Consulting" is never the income "Consulting", whatever the section is
// called.
const COST_KINDS = new Set(['cogs', 'opex', 'otherExpense']);
function _sameSide(a, b) {
  const ka = _sectionKind(a), kb = _sectionKind(b);
  if (ka === 'other' || kb === 'other') return true;
  return COST_KINDS.has(ka) === COST_KINDS.has(kb);
}

// The layout row a report line belongs to, or null when it has none yet.
// `claimed` holds rows an earlier line of the same report already took, so two
// lines of one report never land on one row.
function _matchLine(layout, line, { claimed, alias, counts }) {
  const free = r => r.kind !== 'section' && !claimed.has(r);
  const key = _lineKey(line.section, line.label);
  const exact = layout.find(r => free(r) && r.key === key);
  if (exact) return exact;
  if (line.kind === 'summary') return null;
  // The two reports should title their sections identically under the standard
  // layout, but nothing guarantees it, and a small difference must not split
  // every line in two. So the label alone is enough when it names exactly one
  // line in each report and its sections are on the same side of the P&L —
  // but never for a section the budget has too: a section both reports share
  // is a genuine second section, and a namesake elsewhere is a different
  // account. The one thing the two reports may still word differently under a
  // shared section is its total ("Total Operating Expenses" in the budget,
  // "Total Expenses" in the P&L), which is the section's one subtotal, not a
  // second one with half its figures nil.
  const budgetHasSection = layout.some(r => r.kind === 'section' && !r.unbudgeted && _norm(r.label) === _norm(line.section));
  if (budgetHasSection) {
    return line.kind === 'subtotal' ? _onlyFreeSubtotal(layout, line.section, claimed) : null;
  }
  const name = _lineName(line.label);
  if (counts.get(name) === 1) {
    const same = layout.filter(r => r.kind !== 'section' && r.kind !== 'summary' && r.name === name);
    if (same.length === 1 && !claimed.has(same[0]) && _sameSide(same[0].section, line.section)) return same[0];
  }
  // A retitled section usually retitles its total too ("Total Overheads"), so a
  // subtotal under a section already matched that way is that section's total
  // when it has exactly one.
  const target = alias.get(_norm(line.section));
  if (line.kind === 'subtotal' && target !== undefined) return _onlyFreeSubtotal(layout, target, claimed);
  return null;
}

// Adds a line the layout does not have yet, in its own section and in its own
// report's order, and returns the new row.
//
// Appending it at the bottom — the old behaviour — put it below Net Profit with
// no section, so section sums no longer added up and the dashboard's revenue
// and expense lines skipped it. An account goes after the line before it in its
// report when that line is in the same section, otherwise first in the section;
// either way before the section's subtotal. A section the layout does not have
// at all goes in whole, after whatever preceded it in its report — which puts
// it before the next summary line, where Xero shows it.
function _insertLine(layout, line, prev, { alias, budgeted, totalMonths }) {
  const row = {
    kind: line.kind, label: line.label, section: '', unbudgeted: !budgeted,
    name: _lineName(line.label), key: null,
    budget: Array(totalMonths).fill(0), actual: Array(totalMonths).fill(0),
  };
  if (line.kind === 'summary') {
    row.key = _lineKey('', line.label);
    layout.splice(_placeAfter(layout, prev), 0, row);
    return row;
  }
  const title = alias.get(_norm(line.section)) ?? line.section;
  row.section = title;
  row.key = _lineKey(title, line.label);
  const h = _sectionIndex(layout, title);
  if (h < 0) {
    layout.splice(_placeAfter(layout, prev), 0, { kind: 'section', label: title, section: title, unbudgeted: !budgeted }, row);
    return row;
  }
  const end = _sectionEnd(layout, h);
  if (line.kind === 'subtotal') { layout.splice(end, 0, row); return row; }
  const sub = layout.findIndex((r, i) => i > h && i < end && r.kind === 'subtotal');
  const limit = sub >= 0 ? sub : end;
  const p = prev ? layout.indexOf(prev) : -1;
  layout.splice(p > h && p < limit ? p + 1 : h + 1, 0, row);
  return row;
}

// Lays one report's lines into the layout and writes their figures into
// `field` at the report's month offset.
//
// Every line is matched before any is inserted, so whether a line finds its
// row never depends on what the same report happened to insert ahead of it.
function _placeLines(layout, { lines, offset, n }, { field, budgeted, totalMonths }) {
  const claimed = new Set();
  const alias   = new Map();   // this report's section title -> the layout's, learnt from label matches
  const counts  = new Map();
  for (const l of lines) counts.set(_lineName(l.label), (counts.get(_lineName(l.label)) || 0) + 1);
  const matched = lines.map(line => {
    const row = _matchLine(layout, line, { claimed, alias, counts });
    if (row) {
      claimed.add(row);
      if (line.kind !== 'summary' && _norm(row.section) !== _norm(line.section)) alias.set(_norm(line.section), row.section);
    }
    return row;
  });
  let prev = null;
  lines.forEach((line, k) => {
    const row = matched[k] || _insertLine(layout, line, prev, { alias, budgeted, totalMonths });
    for (let i = 0; i < n; i++) row[field][offset + i] = line.values[i] || 0;
    prev = row;
  });
}

// Xero's variance percentage, matched against the org's own Budget Variance
// report: variance over the ABSOLUTE budget, so a negative budget still yields a
// signed percentage the same way Xero shows it (Sep gross profit budgeted at
// -1,030 against nil actual reads +100.00%, not -100.00%).
//
// Against a nil budget the percentage is undefined rather than infinite, so it's
// null and the frontend prints a dash — again matching Xero.
function _variancePct(variance, budget) {
  return budget !== 0 ? variance / Math.abs(budget) : null;
}

// Pure. Stitches every chunk's two reports into one ordered layout of rows,
// each carrying its budget and actual series across every month.
//
// The order is BudgetSummary's, which is the richer of the two: confirmed live
// that it returns every row the P&L does plus the budget-only accounts (Cost of
// Goods Sold, Other Income - Grant, the overheads), because the P&L omits any
// account with no actual transactions entirely. Every chunk's budget is laid
// down before any actuals, so an account budgeted in any chunk counts as
// budgeted wherever its actuals first appear; whatever the P&L has beyond that
// is `unbudgeted`. A row first seen in a later chunk joins its own section, in
// its report's order, rather than the bottom of the layout.
//
// Each chunk is an independent Xero response, so an account can be present in
// one and absent from another (the P&L omits accounts with no transactions in
// that span). Missing chunks are zero-filled at the right offset rather than
// shortening the series, otherwise months would silently slide. A part's P&L
// comes as `pnl` pieces (see _pnlCallPlan), or as one `pnlRows` covering it.
function _mergeChunks(parts, totalMonths) {
  const layout = [];
  const budgets = [], actuals = [];
  let offset = 0;
  for (const part of parts) {
    const n = part.months.length;
    budgets.push({ lines: _reportLines(part.budgetRows, { n }), offset, n });
    for (const piece of part.pnl || [{ rows: part.pnlRows, offset: 0, n }]) {
      actuals.push({ lines: _reportLines(piece.rows, { reverse: true, n: piece.n }), offset: offset + piece.offset, n: piece.n });
    }
    offset += n;
  }
  for (const b of budgets) _placeLines(layout, b, { field: 'budget', budgeted: true,  totalMonths });
  for (const a of actuals) _placeLines(layout, a, { field: 'actual', budgeted: false, totalMonths });
  return { layout, budgetMissing: budgets.every(b => b.lines.length === 0) };
}

// Every figure the payload carries is rounded to the cent. Sums of report
// values carry floating-point dust (-3.55e-15), which a reader sees as a red
// "(0.00)", or as a variance where there is none. -0 becomes 0 for the same
// reason.
function _cents(v) {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}

// The bottom line. By name when it carries one of Xero's two names for it —
// the whole name, so a layout with a "Net Profit Before Tax" above the bottom
// line does not stop there; failing that, the last floating summary line,
// which is where Xero puts it.
function _netRow(rows) {
  return rows.find(r => r.kind === 'summary' && /^net (profit|loss)$/.test(_norm(r.label)))
      || [...rows].reverse().find(r => r.kind === 'summary' && !r.section);
}

// Lives here rather than with the dashboard figures in ./performance, which
// totals revenue and costs by it: the grid below reads it too, to mark cost
// lines, and ./performance already depends on this module, not the other way
// round.
//
// Which P&L section a row belongs to. The titles are the ones Xero's standard
// layout uses across its regions — "Less Cost of Sales" here, "Cost of Goods
// Sold" or "Direct Costs" elsewhere, "Turnover" and "Less Overheads" in the
// UK layout, and "Less Expenses" or plain "Expenses" where there is no
// operating/other split. Order matters: the revenue pattern is loose on
// purpose (income, revenue, sales, turnover), so every cost pattern has to be
// tested before it — "Less Cost of Sales" contains the word "Sales", "Less
// Income Tax" the word "Income".
//
// Depreciation, income tax, finance costs and the like are 'otherExpense':
// an expense for colouring, but not an overhead, so the dashboard's cost
// totals (which read 'cogs' and 'opex' only) are not changed by it.
//
// Other income may be headed "Plus Other Income". Read as revenue — it contains
// "income" — its total would now be added into revenue, since totals are found
// by their section (see _sectionTotal). Revenue against other income makes no
// difference to the budget grid, which reads this only to tell costs apart.
function _sectionKind(section) {
  const s = (section || '').trim();
  if (/^(less )?(cost of (sales|goods sold)|direct costs)/i.test(s))                              return 'cogs';
  if (/^(less )?(other expenses|depreciation|income tax|taxation|finance costs|interest expense)/i.test(s)) return 'otherExpense';
  if (/^(less )?(operating expenses|administrative expenses|expenses|overheads)/i.test(s))         return 'opex';
  if (/^(plus )?other income/i.test(s))                                                            return 'otherIncome';
  if (/income|revenue|sales|turnover/i.test(s))                                                    return 'revenue';
  return 'other';
}

// Pure. Merges the two reports into one flat, ordered row list.
//
// Each cell is actual OR budget depending on whether its month has fully
// elapsed — never both, and never a sum of the two. Subtotals are taken from
// whichever report supplied that column rather than recomputed, so they stay
// internally consistent with the figures above them.
//
// `currentIdx` is the month containing today, when the period includes it. Its
// cell stays budget, for the reason _actualThroughIndex gives; what has been
// booked against it so far is reported beside the grid as kpis.currentMonth
// instead, read on `asOfISO`, and is not added into any total.
function _buildBudgetVariance({ budgetRows, pnlRows, months, actualThroughIdx, merged, currentIdx = -1, asOfISO = null }) {
  // `merged` is the fetched path; a lone pair of reports is merged as one chunk.
  const { layout, budgetMissing } = merged || _mergeChunks([{ months, budgetRows, pnlRows }], months.length);

  const elapsed = actualThroughIdx + 1;
  const pair = (actual, budget) => {
    // From the rounded figures, so a percentage always agrees with what is shown.
    const variance = _cents(actual - budget);
    return { actual, budget, variance, variancePct: _variancePct(variance, budget) };
  };
  const rows = layout.map(r => {
    const row = {
      kind: r.kind, label: r.label, section: r.section,
      // Costs, where a figure above budget is the bad direction: every line of
      // the cost-of-sales, overhead and other-expense sections, their
      // subtotals included.
      expense:    r.kind !== 'section' && COST_KINDS.has(_sectionKind(r.section)),
      unbudgeted: !!r.unbudgeted,
    };
    if (r.kind === 'section') return row;
    const a = months.map((_, i) => _cents(r.actual[i] || 0));
    const b = months.map((_, i) => _cents(r.budget[i] || 0));
    const cells = months.map((_, i) => (i <= actualThroughIdx ? a[i] : b[i]));

    // Per-month actual/budget/variance, kept for every month including ones not
    // yet elapsed. Xero's own Budget Variance report compares the CURRENT
    // (part-elapsed) month too — confirmed against the org's report, which shows
    // August actuals of 52,000 against a 17,615 August budget — so the actuals
    // can't be suppressed here the way the monthly grid suppresses them.
    const monthly = months.map((_, i) => pair(a[i], b[i]));

    // Running totals from the period's first month over those same figures, so
    // "to date" at any month is one lookup rather than a re-sum each consumer
    // could do slightly differently.
    let runA = 0, runB = 0;
    const cumulative = months.map((_, i) => { runA += a[i]; runB += b[i]; return pair(_cents(runA), _cents(runB)); });

    // Year-to-date rolls up the fully elapsed months only.
    const toDate = elapsed > 0 ? cumulative[elapsed - 1] : pair(0, 0);
    return {
      ...row,
      cells,
      total:        _cents(cells.reduce((s, v) => s + v, 0)),
      monthly,
      cumulative,
      actualToDate: toDate.actual,
      budgetToDate: toDate.budget,
      variance:     toDate.variance,
      variancePct:  toDate.variancePct,
    };
  });

  const net = _netRow(rows);
  const cur = currentIdx >= 0 && currentIdx < months.length ? currentIdx : -1;
  return {
    rows,
    // Said outright, because a missing budget otherwise looks exactly like a
    // budget of nil on every line.
    budgetMissing,
    kpis: {
      monthsElapsed:  elapsed,
      monthsTotal:    months.length,
      ytdActualNet:   net ? net.actualToDate : 0,
      restOfYearNet:  net ? _cents(net.cells.slice(elapsed).reduce((s, v) => s + v, 0)) : 0,
      forecastNet:    net ? net.total : 0,
      // Everything Xero holds dated in this month, which can include
      // transactions dated later in it — "so far" means booked so far.
      currentMonth: cur < 0 ? null : {
        key:       months[cur].key,
        label:     months[cur].label,
        asOf:      asOfISO,
        actualNet: net ? net.monthly[cur].actual : 0,
        budgetNet: net ? net.monthly[cur].budget : 0,
      },
    },
  };
}

async function _getBudgetVarianceRaw(userId, tenantId, { force = false, timezone = 'UTC', window = 'fy', period } = {}) {
  const org           = await _getOrganisation(userId, tenantId, force);
  const fiscalYearEnd = { month: org.financialYearEndMonth || 12, day: org.financialYearEndDay || 31 };
  const today         = _todayPartsInTz(timezone);
  const win           = period ? _resolvePeriod(period, today, fiscalYearEnd)
                               : _resolveWindow(window, today, fiscalYearEnd);
  const months        = win.months;
  const actualThroughIdx = _actualThroughIndex(months, today);
  const todayKey      = `${today.year}-${String(today.month).padStart(2, '0')}`;
  const currentIdx    = months.findIndex(m => m.key === todayKey);

  // The exact span is part of the key — two periods are two different reports,
  // and serving one for the other would silently show the wrong months.
  //
  // So is the period's name. The payload carries it (period.key and label, and
  // the fiscalYear title built from them), so a custom Jan–Dec and the 'fy'
  // preset of a December year end — the same months — must not share an entry,
  // or whichever came first titles both, down to the exports' "year to date"
  // or "period to date" wording.
  //
  // And so is the month in progress. When a period's first month begins, no
  // month of it has closed on either side of midnight, so actualThroughIdx
  // alone does not change, and the entry from the day before was served without
  // that month marked current for up to a cache lifetime.
  const key    = `budgetvar:${userId}:${tenantId}:${win.key}:${months[0].key}:${months[months.length - 1].key}:${actualThroughIdx}:${currentIdx}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  // A period longer than 12 months exceeds what one call pair can return, so it
  // is fetched as several, two chunks at a time (see _mapWithConcurrency) and
  // never all at once: Xero's 60/min budget is shared with real invoice
  // submission, and a long range shouldn't burst.
  // BudgetSummary only ever reports the OVERALL budget. Listing the budgets
  // makes that explicit rather than leaving the reader to assume the figures
  // cover a tracking-category budget they may also have.
  let budgets = [];
  try {
    const bRes = await withRetry(() => api.getBudgets(tenantId));
    budgets = (bRes.body.budgets || []).map(b => ({ id: b.budgetID, type: b.type, description: b.description }));
  } catch (err) {
    logger.info('Budget list unavailable — reporting the Overall budget only', { userId, tenantId });
  }

  const chunks = _chunkMonths(months, 12);
  let pnlCalls = 0;
  const parts = await _mapWithConcurrency(chunks, REPORT_CHUNK_CONCURRENCY, async (chunk) => {
    const first = chunk[0], n = chunk.length;
    // A chunk's P&L pieces go one after the other rather than side by side, so
    // two chunks in flight stay at four calls, inside Xero's limit of five
    // concurrent calls per organisation.
    const fetchPnl = async () => {
      const pieces = [];
      for (const c of _pnlCallPlan(chunk)) {
        pnlCalls++;
        // standardLayout: without it Xero lays the P&L out in the
        // organisation's own custom layout, whose sections and labels need not
        // match BudgetSummary's — and the two are matched line by line on them.
        const res = await withRetry(() => api.getReportProfitAndLoss(
          tenantId, c.fromISO, c.toISO, c.periods, c.periods ? 'MONTH' : undefined,
          undefined, undefined, undefined, undefined, true));
        pieces.push({ rows: res.body.reports?.[0]?.rows || [], offset: c.offset, n: c.n });
      }
      return pieces;
    };
    const [pnl, budRes] = await Promise.all([
      fetchPnl(),
      // Anchored on the FIRST month — periods counts forwards from here. timeframe 1 = month.
      withRetry(() => api.getReportBudgetSummary(tenantId, first.endISO, n, 1)),
    ]);
    return { months: chunk, budgetRows: budRes.body.reports?.[0]?.rows || [], pnl };
  });

  const built = _buildBudgetVariance({
    months, actualThroughIdx, currentIdx, asOfISO: _fmtISODate(today),
    merged: _mergeChunks(parts, months.length),
  });

  // Re-derived here: the loop above scopes its own first/last to each chunk.
  const first = months[0], last = months[months.length - 1];
  const end = _parseISODate(last.endISO);
  const MONTHS_LONG = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  // Only a true fiscal-year window can honestly be called "the year ended X".
  // A custom range is already named by its months, so they are not said twice.
  const range = `${first.label} – ${last.label}`;
  const periodLabel = win.key === 'fy'
    ? `For the year ended ${end.day} ${MONTHS_LONG[end.month - 1]} ${end.year}`
    : (win.label === range ? range : `${win.label} · ${range}`);
  // The closed months a to-date figure covers, named once here so the screen
  // and the exports cannot describe them differently.
  const closedLast = actualThroughIdx >= 0 ? months[actualThroughIdx] : null;
  logger.info('Budget vs Actual fetched', {
    userId, tenantId, period: win.key, range: `${first.key}..${last.key}`,
    months: months.length, chunks: chunks.length, pnlCalls, actualMonths: actualThroughIdx + 1,
  });

  return _cacheSet(key, {
    organisation: { name: org.name || org.legalName || 'Organisation', currency: org.baseCurrency || '' },
    fiscalYear:   { label: periodLabel, fromISO: first.startISO, toISO: last.endISO },
    budgets,
    period:       { key: win.key, label: win.label, months: months.length, chunks: chunks.length,
                    fromKey: months[0].key, toKey: months[months.length - 1].key,
                    toDateLabel:      _toDateLabel(months, fiscalYearEnd, today),
                    closedFromLabel:  closedLast ? first.label : null,
                    closedToLabel:    closedLast ? closedLast.label : null,
                    closedThroughISO: closedLast ? closedLast.endISO : null },
    months:       months.map((m, i) => ({ key: m.key, label: m.label, source: i <= actualThroughIdx ? 'actual' : 'budget', current: i === currentIdx })),
    ...built,
  }, _periodCacheTtl(months, today));
}

// The period reports name their option defaults (see _dedupe), matching the
// defaults in their own signatures. These are the ones fetched together — the
// Insights page asks for performance, commentary and narrative at once, and
// each of those asks for the next one down — so these are where a request
// spelled two ways cost two fetches.
//
// Bound after the declaration, through the one in-flight map in
// ./report-cache, so getPerformance's call to it goes through the same
// in-flight map as the /budget-variance route.
const getBudgetVariance      = _dedupe('getBudgetVariance', _getBudgetVarianceRaw,
  { force: false, timezone: 'UTC', window: 'fy' });

module.exports = {
  getBudgetVariance,
  _pnlCallPlan, _reportLines, _mergeChunks, _buildBudgetVariance, _mapWithConcurrency,
  _variancePct, _cents, _netRow, _sectionKind, _norm,
};
