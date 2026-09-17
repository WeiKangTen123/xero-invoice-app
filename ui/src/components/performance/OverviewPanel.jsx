import { useState } from 'react';
import { fmtMoney, fmtPct } from '../../utils/format';
import { BarList, ChartModeToggle, TrendChart } from './charts';
import { GrowthPill, Legend, Metric, Rows, ScoreCard, Surface, WatchBand, closedInRange, rangeGrowth, rangeLabel, slice, sliceSum, useRangeTotals } from './primitives';

export function OverviewPanel({ data, from, to, insights, summary, narrative, onOpenAnalysis }) {
  const [trendMode, setTrendMode] = useState('bar');
  const cur = data.organisation?.currency || '';
  const T   = useRangeTotals(data, from, to);
  const months = data.months.slice(from, to + 1);
  const closed = closedInRange(data, from, to);
  if (!T) return null;

  const healthy = T.netProfit > 0 && (T.grossMargin === null || T.grossMargin > 0);
  const cash = data.cash?.available ? data.cash.total : null;
  const g = rangeGrowth(data, from, to);

  const serviceItems = data.serviceLines
    .filter(l => !l.otherIncome)
    .map(l => ({ label: l.label, value: sliceSum(l.actual, from, to), tag: l.recurring ? 'recurring' : null }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  // Days Sales Outstanding: how long invoiced revenue takes to become cash.
  // Receivables come from the invoice summary, revenue from the P&L — both
  // already on the page, so this costs no extra call. Undefined without revenue.
  const days = months.length * 30.44;
  const receivables = summary?.kpis?.totalReceivables ?? null;
  const dso = (receivables !== null && T.revenue > 0) ? (receivables / T.revenue) * days : null;
  const overdue = summary?.kpis?.overdueAmount ?? null;

  const scorecard = [
    { label: 'Recurring mix', target: 'Higher is steadier',
      value: T.recurringMix === null ? '—' : fmtPct(T.recurringMix, 0),
      note: T.recurringMix === null ? 'No revenue yet' : `${fmtMoney(T.recurring, cur)} recurring` },
    { label: 'Budget attainment', target: 'Target 100%',
      value: T.revenueBudget > 0 ? fmtPct(T.revenue / T.revenueBudget, 0) : '—',
      tone: T.revenueBudget > 0 && T.revenue < T.revenueBudget ? 'var(--danger)' : 'var(--success)',
      note: T.revenueBudget > 0 ? `vs ${fmtMoney(T.revenueBudget, cur)}` : 'Nothing budgeted' },
    { label: 'Expense ratio', target: 'Lower is better',
      value: T.revenue > 0 ? fmtPct((T.cogs + T.opex) / T.revenue, 0) : '—',
      note: T.revenue > 0 ? `${fmtMoney(T.cogs + T.opex, cur)} of costs` : 'No revenue yet' },
    { label: 'Debtor days', target: 'Lower is better',
      value: dso === null ? '—' : `${Math.round(dso)} days`,
      tone: dso !== null && dso > 60 ? 'var(--warning)' : undefined,
      note: receivables === null ? 'Needs invoice data'
            : overdue > 0 ? `${fmtMoney(overdue, cur)} overdue` : `${fmtMoney(receivables, cur)} outstanding` },
    // Level without direction makes the reader do the differencing themselves.
    { label: 'Revenue growth', target: 'Month on month',
      value: g.mom === null ? '—' : `${g.mom >= 0 ? '+' : ''}${fmtPct(g.mom, 1)}`,
      tone: g.mom === null ? undefined : g.mom >= 0 ? 'var(--success)' : 'var(--danger)',
      note: g.mom === null
        ? (g.available ? 'Needs two closed months' : 'No closed month in range')
        : `${g.latestLabel} vs ${g.momLabel}` },
  ];

  const varianceItems = [...data.serviceLines, ...data.expenseLines]
    .map(l => ({ label: l.label, a: sliceSum(l.actual, from, to), b: sliceSum(l.budget, from, to) }))
    .map(l => ({ ...l, v: l.a - l.b }))
    .filter(l => l.v !== 0)
    .sort((x, y) => Math.abs(y.v) - Math.abs(x.v))
    .slice(0, 6);

  return (
    <>
      {/* Health strip — the reference dashboard's top banner, but the verdict is
          derived from the figures rather than a stored status. */}
      <div className="card" style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap',
        borderLeft: `3px solid ${healthy ? 'var(--success)' : 'var(--warning)'}`, marginBottom: 16,
      }}>
        <div style={{ fontSize: 13 }}>
          <strong style={{ color: healthy ? 'var(--success)' : 'var(--warning)' }}>
            {healthy ? 'Trading profitably' : 'Needs attention'}
          </strong>
          <span style={{ color: 'var(--text-muted)' }}>
            {' '}· {closed} of {months.length} month{months.length === 1 ? '' : 's'} in range closed
            {data.watchList.length > 0 && ` · ${data.watchList.length} item${data.watchList.length === 1 ? '' : 's'} to review`}
          </span>
        </div>
        <div style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
          {fmtMoney(T.revenue, cur)} revenue · {T.netMargin === null ? '—' : fmtPct(T.netMargin)} net margin
        </div>

        {/* One AI sentence INSIDE the strip that was already here, rather than a
            thirteenth block on a crowded page. The full analysis has its own tab. */}
        {narrative?.available && narrative.text && (
          <div style={{ flexBasis: '100%', borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 2,
                        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55, flex: 1, minWidth: 260 }}>
              <span style={{ color: 'var(--accent)', fontSize: 10, marginRight: 6 }}>AI</span>
              {narrative.text.split(/(?<=\.)\s+/)[0]}
            </span>
            {onOpenAnalysis && (
              <button onClick={onOpenAnalysis}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                               fontSize: 11.5, color: 'var(--accent)', whiteSpace: 'nowrap' }}>
                See full analysis →
              </button>
            )}
          </div>
        )}
      </div>

      <WatchBand items={data.watchList} />

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <Metric label="Total revenue" value={fmtMoney(T.revenue, cur)}
                meter={T.revenueBudget > 0 ? (T.revenue / T.revenueBudget) * 100 : null}
                footLeft={T.recurringMix === null ? 'No revenue yet' : `${fmtPct(T.recurringMix, 0)} recurring`}
                footRight={T.revenueBudget > 0 ? `${fmtPct(T.revenue / T.revenueBudget, 0)} of budget` : 'No budget set'} />
        <Metric label="Gross margin" value={T.grossMargin === null ? '—' : fmtPct(T.grossMargin)}
                meter={T.grossMargin === null ? null : T.grossMargin * 100}
                footLeft={`${fmtMoney(T.grossProfit, cur)} gross profit`}
                footRight={T.cogs === 0 ? 'No cost of sales booked' : `${fmtMoney(T.cogs, cur)} cost of sales`} />
        <Metric label="Net margin" value={T.netMargin === null ? '—' : fmtPct(T.netMargin)}
                meter={T.netMargin === null ? null : T.netMargin * 100}
                tone={T.netProfit < 0 ? 'var(--danger)' : undefined}
                footLeft={`${fmtMoney(T.netProfit, cur)} net`}
                footRight={`${fmtMoney(T.opex, cur)} operating costs`} />
        <Metric label="Cash at bank" value={cash === null ? '—' : fmtMoney(cash, cur)}
                meter={null}
                footLeft={cash === null ? 'Bank summary unavailable' : `${data.cash.accounts.length} account${data.cash.accounts.length === 1 ? '' : 's'}`}
                footRight={cash === null ? '' : 'Closing balance'} />
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <Surface title="Revenue by service line" right={T.recurringMix === null ? null : `${fmtPct(T.recurringMix, 0)} recurring`} flex={7} minWidth={380}>
          <BarList items={serviceItems} currency={cur} showPctOfTotal />
          <div style={{ marginTop: 12, padding: '8px 10px', borderRadius: 8, background: 'var(--bg-secondary)',
                        fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.55 }}>
            <strong style={{ color: 'var(--warning)' }}>Inferred, not reported.</strong>{' '}
            Xero has no "this account is recurring" flag, so this split is guessed from account names.
            {data.recurringAccounts.length > 0
              ? ` Treated as recurring: ${data.recurringAccounts.join(', ')}.`
              : ' No account name matched, so everything counts as project revenue.'}
            {' '}Setting up Repeating Invoices in Xero would make this a reported figure instead of a guess.
          </div>
        </Surface>
        <Surface title="Executive snapshot" right={rangeLabel(data.months, from, to)} flex={5} minWidth={300}>
          <Rows currency={cur} items={[
            { label: 'Total revenue',     value: T.revenue, strong: true },
            { label: 'Recurring revenue', value: T.recurring },
            { label: 'Project revenue',   value: T.project },
            { label: 'Cost of sales',     value: T.cogs },
            { label: 'Gross profit',      value: T.grossProfit, strong: true },
            { label: 'Other income',      value: T.otherIncome },
            { label: 'Operating expenses', value: T.opex },
            { label: 'Net profit',        value: T.netProfit, strong: true },
          ]} />
        </Surface>
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <Surface title="Margin bridge" flex={6} minWidth={340}>
          <BarList currency={cur} items={[
            { label: 'Revenue',            value: T.revenue,     color: 'var(--accent)' },
            { label: 'Cost of sales',      value: T.cogs,        color: 'var(--text-muted)' },
            { label: 'Operating expenses', value: T.opex,        color: '#b8860b' },
            { label: 'Net profit',         value: T.netProfit,   color: T.netProfit < 0 ? 'var(--danger)' : 'var(--success)' },
          ]} />
        </Surface>
        <Surface title="KPI scorecard" right={rangeLabel(data.months, from, to)} flex={6} minWidth={340}>
          <ScoreCard items={scorecard} />
        </Surface>
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <Surface title="Revenue trend" right={<ChartModeToggle mode={trendMode} onChange={setTrendMode} />} flex={7} minWidth={380}>
          {/* Follows the month range, same as every other figure on this panel —
              a chart showing a different period from the numbers beside it is
              worse than a short chart. */}
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 8 }}>
            {rangeLabel(data.months, from, to)}
            {from === to && ' · widen the range to see a trend'}
          </div>
          <TrendChart mode={trendMode} months={months} currency={cur}
                      actual={slice(data.totals.revenue.actual, from, to)}
                      budget={slice(data.totals.revenue.budget, from, to)} />
          <Legend items={[{ label: 'Actual', color: 'var(--accent)' }, { label: 'Budget', color: 'var(--text-muted)', opacity: 0.32 }]} />
          {/* Direction alongside level. Closed months only — the current month
              is partial and would read as a crash every time. */}
          {g.available && (
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                Month on month{' '}
                <GrowthPill value={g.mom} title={g.momLabel ? `${g.latestLabel} vs ${g.momLabel}` : 'Needs two closed months'} />
                {g.momLabel && <span> · {g.latestLabel} vs {g.momLabel}</span>}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                Year on year{' '}
                <GrowthPill value={g.yoy} title={g.yoyLabel ? `${g.latestLabel} vs ${g.yoyLabel}` : 'Needs 13 months of history'} />
                {g.yoyLabel ? <span> · {g.latestLabel} vs {g.yoyLabel}</span> : <span> · needs a full prior year</span>}
              </div>
            </div>
          )}
        </Surface>
        <Surface
          title="Variance Reasons"
          right={insights?.categories?.length ? <span style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700 }}>Executive Scorecard</span> : 'Actual − budget'}
          flex={5}
          minWidth={320}
        >
          {insights?.categories && insights.categories.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {insights.categories.slice(0, 3).map(cat => {
                const isFavorable = cat.status === 'favorable';
                return (
                  <div
                    key={cat.key}
                    style={{
                      background: 'var(--bg-secondary)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      padding: '10px 12px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{cat.title}</span>
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10, textTransform: 'lowercase',
                        background: isFavorable ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                        color: isFavorable ? 'var(--success)' : 'var(--danger)',
                        border: `1px solid ${isFavorable ? 'rgba(34, 197, 94, 0.28)' : 'rgba(239, 68, 68, 0.28)'}`,
                      }}>{cat.status}</span>
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                      <strong style={{ color: 'var(--text-primary)', marginRight: 5 }}>{cat.deltaText}</strong>
                      {cat.reason}
                    </div>
                  </div>
                );
              })}
              {onOpenAnalysis && (
                <button
                  type="button"
                  onClick={onOpenAnalysis}
                  className="btn btn-outline btn-sm"
                  style={{ width: '100%', marginTop: 2, justifyContent: 'center', fontSize: 11.5 }}
                >
                  View full variance analysis →
                </button>
              )}
            </div>
          ) : (
            <>
              <Rows currency={cur} items={varianceItems.map(l => ({ label: l.label, value: l.v }))} />
              {onOpenAnalysis && (
                <button
                  type="button"
                  onClick={onOpenAnalysis}
                  style={{
                    background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                    fontSize: 11, color: 'var(--accent)', fontWeight: 600, marginTop: 10, display: 'block', textAlign: 'left',
                  }}
                >
                  Why these differ → <strong>Analysis</strong> tab
                </button>
              )}
            </>
          )}
        </Surface>
      </div>
    </>
  );
}
