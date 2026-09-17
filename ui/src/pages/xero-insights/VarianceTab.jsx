import { fmtMoney } from '../../utils/format';
import { BudgetExport } from './BudgetExport';
import { VarianceTable } from './VarianceTable';
import { SourceNote } from './bits';

export default function VarianceTab({ isMobile, monthsRef, monthEdges, budget, varianceMonth, setVarianceMonth, fetchBudget, currency }) {
  return (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div className="card-title" style={{ marginBottom: 2 }}>Budget Variance</div>
              <div className="card-subtitle" style={{ marginBottom: 2 }}>
                {varianceMonth === 'ytd'
                  ? `Year to date — ${budget.data?.kpis?.monthsElapsed ?? 0} completed month(s)`
                  : `For the month ended ${budget.data?.months?.find(m => m.key === varianceMonth)?.label || '—'}`}
              </div>
              <SourceNote>Xero Profit &amp; Loss (actuals) vs Budget Summary — variance computed per Xero&apos;s formula</SourceNote>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <BudgetExport kind="variance" month={varianceMonth} disabled={budget.status !== 'done' || !!budget.error} />
              <button className="btn btn-outline btn-sm" disabled={budget.status === 'loading'} onClick={() => fetchBudget({ force: true })}>
                {budget.status === 'loading' ? <span className="btn-spinner" /> : '↻'} Refresh
              </button>
            </div>
          </div>

          {budget.status === 'loading' && <div style={{ padding: 28, color: 'var(--text-muted)', fontSize: 13 }}>Loading variance report...</div>}
          {budget.error && <div className="alert alert-error" style={{ marginTop: 14 }}><span className="alert-icon">✕</span>{budget.error}</div>}

          {budget.status === 'done' && !budget.error && budget.data && (() => {
            const d   = budget.data;
            const cur = d.organisation?.currency || currency;
            // A stale selection (tenant switched mid-render, say) must not index
            // past the array — fall back to the first month rather than crash.
            const found = d.months.findIndex(m => m.key === varianceMonth);
            const idx   = found >= 0 ? found : 0;

            // Either one month's own figures, or the year-to-date rollup the
            // backend already computed over the completed months.
            const periods = varianceMonth === 'ytd'
              ? [{ label: 'Year to date', of: r => ({ actual: r.actualToDate, budget: r.budgetToDate, variance: r.variance, variancePct: r.variancePct }) }]
              : [{ label: d.months[idx].label, of: r => r.monthly[idx] }];

            const net = d.rows.find(r => r.kind === 'summary' && /^net (profit|loss)/i.test(r.label));
            const nv  = net ? periods[0].of(net) : null;

            return (
              <>
                <div style={{ position: 'relative', margin: '14px 0 4px' }}>
                  {isMobile && monthEdges.start && (
                    <div aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 28, zIndex: 1,
                      pointerEvents: 'none', background: 'linear-gradient(to left, transparent, var(--bg-card))' }} />
                  )}
                  {isMobile && monthEdges.end && (
                    <div aria-hidden="true" style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 28, zIndex: 1,
                      pointerEvents: 'none', background: 'linear-gradient(to right, transparent, var(--bg-card))' }} />
                  )}
                <div
                  ref={monthsRef}
                  className={isMobile ? 'mobile-scroll-x' : undefined}
                  style={{ display: 'flex', gap: 6, flexWrap: isMobile ? 'nowrap' : 'wrap' }}
                >
                  {d.months.map(m => (
                    <button key={m.key} type="button" onClick={() => setVarianceMonth(m.key)} style={{
                      padding: '5px 10px', fontSize: 11.5, fontWeight: 600, borderRadius: 7, cursor: 'pointer',
                      flexShrink: 0, whiteSpace: 'nowrap',
                      border: `1px solid ${varianceMonth === m.key ? 'transparent' : 'var(--border)'}`,
                      background: varianceMonth === m.key ? 'var(--accent-gradient)' : 'transparent',
                      color: varianceMonth === m.key ? '#fff' : (m.source === 'actual' ? 'var(--text-secondary)' : 'var(--text-muted)'),
                    }}>{m.label}</button>
                  ))}
                  <button type="button" onClick={() => setVarianceMonth('ytd')} style={{
                    padding: '5px 10px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, cursor: 'pointer',
                    flexShrink: 0, whiteSpace: 'nowrap',
                    border: `1px solid ${varianceMonth === 'ytd' ? 'transparent' : 'var(--border)'}`,
                    background: varianceMonth === 'ytd' ? 'var(--accent-gradient)' : 'transparent',
                    color: varianceMonth === 'ytd' ? '#fff' : 'var(--text-muted)',
                  }}>Year to date</button>
                </div>
                </div>

                {nv && (
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '16px 0 2px' }}>
                    {[
                      { label: 'Net profit actual', value: fmtMoney(nv.actual, cur), color: undefined },
                      { label: 'Net profit budget', value: fmtMoney(nv.budget, cur), color: undefined },
                      { label: 'Variance', value: `${nv.variance > 0 ? '+' : ''}${fmtMoney(nv.variance, cur)}`,
                        color: nv.variance === 0 ? undefined : nv.variance > 0 ? 'var(--success)' : 'var(--danger)' },
                      { label: 'Variance %', value: nv.variance === 0 || nv.variancePct === null ? '—' : `${(nv.variancePct * 100).toFixed(2)}%`,
                        color: nv.variance === 0 ? undefined : nv.variance > 0 ? 'var(--success)' : 'var(--danger)' },
                    ].map(t => (
                      <div key={t.label} className="card figure-tile" style={{ flex: 1, minWidth: 165, background: 'var(--bg-secondary)' }}>
                        <div className="figure-label" style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4 }}>{t.label}</div>
                        <div className="figure-value" style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: t.color }}>{t.value}</div>
                      </div>
                    ))}
                  </div>
                )}

                <VarianceTable rows={d.rows} periods={periods} currency={cur} />

                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 14, lineHeight: 1.6 }}>
                  Variance is actual minus budget; the percentage divides that by the absolute budget, so a negative
                  budget still reads with Xero&apos;s sign. An on-budget line and a line with no budget both show
                  &ldquo;-&rdquo; rather than 0.00%. Unlike the monthly grid, this view compares the current month using
                  the actuals booked so far &mdash; so a part-elapsed month can look far ahead of budget simply because
                  its costs haven&apos;t been entered yet.
                </div>
              </>
            );
          })()}
        </div>
  );
}
