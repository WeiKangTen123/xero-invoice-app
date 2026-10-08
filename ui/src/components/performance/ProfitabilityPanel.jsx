import { fmtMoney, fmtPct } from '../../utils/format';
import { GroupedMonthlyBars, PriorYearBars, Waterfall } from './charts';
import { BudgetLine, Empty, Legend, Metric, Surface, closedCaption, closedSpan, closedSum, priorYearReason, rangeLabel, slice, sliceSum, useRangeTotals } from './primitives';

// ── Profitability ────────────────────────────────────────────────────────────────
// Xero has no cash-flow-statement endpoint, so every figure here is constructed
// from Bank Summary, Payments, Bank Transactions and Invoices.

// ── Profitability ───────────────────────────────────────────────────────────

// Variance signed for FAVOURABILITY rather than arithmetic. Spending more than
// budget is an unfavourable outcome even though actual − budget is positive, and
// a statement that colours it green because the number is positive is worse than
// one with no colour at all.
function favourable(variance, favour) {
  if (!variance) return null;
  return favour === 'down' ? variance < 0 : variance > 0;
}

function varianceTone(variance, favour) {
  const good = favourable(variance, favour);
  return good === null ? 'var(--text-muted)' : good ? 'var(--success)' : 'var(--danger)';
}

// Same rule the server uses: divide by the magnitude of budget so an
// unfavourable variance against a negative budget still reads as negative, and
// return null rather than infinity when nothing was budgeted.
function varPct(variance, budget) {
  if (!budget) return null;
  return variance / Math.abs(budget);
}

// A formatted income statement — the layout an accountant checks first, and the
// one view the budget grid cannot replace: it reads top to bottom as a single
// argument ending in net profit, rather than as a matrix of months.
//
// With a budget, every column is the closed months, so actual, budget and
// variance describe the same months. What the month in progress has booked
// so far is then its own column (`soFarLabel` names the month), in no
// variance, so the statement still adds up to the tiles above it.
function StatementTable({ rows, currency, revenue, showBudget = true, soFarLabel = null }) {
  const cell = (align = 'right') => ({ padding: '7px 10px', textAlign: align, whiteSpace: 'nowrap' });
  const head = ['', 'Actual', ...(showBudget ? ['Budget', 'Variance', 'Var %'] : []), ...(soFarLabel ? [`${soFarLabel} so far`] : []), '% of revenue'];

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            {head.map((h, i) => (
              <th key={h || i} style={{ ...cell(i === 0 ? 'left' : 'right'), fontSize: 10.5, fontWeight: 700,
                                        letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            if (r.kind === 'section') {
              return (
                <tr key={`${r.label}-${i}`}>
                  <td colSpan={head.length} style={{
                    ...cell('left'), paddingTop: 16, paddingBottom: 4, fontSize: 10.5, fontWeight: 800,
                    letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-muted)',
                  }}>{r.label}</td>
                </tr>
              );
            }
            const variance = r.actual - r.budget;
            const pct = varPct(variance, r.budget);
            const share = revenue ? r.actual / revenue : null;
            const isResult = r.kind === 'result';
            const isTotal  = r.kind === 'total' || isResult;

            return (
              <tr key={`${r.label}-${i}`} style={{
                borderTop: isTotal ? '1px solid var(--border)' : 'none',
                background: isResult ? 'var(--bg-secondary)' : undefined,
              }}>
                <td style={{ ...cell('left'), paddingLeft: r.kind === 'line' ? 22 : 10,
                             fontWeight: isTotal ? 700 : 400,
                             color: isTotal ? undefined : 'var(--text-secondary)' }}>{r.label}</td>
                <td style={{ ...cell(), fontWeight: isTotal ? 800 : 500,
                             color: isResult && r.actual < 0 ? 'var(--danger)' : undefined }}>
                  {fmtMoney(r.actual, currency)}
                </td>
                {showBudget && <>
                  <td style={{ ...cell(), color: 'var(--text-muted)' }}>{r.budget ? fmtMoney(r.budget, currency) : '—'}</td>
                  <td style={{ ...cell(), color: varianceTone(variance, r.favour), fontWeight: variance ? 600 : 400 }}>
                    {variance ? `${variance > 0 ? '+' : ''}${fmtMoney(variance, currency)}` : '—'}
                  </td>
                  <td style={{ ...cell(), color: varianceTone(variance, r.favour), fontSize: 11.5 }}
                      title={pct === null ? 'Nothing budgeted, so there is no percentage to compute' : undefined}>
                    {pct === null ? '—' : `${pct > 0 ? '+' : ''}${fmtPct(pct, 1)}`}
                  </td>
                </>}
                {soFarLabel && (
                  <td style={{ ...cell(), color: 'var(--text-muted)' }}>{r.soFar ? fmtMoney(r.soFar, currency) : '—'}</td>
                )}
                <td style={{ ...cell(), color: 'var(--text-muted)', fontSize: 11.5 }}>
                  {share === null ? '—' : fmtPct(share, 1)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Budget net profit → actual net profit, one step per driver. Answers the
// question the budget grid raises and never settles: the profit missed target,
// but because of WHAT?
//
// The identity is exact by construction (net = revenue + other income − cost of
// sales − operating expenses), but a Xero P&L can carry rows outside those four.
// Any residual becomes its own labelled step rather than being absorbed silently
// into the last bar.
//
// `actual` and `budget` are the closed months' totals (useRangeTotals's
// actualClosed and budgetClosed), so the bridge explains the same gap the
// Budget tab shows.
function varianceBridgeSteps(actual, budget) {
  const steps = [{ label: 'Budget net profit', delta: budget.netProfit, kind: 'total', start: 0, end: budget.netProfit }];
  let run = budget.netProfit;
  const push = (label, delta, kind) => {
    if (!Math.round(delta)) return;
    const start = run;
    run += delta;
    steps.push({ label, delta, kind: kind || (delta >= 0 ? 'in' : 'out'), start, end: run });
  };

  push('Revenue',            actual.revenue     - budget.revenue);
  push('Other income',       actual.otherIncome - budget.otherIncome);
  // Negated: underspending against budget IMPROVES profit, so it must push the
  // bar up even though actual − budget is negative.
  push('Cost of sales',      -(actual.cogs - budget.cogs));
  push('Operating expenses', -(actual.opex - budget.opex));

  const residual = actual.netProfit - run;
  if (Math.abs(residual) > 1) push('Other movements', residual, 'gap');

  steps.push({ label: 'Actual net profit', delta: actual.netProfit, kind: 'total', start: 0, end: actual.netProfit });
  return steps;
}

export function ProfitabilityPanel({ data, from, to }) {
  const cur = data.organisation?.currency || '';
  const T = useRangeTotals(data, from, to);
  const months = data.months.slice(from, to + 1);
  if (!T) return null;

  // Everything compared with budget is on the closed months of the range, the
  // Budget tab's basis (see closedSpan). The whole range was compared before,
  // which read every month not yet reached as a full shortfall against plan
  // and the month in progress as a part one.
  const span = closedSpan(data, from, to);
  const compared = span.months > 0;
  const open = T.openMonthLabel;

  // Statement lines on the budget's basis, so actual, budget and variance
  // describe the same months. With no closed month there is no budget to
  // compare with, and the statement is what has been booked so far instead.
  const sliceOf = l => (compared ? closedSum(l.actual, span) : sliceSum(l.actual, from, to));
  const sliceB  = l => closedSum(l.budget, span);
  // Booked after the closed months: the month in progress, so far.
  const soFarOf = series => sliceSum(series, span.to + 1, to);
  const line = (l, favour) => ({ label: l.label, actual: sliceOf(l), budget: sliceB(l), soFar: soFarOf(l.actual), kind: 'line', favour });

  const revenueLines = data.serviceLines.filter(l => !l.otherIncome)
    .map(l => line(l, 'up'))
    .filter(l => l.actual || l.budget || l.soFar)
    .sort((a, b) => Math.abs(b.actual) - Math.abs(a.actual));

  const otherIncomeLines = data.serviceLines.filter(l => l.otherIncome)
    .map(l => line(l, 'up'))
    .filter(l => l.actual || l.budget || l.soFar);

  const lineOf = kind => data.expenseLines.filter(l => l.kind === kind)
    .map(l => line(l, 'down'))
    .filter(l => l.actual || l.budget || l.soFar)
    .sort((a, b) => Math.abs(b.actual) - Math.abs(a.actual));

  const cogsLines = lineOf('cogs');
  const opexLines = lineOf('opex');

  // The statement's totals on the same basis as its lines. A total's "so far"
  // is the whole range less the closed months, so it holds even for a gross
  // profit worked out from revenue and cost of sales.
  const whole = { revenue: T.revenue, otherIncome: T.otherIncome, cogs: T.cogs, opex: T.opex, netProfit: T.netProfit, grossProfit: T.grossProfit };
  const A = compared ? T.actualClosed : whole;
  const B = T.budgetClosed;
  const total = (kind, label, key, favour) => ({ kind, label, actual: A[key], budget: B[key], soFar: whole[key] - T.actualClosed[key], favour });

  const rows = [
    { kind: 'section', label: 'Revenue' },
    ...revenueLines,
    total('total', 'Total revenue', 'revenue', 'up'),

    ...(cogsLines.length ? [
      { kind: 'section', label: 'Less cost of sales' },
      ...cogsLines,
      total('total', 'Total cost of sales', 'cogs', 'down'),
      total('result', 'Gross profit', 'grossProfit', 'up'),
    ] : []),

    ...(otherIncomeLines.length ? [
      { kind: 'section', label: 'Other income' },
      ...otherIncomeLines,
      total('total', 'Total other income', 'otherIncome', 'up'),
    ] : []),

    ...(opexLines.length ? [
      { kind: 'section', label: 'Less operating expenses' },
      ...opexLines,
      total('total', 'Total operating expenses', 'opex', 'down'),
    ] : []),

    total('result', 'Net profit', 'netProfit', 'up'),
  ];

  const bridge = compared ? varianceBridgeSteps(T.actualClosed, T.budgetClosed) : [];
  const profitGap = T.actualClosed.netProfit - T.budgetClosed.netProfit;
  const gapKnown = compared && T.budgetClosed.netProfit !== 0;
  const basisNote = compared
    ? `Budget comparisons use the closed months only: ${closedCaption(span).replace(/^Closed months?: /, '')}.`
      + (open ? ` Revenue, gross profit and net profit above include ${open} so far.` : '')
    : 'No closed month yet in this period — the figures above are what has been booked so far; budget comparisons start when a month closes.';

  // Margin by month, over the selected range. Null where there was no revenue —
  // a margin on nothing is undefined, not zero.
  const marginSeries = months.map((_, i) => {
    const idx = from + i;
    const rev = data.totals.revenue.actual[idx];
    return {
      gross: rev ? (data.totals.grossProfit.actual[idx] || (rev - data.totals.cogs.actual[idx])) / rev : null,
      net:   rev ? data.totals.netProfit.actual[idx] / rev : null,
    };
  });
  const hasMargins = marginSeries.some(m => m.gross !== null || m.net !== null);

  // Net profit month by month against the same month last year, when the
  // report carries last year (this tab asks for it). The margin chart beside
  // the bridge stays as it was: a margin line from last year over this year's
  // margin bars would put two different questions on one scale.
  const py = data.priorYear || null;
  const closedInView = Math.max(0, Math.min(data.closedThroughIdx + 1, to + 1) - from);

  return (
    <>
      {/* The headline figures are the whole range as booked, the month in
          progress included; each comparison under them is the closed months'
          (BudgetLine), and the line under the row says which is which. */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 8 }}>
        <Metric label="Revenue" value={fmtMoney(T.revenue, cur)} meter={null}
                footLeft={rangeLabel(data.months, from, to)}
                footRight={open ? `incl. ${open} so far` : ''}
                compare={<BudgetLine actual={T.actualClosed.revenue} budget={T.budgetClosed.revenue} span={span} currency={cur} />} />
        <Metric label="Gross profit" value={T.grossMargin === null ? '—' : fmtMoney(T.grossProfit, cur)}
                meter={T.grossMargin === null ? null : Math.max(0, Math.min(100, T.grossMargin * 100))}
                tone={T.grossProfit < 0 ? 'var(--danger)' : 'var(--success)'}
                footLeft={T.grossMargin === null ? 'No revenue' : `${fmtPct(T.grossMargin, 1)} margin`}
                footRight={cogsLines.length ? `after ${fmtMoney(T.cogs, cur)} of costs` : 'no cost of sales booked'} />
        <Metric label="Net profit" value={fmtMoney(T.netProfit, cur)} meter={null}
                tone={T.netProfit < 0 ? 'var(--danger)' : 'var(--success)'}
                footLeft={T.netMargin === null ? 'No revenue' : `${fmtPct(T.netMargin, 1)} margin`}
                footRight={open ? `incl. ${open} so far` : ''}
                compare={<BudgetLine actual={T.actualClosed.netProfit} budget={T.budgetClosed.netProfit} span={span} currency={cur} />} />
        <Metric label="Net profit vs budget"
                value={gapKnown ? `${profitGap > 0 ? '+' : ''}${fmtMoney(profitGap, cur)}` : '—'}
                meter={null}
                tone={!gapKnown ? undefined : profitGap >= 0 ? 'var(--success)' : 'var(--danger)'}
                footLeft={!compared ? 'No closed month yet in this period'
                        : !gapKnown ? 'Nothing budgeted for the closed months'
                        : profitGap > 0 ? 'Ahead of plan' : profitGap < 0 ? 'Behind plan' : 'On plan'}
                footRight={gapKnown ? `${fmtPct(Math.abs(profitGap / Math.abs(T.budgetClosed.netProfit)), 0)} of budget` : ''} />
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 16 }}>
        {basisNote}
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <Surface title="Why profit differs from budget" right={compared ? closedCaption(span) : 'actual − budget, by driver'} flex={7} minWidth={400}>
          {!compared
            ? <Empty>No closed month yet in this period, so there is no variance to explain.</Empty>
            : bridge.length > 2
              ? <Waterfall steps={bridge} currency={cur} height={230} />
              : <Empty>Nothing budgeted for the closed months, so there is no variance to explain.</Empty>}
          {/* The one place the whole range's budget is shown — every month of
              it, reached or not — and it is labelled as the plan, because
              nothing on this dashboard is compared with it. */}
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 12, lineHeight: 1.5 }}>
            Plan for the whole period ({T.wholeMonths} month{T.wholeMonths === 1 ? '' : 's'}):{' '}
            {T.netProfitBudget || T.revenueBudget
              ? <>{fmtMoney(T.netProfitBudget, cur)} net profit on {fmtMoney(T.revenueBudget, cur)} of revenue, {rangeLabel(data.months, from, to)}.</>
              : <>nothing budgeted for {rangeLabel(data.months, from, to)}.</>}
          </div>
          {compared && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.5 }}>
              Cost bars are inverted: spending less than budget pushes profit up, so it rises even though
              actual minus budget is negative. Green is favourable to profit, not arithmetically positive.
            </div>
          )}
        </Surface>

        <Surface title="Margin trend" right={rangeLabel(data.months, from, to)} flex={5} minWidth={320}>
          {hasMargins ? (
            <>
              <GroupedMonthlyBars months={months} currency={cur} percent series={[
                { label: 'Gross margin', color: 'var(--success)', values: marginSeries.map(m => (m.gross ?? 0) * 100) },
                { label: 'Net margin',   color: 'var(--accent)',  values: marginSeries.map(m => (m.net ?? 0) * 100) },
              ]} />
              <Legend items={[{ label: 'Gross margin', color: 'var(--success)' }, { label: 'Net margin', color: 'var(--accent)' }]} />
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
                Months with no revenue are omitted rather than drawn as zero — a margin on nothing is undefined.
              </div>
            </>
          ) : <Empty>No revenue in this range, so there is no margin to plot.</Empty>}
        </Surface>
      </div>

      {py && (
        <div style={{ marginBottom: 16 }}>
          <Surface title="Net profit by month" right={py.available ? 'against the same month last year' : rangeLabel(data.months, from, to)}>
            <PriorYearBars months={months} currency={cur} label="Net profit"
                           current={slice(data.totals.netProfit.actual, from, to)}
                           prior={py.available ? slice(py.totals.netProfit.monthly, from, to) : months.map(() => null)}
                           priorMonths={slice(py.months || [], from, to)}
                           closed={closedInView} />
            {py.available && (
              <Legend items={[
                { label: 'This year', color: 'var(--accent)' },
                { label: 'Same month last year', color: 'var(--text-secondary)', dashed: true },
              ]} />
            )}
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
              {py.available
                ? <>Faded columns are months not yet closed, which no comparison counts.
                    {py.compared?.firstActivityLabel && ` Nothing was recorded in Xero before ${py.compared.firstActivityLabel}, so last year's line starts there.`}</>
                : <>No line for last year: {priorYearReason(py.reason)}.</>}
            </div>
          </Surface>
        </div>
      )}

      <Surface title="Income statement" right={compared ? closedCaption(span) : `${rangeLabel(data.months, from, to)} · booked so far`}>
        <StatementTable rows={rows} currency={cur} revenue={A.revenue} showBudget={compared} soFarLabel={compared ? open : null} />
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.5 }}>
          {compared
            ? <>Actual, budget and variance cover the closed months only, as the Budget tab&apos;s year to date does.
                {open && <> What {open} has booked so far is its own column and is in no variance.</>}</>
            : <>No closed month yet in this period, so there is no budget column: the figures are what has been booked so far.</>}
          {' '}Every figure is read from Xero&apos;s Profit &amp; Loss and Budget Summary reports for this period —
          the same source as the Budget tabs, laid out as a statement rather than a grid. Accounts with no
          activity and nothing budgeted are omitted.
        </div>
      </Surface>
    </>
  );
}
