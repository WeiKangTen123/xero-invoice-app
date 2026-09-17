import { fmtMoney, fmtPct } from '../../utils/format';
import { BarList, GroupedMonthlyBars, Waterfall } from './charts';
import {AlertBand, CurrencyNote, Empty, Legend, Metric, Rows, Surface } from './primitives';

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
      <AlertBand alerts={data.alerts?.alerts} counts={data.alerts?.counts} currency={cur} />

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
        {/* Operations on their own. Shown whenever the split is available, and
            coloured only when the headline is flattering the operating picture. */}
        {rw.available && rw.operatingNet !== null && (
          <Metric label="Operating cash flow"
                  value={`${fmtMoney(rw.operatingNet, cur)}/mo`}
                  meter={null}
                  tone={rw.operatingBurning ? 'var(--danger)' : 'var(--success)'}
                  footLeft={`${fmtMoney(rw.avgOperatingIn, cur)} from customers`}
                  footRight={rw.operatingBurning && rw.operatingRunwayMonths !== null
                    ? `${rw.operatingRunwayMonths >= 24 ? '24+' : rw.operatingRunwayMonths.toFixed(1)} months at this rate`
                    : 'Self-funding'} />
        )}
      </div>



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
            {rec.notCollected !== 0 && (
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
                A sales invoice hits the Profit &amp; Loss the day it is raised; cash only moves when it is
                paid. {fmtMoney(rec.revenueAccrual, cur)} invoiced, {fmtMoney(rec.customerReceipts, cur)} received.
              </div>
            )}
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

        <Surface title="Where the money goes"
                 right={data.supplierSpend?.available ? `${data.supplierSpend.count} supplier${data.supplierSpend.count === 1 ? '' : 's'}` : null}
                 flex={5} minWidth={300}>
          {/* The revenue side has had Top Customers from the start; the cost side
              only ever had expense ACCOUNTS. "Rent 12,000" names a category;
              "one supplier is 40% of your spend" is something you can act on. */}
          {data.supplierSpend?.available ? (
            <>
              <BarList currency={cur} showPctOfTotal
                       items={data.supplierSpend.suppliers.slice(0, 8).map(x => ({
                         label: x.name, value: x.spend,
                         tag: x.bills > 1 ? `${x.bills} bills` : null,
                       }))} />
              {data.supplierSpend.topShare !== null && data.supplierSpend.count > 1 && (
                <div style={{ fontSize: 11.5, marginTop: 12,
                              color: data.supplierSpend.topShare > 0.5 ? 'var(--warning)' : 'var(--text-muted)' }}>
                  {data.supplierSpend.topShare > 0.5 ? '▲ ' : ''}
                  {fmtPct(data.supplierSpend.topShare, 0)} of spend goes to {data.supplierSpend.suppliers[0].name}
                  {data.supplierSpend.topShare > 0.5 ? ' — concentrated on one supplier.' : '.'}
                </div>
              )}
              <CurrencyNote currency={data.supplierSpend.currency} />
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
                Bills raised in this period, from Xero. Includes tax, so it will not tie exactly to the
                net expense figures on Profitability.
              </div>
            </>
          ) : <Empty>No bills raised in this period.</Empty>}
        </Surface>
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
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
