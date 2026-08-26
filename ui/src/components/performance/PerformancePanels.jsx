import { useMemo, useState } from 'react';
import { fmtMoney, fmtMoneyShort, fmtPct } from '../../utils/format';

// Dashboard → Overview and Revenue.
//
// Every figure here comes from /api/xero-reports/performance, which is composed
// from the Profit & Loss and Budget Summary reports. Nothing is modelled,
// estimated or carried over from a spreadsheet: a metric Xero cannot answer
// renders as an em dash with the reason, never as a zero.
//
// The backend returns all twelve months whole, so the month-range control below
// re-slices in place without another request.

const SERIES_COLORS = ['var(--accent)', 'var(--success)', '#b8860b', '#8b5cf6', '#0ea5e9', '#f97316'];

function sum(a) { return a.reduce((s, v) => s + v, 0); }
function slice(series, from, to) { return series.slice(from, to + 1); }
function sliceSum(series, from, to) { return sum(slice(series, from, to)); }

// ── Month range ──────────────────────────────────────────────────────────────
// Two selects rather than a date picker: the underlying reports are monthly, so
// offering arbitrary days would imply a precision the data doesn't have.
// The 12-month windows a single pair of Xero calls can cover. Anything wider
// would need several calls stitched together, so it isn't offered here.
// Quick picks. Each resolves server-side from the ORG's own fiscal year end, so
// "financial year to date" means Apr-to-now for a March year end and Jan-to-now
// for a December one — no per-company configuration.
export const PRESETS = [
  { key: 'this-month',   label: 'This month' },
  { key: 'last-month',   label: 'Last month' },
  { key: 'this-quarter', label: 'This quarter' },
  { key: 'last-quarter', label: 'Last quarter' },
  { key: 'fy-ytd',       label: 'Financial year to date' },
  { key: 'cy-ytd',       label: 'Calendar year to date' },
  { key: 'fy',           label: 'This financial year' },
  { key: 'prev-fy',      label: 'Previous financial year' },
  { key: 'next-fy',      label: 'Next financial year' },
  { key: 'cy',           label: 'Calendar year' },
  { key: 'last-3',       label: 'Last 3 months' },
  { key: 'last-6',       label: 'Last 6 months' },
  { key: 'last-12',      label: 'Last 12 months' },
];

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Two independent controls. The preset is a shortcut that SETS the range; the
// range itself spans years and is never limited to whatever the preset chose —
// constraining one by the other was what made the old control unusable.
export function MonthRange({ months, from, to, onChange, label, preset, onPreset, onRange, chunks }) {
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 11 }, (_, i) => thisYear - 7 + i);
  const sel = { width: 'auto', fontSize: 12, padding: '5px 8px' };

  // The range pickers work in absolute year+month, independent of the months the
  // current period happens to contain.
  const parse = k => ({ y: Number(String(k).slice(0, 4)), m: Number(String(k).slice(5, 7)) });
  const fromKey = months?.[from]?.key || months?.[0]?.key;
  const toKey   = months?.[to]?.key   || months?.[months.length - 1]?.key;
  if (!fromKey || !toKey) return null;
  const F = parse(fromKey), T = parse(toKey);
  const emit = (f, t) => onRange(`${f.y}-${String(f.m).padStart(2, '0')}`, `${t.y}-${String(t.m).padStart(2, '0')}`);

  const picker = (v, onY, onM) => (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      <select className="form-input" style={sel} value={v.m} onChange={e => onM(Number(e.target.value))}>
        {MONTH_ABBR.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
      </select>
      <select className="form-input" style={sel} value={v.y} onChange={e => onY(Number(e.target.value))}>
        {years.map(y => <option key={y} value={y}>{y}</option>)}
      </select>
    </span>
  );

  const span = months.length;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
        Period
      </span>
      <select className="form-input" style={sel} value={preset} onChange={e => onPreset(e.target.value)}>
        {PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
        <option value="custom">Custom range…</option>
      </select>

      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>·</span>
      {picker(F, y => emit({ ...F, y }, T), m => emit({ ...F, m }, T))}
      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>→</span>
      {picker(T, y => emit(F, { ...T, y }), m => emit(F, { ...T, m }))}

      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        {span} month{span === 1 ? '' : 's'}
        {chunks > 1 && ` · ${chunks} Xero fetches`}
        {label ? ` · ${label}` : ''}
      </span>
    </div>
  );
}

// ── Building blocks ──────────────────────────────────────────────────────────

// The reference dashboard's signature card: label, big value, a thin meter, and
// two footnotes. `meter` is a 0-100 fill, or null when there's nothing sensible
// to measure against — an unfilled bar reads as "zero", which would be a lie.
function Metric({ label, value, meter, footLeft, footRight, tone }) {
  const width = meter === null || meter === undefined ? null : Math.max(0, Math.min(100, meter));
  return (
    <div className="card" style={{ flex: 1, minWidth: 190, background: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{label}</div>
      <div>
        <div style={{ fontSize: 23, fontWeight: 800, fontVariantNumeric: 'tabular-nums', lineHeight: 1.15, color: tone }}>{value}</div>
        {width !== null && (
          <div style={{ height: 3, borderRadius: 2, background: 'var(--bg-hover)', marginTop: 8, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${width}%`, background: tone || 'var(--accent)', borderRadius: 2, transition: 'width .4s ease' }} />
          </div>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 10.5, color: 'var(--text-muted)' }}>
        <span>{footLeft}</span><span>{footRight}</span>
      </div>
    </div>
  );
}

function Surface({ title, right, children, flex = 1, minWidth = 320 }) {
  return (
    <div className="card" style={{ flex, minWidth, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
        <div className="card-title" style={{ marginBottom: 0 }}>{title}</div>
        {right && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{right}</span>}
      </div>
      {children}
    </div>
  );
}

function Empty({ children }) {
  return <div style={{ padding: '26px 0', textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>{children}</div>;
}

// Horizontal bars — used for the service-line mix and the margin bridge. Scaled
// against the largest ABSOLUTE value so a negative bar (a credit note month)
// still renders at a truthful length.
function BarList({ items, currency, showPctOfTotal }) {
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
                {it.tag && <span style={{ marginLeft: 6, fontSize: 9.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--accent)' }}>{it.tag}</span>}
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
function MonthlyBars({ months, actual, budget, currency, height = 190, showBudget = true }) {
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
function TrendChart({ mode, ...rest }) {
  return mode === 'line' ? <MonthlyLine {...rest} /> : <MonthlyBars {...rest} />;
}

function ChartModeToggle({ mode, onChange }) {
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

// Real variance figures, each with the model's suggested cause where one was
// generated. The figures are always shown; the prose is additive and clearly
// marked, so an LLM outage degrades this card rather than emptying it.
function VarianceReasons({ items, insights, currency }) {
  if (!items.length) return <Empty>Nothing differs from budget in this range.</Empty>;
  const reasonFor = new Map((insights?.lines || []).map(l => [l.account, l.reason]).filter(([, r]) => r));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
      {items.map(it => {
        const reason = reasonFor.get(it.label);
        const neg = it.v < 0;
        return (
          <div key={it.label}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5 }}>
              <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, flexShrink: 0,
                             color: neg ? 'var(--danger)' : 'var(--success)' }}>
                {neg ? '' : '+'}{fmtMoney(it.v, currency)}
              </span>
            </div>
            {reason && (
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.5 }}>{reason}</div>
            )}
          </div>
        );
      })}
      <div style={{ fontSize: 10, color: 'var(--text-muted)', borderTop: '1px solid var(--border)', paddingTop: 9, lineHeight: 1.5 }}>
        {insights?.source === 'gemini'
          ? 'Figures are computed from Xero. The explanations are AI-suggested causes to verify, not statements of fact.'
          : (insights?.reason || 'Figures are computed from Xero.')}
      </div>
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
function Waterfall({ steps, currency, height = 240 }) {
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

// A signed delta. Null renders as an em dash with the reason — growth measured
// from a zero or negative base is undefined, and showing it as 0% or ∞ would
// invite the reader to quote a number nobody computed.
function GrowthPill({ value, title }) {
  if (value === null || value === undefined) {
    return <span title={title || 'No comparable prior period'} style={{ fontSize: 11, color: 'var(--text-muted)' }}>—</span>;
  }
  const up = value >= 0;
  return (
    <span title={title} style={{ fontSize: 11, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: up ? 'var(--success)' : 'var(--danger)' }}>
      {up ? '\u25B2' : '\u25BC'} {fmtPct(Math.abs(value), 1)}
    </span>
  );
}

// Multi-currency organisations only. Xero reports in base currency and returns
// documents in their own, so the conversion is stated rather than left to be
// assumed. Single-currency orgs render nothing.
function CurrencyNote({ currency, style }) {
  if (!currency?.mixed) return null;
  return (
    <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5, ...style }}>
      Includes {currency.currencies.join(', ')} converted to {currency.baseCurrency || 'base currency'} at the rate Xero stamped on each document.
      {currency.unconvertible > 0 && (
        <span style={{ color: 'var(--warning)' }}>
          {' '}{currency.unconvertible} had no rate and {currency.unconvertible === 1 ? 'is' : 'are'} counted at face value.
        </span>
      )}
    </div>
  );
}

function ScoreCard({ items }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
      {items.map(it => (
        <div key={it.label} style={{ background: 'var(--bg-secondary)', borderRadius: 9, padding: '11px 13px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 5 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{it.label}</span>
            <span style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>{it.target}</span>
          </div>
          <div style={{ fontSize: 18, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: it.tone }}>{it.value}</div>
          {it.note && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>{it.note}</div>}
        </div>
      ))}
    </div>
  );
}

// Compact data-trust band. Sits directly under the health strip because it says
// whether the figures below can be believed — that belongs before them, not
// buried three rows down.
function WatchBand({ items }) {
  if (!items?.length) return null;
  return (
    <div className="card" style={{ marginBottom: 16, padding: '11px 16px', borderLeft: '3px solid var(--warning)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map((w, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11.5, lineHeight: 1.5 }}>
            <span style={{ flexShrink: 0, color: w.severity === 'warn' ? 'var(--warning)' : 'var(--text-muted)' }}>
              {w.severity === 'warn' ? '▲' : '•'}
            </span>
            <span style={{ color: 'var(--text-secondary)' }}>{w.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Two series in ONE plot. The recurring/project split was previously drawn as
// two separate charts stacked vertically, which makes the mix impossible to read
// — comparing bar heights across two independently-scaled plots is exactly the
// comparison the card exists to make. Shared scale, side-by-side bars.
function GroupedMonthlyBars({ months, series, currency, height = 200 }) {
  const n = months.length;
  if (!n) return <Empty>Pick a wider period.</Empty>;
  const all = series.flatMap(s => s.values);
  if (!all.some(v => v !== 0)) return <Empty>Nothing recorded in this period.</Empty>;

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
                    <title>{`${m.label} · ${s.label}: ${fmtMoney(v, currency)}`}</title>
                  </rect>
                );
              })}
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

function Legend({ items }) {
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 10.5, color: 'var(--text-muted)', marginTop: 8 }}>
      {items.map(i => (
        <span key={i.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 9, height: 9, borderRadius: 2, background: i.color, opacity: i.opacity ?? 1, display: 'inline-block' }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

function Rows({ items, currency }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {items.map(r => (
        <div key={r.label} style={{
          display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', fontSize: 12.5,
          borderTop: r.strong ? '1px solid var(--border)' : undefined,
          fontWeight: r.strong ? 700 : 400,
        }}>
          <span style={{ color: r.strong ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{r.label}</span>
          <span style={{ fontVariantNumeric: 'tabular-nums', color: r.value < 0 ? 'var(--danger)' : undefined }}>
            {r.value === 0 ? <span style={{ color: 'var(--text-muted)' }}>—</span> : fmtMoney(r.value, currency)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Shared derivation ────────────────────────────────────────────────────────
// Every headline number for the selected range, derived in one place so Overview
// and Revenue can never disagree about what "total revenue" means.
function useRangeTotals(d, from, to) {
  return useMemo(() => {
    if (!d) return null;
    const t = d.totals;
    const S = (series, kind) => sliceSum(series[kind], from, to);
    const revenue     = S(t.revenue, 'actual');
    const otherIncome = S(t.otherIncome, 'actual');
    const cogs        = S(t.cogs, 'actual');
    const opex        = S(t.opex, 'actual');
    const netProfit   = S(t.netProfit, 'actual');
    const grossProfit = S(t.grossProfit, 'actual') || (revenue - cogs);
    const recurring   = sliceSum(d.split.recurring.actual, from, to);
    const project     = sliceSum(d.split.project.actual, from, to);
    return {
      revenue, otherIncome, cogs, opex, netProfit, grossProfit, recurring, project,
      revenueBudget:   S(t.revenue, 'budget'),
      netProfitBudget: S(t.netProfit, 'budget'),
      grossMargin:  revenue !== 0 ? grossProfit / revenue : null,
      netMargin:    revenue !== 0 ? netProfit / revenue : null,
      recurringMix: (recurring + project) !== 0 ? recurring / (recurring + project) : null,
    };
  }, [d, from, to]);
}

function rangeLabel(months, from, to) {
  if (!months?.length) return '';
  return from === to ? months[from].label : `${months[from].label} – ${months[to].label}`;
}

// How many of the selected months are closed — the honest denominator for
// anything described as "actual".
function closedInRange(d, from, to) {
  return Math.max(0, Math.min(d.actualThroughIdx, to) - from + 1);
}

// Revenue momentum for the SELECTED range, recomputed as the range moves — the
// server's figure covers the whole period, and a control the reader just dragged
// should move the numbers underneath it.
//
// Uses closedThroughIdx, not actualThroughIdx: the latter includes the current
// month, which is partial, and comparing a half-finished month against a
// complete one manufactures a collapse that is only the calendar.
function rangeGrowth(d, from, to) {
  const series = d?.totals?.revenue?.actual || [];
  const closedIdx = d?.closedThroughIdx ?? -1;
  const lastClosed = Math.min(closedIdx, to);
  if (lastClosed < from || lastClosed < 0) return { available: false, closedMonths: 0 };

  const n = lastClosed - from + 1;
  const pct = (c, p) => (Number.isFinite(c) && Number.isFinite(p) && p > 0) ? (c - p) / p : null;
  const label = i => (i >= 0 && i < d.months.length ? d.months[i].label : null);
  const yoyIdx = lastClosed - 12;

  return {
    available: true,
    closedMonths: n,
    latest: series[lastClosed], latestLabel: label(lastClosed),
    mom: n >= 2 ? pct(series[lastClosed], series[lastClosed - 1]) : null,
    momLabel: n >= 2 ? label(lastClosed - 1) : null,
    // Deliberately reaches outside the selected range: the year-ago comparator
    // is fixed by the calendar, not by what the reader happens to have selected.
    yoy: yoyIdx >= 0 ? pct(series[lastClosed], series[yoyIdx]) : null,
    yoyLabel: yoyIdx >= 0 ? label(yoyIdx) : null,
  };
}

// ── Overview ─────────────────────────────────────────────────────────────────
export function OverviewPanel({ data, from, to, insights, summary }) {
  const [trendMode, setTrendMode] = useState('bar');
  const cur = data.organisation?.currency || '';
  const T   = useRangeTotals(data, from, to);
  const months = data.months.slice(from, to + 1);
  const closed = closedInRange(data, from, to);
  if (!T) return null;

  const healthy = T.netProfit > 0 && (T.grossMargin === null || T.grossMargin > 0);
  const cash = data.cash?.available ? data.cash.total : null;
  const g = rangeGrowth(data, from, to);

  const serviceItems = data.serviceLines
    .filter(l => !l.otherIncome)
    .map(l => ({ label: l.label, value: sliceSum(l.actual, from, to), tag: l.recurring ? 'recurring' : null }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  // Days Sales Outstanding: how long invoiced revenue takes to become cash.
  // Receivables come from the invoice summary, revenue from the P&L — both
  // already on the page, so this costs no extra call. Undefined without revenue.
  const days = months.length * 30.44;
  const receivables = summary?.kpis?.totalReceivables ?? null;
  const dso = (receivables !== null && T.revenue > 0) ? (receivables / T.revenue) * days : null;
  const overdue = summary?.kpis?.overdueAmount ?? null;

  const scorecard = [
    { label: 'Recurring mix', target: 'Higher is steadier',
      value: T.recurringMix === null ? '—' : fmtPct(T.recurringMix, 0),
      note: T.recurringMix === null ? 'No revenue yet' : `${fmtMoney(T.recurring, cur)} recurring` },
    { label: 'Budget attainment', target: 'Target 100%',
      value: T.revenueBudget > 0 ? fmtPct(T.revenue / T.revenueBudget, 0) : '—',
      tone: T.revenueBudget > 0 && T.revenue < T.revenueBudget ? 'var(--danger)' : 'var(--success)',
      note: T.revenueBudget > 0 ? `vs ${fmtMoney(T.revenueBudget, cur)}` : 'Nothing budgeted' },
    { label: 'Expense ratio', target: 'Lower is better',
      value: T.revenue > 0 ? fmtPct((T.cogs + T.opex) / T.revenue, 0) : '—',
      note: T.revenue > 0 ? `${fmtMoney(T.cogs + T.opex, cur)} of costs` : 'No revenue yet' },
    { label: 'Debtor days', target: 'Lower is better',
      value: dso === null ? '—' : `${Math.round(dso)} days`,
      tone: dso !== null && dso > 60 ? 'var(--warning)' : undefined,
      note: receivables === null ? 'Needs invoice data'
            : overdue > 0 ? `${fmtMoney(overdue, cur)} overdue` : `${fmtMoney(receivables, cur)} outstanding` },
    // Level without direction makes the reader do the differencing themselves.
    { label: 'Revenue growth', target: 'Month on month',
      value: g.mom === null ? '—' : `${g.mom >= 0 ? '+' : ''}${fmtPct(g.mom, 1)}`,
      tone: g.mom === null ? undefined : g.mom >= 0 ? 'var(--success)' : 'var(--danger)',
      note: g.mom === null
        ? (g.available ? 'Needs two closed months' : 'No closed month in range')
        : `${g.latestLabel} vs ${g.momLabel}` },
  ];

  const varianceItems = [...data.serviceLines, ...data.expenseLines]
    .map(l => ({ label: l.label, a: sliceSum(l.actual, from, to), b: sliceSum(l.budget, from, to) }))
    .map(l => ({ ...l, v: l.a - l.b }))
    .filter(l => l.v !== 0)
    .sort((x, y) => Math.abs(y.v) - Math.abs(x.v))
    .slice(0, 6);

  return (
    <>
      {/* Health strip — the reference dashboard's top banner, but the verdict is
          derived from the figures rather than a stored status. */}
      <div className="card" style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap',
        borderLeft: `3px solid ${healthy ? 'var(--success)' : 'var(--warning)'}`, marginBottom: 16,
      }}>
        <div style={{ fontSize: 13 }}>
          <strong style={{ color: healthy ? 'var(--success)' : 'var(--warning)' }}>
            {healthy ? 'Trading profitably' : 'Needs attention'}
          </strong>
          <span style={{ color: 'var(--text-muted)' }}>
            {' '}· {closed} of {months.length} month{months.length === 1 ? '' : 's'} in range closed
            {data.watchList.length > 0 && ` · ${data.watchList.length} item${data.watchList.length === 1 ? '' : 's'} to review`}
          </span>
        </div>
        <div style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
          {fmtMoney(T.revenue, cur)} revenue · {T.netMargin === null ? '—' : fmtPct(T.netMargin)} net margin
        </div>
      </div>

      <WatchBand items={data.watchList} />

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <Metric label="Total revenue" value={fmtMoney(T.revenue, cur)}
                meter={T.revenueBudget > 0 ? (T.revenue / T.revenueBudget) * 100 : null}
                footLeft={T.recurringMix === null ? 'No revenue yet' : `${fmtPct(T.recurringMix, 0)} recurring`}
                footRight={T.revenueBudget > 0 ? `${fmtPct(T.revenue / T.revenueBudget, 0)} of budget` : 'No budget set'} />
        <Metric label="Gross margin" value={T.grossMargin === null ? '—' : fmtPct(T.grossMargin)}
                meter={T.grossMargin === null ? null : T.grossMargin * 100}
                footLeft={`${fmtMoney(T.grossProfit, cur)} gross profit`}
                footRight={T.cogs === 0 ? 'No cost of sales booked' : `${fmtMoney(T.cogs, cur)} cost of sales`} />
        <Metric label="Net margin" value={T.netMargin === null ? '—' : fmtPct(T.netMargin)}
                meter={T.netMargin === null ? null : T.netMargin * 100}
                tone={T.netProfit < 0 ? 'var(--danger)' : undefined}
                footLeft={`${fmtMoney(T.netProfit, cur)} net`}
                footRight={`${fmtMoney(T.opex, cur)} operating costs`} />
        <Metric label="Cash at bank" value={cash === null ? '—' : fmtMoney(cash, cur)}
                meter={null}
                footLeft={cash === null ? 'Bank summary unavailable' : `${data.cash.accounts.length} account${data.cash.accounts.length === 1 ? '' : 's'}`}
                footRight={cash === null ? '' : 'Closing balance'} />
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <Surface title="Revenue by service line" right={T.recurringMix === null ? null : `${fmtPct(T.recurringMix, 0)} recurring`} flex={7} minWidth={380}>
          <BarList items={serviceItems} currency={cur} showPctOfTotal />
          <div style={{ marginTop: 12, padding: '8px 10px', borderRadius: 8, background: 'var(--bg-secondary)',
                        fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.55 }}>
            <strong style={{ color: 'var(--warning)' }}>Inferred, not reported.</strong>{' '}
            Xero has no "this account is recurring" flag, so this split is guessed from account names.
            {data.recurringAccounts.length > 0
              ? ` Treated as recurring: ${data.recurringAccounts.join(', ')}.`
              : ' No account name matched, so everything counts as project revenue.'}
            {' '}Setting up Repeating Invoices in Xero would make this a reported figure instead of a guess.
          </div>
        </Surface>
        <Surface title="Executive snapshot" right={rangeLabel(data.months, from, to)} flex={5} minWidth={300}>
          <Rows currency={cur} items={[
            { label: 'Total revenue',     value: T.revenue, strong: true },
            { label: 'Recurring revenue', value: T.recurring },
            { label: 'Project revenue',   value: T.project },
            { label: 'Cost of sales',     value: T.cogs },
            { label: 'Gross profit',      value: T.grossProfit, strong: true },
            { label: 'Other income',      value: T.otherIncome },
            { label: 'Operating expenses', value: T.opex },
            { label: 'Net profit',        value: T.netProfit, strong: true },
          ]} />
        </Surface>
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <Surface title="Margin bridge" flex={6} minWidth={340}>
          <BarList currency={cur} items={[
            { label: 'Revenue',            value: T.revenue,     color: 'var(--accent)' },
            { label: 'Cost of sales',      value: T.cogs,        color: 'var(--text-muted)' },
            { label: 'Operating expenses', value: T.opex,        color: '#b8860b' },
            { label: 'Net profit',         value: T.netProfit,   color: T.netProfit < 0 ? 'var(--danger)' : 'var(--success)' },
          ]} />
        </Surface>
        <Surface title="KPI scorecard" right={rangeLabel(data.months, from, to)} flex={6} minWidth={340}>
          <ScoreCard items={scorecard} />
        </Surface>
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <Surface title="Revenue trend" right={<ChartModeToggle mode={trendMode} onChange={setTrendMode} />} flex={7} minWidth={380}>
          {/* Follows the month range, same as every other figure on this panel —
              a chart showing a different period from the numbers beside it is
              worse than a short chart. */}
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 8 }}>
            {rangeLabel(data.months, from, to)}
            {from === to && ' · widen the range to see a trend'}
          </div>
          <TrendChart mode={trendMode} months={months} currency={cur}
                      actual={slice(data.totals.revenue.actual, from, to)}
                      budget={slice(data.totals.revenue.budget, from, to)} />
          <Legend items={[{ label: 'Actual', color: 'var(--accent)' }, { label: 'Budget', color: 'var(--text-muted)', opacity: 0.32 }]} />
          {/* Direction alongside level. Closed months only — the current month
              is partial and would read as a crash every time. */}
          {g.available && (
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                Month on month{' '}
                <GrowthPill value={g.mom} title={g.momLabel ? `${g.latestLabel} vs ${g.momLabel}` : 'Needs two closed months'} />
                {g.momLabel && <span> · {g.latestLabel} vs {g.momLabel}</span>}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                Year on year{' '}
                <GrowthPill value={g.yoy} title={g.yoyLabel ? `${g.latestLabel} vs ${g.yoyLabel}` : 'Needs 13 months of history'} />
                {g.yoyLabel ? <span> · {g.latestLabel} vs {g.yoyLabel}</span> : <span> · needs a full prior year</span>}
              </div>
            </div>
          )}
        </Surface>
        <Surface title="Variance reasons"
                 right={insights?.source === 'gemini'
                   ? <span style={{ fontSize: 10, color: 'var(--accent)' }}>AI-suggested</span>
                   : 'Actual − budget'}
                 flex={5} minWidth={300}>
          <VarianceReasons items={varianceItems} insights={insights} currency={cur} />
        </Surface>
      </div>
    </>
  );
}

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

// ── Cash flow ────────────────────────────────────────────────────────────────
// Xero has no cash-flow-statement endpoint, so every figure here is constructed
// from Bank Summary, Payments, Bank Transactions and Invoices.
export function CashFlowPanel({ data }) {
  const cur = data.organisation?.currency || '';
  const m   = data.movement;
  const wc  = data.workingCapital;
  const fc  = data.forecast;
  const rec = data.reconciliation;
  const rw  = data.runway  || { available: false };
  const wf  = data.waterfall;
  const months = data.months;

  const runwayTone = !rw.available ? undefined
    : !rw.burning ? 'var(--success)'
    : rw.runwayMonths < 3 ? 'var(--danger)'
    : rw.runwayMonths < 6 ? 'var(--warning)' : undefined;

  const collectionTone = wc.collectionRate === null ? undefined
    : wc.collectionRate < 0.5 ? 'var(--danger)' : wc.collectionRate < 0.9 ? 'var(--warning)' : 'var(--success)';

  return (
    <>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <Metric label="Cash at bank" value={data.cash.available ? fmtMoney(data.cash.closing, cur) : '—'}
                meter={null}
                footLeft={data.cash.available ? `${data.cash.accounts.length} account${data.cash.accounts.length === 1 ? '' : 's'}` : 'Bank summary unavailable'}
                footRight="Closing balance" />
        <Metric label="Cash in" value={fmtMoney(data.cash.available ? data.cash.cashIn : m.cashIn, cur)} meter={null}
                tone="var(--success)"
                footLeft={`${fmtMoney(m.customerReceipts, cur)} from customers`}
                footRight={`${fmtMoney(m.otherReceipts, cur)} other`} />
        <Metric label="Cash out" value={fmtMoney(data.cash.available ? data.cash.cashOut : m.cashOut, cur)} meter={null}
                tone="var(--danger)"
                footLeft={`${fmtMoney(m.supplierPayments, cur)} to suppliers`}
                footRight={`${fmtMoney(m.otherPayments, cur)} other`} />
        <Metric label="Collection rate"
                value={wc.collectionRate === null ? '—' : fmtPct(wc.collectionRate, 0)}
                meter={wc.collectionRate === null ? null : wc.collectionRate * 100}
                tone={collectionTone}
                footLeft={`${fmtMoney(wc.collected, cur)} collected`}
                footRight={`of ${fmtMoney(wc.invoiced, cur)} invoiced`} />
        {/* Running out of cash is what actually closes small businesses, so the
            runway sits alongside the balance rather than buried below it. A
            cash-positive month has no runway to report — it says so instead of
            rendering an infinity. */}
        <Metric label={rw.available && !rw.burning ? 'Net cash flow' : 'Cash runway'}
                value={!rw.available ? '—'
                     : !rw.burning ? `${fmtMoney(rw.avgNet, cur)}/mo`
                     : rw.runwayMonths >= 24 ? '24+ months'
                     : `${rw.runwayMonths.toFixed(1)} months`}
                meter={rw.available && rw.burning ? Math.min(100, (rw.runwayMonths / 12) * 100) : null}
                tone={runwayTone}
                footLeft={!rw.available ? 'No closed month yet'
                        : rw.burning ? `Burning ${fmtMoney(rw.netBurn, cur)}/mo net`
                        : 'Taking in more than it spends'}
                footRight={rw.available ? `${rw.months}-mo avg${rw.partial ? ', partial' : ''}` : ''} />
      </div>

      {/* Revenue and cash tell opposite stories when nothing has been collected,
          so the gap is stated rather than left for the reader to spot. */}
      {rec.notCollected !== 0 && (
        <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid var(--warning)' }}>
          <div className="card-title" style={{ marginBottom: 8 }}>Profit is not cash</div>
          <Rows currency={cur} items={[
            { label: 'Revenue invoiced (P&L, accrual)', value: rec.revenueAccrual },
            { label: 'Not yet collected',                value: -rec.notCollected },
            { label: 'Cash actually received from customers', value: rec.customerReceipts, strong: true },
          ]} />
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
            A sales invoice hits the Profit &amp; Loss the day it is raised. Cash only moves when it is paid.
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <Surface title="How the cash balance moved" right={wf?.reconciles === false ? 'does not tie to bank' : undefined} flex={6} minWidth={340}>
          {wf ? <Waterfall steps={wf.steps} currency={cur} /> : (
            <BarList currency={cur} items={[
              { label: 'Customer receipts', value: m.customerReceipts, color: 'var(--success)' },
              { label: 'Other receipts',    value: m.otherReceipts,    color: 'var(--accent)' },
              { label: 'Supplier payments', value: -m.supplierPayments },
              { label: 'Other payments',    value: -m.otherPayments },
            ].filter(i => i.value !== 0)} />
          )}
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 14, paddingTop: 10 }}>
            <Rows currency={cur} items={[
              { label: 'Opening balance', value: data.cash.opening },
              { label: 'Net movement',    value: data.cash.net },
              { label: 'Closing balance', value: data.cash.closing, strong: true },
            ]} />
            {data.unreconciled?.material && (
              <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 10, lineHeight: 1.5 }}>
                ▲ The payment records don&apos;t tie to the bank statement
                {data.unreconciled.inGap !== 0 && ` — ${fmtMoney(Math.abs(data.unreconciled.inGap), cur)} of receipts`}
                {data.unreconciled.outGap !== 0 && `${data.unreconciled.inGap !== 0 ? ' and' : ' — '} ${fmtMoney(Math.abs(data.unreconciled.outGap), cur)} of payments`}
                {' '}recorded in Xero but not seen in the bank. Usually means posted to a non-bank account, or not yet reconciled.
              </div>
            )}
          </div>
        </Surface>

        <Surface title="Working capital" right="right now" flex={6} minWidth={340}>
          <Rows currency={cur} items={[
            { label: `Owed to you (${wc.counts.receivable} sales invoices)`, value: wc.receivable },
            { label: `You owe (${wc.counts.payable} bills)`,                 value: wc.payable },
            { label: 'Net position', value: wc.net, strong: true },
          ]} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 14 }}>
            {[{ l: 'Debtor days', v: wc.dso }, { l: 'Creditor days', v: wc.dpo }].map(x => (
              <div key={x.l} style={{ background: 'var(--bg-secondary)', borderRadius: 9, padding: '10px 12px' }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{x.l}</div>
                <div style={{ fontSize: 18, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                  {x.v === null ? '—' : `${Math.round(x.v)} days`}
                </div>
              </div>
            ))}
          </div>
          <CurrencyNote currency={wc.currency} />
        </Surface>
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <Surface title="Monthly cash in and out" flex={7} minWidth={380}>
          <GroupedMonthlyBars months={months} currency={cur} series={[
            { label: 'Cash in',  color: 'var(--success)', values: m.monthly.in },
            { label: 'Cash out', color: 'var(--danger)',  values: m.monthly.out },
          ]} />
          <Legend items={[{ label: 'Cash in', color: 'var(--success)' }, { label: 'Cash out', color: 'var(--danger)' }]} />
          {rw.available && (
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
              Averaging {fmtMoney(rw.avgCashIn, cur)} in and {fmtMoney(rw.avgCashOut, cur)} out per month
              across {rw.months} closed month{rw.months === 1 ? '' : 's'}
              {rw.partial && ' (this month only, still in progress)'}.
              {rw.burning && rw.runwayDate && ` At that rate the current balance lasts until ${rw.runwayDate}.`}
            </div>
          )}
        </Surface>

        <Surface title="Receivables ageing" right={fmtMoney(wc.receivable, cur)} flex={5} minWidth={300}>
          <BarList currency={cur} items={[
            { label: 'Not yet due',      value: wc.arAgeing.current, color: 'var(--success)' },
            { label: '1–30 days late',   value: wc.arAgeing.d1_30,   color: 'var(--warning)' },
            { label: '31–60 days late',  value: wc.arAgeing.d31_60,  color: '#f97316' },
            { label: 'Over 60 days',     value: wc.arAgeing.d60plus, color: 'var(--danger)' },
          ].filter(i => i.value !== 0)} />
          {wc.overdue > 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--warning)', marginTop: 12 }}>
              ▲ {fmtMoney(wc.overdue, cur)} is past its due date.
            </div>
          )}
        </Surface>
      </div>

      {data.hygiene?.issues?.length > 0 && (
        <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid var(--warning)' }}>
          <div className="card-title" style={{ marginBottom: 8 }}>Invoice data quality</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.hygiene.issues.map((i, k) => (
              <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11.5, lineHeight: 1.5 }}>
                <span style={{ flexShrink: 0, color: i.severity === 'warn' ? 'var(--warning)' : 'var(--text-muted)' }}>
                  {i.severity === 'warn' ? '▲' : '•'}
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>{i.text}</span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
            Faults in the underlying records rather than in the business. Every figure above is built on
            these invoices, so they are worth resolving in Xero.
          </div>
        </div>
      )}

      <Surface title="13-week cash forecast" right="from invoice due dates">
        {(fc.overdueReceipts > 0 || fc.overduePayments > 0) && (
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
            Excludes {fmtMoney(fc.overdueReceipts, cur)} already overdue from customers
            {fc.overduePayments > 0 && ` and ${fmtMoney(fc.overduePayments, cur)} overdue to suppliers`} —
            those are past due, so treating them as scheduled would overstate the projection.
          </div>
        )}
        <GroupedMonthlyBars
          months={fc.weeks.map(w => ({ key: w.startISO, label: w.label }))}
          currency={cur}
          series={[
            { label: 'Receipts', color: 'var(--success)', values: fc.weeks.map(w => w.receipts) },
            { label: 'Payments', color: 'var(--danger)',  values: fc.weeks.map(w => w.payments) },
          ]} />
        <Legend items={[{ label: 'Expected receipts', color: 'var(--success)' }, { label: 'Expected payments', color: 'var(--danger)' }]} />
        <div style={{ overflowX: 'auto', marginTop: 14 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
            <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
              {['Week', 'Starting', 'Receipts', 'Payments', 'Net', 'Projected balance'].map((h, i) => (
                <th key={h} style={{ padding: '8px 10px', textAlign: i < 2 ? 'left' : 'right', fontSize: 11, color: 'var(--text-muted)' }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {fc.weeks.filter(w => w.receipts || w.payments || w.week === 13).map(w => (
                <tr key={w.week} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '7px 10px' }}>{w.label}</td>
                  <td style={{ padding: '7px 10px', color: 'var(--text-muted)' }}>{w.startISO}</td>
                  <td style={{ padding: '7px 10px', textAlign: 'right', color: w.receipts ? 'var(--success)' : 'var(--text-muted)' }}>{w.receipts ? fmtMoney(w.receipts, cur) : '-'}</td>
                  <td style={{ padding: '7px 10px', textAlign: 'right', color: w.payments ? 'var(--danger)' : 'var(--text-muted)' }}>{w.payments ? fmtMoney(w.payments, cur) : '-'}</td>
                  <td style={{ padding: '7px 10px', textAlign: 'right' }}>{w.net ? fmtMoney(w.net, cur) : '-'}</td>
                  <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 700, color: w.balance < 0 ? 'var(--danger)' : undefined }}>{fmtMoney(w.balance, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.5 }}>
          Assumes every open invoice is paid on its due date. Built from Xero invoice and bill due dates —
          Xero publishes no cash-flow statement, so this is derived, not reported.
        </div>
      </Surface>
    </>
  );
}
