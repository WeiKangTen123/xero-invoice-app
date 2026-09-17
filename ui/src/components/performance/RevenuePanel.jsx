import { useState } from 'react';
import { fmtMoney, fmtMoneyShort, fmtPct } from '../../utils/format';
import { BarList, GroupedMonthlyBars, MonthlyBars } from './charts';
import { CurrencyNote, Empty, Legend, Metric, Rows, Surface, rangeLabel, slice, sliceSum, sum, useRangeTotals } from './primitives';

// ── Revenue ──────────────────────────────────────────────────────────────────
export function RevenuePanel({ data, from, to, selectedLine, onSelectLine }) {
  const [view, setView] = useState('actual');   // 'actual' | 'budget' — Xero has no forecast
  const cur = data.organisation?.currency || '';
  const T   = useRangeTotals(data, from, to);
  const months = data.months.slice(from, to + 1);
  if (!T) return null;

  const lines = data.serviceLines.filter(l => !l.otherIncome);
  const active = selectedLine === 'overall' ? null : lines.find(l => l.label === selectedLine);
  const actual = active ? slice(active.actual, from, to) : slice(data.totals.revenue.actual, from, to);
  const budget = active ? slice(active.budget, from, to) : slice(data.totals.revenue.budget, from, to);
  const total  = sum(actual);
  const totalB = sum(budget);

  // A netted "vs budget" is close to useless on a revenue tab: this org's
  // implementation revenue is 75,000 UNDER budget while maintenance is 75,000
  // OVER, so the total reads 0 and the card claims "on budget" while the mix has
  // changed completely. Report the biggest single mover instead.
  const lineVariances = lines
    .map(l => ({ label: l.label, v: sliceSum(l.actual, from, to) - sliceSum(l.budget, from, to) }))
    .filter(l => l.v !== 0)
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  const biggest = lineVariances[0] || null;
  const offsetting = lineVariances.length > 1 && Math.abs(total - totalB) < Math.abs(biggest?.v ?? 0);

  // Annualised run-rate from the recurring lines. Derived, not a Xero figure —
  // labelled as such, and meaningless with no closed months to annualise from.
  const monthsInPeriod = Math.max(1, to - from + 1);
  const runRate = T.recurring !== 0 ? (T.recurring / monthsInPeriod) * 12 : null;

  const waterfall = [
    ...lines.map(l => ({ label: l.label, value: sliceSum(l.actual, from, to), tag: l.recurring ? 'recurring' : null })),
    ...data.serviceLines.filter(l => l.otherIncome)
      .map(l => ({ label: l.label, value: sliceSum(l.actual, from, to), tag: 'other income' })),
  ].filter(i => i.value !== 0);

  return (
    <>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {[{ label: 'Overall revenue', key: 'overall' }, ...lines.map(l => ({ label: l.label, key: l.label }))].map(o => (
          <button key={o.key} type="button" onClick={() => onSelectLine(o.key)} style={{
            padding: '5px 11px', fontSize: 11.5, fontWeight: 600, borderRadius: 7, cursor: 'pointer',
            border: `1px solid ${selectedLine === o.key ? 'transparent' : 'var(--border)'}`,
            background: selectedLine === o.key ? 'var(--accent-gradient)' : 'transparent',
            color: selectedLine === o.key ? '#fff' : 'var(--text-muted)',
          }}>{o.label}</button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <Metric label={active ? active.label : 'Total revenue'} value={fmtMoney(total, cur)}
                meter={totalB > 0 ? (total / totalB) * 100 : null}
                footLeft={rangeLabel(data.months, from, to)}
                footRight={totalB > 0 ? `${fmtPct(total / totalB, 0)} of budget` : 'No budget set'} />
        <Metric label="Recurring revenue" value={fmtMoney(T.recurring, cur)}
                meter={T.recurringMix === null ? null : T.recurringMix * 100}
                footLeft={T.recurringMix === null ? 'No revenue yet' : `${fmtPct(T.recurringMix, 0)} of revenue`}
                footRight="Name-inferred" />
        <Metric label="Recurring run-rate" value={runRate === null ? '—' : fmtMoney(runRate, cur)}
                meter={null}
                footLeft={runRate === null ? 'No recurring revenue' : `${fmtMoney(T.recurring, cur)} over ${monthsInPeriod}mo`}
                footRight="Annualised · derived" />
        <Metric label="Largest variance"
                value={biggest ? `${biggest.v > 0 ? '+' : ''}${fmtMoney(biggest.v, cur)}` : '—'}
                meter={null}
                tone={!biggest ? undefined : biggest.v > 0 ? 'var(--success)' : 'var(--danger)'}
                footLeft={biggest ? biggest.label : 'Nothing differs from budget'}
                footRight={offsetting ? 'offsetting movements' : (totalB === 0 ? 'Nothing budgeted' : `net ${fmtMoney(total - totalB, cur)}`)} />
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <Surface flex={7} minWidth={380}
                 title={active ? `${active.label} — monthly`
                               : (view === 'budget' ? 'Revenue — actual vs budget' : 'Recurring vs project revenue')}
                 right={!active && (
                   <div style={{ display: 'flex', gap: 2, background: 'var(--bg-secondary)', borderRadius: 7, padding: 2 }}>
                     {[{ k: 'actual', l: 'Actual' }, { k: 'budget', l: 'vs Budget' }].map(o => (
                       <button key={o.k} type="button" onClick={() => setView(o.k)} style={{
                         padding: '3px 10px', fontSize: 11, fontWeight: 600, borderRadius: 5, cursor: 'pointer', border: 'none',
                         background: view === o.k ? 'var(--accent-gradient)' : 'transparent',
                         color: view === o.k ? '#fff' : 'var(--text-muted)',
                       }}>{o.l}</button>
                     ))}
                   </div>
                 )}>
          {active ? (
            <>
              <MonthlyBars months={months} actual={actual} budget={budget} currency={cur} />
              <Legend items={[{ label: 'Actual', color: 'var(--accent)' }, { label: 'Budget', color: 'var(--text-muted)', opacity: 0.32 }]} />
            </>
          ) : (
            <>
              <GroupedMonthlyBars months={months} currency={cur} series={
                view === 'budget'
                  ? [{ label: 'Actual', color: 'var(--accent)',      values: slice(data.totals.revenue.actual, from, to) },
                     { label: 'Budget', color: 'var(--text-muted)',  values: slice(data.totals.revenue.budget, from, to) }]
                  : [{ label: 'Recurring', color: 'var(--accent)',   values: slice(data.split.recurring.actual, from, to) },
                     { label: 'Project',   color: 'var(--success)',  values: slice(data.split.project.actual, from, to) }]
              } />
              <Legend items={view === 'budget'
                ? [{ label: 'Actual', color: 'var(--accent)' }, { label: 'Budget', color: 'var(--text-muted)' }]
                : [{ label: 'Recurring', color: 'var(--accent)' }, { label: 'Project', color: 'var(--success)' }]} />
            </>
          )}
        </Surface>
        <Surface title="Revenue waterfall" right={fmtMoneyShort(T.revenue + T.otherIncome, cur)} flex={5} minWidth={300}>
          <BarList items={waterfall} currency={cur} showPctOfTotal />
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 12, paddingTop: 10 }}>
            <Rows currency={cur} items={[{ label: 'Total income', value: T.revenue + T.otherIncome, strong: true }]} />
          </div>
        </Surface>
      </div>

      {data.quotePipeline?.available && data.quotePipeline.total > 0 && (
        <Surface title="Quoted, not yet invoiced" right="sales pipeline">
          <BarList currency={cur} items={[
            { label: `Accepted (${data.quotePipeline.counts.accepted})`, value: data.quotePipeline.accepted, color: 'var(--success)' },
            { label: `Sent, awaiting decision (${data.quotePipeline.counts.sent})`, value: data.quotePipeline.sent, color: 'var(--accent)' },
          ].filter(i => i.value !== 0)} />
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.5 }}>
            Work quoted in Xero that has not become an invoice, so it appears in no revenue or cash figure
            on this dashboard. Quotes already marked INVOICED are excluded — they would double-count.
          </div>
        </Surface>
      )}

      {data.customerRevenue?.available && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 16, marginBottom: 16 }}>
          <Surface title="Top customers" right={`${data.customerRevenue.count} invoiced`} flex={7} minWidth={380}>
            {data.customerRevenue.customers.length === 0
              ? <Empty>No sales invoices in this period.</Empty>
              : <BarList currency={cur} showPctOfTotal
                         items={data.customerRevenue.customers.slice(0, 8)
                           .map(c => ({ label: c.name, value: c.invoiced,
                                        tag: c.invoices > 1 ? `${c.invoices} invoices` : null }))} />}
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.5 }}>
              Invoice totals from Xero, which include tax — so this will not tie exactly to the
              net revenue figures above unless your sales accounts are zero-rated.
            </div>
            <CurrencyNote currency={data.customerRevenue.currency} style={{ marginTop: 6 }} />
          </Surface>
          <Surface title="Per customer" right={rangeLabel(data.months, from, to)} flex={5} minWidth={280}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Average invoiced</div>
                <div style={{ fontSize: 21, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                  {data.customerRevenue.average === null ? '—' : fmtMoney(data.customerRevenue.average, cur)}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                  across {data.customerRevenue.count} customer{data.customerRevenue.count === 1 ? '' : 's'}
                </div>
              </div>
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Largest customer share</div>
                <div style={{ fontSize: 21, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                  {data.customerRevenue.total > 0
                    ? fmtPct(data.customerRevenue.customers[0].invoiced / data.customerRevenue.total, 0)
                    : '—'}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                  {data.customerRevenue.customers[0]?.name || 'no customers'} · concentration risk
                </div>
              </div>
            </div>
          </Surface>
        </div>
      )}

      <Surface title="Service lines — actual vs budget" right={rangeLabel(data.months, from, to)}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Service line', 'Type', 'Actual', 'Budget', 'Variance', '% of revenue'].map((h, i) => (
                  <th key={h} style={{ padding: '8px 10px', textAlign: i < 2 ? 'left' : 'right', fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.map(l => {
                const a = sliceSum(l.actual, from, to), b = sliceSum(l.budget, from, to), v = a - b;
                return (
                  <tr key={l.label} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 10px' }}>{l.label}</td>
                    <td style={{ padding: '8px 10px', color: 'var(--text-muted)', fontSize: 11.5 }}>{l.recurring ? 'Recurring' : 'Project'}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: a < 0 ? 'var(--danger)' : undefined }}>{fmtMoney(a, cur)}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{fmtMoney(b, cur)}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: v === 0 ? undefined : v > 0 ? 'var(--success)' : 'var(--danger)' }}>
                      {v === 0 ? <span style={{ color: 'var(--text-muted)' }}>-</span> : `${v > 0 ? '+' : ''}${fmtMoney(v, cur)}`}
                    </td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>
                      {T.revenue === 0 ? '—' : fmtPct(a / T.revenue, 0)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Surface>
    </>
  );
}
