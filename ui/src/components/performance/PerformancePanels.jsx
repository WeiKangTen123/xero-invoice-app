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
export const WINDOWS = [
  { key: 'fy',      label: 'This financial year' },
  { key: 'rolling', label: 'Last 12 months' },
  { key: 'prev-fy', label: 'Previous financial year' },
  { key: 'next-fy', label: 'Next financial year' },
];

export function MonthRange({ months, from, to, onChange, label, window: win, onWindow }) {
  if (!months?.length) return null;
  const opt = (m, i) => <option key={m.key} value={i}>{m.label}</option>;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      {onWindow && (
        <>
          <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
            Period
          </span>
          <select className="form-input" style={{ width: 'auto', fontSize: 12, padding: '5px 8px' }}
                  value={win} onChange={e => onWindow(e.target.value)}>
            {WINDOWS.map(w => <option key={w.key} value={w.key}>{w.label}</option>)}
          </select>
        </>
      )}
      <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
        Month range
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <select className="form-input" style={{ width: 'auto', fontSize: 12, padding: '5px 8px' }}
                value={from} onChange={e => onChange(Math.min(Number(e.target.value), to), to)}>
          {months.map(opt)}
        </select>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>→</span>
        <select className="form-input" style={{ width: 'auto', fontSize: 12, padding: '5px 8px' }}
                value={to} onChange={e => onChange(from, Math.max(Number(e.target.value), from))}>
          {months.map(opt)}
        </select>
      </div>
      {label && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</span>}
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
          {data.recurringAccounts.length > 0 && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.5 }}>
              Recurring inferred from account names — Xero records no such flag. Treated as recurring:{' '}
              {data.recurringAccounts.join(', ')}.
            </div>
          )}
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
          {/* Deliberately spans the whole window, not the selected range — a
              single-month selection would otherwise render one bar, which is
              not a trend. The KPIs above still follow the range. */}
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 8 }}>
            Full period · {data.months[0].label} – {data.months[data.months.length - 1].label}
          </div>
          <TrendChart mode={trendMode} months={data.months} currency={cur}
                      actual={data.totals.revenue.actual}
                      budget={data.totals.revenue.budget} />
          <Legend items={[{ label: 'Actual', color: 'var(--accent)' }, { label: 'Budget', color: 'var(--text-muted)', opacity: 0.32 }]} />
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
        <Metric label="Project revenue" value={fmtMoney(T.project, cur)}
                meter={T.recurringMix === null ? null : (1 - T.recurringMix) * 100}
                tone={T.project < 0 ? 'var(--danger)' : undefined}
                footLeft="Non-recurring lines" footRight="One-off work" />
        <Metric label="Vs budget" value={totalB === 0 ? '—' : fmtMoney(total - totalB, cur)}
                meter={null}
                tone={total - totalB < 0 ? 'var(--danger)' : 'var(--success)'}
                footLeft={totalB === 0 ? 'Nothing budgeted' : `${fmtMoney(totalB, cur)} budgeted`}
                footRight="Higher is favourable" />
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <Surface title={active ? `${active.label} — monthly` : 'Recurring vs project revenue'} flex={7} minWidth={380}>
          {active ? (
            <>
              <MonthlyBars months={months} actual={actual} budget={budget} currency={cur} />
              <Legend items={[{ label: 'Actual', color: 'var(--accent)' }, { label: 'Budget', color: 'var(--text-muted)', opacity: 0.32 }]} />
            </>
          ) : (
            <>
              <MonthlyBars months={months} currency={cur} showBudget={false}
                           actual={slice(data.split.recurring.actual, from, to)} budget={[]} />
              <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 10px' }}>Recurring</div>
              <MonthlyBars months={months} currency={cur} showBudget={false} height={150}
                           actual={slice(data.split.project.actual, from, to)} budget={[]} />
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Project</div>
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
