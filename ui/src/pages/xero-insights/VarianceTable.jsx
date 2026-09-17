import { Fragment } from 'react';
import { fmtMoney, fmtCell } from '../../utils/format';
import { useViewMode } from '../../context/ViewModeContext';

// Xero's Budget Variance report: Actual | Budget | Variance | Variance % for one
// or more months side by side. `periods` is a list of { label, of(row) } so the
// same table renders a single month or the year-to-date rollup.
//
// A zero variance prints as a dash, not "0.00%" — matched against the org's own
// Budget Variance report, where an on-budget line shows "-" in both columns.
// One account as a card, for phones.
//
// The table is five columns and about 1.4 screens wide, so Variance % — the
// rightmost column — was the one nobody ever scrolled to see. Stacked, all four
// figures are visible at once and nothing scrolls sideways. Same substitution
// the AR & AP list already makes on mobile.
function VarianceCard({ row, period, currency }) {
  const v      = period.of(row);
  const strong = row.kind === 'subtotal' || row.kind === 'summary';
  // Direction only, never a verdict: under budget is good on an expense and bad
  // on income, and the row does not carry its own sign convention.
  const col    = v.variance === 0 ? undefined : v.variance > 0 ? 'var(--success)' : 'var(--danger)';
  const pct    = v.variance === 0 || v.variancePct === null ? null : `${v.variance > 0 ? '+' : ''}${(v.variancePct * 100).toFixed(1)}%`;

  const pair = (label, value, style) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums', ...style }}>{value}</span>
    </div>
  );

  return (
    <div style={{
      background: strong ? 'var(--bg-secondary)' : 'var(--bg-card)',
      border: '1px solid var(--border)', borderRadius: 10,
      padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 2 }}>
        <span style={{ fontWeight: strong ? 700 : 600, fontSize: 13 }}>{row.label}</span>
        {pct && <span style={{ fontSize: 12, fontWeight: 700, color: col, whiteSpace: 'nowrap' }}>{pct}</span>}
      </div>
      {pair('Actual',   v.actual === 0 ? '-' : fmtMoney(v.actual, currency))}
      {pair('Budget',   v.budget === 0 ? '-' : fmtMoney(v.budget, currency), { color: 'var(--text-muted)' })}
      {pair('Variance', v.variance === 0 ? '-' : fmtCell(v.variance), { color: col, fontWeight: 700 })}
    </div>
  );
}

export function VarianceTable({ rows, periods, currency }) {
  const { isMobile } = useViewMode();
  const numeric = { textAlign: 'right', padding: '7px 10px', whiteSpace: 'nowrap' };
  const dash    = <span style={{ color: 'var(--text-muted)' }}>-</span>;

  // Cards only make sense against a single period; comparing two side by side is
  // inherently a table, so a multi-period view keeps scrolling even on a phone.
  if (isMobile && periods.length === 1) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
        {rows.map((r, idx) => (r.kind === 'section' ? (
          <div key={`s-${idx}`} style={{ fontWeight: 700, fontSize: 12, marginTop: idx === 0 ? 0 : 8 }}>{r.label}</div>
        ) : (
          <VarianceCard key={`r-${idx}`} row={r} period={periods[0]} currency={currency} />
        )))}
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto', marginTop: 14 }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12.5, fontVariantNumeric: 'tabular-nums', minWidth: '100%' }}>
        <thead>
          {periods.length > 1 && (
            <tr>
              <th />
              {periods.map((p, i) => (
                <th key={p.label} colSpan={4} style={{ padding: '2px 10px', fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase',
                                                       color: 'var(--accent)', borderLeft: i > 0 ? '1px solid var(--border)' : undefined }}>{p.label}</th>
              ))}
            </tr>
          )}
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            <th style={{ position: 'sticky', left: 0, background: 'var(--bg-card)', textAlign: 'left', padding: '8px 12px 8px 0',
                         fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Account</th>
            {periods.map((p, pi) => ['Actual', 'Budget', 'Variance', 'Variance %'].map((h, hi) => (
              <th key={`${p.label}-${h}`} style={{ ...numeric, padding: '8px 10px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600,
                                                   borderLeft: hi === 0 && pi > 0 ? '1px solid var(--border)' : undefined }}>{h}</th>
            )))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => {
            if (r.kind === 'section') return (
              <tr key={`s-${idx}`}>
                <td colSpan={1 + periods.length * 4} style={{ padding: '14px 0 4px', fontWeight: 700, fontSize: 12 }}>{r.label}</td>
              </tr>
            );
            const strong = r.kind === 'subtotal' || r.kind === 'summary';
            return (
              <tr key={`r-${idx}`} style={{ borderTop: r.kind === 'summary' ? '1px solid var(--border)' : undefined }}>
                <td style={{ position: 'sticky', left: 0, background: 'var(--bg-card)', padding: '7px 12px 7px 0',
                             paddingLeft: r.kind === 'account' ? 14 : 0, fontWeight: strong ? 700 : 400, whiteSpace: 'nowrap' }}>{r.label}</td>
                {periods.map((p, pi) => {
                  const v = p.of(r);
                  // Direction only — for an expense, under budget is good; for
                  // income it's bad. Without each account's sign convention the
                  // colour shows which way it moved, never a verdict.
                  const col = v.variance === 0 ? undefined : v.variance > 0 ? 'var(--success)' : 'var(--danger)';
                  const edge = pi > 0 ? { borderLeft: '1px solid var(--border)' } : {};
                  return (
                    <Fragment key={p.label}>
                      <td style={{ ...numeric, ...edge, fontWeight: strong ? 700 : 400 }}>{v.actual === 0 ? dash : fmtMoney(v.actual, currency)}</td>
                      <td style={{ ...numeric, color: 'var(--text-muted)' }}>{v.budget === 0 ? dash : fmtMoney(v.budget, currency)}</td>
                      <td style={{ ...numeric, fontWeight: 700, color: col }}>{v.variance === 0 ? dash : fmtCell(v.variance)}</td>
                      <td style={{ ...numeric, color: col }}>
                        {v.variance === 0 || v.variancePct === null ? dash : `${(v.variancePct * 100).toFixed(2)}%`}
                      </td>
                    </Fragment>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
