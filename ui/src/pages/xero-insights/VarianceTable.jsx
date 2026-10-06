import { Fragment } from 'react';
import { fmtCell, fmtVariancePct, isNilAmount } from '../../utils/format';
import { useViewMode } from '../../context/ViewModeContext';
import { NotBudgeted } from './bits';

// Xero's Budget Variance report: Actual | Budget | Variance | Variance % for one
// or more periods side by side. `periods` is a list of { label, short, of(row) }
// so the same table renders the year-to-date rollup alone, or a month beside
// the year to date up to it, as Xero's report does.
//
// Figures print as the Budget vs Actual grid and the exports print them:
// brackets for negatives, a dash for nil, and the currency named once above the
// table instead of in every cell. A zero variance prints a dash rather than
// "0.00%", matched against the org's own report, where an on-budget line shows
// "-" in both columns.

// A period with no figures for a row (a payload that predates the field the
// period reads) shows dashes rather than throwing.
const NIL = { actual: 0, budget: 0, variance: 0, variancePct: null };
const figures = (p, row) => p.of(row) || NIL;

// Older payloads do not say which rows are costs. Their section titles do:
// Xero's standard layout prefixes them "Less" (Less Cost of Sales, Less
// Operating Expenses), so the colours below still read right on one.
function isExpense(row) {
  if (typeof row.expense === 'boolean') return row.expense;
  return /^less\b|cost of sales|expense|overhead/i.test(row.section || '');
}

// Green is favourable and red unfavourable, as in Xero: income or profit above
// budget is good, a cost above budget is bad. The figure keeps Xero's sign
// either way (actual minus budget), so a cost under budget reads negative and
// green. Colouring by sign alone painted every overspend green.
function tone(row, v) {
  if (isNilAmount(v.variance)) return undefined;
  const good = isExpense(row) ? v.variance < 0 : v.variance > 0;
  return good ? 'var(--success)' : 'var(--danger)';
}

// An unbudgeted line has no budget to show, so it prints a dash whatever
// arrives in that field.
const budgetOf = (row, v) => (row.unbudgeted ? 0 : v.budget);

const currencyNote = currency => (currency ? `Figures in ${currency}` : '');

// One account as a card, for phones.
//
// The table is about 1.4 screens wide for a single period and twice that for a
// month beside its year to date, so the rightmost columns were the ones nobody
// scrolled to see. Stacked, each period is a column of four figures and
// nothing scrolls sideways. Same substitution the AR & AP list makes on mobile.
function VarianceCard({ row, periods }) {
  const strong = row.kind === 'subtotal' || row.kind === 'summary';
  const vs     = periods.map(p => figures(p, row));
  const num    = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
  const lines  = [
    { label: 'Actual',     text: v => fmtCell(v.actual) },
    { label: 'Budget',     text: v => fmtCell(budgetOf(row, v)), style: () => ({ color: 'var(--text-muted)' }) },
    { label: 'Variance',   text: v => fmtCell(v.variance), style: v => ({ color: tone(row, v), fontWeight: 700 }) },
    { label: 'Variance %', text: v => fmtVariancePct(v.variance, v.variancePct), style: v => ({ color: tone(row, v) }) },
  ];

  return (
    <div style={{
      background: strong ? 'var(--bg-secondary)' : 'var(--bg-card)',
      border: '1px solid var(--border)', borderRadius: 10,
      padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{ fontWeight: strong ? 700 : 600, fontSize: 13, marginBottom: 2 }}>
        {row.label}{row.unbudgeted && <NotBudgeted />}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `auto repeat(${periods.length}, minmax(0, 1fr))`,
                    columnGap: 12, rowGap: 3, fontSize: 12.5, alignItems: 'baseline' }}>
        {periods.length > 1 && (
          <>
            <span />
            {periods.map((p, i) => (
              <span key={i} style={{ ...num, fontSize: 10.5, fontWeight: 700, color: 'var(--accent)' }}>{p.short || p.label}</span>
            ))}
          </>
        )}
        {lines.map(l => (
          <Fragment key={l.label}>
            <span style={{ color: 'var(--text-muted)' }}>{l.label}</span>
            {vs.map((v, i) => <span key={i} style={{ ...num, ...(l.style ? l.style(v) : {}) }}>{l.text(v)}</span>)}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export function VarianceTable({ rows, periods, currency }) {
  const { isMobile } = useViewMode();
  const numeric = { textAlign: 'right', padding: '7px 10px', whiteSpace: 'nowrap' };
  const dash    = <span style={{ color: 'var(--text-muted)' }}>-</span>;
  const cell    = n => (isNilAmount(n) ? dash : fmtCell(n));

  if (isMobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
        {currency && <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{currencyNote(currency)}</div>}
        {rows.map((r, idx) => (r.kind === 'section' ? (
          <div key={`s-${idx}`} style={{ fontWeight: 700, fontSize: 12, marginTop: idx === 0 ? 0 : 8 }}>{r.label}</div>
        ) : (
          <VarianceCard key={`r-${idx}`} row={r} periods={periods} />
        )))}
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto', marginTop: 14 }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12.5, fontVariantNumeric: 'tabular-nums', minWidth: '100%' }}>
        <thead>
          {/* Each period titled over its four columns, so "Actual" under a month
              and "Actual" under the year to date cannot be mistaken for each other. */}
          <tr>
            <th style={{ position: 'sticky', left: 0, background: 'var(--bg-card)', textAlign: 'left', padding: '2px 12px 2px 0',
                         fontSize: 10.5, fontWeight: 600, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{currencyNote(currency)}</th>
            {periods.map((p, i) => (
              <th key={i} colSpan={4} style={{ padding: '2px 10px', fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase',
                                                color: 'var(--accent)',
                                                borderLeft: i > 0 ? '1px solid var(--border)' : undefined }}>{p.label}</th>
            ))}
          </tr>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            <th style={{ position: 'sticky', left: 0, background: 'var(--bg-card)', textAlign: 'left', padding: '8px 12px 8px 0',
                         fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Account</th>
            {periods.map((p, pi) => ['Actual', 'Budget', 'Variance', 'Variance %'].map((h, hi) => (
              <th key={`${pi}-${h}`} style={{ ...numeric, padding: '8px 10px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600,
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
                             paddingLeft: r.kind === 'account' ? 14 : 0, fontWeight: strong ? 700 : 400, whiteSpace: 'nowrap' }}>
                  {r.label}{r.unbudgeted && <NotBudgeted />}
                </td>
                {periods.map((p, pi) => {
                  const v    = figures(p, r);
                  const col  = tone(r, v);
                  const pct  = fmtVariancePct(v.variance, v.variancePct);
                  const edge = pi > 0 ? { borderLeft: '1px solid var(--border)' } : {};
                  return (
                    <Fragment key={pi}>
                      <td style={{ ...numeric, ...edge, fontWeight: strong ? 700 : 400 }}>{cell(v.actual)}</td>
                      <td style={{ ...numeric, color: 'var(--text-muted)' }}>{cell(budgetOf(r, v))}</td>
                      <td style={{ ...numeric, fontWeight: 700, color: col }}>{cell(v.variance)}</td>
                      <td style={{ ...numeric, color: col }}>{pct === '-' ? dash : pct}</td>
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
