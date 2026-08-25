import { useState, useEffect, useRef, useMemo, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { formatDateTime, formatRelative } from '../utils/formatDate';
import { fmtMoney, fmtPct, fmtCell } from '../utils/format';
import { MonthRange, OverviewPanel, RevenuePanel } from '../components/performance/PerformancePanels';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'revenue',  label: 'Revenue' },
  { key: 'invoices', label: 'Invoices & Bills' },
  { key: 'banking',  label: 'Banking' },
  { key: 'accounts', label: 'Chart of Accounts' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'pnl',      label: 'P&L' },
  { key: 'budget',   label: 'Budget vs Actual' },
  { key: 'variance', label: 'Budget Variance' },
];
// Nothing left here for now — kept as an array (rather than removed outright)
// since it's the natural place to list whatever needs the next scope widening.
const PHASE2_TABS = [];

const RANGE_PRESETS = [
  { key: 'day',   label: 'Today' },
  { key: 'week',  label: 'This Week' },
  { key: 'month', label: 'This Month' },
  { key: 'year',  label: 'This Year' },
  { key: 'all',   label: 'All Time' },
  { key: 'custom',label: 'Custom' },
];


// P&L/Cash Flow are Xero Report-API-backed, and Xero rejects >365-day report
// ranges outright — the backend silently clamps a very wide request (like
// "All Time") to the most recent ~10 years instead. Showing the range the
// API actually used (echoed back on the response) rather than the raw
// preset's own range keeps "All Time" from implying more than it delivers.
function reportRangeLabel(applied, periodRange) {
  if (!applied) return periodRange ? `${periodRange.fromISO} → ${periodRange.toISO}` : 'Same date range as above';
  const label = `${applied.from} → ${applied.to}`;
  const clamped = periodRange && applied.from !== periodRange.fromISO;
  return clamped ? `${label} · Xero's reports cap out at ~10 years of history per view` : label;
}

// Small provenance caption under a card title — which live Xero API/report the
// numbers below it came from, so "where did this come from" never needs asking.
function SourceNote({ children }) {
  return <div style={{ fontSize: 10.5, color: 'var(--text-muted)', opacity: 0.75, marginBottom: 10 }}>Source: {children}</div>;
}

function fmtBucketLabel(bucket, granularity) {
  if (granularity === 'month') {
    const [y, m] = bucket.split('-');
    return new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  }
  return bucket.slice(5); // MM-DD
}

// ── Bar chart: any two values compared — interactive hover ──────────────────
// Generic enough to serve Receivables/Payables (Overview), Income/Expenses
// (P&L), and Cash In/Cash Out (Cash Flow) — same visual language throughout.
function TwoBarChart({ leftLabel, leftValue, leftColor = 'var(--success)', rightLabel, rightValue, rightColor = 'var(--danger)', currency }) {
  const [hover, setHover] = useState(null);
  const max = Math.max(leftValue, rightValue, 1);
  // PAD_T needs headroom for the value label drawn *above* the tallest bar
  // (label baseline sits 8px above the bar top, and the text itself extends
  // further up from its baseline by roughly the font's ascent) — 14 wasn't
  // enough and let the whole-value label for whichever bar hit the chart's
  // max clip off the top of the SVG.
  const W = 360, H = 170, PAD_B = 26, PAD_T = 26, barW = 78;
  const scale = v => (v / max) * (H - PAD_T - PAD_B);

  const bars = [
    { key: 'left',  label: leftLabel,  value: leftValue,  x: 70,  color: leftColor },
    { key: 'right', label: rightLabel, value: rightValue, x: 210, color: rightColor },
  ];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      <line x1="40" y1={PAD_T} x2="40" y2={H - PAD_B} stroke="var(--border)" strokeWidth="1" />
      <line x1="40" y1={H - PAD_B} x2={W - 20} y2={H - PAD_B} stroke="var(--border)" strokeWidth="1" />
      {bars.map(b => {
        const h = scale(b.value);
        const y = H - PAD_B - h;
        const active = hover === b.key;
        return (
          <g key={b.key} onMouseEnter={() => setHover(b.key)} onMouseLeave={() => setHover(null)} style={{ cursor: 'pointer' }}>
            <rect x={b.x} y={PAD_T} width={barW} height={H - PAD_T - PAD_B} fill="transparent" />
            <rect x={b.x} y={y} width={barW} height={Math.max(h, 2)} rx="6" fill={b.color} opacity={active ? 1 : 0.82} />
            <text x={b.x + barW / 2} y={y - 8} textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--text-primary)">
              {active ? fmtMoney(b.value, currency) : b.value.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </text>
            <text x={b.x + barW / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--text-secondary)">{b.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Aging bars: outstanding amount bucketed by how soon it's due ────────────
// Mirrors Xero's own "Invoices owed to you" / "Bills to pay" widgets, just
// with fixed day windows instead of Xero's dynamic weekly columns.
const AGING_BUCKETS = [
  { key: 'overdue',  label: 'Overdue' },
  { key: 'within7',  label: 'Due ≤7d' },
  { key: 'within30', label: 'Due ≤30d' },
  { key: 'later',    label: 'Later' },
];
function AgingChart({ aging, color, currency }) {
  const [hover, setHover] = useState(null);
  const total = AGING_BUCKETS.reduce((s, b) => s + (aging?.[b.key]?.amount || 0), 0);
  if (!total) return <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>Nothing outstanding</div>;

  const max = Math.max(...AGING_BUCKETS.map(b => aging[b.key].amount), 1);
  // Same headroom fix as TwoBarChart — 14 clipped the value label on
  // whichever bucket happened to be the tallest bar.
  const W = 360, H = 150, PAD_B = 26, PAD_T = 26, barW = 62, gap = 20;
  const scale = v => (v / max) * (H - PAD_T - PAD_B);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      <line x1="0" y1={H - PAD_B} x2={W} y2={H - PAD_B} stroke="var(--border)" strokeWidth="1" />
      {AGING_BUCKETS.map((b, i) => {
        const bucket = aging[b.key];
        const x = 14 + i * (barW + gap);
        const h = scale(bucket.amount);
        const y = H - PAD_B - h;
        const active = hover === b.key;
        return (
          <g key={b.key} onMouseEnter={() => setHover(b.key)} onMouseLeave={() => setHover(null)} style={{ cursor: 'pointer' }}>
            <rect x={x} y={PAD_T} width={barW} height={H - PAD_T - PAD_B} fill="transparent" />
            <rect x={x} y={y} width={barW} height={Math.max(h, 2)} rx="6" fill={color} opacity={active ? 1 : 0.55 + 0.15 * (bucket.amount > 0)} />
            <text x={x + barW / 2} y={y - 8} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--text-primary)">
              {active ? fmtMoney(bucket.amount, currency) : bucket.count}
            </text>
            <text x={x + barW / 2} y={H - 8} textAnchor="middle" fontSize="10.5" fill="var(--text-secondary)">{b.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Donut: invoice status breakdown — interactive hover ─────────────────────
function StatusDonut({ breakdown }) {
  const [hover, setHover] = useState(null);
  const segments = [
    { key: 'paid',    label: 'Paid',     value: breakdown.paid,    color: 'var(--success)' },
    { key: 'awaiting',label: 'Awaiting', value: breakdown.awaiting,color: 'var(--warning)' },
    { key: 'overdue', label: 'Overdue',  value: breakdown.overdue, color: 'var(--danger)' },
  ];
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const R = 52, CX = 90, CY = 74, CIRC = 2 * Math.PI * R;
  let offset = 0;

  return (
    <div>
      <svg viewBox="0 0 180 150" style={{ width: '100%', height: 'auto', display: 'block' }}>
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--bg-secondary)" strokeWidth="20" />
        {segments.map(s => {
          const frac = s.value / total;
          const dash = frac * CIRC;
          const el = (
            <circle
              key={s.key} cx={CX} cy={CY} r={R} fill="none" stroke={s.color}
              strokeWidth={hover === s.key ? 24 : 20}
              strokeDasharray={`${dash} ${CIRC - dash}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${CX} ${CY})`}
              style={{ cursor: 'pointer', transition: 'stroke-width 0.12s' }}
              onMouseEnter={() => setHover(s.key)} onMouseLeave={() => setHover(null)}
            />
          );
          offset += dash;
          return el;
        })}
        <text x={CX} y={CY - 4} textAnchor="middle" fontSize="19" fontWeight="800" fill="var(--text-primary)">
          {hover ? segments.find(s => s.key === hover).value : total}
        </text>
        <text x={CX} y={CY + 13} textAnchor="middle" fontSize="9.5" fill="var(--text-muted)">
          {hover ? segments.find(s => s.key === hover).label : 'total'}
        </text>
      </svg>
      <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-secondary)', flexWrap: 'wrap', marginTop: 4 }}>
        {segments.map(s => (
          <span key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 5, opacity: hover && hover !== s.key ? 0.5 : 1, cursor: 'pointer' }}
                onMouseEnter={() => setHover(s.key)} onMouseLeave={() => setHover(null)}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: s.color, display: 'inline-block' }} />
            {s.label} {s.value}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Trend chart: Sales vs Bills over the selected date range ────────────────
// Same crosshair+tooltip interaction as the Admin monitoring chart — a chart is
// interactive by default, not an optional extra.
function PeriodTrendChart({ trend, granularity, currency }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  const svgRef = useRef(null);

  if (!trend || trend.length === 0) {
    return <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '30px 0', textAlign: 'center' }}>No invoices dated in this range yet.</div>;
  }

  const W = 760, H = 210, PAD_L = 56, PAD_R = 12, PAD_T = 12, PAD_B = 26;
  const innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B;
  const maxY = Math.max(1, ...trend.flatMap(d => [d.sales, d.bills]));
  const x = i => PAD_L + (trend.length === 1 ? innerW / 2 : (i / (trend.length - 1)) * innerW);
  const y = v => PAD_T + innerH - (v / maxY) * innerH;
  const line = key => trend.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(d[key]).toFixed(1)}`).join(' ');
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(maxY * f));

  function onMove(e) {
    const rect = svgRef.current.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    const frac = Math.min(1, Math.max(0, (relX - PAD_L) / innerW));
    setHoverIdx(Math.round(frac * (trend.length - 1)));
  }
  const hover = hoverIdx != null ? trend[hoverIdx] : null;
  const tooltipRight = hoverIdx != null && x(hoverIdx) > W * 0.65;
  const step = Math.max(1, Math.ceil(trend.length / 8)); // thin out x-axis labels so they don't collide

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: 'var(--success)' }} />Sales
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: 'var(--danger)' }} />Bills
        </div>
      </div>
      <div style={{ position: 'relative', overflowX: 'auto' }}>
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: 480, height: 'auto', display: 'block', cursor: 'crosshair' }}
             onMouseMove={onMove} onMouseLeave={() => setHoverIdx(null)}>
          {yTicks.map((t, i) => (
            <g key={i}>
              <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth="1" />
              <text x={PAD_L - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" fontSize="10" fill="var(--text-muted)">
                {t.toLocaleString(undefined, { notation: t > 9999 ? 'compact' : 'standard' })}
              </text>
            </g>
          ))}
          {trend.map((d, i) => (i % step === 0 || i === trend.length - 1) && (
            <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--text-muted)">
              {fmtBucketLabel(d.bucket, granularity)}
            </text>
          ))}
          <path d={line('sales')} fill="none" stroke="var(--success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d={line('bills')} fill="none" stroke="var(--danger)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          {hover && (
            <g>
              <line x1={x(hoverIdx)} x2={x(hoverIdx)} y1={PAD_T} y2={PAD_T + innerH} stroke="var(--text-muted)" strokeWidth="1" strokeDasharray="3,3" />
              <circle cx={x(hoverIdx)} cy={y(hover.sales)} r="4" fill="var(--success)" stroke="var(--bg-card)" strokeWidth="2" />
              <circle cx={x(hoverIdx)} cy={y(hover.bills)} r="4" fill="var(--danger)" stroke="var(--bg-card)" strokeWidth="2" />
            </g>
          )}
        </svg>
        {hover && (
          <div style={{
            position: 'absolute', top: 4, [tooltipRight ? 'right' : 'left']: `${(x(hoverIdx) / W) * 100}%`,
            transform: tooltipRight ? 'translateX(8px)' : 'translateX(-108%)',
            background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8,
            padding: '8px 10px', fontSize: 11.5, boxShadow: 'var(--shadow-sm)', pointerEvents: 'none', minWidth: 120,
          }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{fmtBucketLabel(hover.bucket, granularity)}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ color: 'var(--text-muted)' }}>Sales</span>
              <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(hover.sales, currency)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ color: 'var(--text-muted)' }}>Bills</span>
              <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(hover.bills, currency)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Date range control: presets + a custom from/to picker ───────────────────
function DateRangeControl({ preset, setPreset, from, to, setFrom, setTo, onApplyCustom }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {RANGE_PRESETS.map(p => (
        <button key={p.key} type="button" onClick={() => setPreset(p.key)} className="btn btn-sm" style={{
          background: preset === p.key ? 'var(--accent-gradient)' : 'var(--bg-secondary)',
          color: preset === p.key ? '#fff' : 'var(--text-muted)', border: 'none',
        }}>{p.label}</button>
      ))}
      {preset === 'custom' && (
        <form onSubmit={e => { e.preventDefault(); onApplyCustom(); }} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="date" className="form-input" style={{ width: 145 }} value={from} onChange={e => setFrom(e.target.value)} required />
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>to</span>
          <input type="date" className="form-input" style={{ width: 145 }} value={to} onChange={e => setTo(e.target.value)} required />
          <button type="submit" className="btn btn-primary btn-sm">Apply</button>
        </form>
      )}
    </div>
  );
}

const STATUS_BADGE = {
  paid:     { cls: 'badge-green',  label: 'Paid' },
  awaiting: { cls: 'badge-yellow', label: 'Awaiting' },
  overdue:  { cls: 'badge-red',    label: 'Overdue' },
};


// The monthly actual/budget grid. 14 columns don't fit any normal screen, so the
// table scrolls horizontally inside its own container while the row-label column
// stays pinned — without that you scroll to December and lose track of the row.
function BudgetGrid({ months, rows }) {
  const firstBudgetIdx = months.findIndex(m => m.source === 'budget');
  const actualCount    = firstBudgetIdx === -1 ? months.length : firstBudgetIdx;

  const labelCell = (extra = {}) => ({
    position: 'sticky', left: 0, zIndex: 1, background: 'var(--bg-primary)',
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

// Xero's Budget Variance report: Actual | Budget | Variance | Variance % for one
// or more months side by side. `periods` is a list of { label, of(row) } so the
// same table renders a single month or the year-to-date rollup.
//
// A zero variance prints as a dash, not "0.00%" — matched against the org's own
// Budget Variance report, where an on-budget line shows "-" in both columns.
function VarianceTable({ rows, periods, currency }) {
  const numeric = { textAlign: 'right', padding: '7px 10px', whiteSpace: 'nowrap' };
  const dash    = <span style={{ color: 'var(--text-muted)' }}>-</span>;

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
            <th style={{ position: 'sticky', left: 0, background: 'var(--bg-primary)', textAlign: 'left', padding: '8px 12px 8px 0',
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
                <td style={{ position: 'sticky', left: 0, background: 'var(--bg-primary)', padding: '7px 12px 7px 0',
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

// Generic "search this table" box, reused for accounts/contacts.
function SearchBox({ value, onChange, placeholder }) {
  return <input type="text" className="form-input" placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} style={{ maxWidth: 240 }} />;
}

export default function XeroInsights() {
  const { user }   = useAuth();
  const navigate   = useNavigate();
  const [data,      setData]      = useState(null); // null = loading
  const [error,     setError]     = useState('');
  const [refreshing,setRefreshing]= useState(false);
  const [tab,       setTab]       = useState('overview');
  const [search,    setSearch]    = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [activeTenantId, setActiveTenantId] = useState(null);
  const [, forceTick] = useState(0); // re-render every 15s so "synced Xs ago" stays live
  const tickRef = useRef(null);

  // Date-range period (Overview trend) — independent fetch from the always-current summary.
  const today = new Date().toISOString().slice(0, 10);
  const [rangePreset, setRangePreset] = useState('month');
  const [rangeFrom, setRangeFrom]     = useState(today);
  const [rangeTo, setRangeTo]         = useState(today);
  const [period, setPeriod]           = useState(null);
  const [periodError, setPeriodError] = useState('');
  // Cash Flow and P&L both need real bank-transaction/report scopes, and both
  // ride on the exact same resolved date range as the trend chart above — they
  // fetch off `period.range`, the server-resolved dates, rather than
  // recomputing preset math a second time on the frontend.
  const [cashFlow, setCashFlow]           = useState(null);
  const [cashFlowError, setCashFlowError] = useState('');
  const [pnl, setPnl]                     = useState(null);
  const [pnlError, setPnlError]           = useState('');

  // Lazily-loaded directory tabs — fetched once, the first time each is opened.
  // data starts as [] (not null) so the very first render after switching to
  // one of these tabs — before the fetch effect has even fired, while status
  // is still 'idle' — never has to null-check .data.length mid-render.
  const [banking,  setBanking]  = useState({ status: 'idle', data: [], error: '' });
  const [accounts, setAccounts] = useState({ status: 'idle', data: [], error: '' });
  const [contacts, setContacts] = useState({ status: 'idle', data: [], error: '' });
  const [accountSearch, setAccountSearch] = useState('');
  const [contactSearch, setContactSearch] = useState('');

  // Banking tab's statement drill-down — which account, and its transactions.
  const [selectedBankAccount, setSelectedBankAccount] = useState(null);
  const [statement, setStatement] = useState({ status: 'idle', data: [], error: '' });

  // Budget vs Actual — lazily loaded like the directory tabs. `data` stays null
  // until loaded (unlike those, it's an object not a list, so there's nothing
  // meaningful to render half-populated).
  const [budget, setBudget] = useState({ status: 'idle', data: null, error: '' });

  // Performance overview — feeds BOTH the Overview and Revenue tabs from one
  // fetch. monthFrom/monthTo index into data.months, so changing the range
  // re-slices in place without touching the network.
  const [perf, setPerf] = useState({ status: 'idle', data: null, error: '' });
  const [monthFrom, setMonthFrom] = useState(0);
  const [monthTo,   setMonthTo]   = useState(11);
  const [revenueLine, setRevenueLine] = useState('overall');
  // Fetched separately from the figures so an LLM outage or a missing API key
  // can never delay or blank the dashboard itself.
  const [insights, setInsights] = useState(null);
  // Which month the Budget Variance tab compares — a month key, or 'ytd'. Defaults
  // to the current month on load (see fetchBudget), matching Xero's own report,
  // which is titled "For the month ended <current month>".
  const [varianceMonth, setVarianceMonth] = useState('');

  async function fetchSummary(opts = {}) {
    if (opts.force) setRefreshing(true);
    try {
      const params = new URLSearchParams();
      if (opts.force) params.set('force', 'true');
      if (activeTenantId) params.set('tenantId', activeTenantId);
      const d = await api.get(`/xero-reports/summary?${params.toString()}`);
      setData(d);
      setError('');
      if (d.activeTenantId) setActiveTenantId(d.activeTenantId);
    } catch (err) {
      setError(err.message || 'Could not load the dashboard');
    } finally {
      setRefreshing(false);
    }
  }

  async function fetchPeriod(opts = {}) {
    try {
      const params = new URLSearchParams({ preset: rangePreset });
      if (rangePreset === 'custom') { params.set('from', rangeFrom); params.set('to', rangeTo); }
      if (activeTenantId) params.set('tenantId', activeTenantId);
      if (opts.force) params.set('force', 'true');
      const d = await api.get(`/xero-reports/period?${params.toString()}`);
      setPeriod(d);
      setPeriodError('');
    } catch (err) {
      setPeriodError(err.message || 'Could not load this date range');
    }
  }

  async function fetchCashFlow(fromISO, toISO, opts = {}) {
    try {
      const params = new URLSearchParams({ from: fromISO, to: toISO });
      if (activeTenantId) params.set('tenantId', activeTenantId);
      if (opts.force) params.set('force', 'true');
      const d = await api.get(`/xero-reports/bank-summary?${params.toString()}`);
      setCashFlow(d);
      setCashFlowError('');
    } catch (err) {
      setCashFlowError(err.message || 'Could not load cash flow');
    }
  }

  async function fetchPnl(fromISO, toISO, opts = {}) {
    try {
      const params = new URLSearchParams({ from: fromISO, to: toISO });
      if (activeTenantId) params.set('tenantId', activeTenantId);
      if (opts.force) params.set('force', 'true');
      const d = await api.get(`/xero-reports/profit-loss?${params.toString()}`);
      setPnl(d);
      setPnlError('');
    } catch (err) {
      setPnlError(err.message || 'Could not load profit & loss');
    }
  }

  useEffect(() => { fetchSummary(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (activeTenantId) { fetchSummary(); fetchPeriod(); }
    // Budget vs Actual is per-organisation, so a tenant switch invalidates it —
    // refetch if it's on screen, otherwise let the lazy loader pick it up.
    if (tab === 'budget' || tab === 'variance') fetchBudget();
    else setBudget({ status: 'idle', data: null, error: '' });
    if (tab === 'overview' || tab === 'revenue') fetchPerf();
    else setPerf({ status: 'idle', data: null, error: '' });
  }, [activeTenantId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (rangePreset !== 'custom') fetchPeriod();
  }, [rangePreset]); // eslint-disable-line react-hooks/exhaustive-deps
  // Fires off the server-RESOLVED range (not preset math redone client-side) —
  // covers both preset changes and a custom range's Apply click, since either
  // way `period.range` is what actually changes.
  useEffect(() => {
    if (period?.range?.fromISO && period?.range?.toISO) {
      fetchCashFlow(period.range.fromISO, period.range.toISO);
      fetchPnl(period.range.fromISO, period.range.toISO);
    }
  }, [period?.range?.fromISO, period?.range?.toISO]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    tickRef.current = setInterval(() => forceTick(t => t + 1), 15000);
    return () => clearInterval(tickRef.current);
  }, []);

  // Lazy tab loaders — only fire the first time a tab is opened.
  useEffect(() => {
    if (tab === 'banking' && banking.status === 'idle') {
      setBanking(s => ({ ...s, status: 'loading' }));
      api.get(`/xero-reports/bank-accounts${activeTenantId ? `?tenantId=${activeTenantId}` : ''}`)
        .then(d => setBanking({ status: 'done', data: d.bankAccounts || [], error: '' }))
        .catch(err => setBanking({ status: 'done', data: [], error: err.message }));
    }
    if (tab === 'accounts' && accounts.status === 'idle') {
      setAccounts(s => ({ ...s, status: 'loading' }));
      api.get(`/xero-reports/accounts${activeTenantId ? `?tenantId=${activeTenantId}` : ''}`)
        .then(d => setAccounts({ status: 'done', data: d.accounts || [], error: '' }))
        .catch(err => setAccounts({ status: 'done', data: [], error: err.message }));
    }
    if (tab === 'contacts' && contacts.status === 'idle') {
      setContacts(s => ({ ...s, status: 'loading' }));
      api.get(`/xero-reports/contacts${activeTenantId ? `?tenantId=${activeTenantId}` : ''}`)
        .then(d => setContacts({ status: 'done', data: d.contacts || [], error: '' }))
        .catch(err => setContacts({ status: 'done', data: [], error: err.message }));
    }
    // Both budget tabs share one fetch and one cache entry — the Budget Variance
    // view is a different presentation of the same merged data, not a second call.
    if ((tab === 'budget' || tab === 'variance') && budget.status === 'idle') fetchBudget();
    if ((tab === 'overview' || tab === 'revenue') && perf.status === 'idle') fetchPerf();
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  function fetchPerf(opts = {}) {
    setPerf(s => ({ ...s, status: 'loading', error: '' }));
    const params = new URLSearchParams();
    if (activeTenantId) params.set('tenantId', activeTenantId);
    if (opts.force) params.set('force', 'true');
    api.get(`/xero-reports/performance?${params.toString()}`)
      .then(d => {
        setPerf({ status: 'done', data: d, error: '' });
        // Default the range to the whole financial year the first time only —
        // re-clamped afterwards so a tenant switch can't leave it out of bounds.
        const last = Math.max(0, (d.months || []).length - 1);
        setMonthFrom(f => Math.min(f, last));
        setMonthTo(t => (t === 11 || t > last ? last : t));
      })
      .catch(err => setPerf({ status: 'done', data: null, error: err.message }));

    // Commentary arrives after the numbers, never blocking them.
    const ip = new URLSearchParams();
    if (activeTenantId) ip.set('tenantId', activeTenantId);
    if (opts.force) ip.set('force', 'true');
    api.get(`/xero-reports/variance-insights?${ip.toString()}`)
      .then(d => setInsights(d))
      .catch(() => setInsights(null));
  }

  function fetchBudget(opts = {}) {
    setBudget(s => ({ ...s, status: 'loading', error: '' }));
    const params = new URLSearchParams();
    if (activeTenantId) params.set('tenantId', activeTenantId);
    if (opts.force) params.set('force', 'true');
    api.get(`/xero-reports/budget-variance?${params.toString()}`)
      .then(d => {
        setBudget({ status: 'done', data: d, error: '' });
        // Keep an existing selection if it still exists in this org's fiscal year,
        // otherwise land on the current month — the first one still on budget.
        setVarianceMonth(prev => {
          if (prev === 'ytd' || (d.months || []).some(m => m.key === prev)) return prev;
          return (d.months || []).find(m => m.source === 'budget')?.key || d.months?.[0]?.key || '';
        });
      })
      .catch(err => setBudget({ status: 'done', data: null, error: err.message }));
  }

  function viewStatement(account) {
    setSelectedBankAccount(account);
    setStatement({ status: 'loading', data: [], error: '' });
    const params = new URLSearchParams({ accountId: account.accountId });
    if (activeTenantId) params.set('tenantId', activeTenantId);
    api.get(`/xero-reports/bank-transactions?${params.toString()}`)
      .then(d => setStatement({ status: 'done', data: d.transactions || [], error: '' }))
      .catch(err => setStatement({ status: 'done', data: [], error: err.message }));
  }

  const filteredInvoices = useMemo(() => {
    if (!data?.invoices) return [];
    const q = search.trim().toLowerCase();
    return data.invoices.filter(inv => {
      if (statusFilter !== 'all' && inv.status !== statusFilter) return false;
      if (!q) return true;
      return inv.contact.toLowerCase().includes(q) || inv.invoiceNumber.toLowerCase().includes(q);
    });
  }, [data, search, statusFilter]);

  const filteredAccounts = useMemo(() => {
    if (!accounts.data) return [];
    const q = accountSearch.trim().toLowerCase();
    if (!q) return accounts.data;
    return accounts.data.filter(a => a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q) || a.type.toLowerCase().includes(q));
  }, [accounts.data, accountSearch]);

  const filteredContacts = useMemo(() => {
    if (!contacts.data) return [];
    const q = contactSearch.trim().toLowerCase();
    if (!q) return contacts.data;
    return contacts.data.filter(c => c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q));
  }, [contacts.data, contactSearch]);

  if (data === null && !error) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', padding: 32 }}>
        <span style={{ width: 16, height: 16, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' }} />
        Loading dashboard...
      </div>
    );
  }

  if (error && !data) {
    return (
      <div>
        <div className="page-header"><h1>Dashboard</h1></div>
        <div className="alert alert-error"><span className="alert-icon">✕</span>{error}</div>
      </div>
    );
  }

  if (!data.connected) {
    return (
      <div>
        <div className="page-header">
          <h1>Dashboard</h1>
          <p>Live financial data pulled read-only from your connected Xero organisation.</p>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '48px 24px' }}>
          <div style={{ fontSize: 34, marginBottom: 12 }}>🔗</div>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>No Xero connection yet</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 18, maxWidth: 380, marginInline: 'auto' }}>
            This dashboard reads from whatever connection you already set up — nothing to configure here.
            Connect via Custom Connection or your own Xero Web app in Setup first.
          </div>
          <button className="btn btn-primary" onClick={() => navigate('/setup')}>Go to Setup →</button>
        </div>
      </div>
    );
  }

  const { organisation, kpis, tenants } = data;
  const currency = organisation.currency !== '—' ? organisation.currency : '';

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div className="page-header" style={{ marginBottom: 0 }}>
          <h1>Dashboard</h1>
          <p>Live financial data pulled read-only from your connected Xero organisation.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {tenants?.length > 1 && (
            <select className="form-input" style={{ width: 'auto', fontSize: 12 }} value={activeTenantId || ''}
                    onChange={e => setActiveTenantId(e.target.value)}>
              {tenants.map(t => <option key={t.tenantId} value={t.tenantId}>{t.tenantName}</option>)}
            </select>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-muted)' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', display: 'inline-block' }} />
            Synced {formatRelative(new Date(data.fetchedAt).toISOString())}
            {data.cached === false && <span style={{ color: 'var(--accent)', fontWeight: 600 }}>· fresh</span>}
          </div>
          <button className="btn btn-outline btn-sm" disabled={refreshing} onClick={() => {
            fetchSummary({ force: true }); fetchPeriod({ force: true });
            if (period?.range) { fetchCashFlow(period.range.fromISO, period.range.toISO, { force: true }); fetchPnl(period.range.fromISO, period.range.toISO, { force: true }); }
          }}>
            {refreshing ? <span className="btn-spinner" /> : '↻'} Refresh
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error" style={{ marginTop: 14 }}><span className="alert-icon">✕</span>{error}</div>}

      <div className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14, margin: '18px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 44, height: 44, borderRadius: 11, background: 'var(--accent-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19 }}>🏢</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{organisation.name}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Connected via Xero</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span className="badge badge-gray">Country {organisation.country}</span>
          <span className="badge badge-gray">Currency {organisation.currency}</span>
          <span className="badge badge-gray">Year end {organisation.yearEnd}</span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 20 }}>
        <div className="card" style={{ display: 'flex', gap: 13 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--success-subtle)', color: 'var(--success)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, flexShrink: 0 }}>↗</div>
          <div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600 }}>Total Receivables</div>
            <div style={{ fontSize: 20, fontWeight: 800, margin: '3px 0 2px' }}>{fmtMoney(kpis.totalReceivables, currency)}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{kpis.receivablesCount} sales invoice{kpis.receivablesCount !== 1 ? 's' : ''} awaiting payment</div>
          </div>
        </div>
        <div className="card" style={{ display: 'flex', gap: 13 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--danger-subtle)', color: 'var(--danger)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, flexShrink: 0 }}>▣</div>
          <div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600 }}>Total Payables</div>
            <div style={{ fontSize: 20, fontWeight: 800, margin: '3px 0 2px' }}>{fmtMoney(kpis.totalPayables, currency)}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{kpis.payablesCount} bill{kpis.payablesCount !== 1 ? 's' : ''} awaiting payment</div>
          </div>
        </div>
        <div className="card" style={{ display: 'flex', gap: 13 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--warning-subtle)', color: 'var(--warning)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, flexShrink: 0 }}>⏱</div>
          <div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600 }}>Overdue Amount</div>
            <div style={{ fontSize: 20, fontWeight: 800, margin: '3px 0 2px' }}>{fmtMoney(kpis.overdueAmount, currency)}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{kpis.statusBreakdown.overdue} invoice{kpis.statusBreakdown.overdue !== 1 ? 's' : ''} past due</div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 4, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 4, marginBottom: 18, width: 'fit-content', flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)} style={{
            padding: '7px 16px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
            background: tab === t.key ? 'var(--accent-gradient)' : 'transparent',
            color: tab === t.key ? '#fff' : 'var(--text-muted)',
          }}>{t.label}</button>
        ))}
        {PHASE2_TABS.map(t => (
          <span key={t.key} title="Coming later — needs a wider Xero connection scope" style={{
            padding: '7px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, color: 'var(--text-muted)', opacity: 0.5,
            display: 'flex', alignItems: 'center', gap: 6, cursor: 'not-allowed',
          }}>
            {t.label}
            <span style={{ fontSize: 8.5, fontWeight: 800, background: 'var(--bg-secondary)', padding: '1px 5px', borderRadius: 5 }}>PHASE 2</span>
          </span>
        ))}
      </div>

      {(tab === 'overview' || tab === 'revenue') && perf.data && !perf.error && (
        <div className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                       gap: 14, flexWrap: 'wrap', marginBottom: 16, padding: '12px 16px' }}>
          <MonthRange months={perf.data.months} from={monthFrom} to={monthTo}
                      onChange={(f, t) => { setMonthFrom(f); setMonthTo(t); }}
                      label={perf.data.fiscalYear?.label} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
              {perf.data.months.filter(m => m.source === 'actual').length} closed · {perf.data.months.filter(m => m.source === 'budget').length} budgeted
            </span>
            <button className="btn btn-outline btn-sm" disabled={perf.status === 'loading'} onClick={() => fetchPerf({ force: true })}>
              {perf.status === 'loading' ? <span className="btn-spinner" /> : '↻'} Refresh
            </button>
          </div>
        </div>
      )}

      {tab === 'overview' && (
        <>
          {perf.status === 'loading' && !perf.data && (
            <div className="card" style={{ padding: 30, color: 'var(--text-muted)', fontSize: 13 }}>Loading performance data…</div>
          )}
          {perf.error && (
            <div className="alert alert-error" style={{ marginBottom: 16 }}><span className="alert-icon">✕</span>{perf.error}</div>
          )}
          {perf.data && !perf.error && (
            <OverviewPanel data={perf.data} from={monthFrom} to={monthTo} insights={insights} />
          )}

          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 4 }}>
              <div className="card-title" style={{ marginBottom: 0 }}>Invoiced Over Time</div>
            </div>
            <div className="card-subtitle" style={{ marginBottom: 2 }}>Review daily, weekly, monthly, yearly, all time, or a custom range</div>
            <SourceNote>Xero Invoices API</SourceNote>
            <DateRangeControl
              preset={rangePreset} setPreset={setRangePreset}
              from={rangeFrom} to={rangeTo} setFrom={setRangeFrom} setTo={setRangeTo}
              onApplyCustom={() => fetchPeriod()}
            />

            {periodError && <div className="alert alert-error" style={{ marginTop: 14 }}><span className="alert-icon">✕</span>{periodError}</div>}

            {period && !periodError && (
              <>
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', margin: '18px 0', fontSize: 12.5 }}>
                  <div>
                    <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{period.range.fromISO} → {period.range.toISO}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>Invoiced (Sales) </span>
                    <b style={{ color: 'var(--success)' }}>{fmtMoney(period.totals.salesTotal, currency)}</b>
                    <span style={{ color: 'var(--text-muted)' }}> · {period.totals.salesCount}</span>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>Billed </span>
                    <b style={{ color: 'var(--danger)' }}>{fmtMoney(period.totals.billsTotal, currency)}</b>
                    <span style={{ color: 'var(--text-muted)' }}> · {period.totals.billsCount}</span>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>Net </span>
                    <b style={{ color: period.totals.net >= 0 ? 'var(--success)' : 'var(--danger)' }}>{fmtMoney(period.totals.net, currency)}</b>
                  </div>
                </div>
                <PeriodTrendChart trend={period.trend} granularity={period.granularity} currency={currency} />
              </>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
            <div className="card">
              <div className="card-title" style={{ marginBottom: 2 }}>Cash In and Out</div>
              <div className="card-subtitle" style={{ marginBottom: 2 }}>{reportRangeLabel(cashFlow, period?.range)}</div>
              <SourceNote>Xero Bank Summary report</SourceNote>
              {cashFlowError ? (
                <div className="alert alert-error"><span className="alert-icon">✕</span>{cashFlowError}</div>
              ) : !cashFlow ? (
                <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0' }}>Loading…</div>
              ) : (
                <>
                  <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 14, fontSize: 12.5 }}>
                    <div><span style={{ color: 'var(--text-muted)' }}>Cash in </span><b style={{ color: 'var(--success)' }}>{fmtMoney(cashFlow.cashIn, currency)}</b></div>
                    <div><span style={{ color: 'var(--text-muted)' }}>Cash out </span><b style={{ color: 'var(--danger)' }}>{fmtMoney(cashFlow.cashOut, currency)}</b></div>
                    <div><span style={{ color: 'var(--text-muted)' }}>Difference </span><b style={{ color: cashFlow.net >= 0 ? 'var(--success)' : 'var(--danger)' }}>{fmtMoney(cashFlow.net, currency)}</b></div>
                  </div>
                  <TwoBarChart leftLabel="Cash In" leftValue={cashFlow.cashIn} rightLabel="Cash Out" rightValue={cashFlow.cashOut} currency={currency} />
                </>
              )}
            </div>

            <div className="card">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                <div className="card-title" style={{ marginBottom: 0 }}>Net Profit or Loss</div>
                <button type="button" className="btn btn-sm" style={{ background: 'none', color: 'var(--accent)', border: 'none' }} onClick={() => setTab('pnl')}>Full P&amp;L →</button>
              </div>
              <div className="card-subtitle" style={{ marginBottom: 2 }}>{reportRangeLabel(pnl, period?.range)}</div>
              <SourceNote>Xero Profit &amp; Loss report</SourceNote>
              {pnlError ? (
                <div className="alert alert-error"><span className="alert-icon">✕</span>{pnlError}</div>
              ) : !pnl ? (
                <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0' }}>Loading…</div>
              ) : (
                <div>
                  <div style={{ fontSize: 26, fontWeight: 800, color: pnl.netProfit >= 0 ? 'var(--success)' : 'var(--danger)', marginBottom: 4 }}>
                    {fmtMoney(pnl.netProfit, currency)}
                  </div>
                  <div style={{ display: 'flex', gap: 16, fontSize: 12.5, color: 'var(--text-muted)' }}>
                    <span>Income <b style={{ color: 'var(--text-primary)' }}>{fmtMoney(pnl.income, currency)}</b></span>
                    <span>Expenses <b style={{ color: 'var(--text-primary)' }}>{fmtMoney(pnl.expenses, currency)}</b></span>
                    <span>Net margin <b style={{ color: 'var(--text-primary)' }}>{fmtPct(pnl.netMargin)}</b></span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {tab === 'revenue' && (
        <>
          {perf.status === 'loading' && !perf.data && (
            <div className="card" style={{ padding: 30, color: 'var(--text-muted)', fontSize: 13 }}>Loading revenue data…</div>
          )}
          {perf.error && (
            <div className="alert alert-error"><span className="alert-icon">✕</span>{perf.error}</div>
          )}
          {perf.data && !perf.error && (
            <RevenuePanel data={perf.data} from={monthFrom} to={monthTo}
                          selectedLine={revenueLine} onSelectLine={setRevenueLine} />
          )}
        </>
      )}

      {tab === 'invoices' && (
        <>
          {/* Moved here from Overview: aging and invoice status answer "who owes
              me money", which is this tab's question, not the performance
              dashboard's. */}
          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                        color: 'var(--text-muted)', margin: '26px 0 12px' }}>
            Outstanding · right now
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 16, marginBottom: 16 }}>
            <div className="card">
              <div className="card-title" style={{ marginBottom: 2 }}>Receivables vs. Payables</div>
              <div className="card-subtitle" style={{ marginBottom: 2 }}>Hover a bar for the exact amount · right now</div>
              <SourceNote>Xero Invoices API (AUTHORISED, unpaid)</SourceNote>
              <TwoBarChart leftLabel="Receivables" leftValue={kpis.totalReceivables} rightLabel="Payables" rightValue={kpis.totalPayables} currency={currency} />
            </div>
            <div className="card">
              <div className="card-title" style={{ marginBottom: 2 }}>Invoice Status</div>
              <div className="card-subtitle">Sales &amp; bills combined</div>
              <StatusDonut breakdown={kpis.statusBreakdown} />
            </div>
          </div>

          {data.aging && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
              <div className="card">
                <div className="card-title" style={{ marginBottom: 2 }}>Invoices Owed to You</div>
                <div className="card-subtitle" style={{ marginBottom: 10 }}>Outstanding sales invoices, by how soon they're due · right now</div>
                <AgingChart aging={data.aging.receivables} color="var(--success)" currency={currency} />
              </div>
              <div className="card">
                <div className="card-title" style={{ marginBottom: 2 }}>Bills to Pay</div>
                <div className="card-subtitle" style={{ marginBottom: 10 }}>Outstanding bills, by how soon they're due · right now</div>
                <AgingChart aging={data.aging.payables} color="var(--danger)" currency={currency} />
              </div>
            </div>
          )}


        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
            <div className="card-title" style={{ marginBottom: 0 }}>Invoices &amp; Bills</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {['all', 'paid', 'awaiting', 'overdue'].map(s => (
                <button key={s} type="button" onClick={() => setStatusFilter(s)} className="btn btn-sm" style={{
                  background: statusFilter === s ? 'var(--accent-gradient)' : 'var(--bg-secondary)',
                  color: statusFilter === s ? '#fff' : 'var(--text-muted)', border: 'none', textTransform: 'capitalize',
                }}>{s}</button>
              ))}
              <SearchBox value={search} onChange={setSearch} placeholder="Search contact or invoice #..." />
            </div>
          </div>

          {filteredInvoices.length === 0 ? (
            <div className="empty-state" style={{ padding: '30px 0' }}>
              <div className="empty-state-icon">📄</div>
              <div>No invoices match</div>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 11 }}>
                    <th style={{ padding: '6px 10px' }}>Type</th>
                    <th style={{ padding: '6px 10px' }}>Contact</th>
                    <th style={{ padding: '6px 10px' }}>Invoice #</th>
                    <th style={{ padding: '6px 10px' }}>Date</th>
                    <th style={{ padding: '6px 10px' }}>Due Date</th>
                    <th style={{ padding: '6px 10px' }}>Status</th>
                    <th style={{ padding: '6px 10px', textAlign: 'right' }}>Total</th>
                    <th style={{ padding: '6px 10px', textAlign: 'right' }}>Amount Due</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredInvoices.map(inv => {
                    const badge = STATUS_BADGE[inv.status];
                    return (
                      <tr key={inv.invoiceId} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '9px 10px' }}>{inv.type}</td>
                        <td style={{ padding: '9px 10px' }}>{inv.contact}</td>
                        <td style={{ padding: '9px 10px', color: 'var(--text-muted)' }}>{inv.invoiceNumber || '—'}</td>
                        <td style={{ padding: '9px 10px', color: 'var(--text-muted)' }}>{formatDateTime(inv.date, user?.timezone).split(',')[0]}</td>
                        <td style={{ padding: '9px 10px', color: 'var(--text-muted)' }}>{inv.dueDate ? formatDateTime(inv.dueDate, user?.timezone).split(',')[0] : '—'}</td>
                        <td style={{ padding: '9px 10px' }}><span className={`badge ${badge.cls}`}>{badge.label}</span></td>
                        <td style={{ padding: '9px 10px', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(inv.total, inv.currency)}</td>
                        <td style={{ padding: '9px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(inv.amountDue, inv.currency)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        </>
      )}

      {tab === 'banking' && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-title" style={{ marginBottom: 2 }}>Bank &amp; Cash Accounts</div>
            <div className="card-subtitle" style={{ marginBottom: 2 }}>Live balances aren't in Xero's read API for this — see Cash In/Out on Overview for period movement instead. Click an account for its transaction statement.</div>
            <SourceNote>Xero Accounts API (Type=BANK)</SourceNote>
            {banking.status !== 'done' ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0' }}>Loading…</div>
            ) : banking.error ? (
              <div className="alert alert-error"><span className="alert-icon">✕</span>{banking.error}</div>
            ) : banking.data.length === 0 ? (
              <div className="empty-state" style={{ padding: '30px 0' }}><div className="empty-state-icon">🏦</div><div>No bank accounts found in Xero</div></div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead><tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 11 }}>
                    <th style={{ padding: '6px 10px' }}>Code</th><th style={{ padding: '6px 10px' }}>Name</th>
                    <th style={{ padding: '6px 10px' }}>Account Number</th><th style={{ padding: '6px 10px' }}>Currency</th>
                    <th style={{ padding: '6px 10px' }}>Status</th><th style={{ padding: '6px 10px' }}></th>
                  </tr></thead>
                  <tbody>{banking.data.map(a => (
                    <tr key={a.accountId} style={{ borderTop: '1px solid var(--border)', background: selectedBankAccount?.accountId === a.accountId ? 'var(--bg-hover)' : undefined }}>
                      <td style={{ padding: '9px 10px' }}>{a.code || '—'}</td>
                      <td style={{ padding: '9px 10px' }}>{a.name}</td>
                      <td style={{ padding: '9px 10px', color: 'var(--text-muted)' }}>{a.accountNumber || '—'}</td>
                      <td style={{ padding: '9px 10px' }}>{a.currency || '—'}</td>
                      <td style={{ padding: '9px 10px' }}><span className={`badge ${a.status === 'ACTIVE' ? 'badge-green' : 'badge-gray'}`}>{a.status || '—'}</span></td>
                      <td style={{ padding: '9px 10px', textAlign: 'right' }}>
                        <button type="button" className="btn btn-outline btn-sm" onClick={() => viewStatement(a)}>View Transactions</button>
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </div>

          {selectedBankAccount && (
            <div className="card">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                <div className="card-title" style={{ marginBottom: 0 }}>Statement — {selectedBankAccount.name}</div>
                <button type="button" className="btn btn-sm" style={{ background: 'none', color: 'var(--text-muted)', border: 'none' }} onClick={() => setSelectedBankAccount(null)}>✕ Close</button>
              </div>
              <div className="card-subtitle" style={{ marginBottom: 2 }}>Most recent transactions for this account</div>
              <SourceNote>Xero Bank Transactions + Payments API — bill/invoice payments show up here too, not just raw bank entries</SourceNote>
              {statement.status !== 'done' ? (
                <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0' }}>Loading…</div>
              ) : statement.error ? (
                <div className="alert alert-error"><span className="alert-icon">✕</span>{statement.error}</div>
              ) : statement.data.length === 0 ? (
                <div className="empty-state" style={{ padding: '30px 0' }}><div className="empty-state-icon">📄</div><div>No transactions found for this account</div></div>
              ) : (
                <div style={{ overflowX: 'auto', maxHeight: 480, overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                    <thead><tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 11 }}>
                      <th style={{ padding: '6px 10px' }}>Date</th><th style={{ padding: '6px 10px' }}>Type</th>
                      <th style={{ padding: '6px 10px' }}>Contact</th><th style={{ padding: '6px 10px' }}>Reference</th>
                      <th style={{ padding: '6px 10px' }}>Source</th>
                      <th style={{ padding: '6px 10px' }}>Reconciled</th><th style={{ padding: '6px 10px', textAlign: 'right' }}>Amount</th>
                    </tr></thead>
                    <tbody>{statement.data.map(t => (
                      <tr key={t.transactionId} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '9px 10px', color: 'var(--text-muted)' }}>{formatDateTime(t.date, user?.timezone).split(',')[0]}</td>
                        <td style={{ padding: '9px 10px' }}><span className={`badge ${t.type === 'Money In' ? 'badge-green' : 'badge-red'}`}>{t.type}</span></td>
                        <td style={{ padding: '9px 10px' }}>{t.contact}</td>
                        <td style={{ padding: '9px 10px', color: 'var(--text-muted)' }}>{t.reference || '—'}</td>
                        <td style={{ padding: '9px 10px', color: 'var(--text-muted)', fontSize: 11 }}>{t.source === 'payment' ? 'Invoice payment' : 'Bank'}</td>
                        <td style={{ padding: '9px 10px' }}>{t.isReconciled ? '✓' : '—'}</td>
                        <td style={{ padding: '9px 10px', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: t.type === 'Money In' ? 'var(--success)' : 'var(--danger)' }}>
                          {t.type === 'Money In' ? '+' : '−'}{fmtMoney(t.total, currency)}
                        </td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {tab === 'accounts' && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
            <div className="card-title" style={{ marginBottom: 0 }}>Chart of Accounts</div>
            <SearchBox value={accountSearch} onChange={setAccountSearch} placeholder="Search by code, name, or type..." />
          </div>
          <SourceNote>Xero Accounts API</SourceNote>
          {accounts.status !== 'done' ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0' }}>Loading…</div>
          ) : accounts.error ? (
            <div className="alert alert-error"><span className="alert-icon">✕</span>{accounts.error}</div>
          ) : filteredAccounts.length === 0 ? (
            <div className="empty-state" style={{ padding: '30px 0' }}><div className="empty-state-icon">📋</div><div>No accounts match</div></div>
          ) : (
            <div style={{ overflowX: 'auto', maxHeight: 480, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead><tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 11 }}>
                  <th style={{ padding: '6px 10px' }}>Code</th><th style={{ padding: '6px 10px' }}>Name</th>
                  <th style={{ padding: '6px 10px' }}>Type</th><th style={{ padding: '6px 10px' }}>Tax Type</th>
                  <th style={{ padding: '6px 10px' }}>Status</th>
                </tr></thead>
                <tbody>{filteredAccounts.map(a => (
                  <tr key={a.accountId} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '9px 10px' }}>{a.code || '—'}</td>
                    <td style={{ padding: '9px 10px' }}>{a.name}</td>
                    <td style={{ padding: '9px 10px', color: 'var(--text-muted)' }}>{a.type}</td>
                    <td style={{ padding: '9px 10px', color: 'var(--text-muted)' }}>{a.taxType || '—'}</td>
                    <td style={{ padding: '9px 10px' }}><span className={`badge ${a.status === 'ACTIVE' ? 'badge-green' : 'badge-gray'}`}>{a.status || '—'}</span></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'contacts' && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
            <div className="card-title" style={{ marginBottom: 0 }}>Contacts</div>
            <SearchBox value={contactSearch} onChange={setContactSearch} placeholder="Search by name or email..." />
          </div>
          <SourceNote>Xero Contacts API</SourceNote>
          {contacts.status !== 'done' ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0' }}>Loading…</div>
          ) : contacts.error ? (
            <div className="alert alert-error"><span className="alert-icon">✕</span>{contacts.error}</div>
          ) : filteredContacts.length === 0 ? (
            <div className="empty-state" style={{ padding: '30px 0' }}><div className="empty-state-icon">👥</div><div>No contacts match</div></div>
          ) : (
            <div style={{ overflowX: 'auto', maxHeight: 480, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead><tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 11 }}>
                  <th style={{ padding: '6px 10px' }}>Name</th><th style={{ padding: '6px 10px' }}>Email</th>
                  <th style={{ padding: '6px 10px' }}>Customer</th><th style={{ padding: '6px 10px' }}>Supplier</th>
                  <th style={{ padding: '6px 10px' }}>Status</th>
                </tr></thead>
                <tbody>{filteredContacts.map(c => (
                  <tr key={c.contactId} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '9px 10px' }}>{c.name}</td>
                    <td style={{ padding: '9px 10px', color: 'var(--text-muted)' }}>{c.email || '—'}</td>
                    <td style={{ padding: '9px 10px' }}>{c.isCustomer ? '✓' : '—'}</td>
                    <td style={{ padding: '9px 10px' }}>{c.isSupplier ? '✓' : '—'}</td>
                    <td style={{ padding: '9px 10px' }}><span className={`badge ${c.status === 'ACTIVE' ? 'badge-green' : 'badge-gray'}`}>{c.status || '—'}</span></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'pnl' && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 2 }}>Profit &amp; Loss</div>
          <div className="card-subtitle" style={{ marginBottom: 2 }}>Same date range as Overview's Invoiced Over Time</div>
          <SourceNote>Xero Profit &amp; Loss report</SourceNote>
          <DateRangeControl
            preset={rangePreset} setPreset={setRangePreset}
            from={rangeFrom} to={rangeTo} setFrom={setRangeFrom} setTo={setRangeTo}
            onApplyCustom={() => fetchPeriod()}
          />

          {pnl && !pnlError && (
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 10 }}>{reportRangeLabel(pnl, period?.range)}</div>
          )}

          {pnlError && <div className="alert alert-error" style={{ marginTop: 14 }}><span className="alert-icon">✕</span>{pnlError}</div>}

          {pnl && !pnlError && (
            <>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '20px 0' }}>
                <div className="card" style={{ flex: 1, minWidth: 160, background: 'var(--bg-secondary)' }}>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4 }}>Total Income</div>
                  <div style={{ fontSize: 22, fontWeight: 800 }}>{fmtMoney(pnl.income, currency)}</div>
                </div>
                <div className="card" style={{ flex: 1, minWidth: 160, background: 'var(--bg-secondary)' }}>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4 }}>Total Expenses</div>
                  <div style={{ fontSize: 22, fontWeight: 800 }}>{fmtMoney(pnl.expenses, currency)}</div>
                </div>
                <div className="card" style={{ flex: 1, minWidth: 160, background: 'var(--bg-secondary)' }}>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4 }}>Net {pnl.netProfit >= 0 ? 'Profit' : 'Loss'}</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: pnl.netProfit >= 0 ? 'var(--success)' : 'var(--danger)' }}>{fmtMoney(pnl.netProfit, currency)}</div>
                </div>
                <div className="card" style={{ flex: 1, minWidth: 160, background: 'var(--bg-secondary)' }}>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4 }}>Net Margin</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: pnl.netMargin >= 0 ? 'var(--success)' : 'var(--danger)' }}>{fmtPct(pnl.netMargin)}</div>
                </div>
              </div>
              <TwoBarChart leftLabel="Income" leftValue={pnl.income} rightLabel="Expenses" rightValue={pnl.expenses} currency={currency} />
            </>
          )}
        </div>
      )}

      {tab === 'budget' && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div className="card-title" style={{ marginBottom: 2 }}>Budget vs Actual</div>
              <div className="card-subtitle" style={{ marginBottom: 2 }}>
                {budget.data?.fiscalYear?.label || 'Current financial year by month'}
              </div>
              <SourceNote>Xero Profit &amp; Loss (actuals) + Budget Summary — Overall Budget</SourceNote>
            </div>
            <button className="btn btn-outline btn-sm" disabled={budget.status === 'loading'} onClick={() => fetchBudget({ force: true })}>
              {budget.status === 'loading' ? <span className="btn-spinner" /> : '↻'} Refresh
            </button>
          </div>

          {budget.status === 'loading' && <div style={{ padding: 28, color: 'var(--text-muted)', fontSize: 13 }}>Loading budget report...</div>}

          {budget.error && (
            <div className="alert alert-error" style={{ marginTop: 14 }}><span className="alert-icon">✕</span>{budget.error}</div>
          )}

          {budget.status === 'done' && !budget.error && budget.data && (() => {
            const d   = budget.data;
            const cur = d.organisation?.currency || currency;
            const k   = d.kpis;
            const tiles = [
              { label: `Actual to date (${k.monthsElapsed}mo)`, value: k.ytdActualNet, hint: 'Net profit, completed months' },
              { label: `Budget remaining (${k.monthsTotal - k.monthsElapsed}mo)`, value: k.restOfYearNet, hint: 'Net profit still budgeted' },
              { label: 'Full-year forecast', value: k.forecastNet, hint: 'Actual to date + budget ahead' },
            ];
            return (
              <>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '18px 0 4px' }}>
                  {tiles.map(t => (
                    <div key={t.label} className="card" style={{ flex: 1, minWidth: 180, background: 'var(--bg-secondary)' }}>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4 }}>{t.label}</div>
                      <div style={{ fontSize: 21, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: t.value < 0 ? 'var(--danger)' : 'var(--success)' }}>
                        {fmtMoney(t.value, cur)}
                      </div>
                      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>{t.hint}</div>
                    </div>
                  ))}
                  <div className="card" style={{ flex: 1, minWidth: 180, background: 'var(--bg-secondary)' }}>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4 }}>Progress</div>
                    <div style={{ fontSize: 21, fontWeight: 800 }}>{k.monthsElapsed} <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)' }}>of {k.monthsTotal} months</span></div>
                    <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>
                      {d.months.find(m => m.source === 'budget')?.label || '—'} onward is budget
                    </div>
                  </div>
                </div>

                <BudgetGrid months={d.months} rows={d.rows} />

                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 14, lineHeight: 1.6 }}>
                  A month shows actuals only once it has fully closed — the current month reads as budget, since its
                  income may be invoiced before its costs are entered. Section names come from Xero&apos;s standard
                  Profit &amp; Loss layout; a custom report layout in Xero may label them differently.
                </div>
              </>
            );
          })()}
        </div>
      )}

      {tab === 'variance' && (
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
            <button className="btn btn-outline btn-sm" disabled={budget.status === 'loading'} onClick={() => fetchBudget({ force: true })}>
              {budget.status === 'loading' ? <span className="btn-spinner" /> : '↻'} Refresh
            </button>
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
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '14px 0 4px' }}>
                  {d.months.map(m => (
                    <button key={m.key} type="button" onClick={() => setVarianceMonth(m.key)} style={{
                      padding: '5px 10px', fontSize: 11.5, fontWeight: 600, borderRadius: 7, cursor: 'pointer',
                      border: `1px solid ${varianceMonth === m.key ? 'transparent' : 'var(--border)'}`,
                      background: varianceMonth === m.key ? 'var(--accent-gradient)' : 'transparent',
                      color: varianceMonth === m.key ? '#fff' : (m.source === 'actual' ? 'var(--text-secondary)' : 'var(--text-muted)'),
                    }}>{m.label}</button>
                  ))}
                  <button type="button" onClick={() => setVarianceMonth('ytd')} style={{
                    padding: '5px 10px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, cursor: 'pointer',
                    border: `1px solid ${varianceMonth === 'ytd' ? 'transparent' : 'var(--border)'}`,
                    background: varianceMonth === 'ytd' ? 'var(--accent-gradient)' : 'transparent',
                    color: varianceMonth === 'ytd' ? '#fff' : 'var(--text-muted)',
                  }}>Year to date</button>
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
                      <div key={t.label} className="card" style={{ flex: 1, minWidth: 165, background: 'var(--bg-secondary)' }}>
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4 }}>{t.label}</div>
                        <div style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: t.color }}>{t.value}</div>
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
      )}
    </div>
  );
}
