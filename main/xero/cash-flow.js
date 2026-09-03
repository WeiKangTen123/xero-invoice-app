const { _toBase, _foreignCurrency } = require('./currency');
const { _monthKeyOfDate, _dateFromParts, _fmtISODate, _addDays, _closedCount } = require('./periods');

// Turning Xero's payment, bank-transaction and invoice records into a cash view.
//
// Xero publishes no cash-flow statement, so all of this is derived. The one rule
// everything here follows: a sales invoice hits the Profit & Loss the day it is
// raised and moves NO CASH. Cash moves only on payments and bank transactions.
// Building a cash view from the P&L would report revenue as though it were
// money in the bank, which for an organisation that has collected none of its
// invoices is the exact opposite of the truth.
//
// Every function is pure — getCashFlow does the fetching and stays in
// reports.js, which re-exports these unchanged.

// A bank transfer moves money between the org's OWN accounts. It appears as a
// bank transaction, but counting it would inflate both sides of the statement.
const _isTransfer = t => /TRANSFER/i.test(t?.type || '');

// Xero's payment types are not uniformly prefixed. The receivable side is
// ACCRECPAYMENT plus the AR* credit-note/overpayment/prepayment variants; the
// rest are payable. Same rule as the Banking statement view already uses.
const _isReceiptPayment = p => /REC/.test(p?.paymentType || '') || (p?.paymentType || '').startsWith('AR');

function _buildCashMovement({ payments = [], bankTransactions = [], months = [], baseCurrency = '' }) {
  const idx = new Map(months.map((m, i) => [m.key, i]));
  const zero = () => Array(months.length).fill(0);
  const monthly = { customerReceipts: zero(), otherReceipts: zero(), supplierPayments: zero(), otherPayments: zero() };
  const totals  = { customerReceipts: 0, otherReceipts: 0, supplierPayments: 0, otherPayments: 0 };

  const add = (bucket, when, amount) => {
    const v = Math.abs(Number(amount || 0));
    if (!v) return;
    totals[bucket] += v;
    const i = idx.get(_monthKeyOfDate(when));
    if (i !== undefined) monthly[bucket][i] += v;
  };

  // Converted to base currency so these tie to the bank summary and the P&L,
  // both of which Xero reports in base.
  for (const p of payments) add(_isReceiptPayment(p) ? 'customerReceipts' : 'supplierPayments', p.date, _toBase(p, p.amount, baseCurrency));
  for (const t of bankTransactions) {
    if (_isTransfer(t)) continue;                       // own-account movement, not cash flow
    add(/^RECEIVE/i.test(t.type || '') ? 'otherReceipts' : 'otherPayments', t.date, _toBase(t, t.total, baseCurrency));
  }

  const cashIn  = totals.customerReceipts + totals.otherReceipts;
  const cashOut = totals.supplierPayments + totals.otherPayments;
  return {
    ...totals, cashIn, cashOut, net: cashIn - cashOut,
    monthly: {
      ...monthly,
      in:  months.map((_, i) => monthly.customerReceipts[i] + monthly.otherReceipts[i]),
      out: months.map((_, i) => monthly.supplierPayments[i] + monthly.otherPayments[i]),
    },
  };
}

// Pure. What is owed in each direction, and how much of what was invoiced has
// actually turned into money.
function _buildWorkingCapital({ invoices = [], revenue = 0, expenses = 0, days = 0, today, baseCurrency = '' }) {
  const ar = { raised: 0, due: 0, count: 0 }, ap = { raised: 0, due: 0, count: 0 };
  const buckets = { current: 0, d1_30: 0, d31_60: 0, d60plus: 0 };
  const now = today ? _dateFromParts(today) : new Date();

  for (const inv of invoices) {
    const g = inv.type === 'ACCREC' ? ar : inv.type === 'ACCPAY' ? ap : null;
    if (!g) continue;
    // Base currency: revenue and expenses below come from the P&L, which Xero
    // reports in base, so DSO/DPO would otherwise divide unlike units.
    const dueBase = _toBase(inv, inv.amountDue, baseCurrency);
    g.raised += _toBase(inv, inv.total, baseCurrency);
    g.due    += dueBase;
    g.count  += 1;

    if (inv.type === 'ACCREC' && dueBase > 0) {
      const overdueDays = inv.dueDate ? Math.floor((now - new Date(inv.dueDate)) / 86400000) : 0;
      const amt = dueBase;
      if (overdueDays <= 0)      buckets.current += amt;
      else if (overdueDays <= 30) buckets.d1_30  += amt;
      else if (overdueDays <= 60) buckets.d31_60 += amt;
      else                        buckets.d60plus += amt;
    }
  }

  const collected = ar.raised - ar.due;
  return {
    receivable: ar.due, payable: ap.due, net: ap.due - ar.due,
    invoiced: ar.raised, collected,
    // Null, not 0, when nothing was invoiced — "0% collected" would be a lie.
    collectionRate: ar.raised > 0 ? collected / ar.raised : null,
    arAgeing: buckets,
    overdue: buckets.d1_30 + buckets.d31_60 + buckets.d60plus,
    dso: revenue  > 0 && days > 0 ? (ar.due / revenue)  * days : null,
    dpo: expenses > 0 && days > 0 ? (ap.due / expenses) * days : null,
    counts: { receivable: ar.count, payable: ap.count },
    currency: _foreignCurrency(invoices, baseCurrency),
  };
}

// Pure. A 13-week projection from invoice DUE DATES — the forward view the
// reference dashboard cannot produce, because its spreadsheet has no due dates.
//
// It assumes every invoice is paid on its due date, which is optimistic; already
// overdue amounts are therefore reported separately rather than folded into
// week 1 as though they were about to arrive.
function _buildCashForecast({ invoices = [], openingBalance = 0, today, weeks = 13, baseCurrency = '' }) {
  const start = today ? _dateFromParts(today) : new Date();
  const out = [];
  let overdueReceipts = 0, overduePayments = 0;

  for (const inv of invoices) {
    const due = _toBase(inv, inv.amountDue, baseCurrency);
    if (due <= 0 || !inv.dueDate) continue;
    if (new Date(inv.dueDate) < start) {
      if (inv.type === 'ACCREC') overdueReceipts += due; else if (inv.type === 'ACCPAY') overduePayments += due;
    }
  }

  let balance = openingBalance;
  for (let w = 0; w < weeks; w++) {
    const from = new Date(start.getTime() + w * 7 * 86400000);
    const to   = new Date(start.getTime() + (w + 1) * 7 * 86400000);
    let receipts = 0, payments = 0;
    for (const inv of invoices) {
      const due = _toBase(inv, inv.amountDue, baseCurrency);
      if (due <= 0 || !inv.dueDate) continue;
      const d = new Date(inv.dueDate);
      if (d < from || d >= to) continue;
      if (inv.type === 'ACCREC') receipts += due; else if (inv.type === 'ACCPAY') payments += due;
    }
    balance += receipts - payments;
    out.push({
      week: w + 1,
      startISO: from.toISOString().slice(0, 10),
      label: `W${w + 1}`,
      receipts, payments, net: receipts - payments, balance,
    });
  }
  return { weeks: out, openingBalance, overdueReceipts, overduePayments };
}

// Pure. Burn rate and runway — the metric small businesses fail for the lack of.
// Gross burn is what leaves each month; net burn is what leaves after receipts.
// Both are averaged over CLOSED months, so a half-finished month cannot flatter
// or panic the figure.
function _buildRunway({ months = [], monthly = {}, closing = 0, today } = {}) {
  const ins = monthly.in || [], outs = monthly.out || [];
  if (!months.length || !ins.length) return { available: false };

  // Fall back to the partial current month only when there is no closed one —
  // a first-month org should see a rough figure, flagged, rather than nothing.
  let n = _closedCount(months, today);
  const partial = n === 0;
  if (partial) n = 1;
  n = Math.min(n, ins.length, outs.length);
  if (n < 1) return { available: false };

  const sum = a => a.reduce((x, y) => x + y, 0);
  const cin = ins.slice(0, n), cout = outs.slice(0, n);
  const avgIn = sum(cin) / n, avgOut = sum(cout) / n;
  const avgNet = avgIn - avgOut;
  const burning = avgNet < 0;
  const runwayMonths = burning ? Math.max(0, closing / -avgNet) : null;

  // Operating cash: customer receipts against everything paid out, ignoring
  // money that came from anywhere else. A capital injection, a loan drawdown or
  // a tax refund makes the headline figure cash-positive while the business
  // itself is still consuming cash every month, and those are not remotely the
  // same situation to be in. Reported alongside the headline rather than instead
  // of it — both are true, and they answer different questions.
  const recs = (monthly.customerReceipts || []).slice(0, n);
  const hasSplit = recs.length === n;
  const avgOperatingIn = hasSplit ? sum(recs) / n : null;
  const operatingNet = hasSplit ? avgOperatingIn - avgOut : null;
  const operatingBurning = operatingNet !== null && operatingNet < 0;
  const operatingRunwayMonths = operatingBurning ? Math.max(0, closing / -operatingNet) : null;

  return {
    available: true,
    months: n,
    partial,
    avgCashIn: avgIn,
    avgCashOut: avgOut,
    avgNet,
    grossBurn: avgOut,
    netBurn: burning ? -avgNet : 0,
    burning,
    closing,
    // Null rather than Infinity when cash-positive. A business taking in more
    // than it spends does not have a long runway, it has no runway *question* —
    // and "∞ months" invites the reader to treat a non-measurement as a
    // measurement.
    runwayMonths,
    runwayDate: (runwayMonths !== null && today)
      ? _fmtISODate(_addDays(today, Math.round(runwayMonths * 30.44)))
      : null,
    netByMonth: cin.map((v, i) => v - cout[i]),

    // Null when the receipts breakdown wasn't supplied, so a caller that only
    // has in/out totals gets no operating figure rather than a wrong one.
    avgOperatingIn,
    operatingNet,
    operatingBurning,
    operatingRunwayMonths,
    // True when the headline says cash-positive only because of money that did
    // not come from customers — the case worth saying out loud.
    propped: burning === false && operatingBurning === true,
  };
}

// Pure. Opening → each driver → closing, as cumulative steps: every bar starts
// where the previous one ended, so the reader sees how the closing balance was
// ARRIVED AT rather than just what its parts were.
//
// The drivers come from Payments and Bank Transactions while opening/closing
// come from the bank statement, and those two can legitimately disagree. Rather
// than let the bars quietly fail to reach the closing balance, any difference is
// shown as its own labelled step.
function _buildCashWaterfall({ opening = 0, closing = 0, movement = {} } = {}) {
  const steps = [{ label: 'Opening balance', delta: opening, kind: 'total', start: 0, end: opening }];
  let run = opening;
  const push = (label, delta, kind) => {
    if (!delta) return;
    const start = run;
    run += delta;
    steps.push({ label, delta, kind, start, end: run });
  };

  push('Customer receipts', Number(movement.customerReceipts || 0), 'in');
  push('Other receipts',    Number(movement.otherReceipts || 0),    'in');
  push('Supplier payments', -Number(movement.supplierPayments || 0), 'out');
  push('Other payments',    -Number(movement.otherPayments || 0),    'out');

  const gap = Math.round((closing - run) * 100) / 100;
  const reconciles = Math.abs(gap) <= 1;
  if (!reconciles) push('Unreconciled', gap, 'gap');

  steps.push({ label: 'Closing balance', delta: run, kind: 'total', start: 0, end: run });
  return { steps, opening, closing: run, bankClosing: closing, gap, reconciles };
}

// ── Threshold alerts ────────────────────────────────────────────────────────
// Every threshold is expressed in months, days or a share of the organisation's
// OWN figures — never an absolute amount of money. A rule that fires at "cash
// below 10,000" is meaningful for one business and noise for the next, and this
// dashboard has to work for organisations we will never see.
//
// A rule whose input is null produces NO alert. Staying silent because a figure
// is unavailable is correct; showing a green light we did not earn is not.
const ALERT_THRESHOLDS = {
  runwayCriticalMonths: 3,
  runwayWarnMonths:     6,
  dsoWarnDays:          60,
  dsoCriticalDays:      90,
  overdueWarnShare:     0.20,
  overdueCriticalShare: 0.50,
  collectionWarnRate:   0.50,
};

const _SEVERITY_ORDER = { critical: 0, warn: 1, info: 2 };

function _buildAlerts({ runway = {}, workingCapital = {}, forecast = {}, unreconciled = {}, cash = {} } = {}, thresholds = ALERT_THRESHOLDS) {
  const alerts = [];
  // `detail` may carry a single {amount} placeholder. The figure stays a number
  // so the UI can format it in the org's own currency — the server never guesses
  // at a currency symbol.
  const add = (severity, code, title, detail, amount = null) => alerts.push({ severity, code, title, detail, amount });

  const wc = workingCapital;
  const receivable = Number(wc.receivable || 0);
  const payable    = Number(wc.payable || 0);

  // 1. The forecast crosses zero. The most actionable thing on the page: it
  //    names the week, so there is a date to work back from.
  const negative = (forecast.weeks || []).find(w => w.balance < 0);
  if (negative) {
    add('critical', 'cash-negative', 'Projected cash goes negative',
      `On current invoice due dates the balance falls below zero in week ${negative.week}, beginning ${negative.startISO}, reaching {amount}.`,
      negative.balance);
  }

  // 2. Runway. Only when actually burning — a cash-positive business has no
  //    runway to run out of.
  if (runway.available && runway.burning && runway.runwayMonths !== null && runway.runwayMonths !== undefined) {
    const m = runway.runwayMonths;
    if (m < thresholds.runwayCriticalMonths) {
      add('critical', 'runway-critical', 'Under three months of cash',
        `At the current net burn the balance runs out in about ${m.toFixed(1)} months, spending {amount} a month more than comes in.`,
        runway.netBurn);
    } else if (m < thresholds.runwayWarnMonths) {
      add('warn', 'runway-low', 'Under six months of cash',
        `About ${m.toFixed(1)} months at the current net burn of {amount} a month.`, runway.netBurn);
    }
  }

  // 3. The headline is positive only because of money that did not come from
  //    customers. Cash-positive and self-funding are not the same claim.
  if (runway.propped) {
    add('warn', 'operating-burn', 'Cash is positive but operations are not',
      'The balance grew, but the trading side of the business consumed {amount} a month once non-customer receipts are excluded.',
      runway.operatingNet === null || runway.operatingNet === undefined ? null : -runway.operatingNet);
  }

  // 4. Overdue as a SHARE of what is owed — size-independent by construction.
  if (receivable > 0 && Number(wc.overdue || 0) > 0) {
    const share = wc.overdue / receivable;
    const pct = Math.round(share * 100);
    if (share >= thresholds.overdueCriticalShare) {
      add('critical', 'overdue-major', 'Most receivables are overdue',
        `${pct}% of what customers owe you is past its due date — {amount}.`, wc.overdue);
    } else if (share >= thresholds.overdueWarnShare) {
      add('warn', 'overdue', 'Receivables are slipping',
        `${pct}% of what customers owe you is past its due date — {amount}.`, wc.overdue);
    }
  }

  // 5. Debtor days. Days are comparable across organisations; the underlying
  //    amounts are not.
  const dso = wc.dso;
  if (dso !== null && dso !== undefined && Number.isFinite(dso)) {
    if (dso > thresholds.dsoCriticalDays) {
      add('critical', 'dso-critical', 'Customers are taking a very long time to pay',
        `Invoiced revenue is taking about ${Math.round(dso)} days to become cash.`);
    } else if (dso > thresholds.dsoWarnDays) {
      add('warn', 'dso', 'Customers are paying slowly',
        `Invoiced revenue is taking about ${Math.round(dso)} days to become cash.`);
    }
  }

  // 6. Cannot cover what is owed even if every customer paid. Requires a real
  //    bank figure — without one, cover would read as zero and fire falsely.
  if (cash.available && payable > 0) {
    const cover = Number(cash.closing || 0) + receivable;
    if (cover < payable) {
      add('critical', 'cannot-cover', 'Bills exceed cash plus receivables',
        'Even if every customer paid in full you would still be {amount} short of what you owe suppliers.',
        payable - cover);
    }
  }

  // 7. Collections stalling.
  if (wc.collectionRate !== null && wc.collectionRate !== undefined
      && Number(wc.invoiced || 0) > 0 && wc.collectionRate < thresholds.collectionWarnRate) {
    add('warn', 'collection-rate', 'Less than half of invoiced work has been collected',
      `${Math.round(wc.collectionRate * 100)}% of {amount} invoiced has turned into cash.`, wc.invoiced);
  }

  // 8. The records disagree with the bank. Not a business problem — a
  //    bookkeeping one — but it undermines every figure above it.
  if (unreconciled.material) {
    add('info', 'unreconciled', 'Payment records do not tie to the bank',
      'Some payments recorded in Xero are not reflected in the bank statement, usually posted to a non-bank account or not yet reconciled.');
  }

  alerts.sort((a, b) => _SEVERITY_ORDER[a.severity] - _SEVERITY_ORDER[b.severity]);
  return {
    alerts,
    counts: {
      critical: alerts.filter(a => a.severity === 'critical').length,
      warn:     alerts.filter(a => a.severity === 'warn').length,
      info:     alerts.filter(a => a.severity === 'info').length,
    },
    thresholds,
  };
}

module.exports = { ALERT_THRESHOLDS, _buildAlerts, _buildCashForecast, _buildCashMovement, _buildCashWaterfall, _buildRunway, _buildWorkingCapital, _isReceiptPayment, _isTransfer };
