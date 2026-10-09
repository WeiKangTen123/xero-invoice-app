import { useState } from 'react';
import { fmtCell, isNilAmount } from '../../utils/format';
import { BudgetExport } from './BudgetExport';
import { BudgetGrid } from './BudgetGrid';
import { XeroCheckPanel } from './XeroCheckPanel';
import { BudgetMissingNote, SourceNote, closedRange, isFullYear, lastLoaded, soFarCaption, soFarRead } from './bits';

// A tile's figure is coloured by its sign, as the grid colours a cell; nil
// prints as a dash and takes no colour.
const signTone = v => (isNilAmount(v) ? undefined : v < 0 ? 'var(--danger)' : 'var(--success)');

export default function BudgetTab({ budget, fetchBudget, currency, exportQuery }) {
  // The check against Xero opens on request only — it costs up to three Xero
  // calls — and is keyed on the query, so a change of period checks the new one.
  const [checking, setChecking] = useState(false);
  const ready = budget.status === 'done' && !budget.error;
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
              <BudgetExport kind="grid" query={exportQuery} disabled={!ready} />
              <button className="btn btn-outline btn-sm" disabled={budget.status === 'loading'} onClick={() => fetchBudget({ force: true })}>
                {budget.status === 'loading' ? <span className="btn-spinner" /> : '↻'} Refresh
              </button>
              <button className="btn btn-outline btn-sm" disabled={!ready} aria-expanded={checking} onClick={() => setChecking(c => !c)}>
                ✓ Check against Xero
              </button>
            </div>
          </div>

          {checking && ready && <XeroCheckPanel key={JSON.stringify(exportQuery)} query={exportQuery} onClose={() => setChecking(false)} />}

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
              { label: `Actual to date (${k.monthsElapsed}mo)`, value: k.ytdActualNet,
                hint: `Net profit, ${closedRange(d) || 'no completed months yet'}` },
              { label: `Budget remaining (${k.monthsTotal - k.monthsElapsed}mo)`, value: k.restOfYearNet, hint: 'Net profit still budgeted' },
              { label: fullYear ? 'Full-year forecast' : 'Period forecast', value: k.forecastNet,
                hint: fullYear ? 'Actual to date + budget ahead' : 'Actual to date + budget to the end of the period' },
            ];
            return (
              <>
                {d.budgetMissing && <BudgetMissingNote />}
                {/* Printed as the grid below prints its cells — brackets for a
                    negative, a dash for nil, the same locale — with the
                    currency named once above rather than on every figure. They
                    used to read "SGD -1,234.50" over a grid of "(1,234.50)". */}
                <div style={{ margin: '18px 0 4px' }}>
                {cur && <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 6 }}>Figures in {cur}</div>}
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  {tiles.map(t => (
                    <div key={t.label} className="card figure-tile" style={{ flex: 1, minWidth: 180, background: 'var(--bg-secondary)' }}>
                      <div className="figure-label" style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4 }}>{t.label}</div>
                      <div className="figure-value" style={{ fontSize: 21, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: signTone(t.value) }}>
                        {fmtCell(t.value)}
                      </div>
                      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>{t.hint}</div>
                    </div>
                  ))}
                  {/* The month in progress, live: everything dated in it as
                      Xero holds it on the day it was read, against its
                      whole-month budget. Matches the amber column in the grid
                      and, like it, is not part of the forecast. */}
                  {cm && (
                    <div className="card figure-tile" title={soFarCaption(cm)}
                         style={{ flex: 1, minWidth: 180, background: 'var(--warning-subtle)', borderColor: 'var(--warning)' }}>
                      <div className="figure-label" style={{ fontSize: 11.5, color: 'var(--warning)', fontWeight: 700, marginBottom: 4 }}>{cm.label} so far</div>
                      <div className="figure-value" style={{ fontSize: 21, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: signTone(cm.actualNet) }}>
                        {fmtCell(cm.actualNet)}
                      </div>
                      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>
                        Net profit, of {fmtCell(cm.budgetNet)} budgeted · {soFarRead(cm)}
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
                </div>

                <BudgetGrid months={d.months} rows={d.rows} currency={cur} soFarNote={soFarCaption(cm)} />

                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 14, lineHeight: 1.6 }}>
                  A month shows actuals only once it has fully closed — the current month reads as budget, since its
                  income may be invoiced before its costs are entered. The amber &ldquo;so far&rdquo; column is
                  everything dated in the current month as Xero held it on the day it was read &mdash; including entries
                  dated later in the month, not just the days elapsed; it is not added into Total or the forecast.
                  Section names come from Xero&apos;s standard Profit &amp; Loss layout; a custom report layout in Xero
                  may label them differently.
                </div>
              </>
            );
          })()}
        </div>
  );
}
