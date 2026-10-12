import { fmtMoney, fmtPct } from '../../utils/format';
import { BarList, GroupedMonthlyBars, Waterfall } from './charts';
import {AlertBand, CurrencyNote, Empty, Legend, Metric, Rows, Surface } from './primitives';

// What the "does not tie" note says, side by side and in the right direction.
// A gap is the payment records minus the bank's figures (transfers between the
// org's own accounts already taken off the bank side): positive means Xero has
// records the bank totals do not show, negative means the bank shows money no
// record accounts for. The note used to say "recorded in Xero but not seen in
// the bank" whatever the sign, so a bank showing MORE was described backwards
// and the reader went looking for the wrong thing. Gaps of a dollar or less are
// rounding, as on the server, and are not mentioned.
export function unreconciledText(u, cur) {
  const sides = [['receipts', Number(u?.inGap || 0)], ['payments', Number(u?.outGap || 0)]]
    .filter(([, gap]) => Math.abs(gap) > 1);
  const over  = sides.filter(([, gap]) => gap > 0);
  const under = sides.filter(([, gap]) => gap < 0);
  const list = xs => xs.map(([what, gap]) => `${fmtMoney(Math.abs(gap), cur)} of ${what}`).join(' and ');
  const parts = [];
  if (over.length) {
    parts.push(`${list(over)} recorded in Xero but not in the bank accounts' totals, which usually means posted to an account that is not a bank account, or not yet reconciled.`);
  }
  if (under.length) {
    parts.push(`${list(under)} in the bank accounts' totals with no payment or bank transaction in Xero behind it, which usually means an entry posted straight to a bank account, such as a manual journal.`);
  }
  return `The payment records don't tie to the bank statement${parts.length ? `: ${parts.join(' ')}` : '.'}`;
}

// The Cash in and Cash out figures. When the payments or bank transactions
// could not be read, the split by customer and supplier is not known, and
// neither is the bank's figure less transfers (the transfers are bank
// transactions), so both say so. They read "0.00 from customers" before,
// which is a figure, and a wrong one. A payload from before recordsAvailable
// existed is taken as read.
export function movementMetrics(data, cur) {
  const m = data?.movement || {};
  const cash = data?.cash || {};
  if (data?.recordsAvailable === false) {
    const unread = { value: '—', footLeft: 'Couldn’t read payments/bank transactions from Xero', footRight: '' };
    return { cashIn: unread, cashOut: unread };
  }
  return {
    cashIn: {
      value: fmtMoney(cash.available ? cash.cashIn : m.cashIn, cur),
      footLeft: `${fmtMoney(m.customerReceipts, cur)} from customers`,
      footRight: `${fmtMoney(m.otherReceipts, cur)} other`,
    },
    cashOut: {
      value: fmtMoney(cash.available ? cash.cashOut : m.cashOut, cur),
      footLeft: `${fmtMoney(m.supplierPayments, cur)} to suppliers`,
      footRight: `${fmtMoney(m.otherPayments, cur)} other`,
    },
  };
}

// The runway card. Without a figure it says why, in the server's words: no
// closed month, no cash moved, or the records not read. It said "No closed
// month yet" whatever the reason, and a period in which nothing moved read
// as a business "taking in more than it spends".
export function runwayMetric(rw, cur) {
  if (!rw?.available) {
    return { label: 'Cash runway', value: '—', meter: null, tone: undefined, footLeft: rw?.reason || 'No closed month yet', footRight: '' };
  }
  return {
    label: rw.burning ? 'Cash runway' : 'Net cash flow',
    value: !rw.burning ? `${fmtMoney(rw.avgNet, cur)}/mo`
      : rw.runwayMonths >= 24 ? '24+ months'
      : `${rw.runwayMonths.toFixed(1)} months`,
    meter: rw.burning ? Math.min(100, (rw.runwayMonths / 12) * 100) : null,
    tone: !rw.burning ? 'var(--success)'
      : rw.runwayMonths < 3 ? 'var(--danger)'
      : rw.runwayMonths < 6 ? 'var(--warning)' : undefined,
    footLeft: rw.burning ? `Burning ${fmtMoney(rw.netBurn, cur)}/mo net` : 'Taking in more than it spends',
    footRight: `${rw.months}-mo avg${rw.partial ? ', partial' : ''}`,
  };
}

// The balance rows under the waterfall. Without the Bank Summary there is no
// opening or closing balance, so each is a dash (Rows draws a nil value as
// one) and the note says why, rather than the rows reading as a balance of
// nothing.
export function balanceRows(cash) {
  const ok = !!cash?.available;
  return {
    items: [
      { label: 'Opening balance', value: ok ? cash.opening : 0 },
      { label: 'Net movement',    value: ok ? cash.net : 0 },
      { label: 'Closing balance', value: ok ? cash.closing : 0, strong: true },
    ],
    note: ok ? null : 'Bank balance unavailable',
  };
}

// What is owed each way, counting only invoices and bills with something
// still due (the server's count), and saying so plainly when there is none
// rather than "Owed to you (0 sales invoices)".
export function owedRows(wc) {
  const n = wc?.counts || {};
  const r = Number(n.receivable || 0), p = Number(n.payable || 0);
  return [
    { label: r ? `Owed to you (${r} sales invoice${r === 1 ? '' : 's'})` : 'Nothing owed to you', value: wc?.receivable || 0 },
    { label: p ? `You owe (${p} bill${p === 1 ? '' : 's'})` : 'No bills to pay', value: wc?.payable || 0 },
    { label: 'Net position', value: wc?.net || 0, strong: true },
  ];
}

// What the receivables ageing and the 13-week chart say when they have
// nothing to draw, or null when they have something. The ageing panel said
// "No activity in this range", the chart helper's words for an empty period;
// a receivables ageing with nothing in it is nothing outstanding, as the
// ageing view says, and a forecast with nothing in it is nothing falling due.
// Read in cents, so float dust is not "something".
export function emptyNotes(wc, fc) {
  const some = v => Math.round(Number(v || 0) * 100) !== 0;
  const a = wc?.arAgeing || {};
  const owed = ['current', 'd1_30', 'd31_60', 'd60plus'].some(k => some(a[k]));
  const due = (fc?.weeks || []).some(w => some(w.receipts) || some(w.payments));
  return {
    ageing: owed ? null : 'Nothing outstanding',
    forecast: due ? null : 'Nothing falls due in the next 13 weeks',
  };
}

export function CashFlowPanel({ data, onOpenAgeing }) {
  const cur = data.organisation?.currency || '';
  const m   = data.movement;
  const wc  = data.workingCapital;
  const fc  = data.forecast;
  const rec = data.reconciliation;
  const rw  = data.runway  || { available: false };
  const wf  = data.waterfall;
  const months = data.months;
  // False only when the server said so; a payload without the field was read.
  const records = data.recordsAvailable !== false;
  const unread = 'Couldn’t read payments/bank transactions from Xero';
  const moved = movementMetrics(data, cur);
  const runway = runwayMetric(rw, cur);
  const balance = balanceRows(data.cash);
  const empty = emptyNotes(wc, fc);

  const collectionTone = wc.collectionRate === null ? undefined
    : wc.collectionRate < 0.5 ? 'var(--danger)' : wc.collectionRate < 0.9 ? 'var(--warning)' : 'var(--success)';

  return (
    <>
      <AlertBand alerts={data.alerts?.alerts} counts={data.alerts?.counts} currency={cur} />

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <Metric label="Cash at bank" value={data.cash.available ? fmtMoney(data.cash.closing, cur) : '—'}
                meter={null}
                footLeft={data.cash.available
                  ? `${data.cash.accounts.length} account${data.cash.accounts.length === 1 ? '' : 's'}`
                    // Foreign-currency accounts are listed on Banking in their own
                    // currency and kept out of every figure here, so say so.
                    + (data.cash.baseOnly && data.cash.foreignAccounts?.length
                      ? ` · excludes ${data.cash.foreignAccounts.length} foreign-currency`
                      : '')
                  : 'Bank summary unavailable'}
                footRight="Closing balance" />
        <Metric label="Cash in" value={moved.cashIn.value} meter={null}
                tone={records ? 'var(--success)' : undefined}
                footLeft={moved.cashIn.footLeft}
                footRight={moved.cashIn.footRight} />
        <Metric label="Cash out" value={moved.cashOut.value} meter={null}
                tone={records ? 'var(--danger)' : undefined}
                footLeft={moved.cashOut.footLeft}
                footRight={moved.cashOut.footRight} />
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
        <Metric label={runway.label} value={runway.value} meter={runway.meter} tone={runway.tone}
                footLeft={runway.footLeft} footRight={runway.footRight} />
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
          {/* The waterfall needs the bank's balances and the records; the
              server sends none without both. Without the records there is
              nothing to draw at all; without the balances, the records' own
              movement is still worth showing. */}
          {wf ? <Waterfall steps={wf.steps} currency={cur} /> : !records ? <Empty>{unread}</Empty> : (
            <BarList currency={cur} items={[
              { label: 'Customer receipts', value: m.customerReceipts, color: 'var(--success)' },
              { label: 'Other receipts',    value: m.otherReceipts,    color: 'var(--accent)' },
              { label: 'Supplier payments', value: -m.supplierPayments },
              { label: 'Other payments',    value: -m.otherPayments },
            ].filter(i => i.value !== 0)} />
          )}
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 14, paddingTop: 10 }}>
            <Rows currency={cur} items={balance.items} />
            {balance.note && (
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>{balance.note}</div>
            )}
            {records && rec.notCollected !== 0 && (
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
                A sales invoice hits the Profit &amp; Loss the day it is raised; cash only moves when it is
                paid. {fmtMoney(rec.revenueAccrual, cur)} invoiced, {fmtMoney(rec.customerReceipts, cur)} received.
              </div>
            )}
            {(data.cash.transfersIn > 0 || data.cash.transfersOut > 0) && (
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
                Transfers between your own accounts ({fmtMoney(Math.max(data.cash.transfersIn || 0, data.cash.transfersOut || 0), cur)})
                {' '}are left out of cash in and cash out: they move money between accounts without any coming in or going out.
              </div>
            )}
            {data.unreconciled?.material && (
              <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 10, lineHeight: 1.5 }}>
                ▲ {unreconciledText(data.unreconciled, cur)}
              </div>
            )}
          </div>
        </Surface>

        <Surface title="Working capital" right="right now" flex={6} minWidth={340}>
          <Rows currency={cur} items={owedRows(wc)} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 14 }}>
            {[{ l: 'Debtor days', v: wc.dso }, { l: 'Creditor days', v: wc.dpo }].map(x => (
              <div key={x.l} style={{ background: 'var(--bg-secondary)', borderRadius: 9, padding: '10px 12px' }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{x.l}</div>
                <div style={{ fontSize: 18, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                  {x.v === null || x.v === undefined ? '—' : `${Math.round(x.v)} days`}
                </div>
              </div>
            ))}
          </div>
          {/* What the two figures are measured over, said once, because both
              changed meaning: closed months only, and invoices and bills on
              both sides of each ratio, tax included alike. */}
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
            {wc.paymentDays?.closedMonths
              ? `What is owed now, against what was invoiced and billed in the ${wc.paymentDays.closedMonths} closed month${wc.paymentDays.closedMonths === 1 ? '' : 's'} to ${wc.paymentDays.toLabel}, tax included on both sides.`
              : wc.paymentDays?.reason === 'no-closed-month'
                ? 'Measured over closed months only, and no month of this period has closed yet.'
                : 'Not available right now — the invoice summary could not be read.'}
          </div>
          <CurrencyNote currency={wc.currency} />
        </Surface>
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <Surface title="Monthly cash in and out" flex={7} minWidth={380}>
          {/* Unread months are not empty ones: the chart's own empty text,
              "Nothing recorded in this period", would say they were. */}
          {records ? (
            <>
              <GroupedMonthlyBars months={months} currency={cur} series={[
                { label: 'Cash in',  color: 'var(--success)', values: m.monthly.in },
                { label: 'Cash out', color: 'var(--danger)',  values: m.monthly.out },
              ]} />
              <Legend items={[{ label: 'Cash in', color: 'var(--success)' }, { label: 'Cash out', color: 'var(--danger)' }]} />
            </>
          ) : <Empty>{unread}</Empty>}
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
          {empty.ageing ? <Empty>{empty.ageing}</Empty> : (
            <BarList currency={cur} items={[
              { label: 'Not yet due',      value: wc.arAgeing.current, color: 'var(--success)' },
              { label: '1–30 days late',   value: wc.arAgeing.d1_30,   color: 'var(--warning)' },
              { label: '31–60 days late',  value: wc.arAgeing.d31_60,  color: '#f97316' },
              { label: 'Over 60 days',     value: wc.arAgeing.d60plus, color: 'var(--danger)' },
            ].filter(i => i.value !== 0)} />
          )}
          {wc.overdue > 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--warning)', marginTop: 12 }}>
              ▲ {fmtMoney(wc.overdue, cur)} is past its due date.
            </div>
          )}
          {/* The customer-by-customer view, with each invoice behind it, is the
              ageing section under the headline cards; this links to it rather
              than repeating it. */}
          {onOpenAgeing && (
            <button type="button" onClick={() => onOpenAgeing('receivables')}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', marginTop: 12,
                             fontSize: 11.5, color: 'var(--accent)', fontWeight: 600, textAlign: 'left' }}>
              By customer, with every invoice →
            </button>
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
        {empty.forecast ? <Empty>{empty.forecast}</Empty> : (
          <>
            <GroupedMonthlyBars
              months={fc.weeks.map(w => ({ key: w.startISO, label: w.label }))}
              currency={cur}
              series={[
                { label: 'Receipts', color: 'var(--success)', values: fc.weeks.map(w => w.receipts) },
                { label: 'Payments', color: 'var(--danger)',  values: fc.weeks.map(w => w.payments) },
              ]} />
            <Legend items={[{ label: 'Expected receipts', color: 'var(--success)' }, { label: 'Expected payments', color: 'var(--danger)' }]} />
          </>
        )}
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
