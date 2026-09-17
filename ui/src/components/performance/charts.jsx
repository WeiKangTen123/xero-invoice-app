import { fmtMoney, fmtMoneyShort, fmtPct } from '../../utils/format';
import { Empty, SERIES_COLORS, sum } from './primitives';

// Horizontal bars — used for the service-line mix and the margin bridge. Scaled
// against the largest ABSOLUTE value so a negative bar (a credit note month)
// still renders at a truthful length.
export function BarList({ items, currency, showPctOfTotal }) {
  const max = Math.max(...items.map(i => Math.abs(i.value)), 1);
  const total = sum(items.map(i => i.value));
  if (!items.length || items.every(i => i.value === 0)) return <Empty>No activity in this range.</Empty>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      {items.map((it, i) => {
        const neg = it.value < 0;
        return (
          <div key={it.label}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, marginBottom: 4 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {it.label}
                {it.tag && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--accent)' }}>{it.tag}</span>}
              </span>
              <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: neg ? 'var(--danger)' : undefined, flexShrink: 0 }}>
                {fmtMoney(it.value, currency)}
                {showPctOfTotal && total !== 0 && (
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

// Monthly columns, actual against budget. Inline SVG rather than a chart
// library — same approach as the rest of this dashboard, and it keeps the
// bundle flat.
export function MonthlyBars({ months, actual, budget, currency, height = 190, showBudget = true }) {
  const n = months.length;
  if (!n) return <Empty>Pick a wider month range.</Empty>;
  const vals = [...actual, ...(showBudget ? budget : [])];
  if (!vals.some(v => v !== 0)) return <Empty>Nothing recorded in this range.</Empty>;

  const W = 720, H = height, padB = 26, padT = 10;
  const plot = H - padB - padT;
  // The baseline is a real zero line, not the floor of the plot — a month with a
  // credit note has to hang below it rather than render as a short positive bar.
  const minV = Math.min(0, ...vals);
  const range = Math.max(...vals, 0) - minV || 1;
  const y = v => padT + plot * (1 - (v - minV) / range);
  const slot = W / n;
  const bw = showBudget ? slot * 0.3 : slot * 0.44;

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: n > 6 ? 520 : 0, display: 'block' }} role="img" aria-label="monthly actual versus budget">
        <line x1="0" x2={W} y1={y(0)} y2={y(0)} stroke="var(--border)" strokeWidth="1" />
        {months.map((m, i) => {
          const cx = slot * i + slot / 2;
          const a = actual[i] || 0, b = budget[i] || 0;
          const ax = showBudget ? cx - bw - 2 : cx - bw / 2;
          return (
            <g key={m.key}>
              {showBudget && b !== 0 && (
                <rect x={cx + 2} width={bw} y={Math.min(y(b), y(0))} height={Math.abs(y(b) - y(0))}
                      fill="var(--text-muted)" opacity="0.32" rx="2">
                  <title>{`${m.label} budget: ${fmtMoney(b, currency)}`}</title>
                </rect>
              )}
              {a !== 0 && (
                <rect x={ax} width={bw} y={Math.min(y(a), y(0))} height={Math.abs(y(a) - y(0))}
                      fill={a < 0 ? 'var(--danger)' : 'var(--accent)'} rx="2">
                  <title>{`${m.label} actual: ${fmtMoney(a, currency)}`}</title>
                </rect>
              )}
              <text x={cx} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--text-muted)">
                {m.label.replace(' 20', " '")}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// Same data as MonthlyBars, drawn as lines. A bar reads best for "how big was
// each month"; a line reads best for direction and for spotting where actual
// crosses budget — hence the toggle rather than picking one.
function MonthlyLine({ months, actual, budget, currency, height = 190, showBudget = true }) {
  const n = months.length;
  if (!n) return <Empty>Pick a wider month range.</Empty>;
  const vals = [...actual, ...(showBudget ? budget : [])];
  if (!vals.some(v => v !== 0)) return <Empty>Nothing recorded in this range.</Empty>;

  const W = 720, H = height, padB = 26, padT = 12, padL = 4;
  const plot = H - padB - padT;
  const minV = Math.min(0, ...vals);
  const range = Math.max(...vals, 0) - minV || 1;
  const y = v => padT + plot * (1 - (v - minV) / range);
  const x = i => (n === 1 ? W / 2 : padL + (W - padL * 2) * (i / (n - 1)));
  const path = arr => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v || 0).toFixed(1)}`).join(' ');

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: n > 6 ? 520 : 0, display: 'block' }} role="img" aria-label="monthly trend">
        <line x1="0" x2={W} y1={y(0)} y2={y(0)} stroke="var(--border)" strokeWidth="1" />
        {showBudget && budget.some(v => v !== 0) && (
          <path d={path(budget)} fill="none" stroke="var(--text-muted)" strokeWidth="1.6" strokeDasharray="5 4" opacity="0.7" />
        )}
        <path d={path(actual)} fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
        {months.map((m, i) => (
          <g key={m.key}>
            {(actual[i] || 0) !== 0 && (
              <circle cx={x(i)} cy={y(actual[i])} r="3.2" fill="var(--accent)">
                <title>{`${m.label} actual: ${fmtMoney(actual[i], currency)}`}</title>
              </circle>
            )}
            <text x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--text-muted)">
              {m.label.replace(' 20', " '")}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

// Bar or line, user's choice, sharing one dataset and one legend.
export function TrendChart({ mode, ...rest }) {
  return mode === 'line' ? <MonthlyLine {...rest} /> : <MonthlyBars {...rest} />;
}

export function ChartModeToggle({ mode, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 2, background: 'var(--bg-secondary)', borderRadius: 7, padding: 2 }}>
      {[{ k: 'bar', l: 'Bar' }, { k: 'line', l: 'Line' }].map(o => (
        <button key={o.k} type="button" onClick={() => onChange(o.k)} style={{
          padding: '3px 10px', fontSize: 11, fontWeight: 600, borderRadius: 5, cursor: 'pointer', border: 'none',
          background: mode === o.k ? 'var(--accent-gradient)' : 'transparent',
          color: mode === o.k ? '#fff' : 'var(--text-muted)',
        }}>{o.l}</button>
      ))}
    </div>
  );
}

// The reference dashboard's KPI scorecard. Its metrics — NRR, LTV/CAC, billable
// mix, CAC payback — need a CRM and timesheets, neither of which Xero holds.
// These four are the closest equivalents that are genuinely derivable, and a
// metric that can't be computed shows an em dash with the reason rather than 0.
// A true waterfall: every bar starts where the previous one ended, so the reader
// sees how the closing balance was ARRIVED AT rather than just what its parts
// were. Research on financial dashboards puts this at the centre of the cash
// view for exactly that reason — a stacked list shows the same numbers without
// showing that they connect.
export function Waterfall({ steps, currency, height = 240 }) {
  if (!steps || steps.length < 3) return <Empty>No cash moved in this period.</Empty>;

  const lo = Math.min(0, ...steps.map(s => Math.min(s.start, s.end)));
  const hi = Math.max(0, ...steps.map(s => Math.max(s.start, s.end)));
  const span = (hi - lo) || 1;
  const pct = v => ((v - lo) / span) * 100;
  const colorOf = k => k === 'total' ? 'var(--accent)'
                     : k === 'in'    ? 'var(--success)'
                     : k === 'gap'   ? 'var(--warning)'
                     :                 'var(--danger)';

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, height, borderBottom: '1px solid var(--border)' }}>
        {steps.map((s, i) => {
          const top = Math.max(s.start, s.end), bot = Math.min(s.start, s.end);
          const barH = Math.max(pct(top) - pct(bot), 0.5);
          return (
            <div key={`${s.label}-${i}`} style={{ flex: 1, minWidth: 38, position: 'relative' }}
                 title={`${s.label}: ${fmtMoney(s.delta, currency)}`}>
              <div style={{
                position: 'absolute', left: '12%', right: '12%',
                bottom: `${pct(bot)}%`, height: `${barH}%`,
                background: colorOf(s.kind), borderRadius: 3,
                opacity: s.kind === 'total' ? 1 : 0.85,
              }} />
              {/* Chart labels, not body text: this one is absolutely positioned
                  with nowrap and negative insets, so it already runs past its
                  own bar — and the one under the axis lives in a 38px column.
                  Both stay at 9.5 deliberately. Sizing them up collides them
                  with the neighbouring bar's label instead of making the chart
                  easier to read. */}
              <div style={{
                position: 'absolute', left: -4, right: -4, bottom: `calc(${pct(top)}% + 5px)`,
                textAlign: 'center', fontSize: 9.5, fontWeight: 700,
                fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)', whiteSpace: 'nowrap',
              }}>{fmtMoneyShort(s.delta, currency)}</div>
              {/* Connector to the next bar — what makes it a waterfall rather
                  than a row of unrelated columns. */}
              {i < steps.length - 1 && steps[i + 1].kind !== 'total' && (
                <div style={{
                  position: 'absolute', left: '88%', right: '-12%',
                  bottom: `${pct(s.end)}%`, borderTop: '1px dashed var(--border)',
                }} />
              )}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        {steps.map((s, i) => (
          <div key={`${s.label}-lbl-${i}`} style={{
            flex: 1, minWidth: 38, textAlign: 'center', fontSize: 9.5,
            color: 'var(--text-muted)', lineHeight: 1.3,
            fontWeight: s.kind === 'total' ? 700 : 400,
          }}>{s.label}</div>
        ))}
      </div>
    </div>
  );
}

// Two series in ONE plot. The recurring/project split was previously drawn as
// two separate charts stacked vertically, which makes the mix impossible to read
// — comparing bar heights across two independently-scaled plots is exactly the
// comparison the card exists to make. Shared scale, side-by-side bars.
// `percent` switches the tooltip from money to a percentage — the same bars serve
// the margin trend, where a currency symbol would be actively misleading.
// `rawLabels` keeps the axis text verbatim. The month shortener below would
// mangle an account called "Savings 2024" into "Savings '24".
export function GroupedMonthlyBars({ months, series, currency, height = 200, percent = false, rawLabels = false }) {
  const n = months.length;
  if (!n) return <Empty>Pick a wider period.</Empty>;
  const all = series.flatMap(s => s.values);
  if (!all.some(v => v !== 0)) return <Empty>Nothing recorded in this period.</Empty>;
  const fmtVal = v => (percent ? fmtPct(v / 100, 1) : fmtMoney(v, currency));

  const W = 720, H = height, padB = 26, padT = 10;
  const plot = H - padB - padT;
  const minV = Math.min(0, ...all);
  const range = Math.max(...all, 0) - minV || 1;
  const y = v => padT + plot * (1 - (v - minV) / range);
  const slot = W / n;
  const bw = Math.min(18, (slot * 0.62) / series.length);

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: n > 6 ? 520 : 0, display: 'block' }} role="img" aria-label="monthly series comparison">
        <line x1="0" x2={W} y1={y(0)} y2={y(0)} stroke="var(--border)" strokeWidth="1" />
        {months.map((m, i) => {
          const cx = slot * i + slot / 2;
          const groupW = bw * series.length + 2 * (series.length - 1);
          return (
            <g key={m.key}>
              {series.map((s, k) => {
                const v = s.values[i] || 0;
                if (v === 0) return null;
                const x = cx - groupW / 2 + k * (bw + 2);
                return (
                  <rect key={s.label} x={x} width={bw} y={Math.min(y(v), y(0))} height={Math.abs(y(v) - y(0))}
                        fill={v < 0 ? 'var(--danger)' : s.color} rx="2">
                    <title>{`${m.label} · ${s.label}: ${fmtVal(v)}`}</title>
                  </rect>
                );
              })}
              <text x={cx} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--text-muted)">
                {rawLabels ? m.label : m.label.replace(' 20', " '")}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
