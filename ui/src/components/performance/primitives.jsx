import { useMemo } from 'react';
import { fmtMoney, fmtPct } from '../../utils/format';

export const SERIES_COLORS = ['var(--accent)', 'var(--success)', '#b8860b', '#8b5cf6', '#0ea5e9', '#f97316'];

export function sum(a) { return a.reduce((s, v) => s + v, 0); }
export function slice(series, from, to) { return series.slice(from, to + 1); }
export function sliceSum(series, from, to) { return sum(slice(series, from, to)); }

// ── Building blocks ──────────────────────────────────────────────────────────

// The reference dashboard's signature card: label, big value, a thin meter, and
// two footnotes. `meter` is a 0-100 fill, or null when there's nothing sensible
// to measure against — an unfilled bar reads as "zero", which would be a lie.
// minWidth 190 is what kept these from pairing up on a phone: two need 394px of
// a 366px content width, so every panel opened with a full-height column of
// tiles and no chart above the fold. .mobile-mode drops it to 170 (see
// globals.css) — the classNames below exist for that rule to reach.
//
// The figure shrinks there rather than being abbreviated. At 2-up a tile is
// ~176px wide, which fits "SGD 128,400.00" at 15px on one line, and an exact
// figure is worth more in an accounting tool than "128.4K". The three-across
// KPI row at the top of the page does abbreviate, because ~118px leaves no
// choice.
export function Metric({ label, value, meter, footLeft, footRight, tone }) {
  const width = meter === null || meter === undefined ? null : Math.max(0, Math.min(100, meter));
  return (
    <div className="card figure-tile" style={{ flex: 1, minWidth: 190, background: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div className="figure-label" style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{label}</div>
      <div>
        <div className="figure-value" style={{ fontSize: 23, fontWeight: 800, fontVariantNumeric: 'tabular-nums', lineHeight: 1.15, color: tone }}>{value}</div>
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

export function Surface({ title, right, children, flex = 1, minWidth = 320 }) {
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

export function Empty({ children }) {
  return <div style={{ padding: '26px 0', textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>{children}</div>;
}

// A signed delta. Null renders as an em dash with the reason — growth measured
// from a zero or negative base is undefined, and showing it as 0% or ∞ would
// invite the reader to quote a number nobody computed.
export function GrowthPill({ value, title }) {
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
export function CurrencyNote({ currency, style }) {
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

export function ScoreCard({ items }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
      {items.map(it => (
        <div key={it.label} style={{ background: 'var(--bg-secondary)', borderRadius: 9, padding: '11px 13px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 5 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{it.label}</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{it.target}</span>
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
export function WatchBand({ items }) {
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

export function Legend({ items }) {
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

export function Rows({ items, currency }) {
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
export function useRangeTotals(d, from, to) {
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
      revenueBudget:     S(t.revenue, 'budget'),
      netProfitBudget:   S(t.netProfit, 'budget'),
      otherIncomeBudget: S(t.otherIncome, 'budget'),
      cogsBudget:        S(t.cogs, 'budget'),
      opexBudget:        S(t.opex, 'budget'),
      grossProfitBudget: S(t.grossProfit, 'budget'),
      grossMargin:  revenue !== 0 ? grossProfit / revenue : null,
      netMargin:    revenue !== 0 ? netProfit / revenue : null,
      recurringMix: (recurring + project) !== 0 ? recurring / (recurring + project) : null,
    };
  }, [d, from, to]);
}

export function rangeLabel(months, from, to) {
  if (!months?.length) return '';
  return from === to ? months[from].label : `${months[from].label} – ${months[to].label}`;
}

// How many of the selected months are closed — the honest denominator for
// anything described as "actual".
export function closedInRange(d, from, to) {
  return Math.max(0, Math.min(d.actualThroughIdx, to) - from + 1);
}

// Revenue momentum for the SELECTED range, recomputed as the range moves — the
// server's figure covers the whole period, and a control the reader just dragged
// should move the numbers underneath it.
//
// Uses closedThroughIdx, not actualThroughIdx: the latter includes the current
// month, which is partial, and comparing a half-finished month against a
// complete one manufactures a collapse that is only the calendar.
export function rangeGrowth(d, from, to) {
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

export function AlertBand({ alerts, counts, currency }) {
  if (!alerts) return null;

  const style = {
    critical: { color: 'var(--danger)',  mark: '\u25CF', label: 'Critical' },
    warn:     { color: 'var(--warning)', mark: '\u25B2', label: 'Warning' },
    info:     { color: 'var(--text-muted)', mark: '\u25CB', label: 'Note' },
  };

  if (!alerts.length) {
    return (
      <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid var(--success)' }}>
        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          <span style={{ color: 'var(--success)', fontWeight: 700 }}>✓</span>{' '}
          Nothing above the alert thresholds for this period. Rules that need a figure Xero
          hasn&apos;t provided stay silent rather than reporting all-clear.
        </div>
      </div>
    );
  }

  const worst = alerts[0].severity;
  return (
    <div className="card" style={{ marginBottom: 16, borderLeft: `3px solid ${style[worst].color}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
        <div className="card-title" style={{ marginBottom: 0 }}>Alerts</div>
        <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
          {[
            counts?.critical ? `${counts.critical} critical` : null,
            counts?.warn ? `${counts.warn} warning${counts.warn === 1 ? '' : 's'}` : null,
            counts?.info ? `${counts.info} note${counts.info === 1 ? '' : 's'}` : null,
          ].filter(Boolean).join(' · ')}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        {alerts.map(a => {
          const st = style[a.severity] || style.info;
          // The server leaves money as a number and marks the slot, so it can be
          // rendered in the organisation's own currency.
          const detail = a.amount === null || a.amount === undefined
            ? a.detail
            : a.detail.replace('{amount}', fmtMoney(Math.abs(a.amount), currency));
          return (
            <div key={a.code} style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
              <span style={{ flexShrink: 0, color: st.color, fontSize: 10, lineHeight: '17px' }} title={st.label}>{st.mark}</span>
              <div style={{ lineHeight: 1.5 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: st.color }}>{a.title}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{detail}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
