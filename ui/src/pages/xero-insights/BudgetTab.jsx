import { fmtMoney } from '../../utils/format';
import { BudgetExport } from './BudgetExport';
import { BudgetGrid } from './BudgetGrid';
import { SourceNote, dayLabel, isFullYear, lastLoaded } from './bits';

export default function BudgetTab({ budget, fetchBudget, currency, exportQuery }) {
  return (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div className="card-title" style={{ marginBottom: 2 }}>Budget vs Actual</div>
              <div className="card-subtitle" style={{ marginBottom: 2 }}>
                {lastLoaded(budget.data?.fiscalYear?.label, !!budget.error) || 'Current financial year by month'}
              </div>
              <SourceNote>Xero Profit &amp; Loss (actuals) + Budget Summary — Overall Budget</SourceNote>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <BudgetExport kind="grid" query={exportQuery} disabled={budget.status !== 'done' || !!budget.error} />
              <button className="btn btn-outline btn-sm" disabled={budget.status === 'loading'} onClick={() => fetchBudget({ force: true })}>
                {budget.status === 'loading' ? <span className="btn-spinner" /> : '↻'} Refresh
              </button>
            </div>
          </div>

          {budget.status === 'loading' && <div style={{ padding: 28, color: 'var(--text-muted)', fontSize: 13 }}>Loading budget report...</div>}

          {budget.error && (
            <div className="alert alert-error" style={{ marginTop: 14 }}><span className="alert-icon">✕</span>{budget.error}</div>
          )}

          {budget.status === 'done' && !budget.error && budget.data && (() => {
            const d   = budget.data;
            const cur = d.organisation?.currency || currency;
            const k   = d.kpis;
            const cm  = k.currentMonth;
            // The forecast is the total over the selected period. Called a
            // full-year forecast whatever the period, a quarter's total read as
            // the whole year's.
            const fullYear = isFullYear(d.period);
            const tiles = [
              { label: `Actual to date (${k.monthsElapsed}mo)`, value: k.ytdActualNet, hint: 'Net profit, completed months' },
              { label: `Budget remaining (${k.monthsTotal - k.monthsElapsed}mo)`, value: k.restOfYearNet, hint: 'Net profit still budgeted' },
              { label: fullYear ? 'Full-year forecast' : 'Period forecast', value: k.forecastNet,
                hint: fullYear ? 'Actual to date + budget ahead' : 'Actual to date + budget to the end of the period' },
            ];
            return (
              <>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '18px 0 4px' }}>
                  {tiles.map(t => (
                    <div key={t.label} className="card figure-tile" style={{ flex: 1, minWidth: 180, background: 'var(--bg-secondary)' }}>
                      <div className="figure-label" style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4 }}>{t.label}</div>
                      <div className="figure-value" style={{ fontSize: 21, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: t.value < 0 ? 'var(--danger)' : 'var(--success)' }}>
                        {fmtMoney(t.value, cur)}
                      </div>
                      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>{t.hint}</div>
                    </div>
                  ))}
                  {/* The month in progress, live: what is booked so far against
                      its whole-month budget. Matches the amber column in the grid
                      and, like it, is not part of the forecast. */}
                  {cm && (
                    <div className="card figure-tile" style={{ flex: 1, minWidth: 180, background: 'var(--warning-subtle)', borderColor: 'var(--warning)' }}>
                      <div className="figure-label" style={{ fontSize: 11.5, color: 'var(--warning)', fontWeight: 700, marginBottom: 4 }}>{cm.label} so far</div>
                      <div className="figure-value" style={{ fontSize: 21, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: cm.actualNet < 0 ? 'var(--danger)' : 'var(--success)' }}>
                        {fmtMoney(cm.actualNet, cur)}
                      </div>
                      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>
                        Net profit booked, of {fmtMoney(cm.budgetNet, cur)} budgeted · as of {dayLabel(cm.asOf)}
                      </div>
                    </div>
                  )}
                  <div className="card figure-tile" style={{ flex: 1, minWidth: 180, background: 'var(--bg-secondary)' }}>
                    <div className="figure-label" style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4 }}>Progress</div>
                    <div className="figure-value" style={{ fontSize: 21, fontWeight: 800 }}>{k.monthsElapsed} <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)' }}>of {k.monthsTotal} months</span></div>
                    <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>
                      {d.months.find(m => m.source === 'budget')?.label || '—'} onward is budget
                    </div>
                  </div>
                </div>

                <BudgetGrid months={d.months} rows={d.rows} />

                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 14, lineHeight: 1.6 }}>
                  A month shows actuals only once it has fully closed — the current month reads as budget, since its
                  income may be invoiced before its costs are entered. What has been booked against it so far is in
                  the amber &ldquo;so far&rdquo; column; it is not added into Total or the forecast. Section names come from Xero&apos;s standard
                  Profit &amp; Loss layout; a custom report layout in Xero may label them differently.
                </div>
              </>
            );
          })()}
        </div>
  );
}
