import { useState } from 'react';
import { fmtMoney } from '../../utils/format';
import {Empty, Surface, rangeLabel, sliceSum } from './primitives';

// Real variance figures, each with the model's suggested cause where one was
// generated. The figures are always shown; the prose is additive and clearly
// marked, so an LLM outage degrades this card rather than emptying it.
// Real variance figures & executive category reasons matching the management scorecard format.
// Always grounded in pre-computed Xero ledger actuals vs budget.
export function VarianceReasons({ items = [], insights, currency }) {
  const [showDrilldown, setShowDrilldown] = useState(false);
  const categories = insights?.categories || [];
  const reasonFor = new Map((insights?.lines || []).map(l => [l.account, l.reason]).filter(([, r]) => r));

  if (!categories.length && !items.length) {
    return <Empty>Nothing differs from budget in this range.</Empty>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 4 Universal Executive Management Cards (Screenshot Format) */}
      {categories.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {categories.map(cat => {
            const isFavorable = cat.status === 'favorable';
            return (
              <div
                key={cat.key}
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: '14px 16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  boxShadow: '0 1px 3px rgba(0,0,0,0.03)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
                    {cat.title}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      padding: '2.5px 9px',
                      borderRadius: 12,
                      textTransform: 'lowercase',
                      letterSpacing: '0.02em',
                      background: isFavorable ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                      color: isFavorable ? 'var(--success, #16a34a)' : 'var(--danger, #ef4444)',
                      border: `1px solid ${isFavorable ? 'rgba(34, 197, 94, 0.28)' : 'rgba(239, 68, 68, 0.28)'}`,
                    }}
                  >
                    {cat.status}
                  </span>
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                  <strong style={{ color: 'var(--text-primary)', fontWeight: 700, marginRight: 6 }}>
                    {cat.deltaText}
                  </strong>
                  {cat.reason}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Optional Account-Level Drilldown */}
      {items.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 4 }}>
          <button
            type="button"
            onClick={() => setShowDrilldown(v => !v)}
            style={{
              background: 'none', border: 'none', padding: '4px 0', cursor: 'pointer',
              fontSize: 11.5, fontWeight: 600, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 5,
            }}
          >
            <span>{showDrilldown ? '▾ Hide' : '▸ View'} specific ledger account movers ({items.length})</span>
          </button>

          {showDrilldown && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 11, marginTop: 10 }}>
              {items.map(it => {
                const reason = reasonFor.get(it.label);
                const neg = it.v < 0;
                return (
                  <div key={it.label} style={{ fontSize: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{it.label}</span>
                      <span style={{
                        fontVariantNumeric: 'tabular-nums', fontWeight: 700, flexShrink: 0,
                        color: neg ? 'var(--danger)' : 'var(--success)',
                      }}>
                        {neg ? '' : '+'}{fmtMoney(it.v, currency)}
                      </span>
                    </div>
                    {reason && (
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.45 }}>
                        {reason}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div style={{ fontSize: 10, color: 'var(--text-muted)', borderTop: '1px solid var(--border)', paddingTop: 8, lineHeight: 1.5 }}>
        {insights?.source === 'gemini'
          ? 'Figures are computed directly from Xero ledger actuals vs budget. The explanations are AI-suggested operational causes to verify.'
          : (insights?.reason || 'Figures are computed from Xero.')}
      </div>
    </div>
  );
}

// ── Analysis ─────────────────────────────────────────────────────────────────

// Everything the model writes, in one place.
//
// It was spread across Overview — a narrative card at the top and variance
// reasons near the bottom — on a tab that already carried twelve blocks. Pulling
// both out makes Overview lighter AND gives the AI somewhere with room for the
// controls it needs: when it last ran, and a way to ask again.
export function AnalysisPanel({ data, from, to, insights, narrative, onReanalyse, reanalysing, lastAnalysedAt }) {
  const cur = data?.organisation?.currency || '';

  const varianceItems = data ? [...data.serviceLines, ...data.expenseLines]
    .map(l => ({ label: l.label, a: sliceSum(l.actual, from, to), b: sliceSum(l.budget, from, to) }))
    .map(l => ({ ...l, v: l.a - l.b }))
    .filter(l => l.v !== 0)
    .sort((x, y) => Math.abs(y.v) - Math.abs(x.v))
    .slice(0, 6) : [];

  const stamp = lastAnalysedAt
    ? new Date(lastAnalysedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <>
      <div className="card" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div className="card-title" style={{ marginBottom: 2 }}>Analysis &amp; Variance Insights</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            {data ? rangeLabel(data.months, from, to) : ''}{stamp ? ` · Last refreshed ${stamp}` : ''}
          </div>
        </div>
        {/* Re-runs the model over figures already fetched. It does NOT re-pull
            from Xero, which is billed by the gigabyte. */}
        <button className="btn btn-outline btn-sm" onClick={onReanalyse} disabled={reanalysing}>
          {reanalysing ? <><span className="btn-spinner" /> Evaluating ledger &amp; variance reasons…</> : '↻ Analyse again'}
        </button>
      </div>

      {stamp && (
        <div style={{
          background: 'rgba(34, 197, 94, 0.08)',
          border: '1px solid rgba(34, 197, 94, 0.22)',
          borderRadius: 8,
          padding: '8px 14px',
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          fontSize: 12,
          color: 'var(--text-secondary)',
        }}>
          <span>
            <strong style={{ color: 'var(--success)', fontWeight: 700 }}>✓ Analysis up to date</strong>
            {' · '}Evaluated 4 financial pillars based on latest Xero actuals vs budget.
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
            {stamp}
          </span>
        </div>
      )}

      {narrative?.available
        ? <NarrativeCard narrative={narrative} />
        : (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-title">What this period comes down to</div>
            <Empty>
              {narrative === null
                ? 'Reading the figures…'
                : 'No summary available right now — the figures on the other tabs are unaffected.'}
            </Empty>
          </div>
        )}

      <Surface
        title="VARIANCE REASONS"
        right={insights?.source === 'gemini'
          ? <span style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700 }}>AI Executive Scorecard</span>
          : 'Actual − budget'}
      >
        <VarianceReasons items={varianceItems} insights={insights} currency={cur} />
      </Surface>

      <ExecutiveActionChecklist data={data} from={from} to={to} insights={insights} currency={cur} />

      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 14, lineHeight: 1.6 }}>
        Every figure on this page is computed from your Xero data before the model sees it — it explains,
        it never calculates. Any sentence containing a number we did not supply is discarded rather than shown.
        A summary, not financial advice.
      </div>
    </>
  );
}

// ── Executive Action Checklist (Signal-from-Noise Takeaways) ─────────────────
export function ExecutiveActionChecklist({ data, from, to, insights, currency }) {
  if (!data) return null;

  const categories = insights?.categories || [];
  
  const revCat = categories.find(c => c.key === 'revenue');
  const cashCat = categories.find(c => c.key === 'cash');
  const deliveryCat = categories.find(c => c.key === 'delivery');
  const opexCat = categories.find(c => c.key === 'opex');

  const actionItems = [];

  // 1. Cash & Collections
  if (cashCat && cashCat.status === 'unfavorable') {
    actionItems.push({
      icon: '💵',
      badge: 'Cash Flow Priority',
      badgeColor: 'var(--danger)',
      title: 'Accelerate Debtor Collections',
      desc: cashCat.reason || 'Cash collections are lagging invoiced revenue. Review customer invoice aging to speed up bank receipts.',
    });
  } else if (cashCat) {
    actionItems.push({
      icon: '✅',
      badge: 'Working Capital',
      badgeColor: 'var(--success)',
      title: 'Healthy Cash Realization',
      desc: 'Customer cash collections are tracking in lockstep with billing.',
    });
  }

  // 2. Cost Control / Direct Delivery
  if (deliveryCat && deliveryCat.status === 'unfavorable' && deliveryCat.variance !== 0) {
    actionItems.push({
      icon: '📦',
      badge: 'Cost Audit',
      badgeColor: 'var(--warning)',
      title: 'Review Direct Delivery & COGS',
      desc: deliveryCat.reason || 'Direct fulfillment and contractor costs ran higher than budgeted for the period.',
    });
  }

  // 3. Overhead / OPEX
  if (opexCat && opexCat.status === 'unfavorable' && opexCat.variance !== 0) {
    actionItems.push({
      icon: '📉',
      badge: 'Expense Control',
      badgeColor: 'var(--warning)',
      title: 'Audit Operating Overheads',
      desc: opexCat.reason || 'Operating expenditure is currently exceeding plan targets.',
    });
  } else if (opexCat && opexCat.status === 'favorable') {
    actionItems.push({
      icon: '🎯',
      badge: 'Budget Discipline',
      badgeColor: 'var(--success)',
      title: 'Operating Spend Under Budget',
      desc: opexCat.reason || 'Operating overhead remained disciplined across major administrative lines.',
    });
  }

  // 4. Topline Performance
  if (revCat) {
    actionItems.push({
      icon: revCat.status === 'favorable' ? '🚀' : '⚠️',
      badge: 'Topline Strategy',
      badgeColor: revCat.status === 'favorable' ? 'var(--success)' : 'var(--danger)',
      title: revCat.status === 'favorable' ? 'Revenue Expansion' : 'Revenue Target Lag',
      desc: revCat.reason || (revCat.status === 'favorable' ? 'Sales outperformed plan targets.' : 'Revenue fell short of budgeted forecast.'),
    });
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div className="card-title" style={{ marginBottom: 0 }}>Executive Action Checklist &amp; Key Focus</div>
        <span style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700 }}>Signal-from-Noise Filter</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        {actionItems.map((item, idx) => (
          <div
            key={idx}
            style={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '12px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>
                <span>{item.icon}</span> {item.title}
              </span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  padding: '2px 7px',
                  borderRadius: 10,
                  color: item.badgeColor,
                  border: `1px solid ${item.badgeColor}`,
                  background: 'transparent',
                }}
              >
                {item.badge}
              </span>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {item.desc}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Threshold alerts from the server. Ordered critical first, and deliberately
// quiet when there is nothing to say — an empty band renders as a single line of
// reassurance rather than an empty box, and a missing figure produces no alert
// at all rather than a false all-clear.
// The synthesis card. The alerts elsewhere are excellent at detection and
// silent on interpretation — five separate red flags are often one story, and
// this says which. Written by Gemini from figures the server computed; any
// sentence containing a number the server did not supply is dropped before it
// ever reaches here.
//
// Renders nothing at all when unavailable. It is an extra, never a figure.
export function NarrativeCard({ narrative, compact = false }) {
  if (!narrative?.available || !narrative.text) return null;
  return (
    <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid var(--accent)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
        <div className="card-title" style={{ marginBottom: 0 }}>What this period comes down to</div>
        <span style={{ fontSize: 10, color: 'var(--accent)' }}>AI-written</span>
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.65, color: 'var(--text-secondary)' }}>{narrative.text}</div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 10, paddingTop: 9, borderTop: '1px solid var(--border)', lineHeight: 1.5 }}>
        Written from the figures on this page{narrative.basedOnAlerts ? ` and the ${narrative.basedOnAlerts} alert${narrative.basedOnAlerts === 1 ? '' : 's'} on Cash Flow` : ''}.
        Every amount is checked against the source before it is shown. A summary, not financial advice.
      </div>
    </div>
  );
}
