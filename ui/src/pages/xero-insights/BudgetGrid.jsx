import { fmtCell } from '../../utils/format';

// The monthly actual/budget grid. 14 columns don't fit any normal screen, so the
// table scrolls horizontally inside its own container while the row-label column
// stays pinned — without that you scroll to December and lose track of the row.
export function BudgetGrid({ months, rows }) {
  const firstBudgetIdx = months.findIndex(m => m.source === 'budget');
  const actualCount    = firstBudgetIdx === -1 ? months.length : firstBudgetIdx;

  const labelCell = (extra = {}) => ({
    position: 'sticky', left: 0, zIndex: 1, background: 'var(--bg-card)',
    textAlign: 'left', padding: '7px 12px 7px 0', whiteSpace: 'nowrap', ...extra,
  });
  // The seam between the last actual month and the first budget month. Xero's own
  // PDF only signals this in the column headers, which is easy to miss.
  const seam = i => (i === firstBudgetIdx ? { borderLeft: '2px solid var(--accent)' } : {});

  return (
    <div style={{ overflowX: 'auto', marginTop: 14 }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums', minWidth: '100%' }}>
        <thead>
          {/* Band spanning the two blocks, so ACTUAL and BUDGET read as two things */}
          <tr>
            <th style={labelCell()} />
            {actualCount > 0 && (
              <th colSpan={actualCount} style={{ padding: '2px 8px', fontSize: 10, letterSpacing: '0.08em', color: 'var(--success)', textTransform: 'uppercase' }}>Actual</th>
            )}
            {actualCount < months.length && (
              <th colSpan={months.length - actualCount} style={{ padding: '2px 8px', fontSize: 10, letterSpacing: '0.08em', color: 'var(--accent)', textTransform: 'uppercase', ...seam(firstBudgetIdx) }}>Overall Budget</th>
            )}
            <th style={{ padding: '2px 8px' }} />
          </tr>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            <th style={labelCell({ fontSize: 11, color: 'var(--text-muted)' })}>Account</th>
            {months.map((m, i) => (
              <th key={m.key} style={{ padding: '6px 10px', textAlign: 'right', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
                                       color: m.source === 'actual' ? 'var(--text-secondary)' : 'var(--text-muted)', ...seam(i) }}>
                {m.label}
              </th>
            ))}
            <th style={{ padding: '6px 10px 6px 16px', textAlign: 'right', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', borderLeft: '1px solid var(--border)' }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => {
            if (r.kind === 'section') return (
              <tr key={`s-${idx}`}>
                <td colSpan={months.length + 2} style={{ padding: '14px 0 4px', fontWeight: 700, fontSize: 12 }}>{r.label}</td>
              </tr>
            );
            const strong  = r.kind === 'subtotal' || r.kind === 'summary';
            const rowLine = r.kind === 'summary' ? { borderTop: '1px solid var(--border)' } : {};
            return (
              <tr key={`r-${idx}`} style={rowLine}>
                <td style={labelCell({ paddingLeft: r.kind === 'account' ? 14 : 0, fontWeight: strong ? 700 : 400 })}>{r.label}</td>
                {r.cells.map((v, i) => (
                  <td key={i} style={{ padding: '7px 10px', textAlign: 'right', fontWeight: strong ? 700 : 400,
                                       color: v < 0 ? 'var(--danger)' : undefined, ...seam(i) }}>
                    {fmtCell(v)}
                  </td>
                ))}
                <td style={{ padding: '7px 10px 7px 16px', textAlign: 'right', fontWeight: 700, borderLeft: '1px solid var(--border)',
                             color: r.total < 0 ? 'var(--danger)' : undefined }}>
                  {fmtCell(r.total)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
