import { fmtMoney, fmtVariancePct, isNilAmount } from '../../utils/format';
import { BudgetExport } from './BudgetExport';
import { VarianceTable } from './VarianceTable';
import { BudgetMissingNote, SourceNote, dayLabel, lastLoaded, toDateText } from './bits';

// A stale selection (tenant switched mid-render, say) must not index past the
// array, so it falls back to the first month rather than crash.
function monthIndex(d, key) {
  const found = d.months.findIndex(m => m.key === key);
  return found >= 0 ? found : 0;
}

// How the selected figures are titled. A month still in progress says "so
// far" and when it was read; it used to say "For the month ended Oct 2026"
// six days into October.
function subtitleFor(d, varianceMonth) {
  if (!d) return '';
  if (varianceMonth === 'ytd' || !d.months?.length) return toDateText(d);
  const m  = d.months[monthIndex(d, varianceMonth)];
  const cm = d.kpis?.currentMonth;
  if (cm && cm.key === m.key) return `${m.label} so far — booked in Xero as of ${dayLabel(cm.asOf)}`;
  return `For the month ended ${m.label}`;
}

// The to-date group shown beside a month, as Xero's Budget Variance report
// shows it: from the period's first month through the chosen one. Over a year
// that is the year to date; over a quarter or a custom range "YTD" would be
// wrong, so the months are named instead.
function cumulativeLabel(d, idx) {
  const m    = d.months[idx];
  const tail = m.current ? ' so far' : '';
  if (d.period?.toDateLabel === 'Year to date') return `YTD to ${m.label}${tail}`;
  // The period's first month alone is not a range: "Jul 2026 – Jul 2026".
  return d.months[0].key === m.key ? `${m.label}${tail}` : `${d.months[0].label} – ${m.label}${tail}`;
}

export default function VarianceTab({ isMobile, monthsRef, monthEdges, budget, varianceMonth, setVarianceMonth, fetchBudget, currency, exportQuery }) {
  return (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div className="card-title" style={{ marginBottom: 2 }}>Budget Variance</div>
              <div className="card-subtitle" style={{ marginBottom: 2 }}>
                {lastLoaded(subtitleFor(budget.data, varianceMonth), !!budget.error && !!budget.data)}
              </div>
              <SourceNote>Xero Profit &amp; Loss (actuals) vs Budget Summary — variance computed per Xero&apos;s formula</SourceNote>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <BudgetExport kind="variance" month={varianceMonth} query={exportQuery} disabled={budget.status !== 'done' || !!budget.error} />
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
            const ytd = varianceMonth === 'ytd' || !d.months.length;
            const idx = ytd ? -1 : monthIndex(d, varianceMonth);
            const m   = ytd ? null : d.months[idx];

            // A payload from before the server sent running totals shows the
            // month alone rather than a to-date group of blanks.
            const hasCumulative = d.rows.some(r => Array.isArray(r.cumulative));
            const yearly        = d.period?.toDateLabel === 'Year to date';

            // Either the to-date rollup the backend computed over the completed
            // months, or one month's own figures beside the running total from
            // the period's start through it, which is how Xero lays out its
            // Budget Variance report for a month.
            const periods = ytd
              ? [{ label: toDateText(d), of: r => ({ actual: r.actualToDate, budget: r.budgetToDate, variance: r.variance, variancePct: r.variancePct }) }]
              : [
                  { label: m.current ? `${m.label} so far` : m.label, short: m.current ? `${m.label} so far` : m.label, of: r => r.monthly?.[idx] },
                  ...(hasCumulative ? [{ label: cumulativeLabel(d, idx), short: yearly ? 'YTD' : 'To date', of: r => r.cumulative?.[idx] }] : []),
                ];

            const net = d.rows.find(r => r.kind === 'summary' && /^net (profit|loss)/i.test(r.label));
            const nv  = net ? periods[0].of(net) : null;
            // Net profit is a profit line, so above budget is the favourable side.
            const netTone = nv && !isNilAmount(nv.variance) ? (nv.variance > 0 ? 'var(--success)' : 'var(--danger)') : undefined;

            return (
              <>
                {d.budgetMissing && <BudgetMissingNote />}
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
                  {d.months.map(mo => (
                    <button key={mo.key} type="button" onClick={() => setVarianceMonth(mo.key)}
                      title={mo.current ? 'In progress: actuals booked so far' : undefined} style={{
                      padding: '5px 10px', fontSize: 11.5, fontWeight: 600, borderRadius: 7, cursor: 'pointer',
                      flexShrink: 0, whiteSpace: 'nowrap',
                      border: `1px solid ${varianceMonth === mo.key ? 'transparent' : mo.current ? 'var(--warning)' : 'var(--border)'}`,
                      background: varianceMonth === mo.key ? 'var(--accent-gradient)' : 'transparent',
                      color: varianceMonth === mo.key ? '#fff' : mo.current ? 'var(--warning)' : (mo.source === 'actual' ? 'var(--text-secondary)' : 'var(--text-muted)'),
                    }}>{mo.label}{mo.current ? ' · so far' : ''}</button>
                  ))}
                  <button type="button" onClick={() => setVarianceMonth('ytd')} style={{
                    padding: '5px 10px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, cursor: 'pointer',
                    flexShrink: 0, whiteSpace: 'nowrap',
                    border: `1px solid ${varianceMonth === 'ytd' ? 'transparent' : 'var(--border)'}`,
                    background: varianceMonth === 'ytd' ? 'var(--accent-gradient)' : 'transparent',
                    color: varianceMonth === 'ytd' ? '#fff' : 'var(--text-muted)',
                  }}>{toDateText(d, { count: false })}</button>
                </div>
                </div>

                {nv && (
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '16px 0 2px' }}>
                    {[
                      { label: 'Net profit actual', value: fmtMoney(nv.actual, cur), color: undefined },
                      { label: 'Net profit budget', value: fmtMoney(nv.budget, cur), color: undefined },
                      { label: 'Variance', value: `${nv.variance > 0 ? '+' : ''}${fmtMoney(nv.variance, cur)}`, color: netTone },
                      { label: 'Variance %', value: fmtVariancePct(nv.variance, nv.variancePct), color: netTone },
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
                  Variance is actual minus budget. As in Xero, green is favourable and red unfavourable: income or
                  profit above budget is green, a cost above budget is red, so a cost under budget reads negative and
                  green. The percentage divides the variance by the absolute budget, so a negative budget still reads
                  with Xero&apos;s sign. An on-budget line and a line with no budget both show &ldquo;-&rdquo; rather
                  than 0.00%. A month is shown beside the running total from the start of the period through it, as in
                  Xero&apos;s report. The month in progress is compared using the actuals booked in it so far, as in
                  Xero&apos;s own report and the amber &ldquo;so far&rdquo; column of the Budget vs Actual grid
                  &mdash; so it can look far ahead of budget simply because its costs haven&apos;t been entered yet.
                </div>
              </>
            );
          })()}
        </div>
  );
}
