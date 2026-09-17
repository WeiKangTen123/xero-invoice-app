import { fmtMoney, fmtPct } from '../../utils/format';
import { GroupedMonthlyBars, Waterfall } from './charts';
import {Empty, Legend, Metric, Surface, rangeLabel, sliceSum, useRangeTotals } from './primitives';

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
function StatementTable({ rows, currency, revenue, showBudget = true }) {
  const cell = (align = 'right') => ({ padding: '7px 10px', textAlign: align, whiteSpace: 'nowrap' });
  const head = ['', 'Actual', ...(showBudget ? ['Budget', 'Variance', 'Var %'] : []), '% of revenue'];

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
function varianceBridgeSteps(T) {
  const steps = [{ label: 'Budget net profit', delta: T.netProfitBudget, kind: 'total', start: 0, end: T.netProfitBudget }];
  let run = T.netProfitBudget;
  const push = (label, delta, kind) => {
    if (!Math.round(delta)) return;
    const start = run;
    run += delta;
    steps.push({ label, delta, kind: kind || (delta >= 0 ? 'in' : 'out'), start, end: run });
  };

  push('Revenue',            T.revenue     - T.revenueBudget);
  push('Other income',       T.otherIncome - T.otherIncomeBudget);
  // Negated: underspending against budget IMPROVES profit, so it must push the
  // bar up even though actual − budget is negative.
  push('Cost of sales',      -(T.cogs - T.cogsBudget));
  push('Operating expenses', -(T.opex - T.opexBudget));

  const residual = T.netProfit - run;
  if (Math.abs(residual) > 1) push('Other movements', residual, 'gap');

  steps.push({ label: 'Actual net profit', delta: T.netProfit, kind: 'total', start: 0, end: T.netProfit });
  return steps;
}

export function ProfitabilityPanel({ data, from, to }) {
  const cur = data.organisation?.currency || '';
  const T = useRangeTotals(data, from, to);
  const months = data.months.slice(from, to + 1);
  if (!T) return null;

  const sliceOf = l => sliceSum(l.actual, from, to);
  const sliceB  = l => sliceSum(l.budget, from, to);

  const revenueLines = data.serviceLines.filter(l => !l.otherIncome)
    .map(l => ({ label: l.label, actual: sliceOf(l), budget: sliceB(l), kind: 'line', favour: 'up' }))
    .filter(l => l.actual || l.budget)
    .sort((a, b) => Math.abs(b.actual) - Math.abs(a.actual));

  const otherIncomeLines = data.serviceLines.filter(l => l.otherIncome)
    .map(l => ({ label: l.label, actual: sliceOf(l), budget: sliceB(l), kind: 'line', favour: 'up' }))
    .filter(l => l.actual || l.budget);

  const lineOf = kind => data.expenseLines.filter(l => l.kind === kind)
    .map(l => ({ label: l.label, actual: sliceOf(l), budget: sliceB(l), kind: 'line', favour: 'down' }))
    .filter(l => l.actual || l.budget)
    .sort((a, b) => Math.abs(b.actual) - Math.abs(a.actual));

  const cogsLines = lineOf('cogs');
  const opexLines = lineOf('opex');

  const rows = [
    { kind: 'section', label: 'Revenue' },
    ...revenueLines,
    { kind: 'total', label: 'Total revenue', actual: T.revenue, budget: T.revenueBudget, favour: 'up' },

    ...(cogsLines.length ? [
      { kind: 'section', label: 'Less cost of sales' },
      ...cogsLines,
      { kind: 'total', label: 'Total cost of sales', actual: T.cogs, budget: T.cogsBudget, favour: 'down' },
      { kind: 'result', label: 'Gross profit', actual: T.grossProfit, budget: T.grossProfitBudget, favour: 'up' },
    ] : []),

    ...(otherIncomeLines.length ? [
      { kind: 'section', label: 'Other income' },
      ...otherIncomeLines,
      { kind: 'total', label: 'Total other income', actual: T.otherIncome, budget: T.otherIncomeBudget, favour: 'up' },
    ] : []),

    ...(opexLines.length ? [
      { kind: 'section', label: 'Less operating expenses' },
      ...opexLines,
      { kind: 'total', label: 'Total operating expenses', actual: T.opex, budget: T.opexBudget, favour: 'down' },
    ] : []),

    { kind: 'result', label: 'Net profit', actual: T.netProfit, budget: T.netProfitBudget, favour: 'up' },
  ];

  const bridge = varianceBridgeSteps(T);
  const profitGap = T.netProfit - T.netProfitBudget;

  // Months in the selected range that have a budget but no actuals yet. Their
  // budget is real and their actual is legitimately zero, so the arithmetic is
  // correct — but read as a variance it says the business missed revenue it was
  // never yet due to earn. Stated rather than silently included.
  const unearnedMonths = Math.max(0, to - data.actualThroughIdx);

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

  return (
    <>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <Metric label="Revenue" value={fmtMoney(T.revenue, cur)} meter={null}
                footLeft={T.revenueBudget ? `vs ${fmtMoney(T.revenueBudget, cur)} budget` : 'Nothing budgeted'}
                footRight={rangeLabel(data.months, from, to)} />
        <Metric label="Gross profit" value={T.grossMargin === null ? '—' : fmtMoney(T.grossProfit, cur)}
                meter={T.grossMargin === null ? null : Math.max(0, Math.min(100, T.grossMargin * 100))}
                tone={T.grossProfit < 0 ? 'var(--danger)' : 'var(--success)'}
                footLeft={T.grossMargin === null ? 'No revenue' : `${fmtPct(T.grossMargin, 1)} margin`}
                footRight={cogsLines.length ? `after ${fmtMoney(T.cogs, cur)} of costs` : 'no cost of sales booked'} />
        <Metric label="Net profit" value={fmtMoney(T.netProfit, cur)} meter={null}
                tone={T.netProfit < 0 ? 'var(--danger)' : 'var(--success)'}
                footLeft={T.netMargin === null ? 'No revenue' : `${fmtPct(T.netMargin, 1)} margin`}
                footRight={T.netProfitBudget ? `vs ${fmtMoney(T.netProfitBudget, cur)} budget` : 'Nothing budgeted'} />
        <Metric label="Against budget"
                value={T.netProfitBudget ? `${profitGap > 0 ? '+' : ''}${fmtMoney(profitGap, cur)}` : '—'}
                meter={null}
                tone={!T.netProfitBudget ? undefined : profitGap >= 0 ? 'var(--success)' : 'var(--danger)'}
                footLeft={!T.netProfitBudget ? 'No budget set'
                        : unearnedMonths > 0 ? `Incl. ${unearnedMonths} unearned month${unearnedMonths === 1 ? '' : 's'}`
                        : profitGap >= 0 ? 'Ahead of plan' : 'Behind plan'}
                footRight={T.netProfitBudget ? fmtPct(Math.abs(profitGap / Math.abs(T.netProfitBudget)), 0) : ''} />
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <Surface title="Why profit differs from budget" right="actual − budget, by driver" flex={7} minWidth={400}>
          {bridge.length > 2
            ? <Waterfall steps={bridge} currency={cur} height={230} />
            : <Empty>Nothing budgeted for this period, so there is no variance to explain.</Empty>}
          {unearnedMonths > 0 && (
            <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 12, lineHeight: 1.5 }}>
              ▲ {unearnedMonths} month{unearnedMonths === 1 ? '' : 's'} in this range {unearnedMonths === 1 ? 'has' : 'have'} a
              budget but no actuals yet, so {unearnedMonths === 1 ? 'it counts' : 'they count'} as a full shortfall against plan.
              Narrow the range to closed months to compare like with like.
            </div>
          )}
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.5 }}>
            Cost bars are inverted: spending less than budget pushes profit up, so it rises even though
            actual minus budget is negative. Green is favourable to profit, not arithmetically positive.
          </div>
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

      <Surface title="Income statement" right={rangeLabel(data.months, from, to)}>
        <StatementTable rows={rows} currency={cur} revenue={T.revenue} showBudget />
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.5 }}>
          Every figure is read from Xero&apos;s Profit &amp; Loss and Budget Summary reports for this period —
          the same source as the Budget tabs, laid out as a statement rather than a grid. Accounts with no
          activity and nothing budgeted are omitted.
        </div>
      </Surface>
    </>
  );
}
