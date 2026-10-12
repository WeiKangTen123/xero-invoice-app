import { useState } from 'react';
import { fmtMoney, fmtPct } from '../../utils/format';
import { ChartModeToggle, TrendChart } from './charts';
import { Empty, GrowthPill, Legend, Metric, PriorYearLine, Rows, SERIES_COLORS, ScoreCard, Surface, WatchBand, changeText, closedCaption, closedInRange, closedSpan, closedVarianceItems, comparedText, priorYearRange, priorYearReason, rangeGrowth, rangeLabel, slice, sliceSum, useRangeTotals } from './primitives';

// Pure. True when nothing was booked or budgeted to any of `parts` (series
// with an actual and a budget per month) in the months from `from` to `to`.
// Only then does a figure read "nothing booked": a zero with a budget beside
// it, or one that is the net of real postings, is a real result and is shown
// as one. Monthly sums cannot tell postings that cancel within a month from
// none at all, which is why a budget counts as a sign of activity too.
//
// Self-contained on purpose — no imports, no React — so a test can read it
// straight out of this file and run it; the same goes for the plain functions
// after it.
export function nothingBooked(parts, from, to) {
  for (const p of parts || []) {
    for (let i = from; i <= to; i++) {
      if (Number((p?.actual && p.actual[i]) || 0) !== 0) return false;
      if (Number((p?.budget && p.budget[i]) || 0) !== 0) return false;
    }
  }
  return true;
}

// Pure. Whether the report carries any budget at all, in any month of the
// period. Without one, "No budget set" is the truth; with one that is nil for
// the closed months, that is what the reader needs told instead.
export function hasAnyBudget(d) {
  const t = d?.totals || {};
  const series = [t.revenue, t.otherIncome, t.cogs, t.opex, ...(d?.serviceLines || []), ...(d?.expenseLines || [])];
  return series.some(x => (x?.budget || []).some(v => Number(v || 0) !== 0));
}

// Pure. What a budget comparison says when it has no percentage to give.
export function noAttainmentText(closedMonths, d) {
  if (!closedMonths) return 'No closed month yet';
  return hasAnyBudget(d) ? 'Nothing budgeted for the closed months' : 'No budget set';
}

// Pure. The note under month-on-month revenue growth, from rangeGrowth. With
// two closed months but no revenue in the earlier one there is nothing to
// grow from, which "Needs two closed months" misdescribed.
export function growthNote(g) {
  if (!g?.available) return 'No closed month in range';
  if (g.mom !== null && g.mom !== undefined) return `${g.latestLabel} vs ${g.momLabel}`;
  return g.momLabel ? `No revenue in ${g.momLabel} to compare with` : 'Needs two closed months';
}

// The snapshot's rows and the bars below it, which say "nothing booked"
// where nothing was. The shared Rows printed "—" for any zero, a real one
// included, and BarList printed "SGD 0.00" for nothing at all, so one account
// with no postings read three ways across this tab. Here a row or bar marked
// `nil` (see nothingBooked) reads "nothing booked", and any other figure, a
// zero included, is printed as the money it is.
const NOTHING = <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>nothing booked</span>;

function BookedRows({ items, currency }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {items.map(r => (
        <div key={r.label} style={{
          display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', fontSize: 12.5,
          borderTop: r.strong ? '1px solid var(--border)' : undefined,
          fontWeight: r.strong ? 700 : 400,
        }}>
          <span style={{ color: r.strong ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{r.label}</span>
          <span style={{ fontVariantNumeric: 'tabular-nums', color: !r.nil && r.value < 0 ? 'var(--danger)' : undefined }}>
            {r.nil ? NOTHING : fmtMoney(r.value, currency)}
          </span>
        </div>
      ))}
    </div>
  );
}

// Horizontal bars, as charts.jsx#BarList draws them, scaled against the
// largest absolute value so a negative bar still renders at a truthful length.
function BookedBars({ items, currency, showPctOfTotal }) {
  if (!items.length || items.every(i => i.nil)) return <Empty>Nothing booked in this range.</Empty>;
  const max = Math.max(...items.map(i => Math.abs(i.value)), 1);
  const total = items.reduce((t, i) => t + i.value, 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      {items.map((it, i) => {
        const neg = !it.nil && it.value < 0;
        return (
          <div key={it.label}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, marginBottom: 4 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {it.label}
                {it.tag && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--accent)' }}>{it.tag}</span>}
              </span>
              <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: neg ? 'var(--danger)' : undefined, flexShrink: 0 }}>
                {it.nil ? NOTHING : fmtMoney(it.value, currency)}
                {!it.nil && showPctOfTotal && total !== 0 && (
                  <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6 }}>{fmtPct(it.value / total, 0)}</span>
                )}
              </span>
            </div>
            <div style={{ height: 7, borderRadius: 4, background: 'var(--bg-hover)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${(Math.abs(it.value) / max) * 100}%`,
                            background: neg ? 'var(--danger)' : (it.color || SERIES_COLORS[i % SERIES_COLORS.length]), borderRadius: 4 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function OverviewPanel({ data, from, to, insights, summary, narrative, onOpenAnalysis }) {
  const [trendMode, setTrendMode] = useState('bar');
  const cur = data.organisation?.currency || '';
  const T   = useRangeTotals(data, from, to);
  const months = data.months.slice(from, to + 1);
  const closed = closedInRange(data, from, to);
  // The months any figure here compares with budget: the closed ones of the
  // range (see closedSpan). The category cards from the server cover the
  // closed months of the whole period, whatever range is selected, so they
  // carry their own caption.
  const span = closedSpan(data, from, to);
  const periodSpan = closedSpan(data, 0, data.months.length - 1);
  if (!T) return null;

  const healthy = T.netProfit > 0 && (T.grossMargin === null || T.grossMargin > 0);
  const cash = data.cash?.available ? data.cash.total : null;
  const g = rangeGrowth(data, from, to);
  // The same months last year, when the report carries them (this tab asks
  // for them). Closed months only, so it sits under the tiles as its own line
  // rather than claiming to compare the whole figure above it.
  const py = priorYearRange(data, from, to);
  const pyLine = (what, key) => (py?.available
    ? <PriorYearLine what={what} c={py[key]} range={py} currency={cur} />
    : null);

  const serviceItems = data.serviceLines
    .filter(l => !l.otherIncome)
    .map(l => ({ label: l.label, value: sliceSum(l.actual, from, to), tag: l.recurring ? 'recurring' : null,
                 nil: nothingBooked([l], from, to) }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  // Which headline figures had nothing booked or budgeted in the range. A
  // figure worked out from others (gross and net profit) is nil only when all
  // of them are, so a profit of exactly 0 from real trading still shows as 0.
  const t = data.totals;
  const none = (...parts) => nothingBooked(parts, from, to);
  const nil = {
    revenue:     none(t.revenue),
    recurring:   none(data.split?.recurring),
    project:     none(data.split?.project),
    cogs:        none(t.cogs),
    grossProfit: none(t.revenue, t.cogs, t.grossProfit),
    otherIncome: none(t.otherIncome),
    opex:        none(t.opex),
    netProfit:   none(t.revenue, t.otherIncome, t.cogs, t.opex, t.netProfit),
  };

  // Debtor days are the server's figure — the same one the Cash Flow tab and
  // its alerts show — measured over the period's closed months with tax treated
  // alike on both sides. This panel used to work out a second one of its own,
  // dividing receivables that include tax by P&L revenue that does not, over
  // every month of the range including ones not yet begun.
  const pd = data.paymentDays || null;
  const dso = pd && Number.isFinite(pd.dso) ? pd.dso : null;
  const receivables = summary?.kpis?.totalReceivables ?? null;
  // Customers only. The summary's overdue figure used to add bills you owe to
  // invoices you are owed, which is no note for a measure of collections.
  const overdueIn = summary?.kpis?.overdueReceivables ?? null;
  const closedNote = pd?.closedMonths ? `${pd.closedMonths} closed month${pd.closedMonths === 1 ? '' : 's'}` : '';

  const scorecard = [
    { label: 'Recurring mix', target: 'Higher is steadier',
      value: T.recurringMix === null ? '—' : fmtPct(T.recurringMix, 0),
      note: T.recurringMix === null ? 'No revenue yet' : `${fmtMoney(T.recurring, cur)} recurring` },
    // Closed months only, as the Budget tab's year to date (see closedAttainment).
    { label: 'Budget attainment', target: 'Target 100%',
      value: T.attainment === null ? '—' : fmtPct(T.attainment, 0),
      tone: T.attainment === null ? undefined : T.attainment < 1 ? 'var(--danger)' : 'var(--success)',
      note: T.attainment !== null
        ? `${fmtMoney(T.attainmentActual, cur)} vs ${fmtMoney(T.attainmentBudget, cur)} to ${T.attainmentThrough}`
        : noAttainmentText(T.attainmentMonths, data) },
    { label: 'Expense ratio', target: 'Lower is better',
      value: T.revenue > 0 ? fmtPct((T.cogs + T.opex) / T.revenue, 0) : '—',
      note: T.revenue > 0 ? `${fmtMoney(T.cogs + T.opex, cur)} of costs` : 'No revenue yet' },
    { label: 'Debtor days', target: 'Lower is better',
      value: dso === null ? '—' : `${Math.round(dso)} days`,
      tone: dso !== null && dso > 60 ? 'var(--warning)' : undefined,
      note: !pd ? 'Needs invoice data'
            : !pd.available ? (pd.reason === 'no-closed-month' ? 'No closed month yet' : 'Not available right now')
            : dso === null ? 'Nothing invoiced in the closed months'
            : overdueIn > 0 ? `${closedNote} · ${fmtMoney(overdueIn, cur)} overdue`
            : receivables !== null ? `${closedNote} · ${fmtMoney(receivables, cur)} outstanding`
            : closedNote },
    // Level without direction makes the reader do the differencing themselves.
    { label: 'Revenue growth', target: 'Month on month',
      value: g.mom === null ? '—' : `${g.mom >= 0 ? '+' : ''}${fmtPct(g.mom, 1)}`,
      tone: g.mom === null ? undefined : g.mom >= 0 ? 'var(--success)' : 'var(--danger)',
      note: growthNote(g) },
  ];

  // Closed months only, the Budget tab's basis. Over the whole range this
  // listed next month's budgeted wages as a saving.
  const varianceItems = closedVarianceItems([...data.serviceLines, ...data.expenseLines], span);
  const categories = insights?.categories?.length && periodSpan.months > 0 ? insights.categories.slice(0, 3) : [];

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

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: py ? 8 : 16 }}>
        {/* The figure is everything booked in the range, the month in progress
            included; the budget beside it is the closed months'. The foot says
            so, because the two side by side otherwise read as one comparison. */}
        <Metric label="Total revenue" value={fmtMoney(T.revenue, cur)}
                meter={T.attainment === null ? null : T.attainment * 100}
                footLeft={T.openMonthLabel ? `incl. ${T.openMonthLabel} so far`
                        : T.recurringMix === null ? 'No revenue yet' : `${fmtPct(T.recurringMix, 0)} recurring`}
                footRight={T.attainment !== null ? `${fmtPct(T.attainment, 0)} of budget to ${T.attainmentThrough}`
                         : noAttainmentText(T.closedMonths, data)}
                compare={pyLine('', 'revenue')} />
        <Metric label="Gross margin" value={T.grossMargin === null ? '—' : fmtPct(T.grossMargin)}
                meter={T.grossMargin === null ? null : T.grossMargin * 100}
                footLeft={`${fmtMoney(T.grossProfit, cur)} gross profit`}
                footRight={T.cogs === 0 ? 'No cost of sales booked' : `${fmtMoney(T.cogs, cur)} cost of sales`}
                compare={pyLine('Gross profit', 'grossProfit')} />
        <Metric label="Net margin" value={T.netMargin === null ? '—' : fmtPct(T.netMargin)}
                meter={T.netMargin === null ? null : T.netMargin * 100}
                tone={T.netProfit < 0 ? 'var(--danger)' : undefined}
                footLeft={`${fmtMoney(T.netProfit, cur)} net`}
                footRight={`${fmtMoney(T.opex, cur)} operating costs`}
                compare={pyLine('Net profit', 'netProfit')} />
        <Metric label="Cash at bank" value={cash === null ? '—' : fmtMoney(cash, cur)}
                meter={null}
                footLeft={cash === null ? 'Bank summary unavailable' : `${data.cash.accounts.length} account${data.cash.accounts.length === 1 ? '' : 's'}`}
                footRight={cash === null ? '' : 'Closing balance'} />
      </div>
      {/* Which months the tiles' comparison covers. The tiles' own figures
          include the month in progress; the comparison never does. */}
      {py && (
        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 16 }}>
          {py.available
            ? <>Compared with the same months last year: {comparedText(py)}, closed months only
                {py.recordsFromLabel && ` — nothing was recorded in Xero before ${py.recordsFromLabel}`}.</>
            : <>No comparison with last year: {priorYearReason(py.reason)}.</>}
        </div>
      )}

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <Surface title="Revenue by service line" right={T.recurringMix === null ? null : `${fmtPct(T.recurringMix, 0)} recurring`} flex={7} minWidth={380}>
          <BookedBars items={serviceItems} currency={cur} showPctOfTotal />
          <div style={{ marginTop: 12, padding: '8px 10px', borderRadius: 8, background: 'var(--bg-secondary)',
                        fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.55 }}>
            <strong style={{ color: 'var(--warning)' }}>Inferred, not reported.</strong>{' '}
            Xero has no "this account is recurring" flag, so this split is guessed from account names,
            except where you have set an account's type on the Revenue tab.
            {data.recurringAccounts.length > 0
              ? ` Treated as recurring: ${data.recurringAccounts.join(', ')}.`
              : ' No account name matched, so everything counts as project revenue.'}
            {' '}Setting up Repeating Invoices in Xero would make this a reported figure instead of a guess.
          </div>
        </Surface>
        <Surface title="Executive snapshot" right={rangeLabel(data.months, from, to)} flex={5} minWidth={300}>
          <BookedRows currency={cur} items={[
            { label: 'Total revenue',     value: T.revenue, strong: true, nil: nil.revenue },
            { label: 'Recurring revenue', value: T.recurring, nil: nil.recurring },
            { label: 'Project revenue',   value: T.project, nil: nil.project },
            { label: 'Cost of sales',     value: T.cogs, nil: nil.cogs },
            { label: 'Gross profit',      value: T.grossProfit, strong: true, nil: nil.grossProfit },
            { label: 'Other income',      value: T.otherIncome, nil: nil.otherIncome },
            { label: 'Operating expenses', value: T.opex, nil: nil.opex },
            { label: 'Net profit',        value: T.netProfit, strong: true, nil: nil.netProfit },
          ]} />
        </Surface>
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <Surface title="Margin bridge" flex={6} minWidth={340}>
          <BookedBars currency={cur} items={[
            { label: 'Revenue',            value: T.revenue,     color: 'var(--accent)',     nil: nil.revenue },
            { label: 'Cost of sales',      value: T.cogs,        color: 'var(--text-muted)', nil: nil.cogs },
            { label: 'Operating expenses', value: T.opex,        color: '#b8860b',           nil: nil.opex },
            { label: 'Net profit',         value: T.netProfit,   color: T.netProfit < 0 ? 'var(--danger)' : 'var(--success)', nil: nil.netProfit },
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
                {g.momLabel && <span> · {growthNote(g)}</span>}
              </div>
              {/* Month against the same month a year before when the range
                  holds thirteen closed months; otherwise the closed months
                  against the same months last year, when the report has them. */}
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                Year on year{' '}
                {g.yoyLabel || !py ? (
                  <>
                    <GrowthPill value={g.yoy} title={g.yoyLabel ? `${g.latestLabel} vs ${g.yoyLabel}` : 'Needs 13 months of history'} />
                    {g.yoyLabel ? <span> · {g.latestLabel} vs {g.yoyLabel}</span> : <span> · needs a full prior year</span>}
                  </>
                ) : py.available ? (
                  <>
                    <strong style={{ fontVariantNumeric: 'tabular-nums',
                                     color: py.revenue.change > 0 ? 'var(--success)' : py.revenue.change < 0 ? 'var(--danger)' : undefined }}>
                      {changeText(py.revenue, cur)}
                    </strong>
                    <span> · {comparedText(py)}</span>
                  </>
                ) : <span>— · {priorYearReason(py.reason)}</span>}
              </div>
            </div>
          )}
        </Surface>
        <Surface
          title="Variance Reasons"
          right={categories.length ? <span style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700 }}>Executive Scorecard</span> : 'Actual − budget'}
          flex={5}
          minWidth={320}
        >
          {/* Which months are compared. The cards are the server's, over the
              period's closed months; the list below them is the range's. */}
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
            {closedCaption(categories.length ? periodSpan : span)}
          </div>
          {categories.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {categories.map(cat => {
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
              {span.months === 0
                ? <Empty>Budget comparisons start when a month closes.</Empty>
                : varianceItems.length === 0
                  ? <Empty>Nothing differs from budget in the closed months.</Empty>
                  : <Rows currency={cur} items={varianceItems.map(l => ({ label: l.label, value: l.v }))} />}
              {onOpenAnalysis && span.months > 0 && (
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
