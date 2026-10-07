const { _toBase, _foreignCurrency } = require('./currency');
const { _monthKeyOfDate, _dateFromParts, _fmtISODate, _addDays, _closedCount, _lastDayOfMonth } = require('./periods');

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

// Xero hands back deleted payments and bank transactions (and voided bank
// transactions) alongside live ones, still carrying the amount they had. A
// deleted payment moved no money, so counting it put cash in or out of the
// bank that never went there.
const _isLive = r => !/^(DELETED|VOIDED)$/i.test(String(r?.status || '').trim());

// Which way a payment moved money. Only the two invoice payments read the way
// their names suggest: ACCRECPAYMENT is a customer paying you, ACCPAYPAYMENT is
// you paying a supplier. Every other type is a REFUND against a credit note, an
// overpayment or a prepayment, and a refund runs against its ledger: an AR*
// refund is money paid back OUT to a customer, an AP* refund is money a
// supplier paid back IN. The old rule ("contains REC, or starts with AR")
// counted a refund to a customer as a receipt, so money that left the bank was
// added to cash in.
const _isReceiptPayment = p => {
  const t = String(p?.paymentType || '').toUpperCase();
  if (t === 'ACCRECPAYMENT') return true;
  if (t === 'ACCPAYPAYMENT') return false;
  return t.startsWith('AP');
};

// True for the two payments that settle an invoice or a bill. The rest are the
// refunds above, which are not customer receipts or supplier payments however
// they are booked, so the cash view files them as "other".
const _isInvoicePayment = p => /^ACC(REC|PAY)PAYMENT$/i.test(String(p?.paymentType || ''));

// Which bucket a payment belongs in. A refund keeps its real direction but is
// not counted as trade with a customer or supplier: a refund paid to a customer
// is not a supplier payment, and one received from a supplier did not come
// from a customer.
function _paymentBucket(p) {
  const receipt = _isReceiptPayment(p);
  if (_isInvoicePayment(p)) return receipt ? 'customerReceipts' : 'supplierPayments';
  return receipt ? 'otherReceipts' : 'otherPayments';
}

function _buildCashMovement({ payments = [], bankTransactions = [], months = [], baseCurrency = '' }) {
  const idx = new Map(months.map((m, i) => [m.key, i]));
  const zero = () => Array(months.length).fill(0);
  const monthly = { customerReceipts: zero(), otherReceipts: zero(), supplierPayments: zero(), otherPayments: zero() };
  const totals  = { customerReceipts: 0, otherReceipts: 0, supplierPayments: 0, otherPayments: 0 };
  // Kept out of every figure above, but totalled: the Bank Summary's received
  // and spent columns DO include transfers, so the tie-out against it has to
  // take them off that side to compare like with like.
  const transfers = { in: 0, out: 0 };

  const add = (bucket, when, amount) => {
    const v = Math.abs(Number(amount || 0));
    if (!v) return;
    totals[bucket] += v;
    const i = idx.get(_monthKeyOfDate(when));
    if (i !== undefined) monthly[bucket][i] += v;
  };

  // Converted to base currency so these tie to the bank summary and the P&L,
  // both of which Xero reports in base.
  for (const p of payments) {
    if (!_isLive(p)) continue;
    add(_paymentBucket(p), p.date, _toBase(p, p.amount, baseCurrency));
  }
  for (const t of bankTransactions) {
    if (!_isLive(t)) continue;
    const receive = /^RECEIVE/i.test(t.type || '');
    if (_isTransfer(t)) {                               // own-account movement, not cash flow
      transfers[receive ? 'in' : 'out'] += Math.abs(Number(_toBase(t, t.total, baseCurrency) || 0));
      continue;
    }
    add(receive ? 'otherReceipts' : 'otherPayments', t.date, _toBase(t, t.total, baseCurrency));
  }

  const cashIn  = totals.customerReceipts + totals.otherReceipts;
  const cashOut = totals.supplierPayments + totals.otherPayments;
  return {
    ...totals, cashIn, cashOut, net: cashIn - cashOut,
    transfers,
    monthly: {
      ...monthly,
      in:  months.map((_, i) => monthly.customerReceipts[i] + monthly.otherReceipts[i]),
      out: months.map((_, i) => monthly.supplierPayments[i] + monthly.otherPayments[i]),
    },
  };
}

// Pure. Which currency each Bank Summary line is in, and totals that only add
// like to like.
//
// The Bank Summary names each account and says nothing of its currency, and
// the Banking table prints each account's figures in that account's own
// currency. The totals added every line together and called the sum the
// organisation's base currency, so a USD account's 10,000 went into an SGD
// total as 10,000 SGD. Each line is now matched by name to the bank account
// list, which does carry the currency. Only base-currency accounts are added
// into the totals; the rest are listed on their own, in their own currency,
// and `baseOnly` says the totals leave them out so the screen can say so.
//
// A line the list does not name, or any line when the list or the base
// currency is unknown, is taken to be in base currency. That is what every
// total assumed before, and it is right for the great majority of accounts.
function _bankByCurrency(bank, bankAccounts = [], baseCurrency = '') {
  const norm = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const listed = new Map((bankAccounts || []).map(a => [norm(a.name), a]));
  const base = String(baseCurrency || '').toUpperCase();
  const lines = (bank?.accounts || []).map(a => {
    const known = listed.get(norm(a.name));
    const currency = String(known?.currency || '').toUpperCase() || base;
    return { ...a, accountId: known?.accountId || null, currency, foreign: !!(base && currency !== base) };
  });
  const inBase  = lines.filter(a => !a.foreign);
  const foreign = lines.filter(a => a.foreign);
  const sum = field => inBase.reduce((s, a) => s + Number(a[field] || 0), 0);
  const cashIn = sum('cashReceived'), cashOut = sum('cashSpent');
  return {
    currency: base,
    accounts: inBase,
    foreignAccounts: foreign,
    closing: sum('closingBalance'),
    opening: sum('openingBalance'),
    cashIn, cashOut, net: cashIn - cashOut,
    baseOnly: foreign.length > 0,
  };
}

// The bank account a payment or bank transaction moved money through: a
// bank transaction names it as bankAccount, a payment as account.
const _recordAccountId = r => r?.bankAccount?.accountID || r?.account?.accountID || null;

// Pure. Whether the payment records tie to the Bank Summary, compared like with
// like.
//
// The Bank Summary's "Cash Received" and "Cash Spent" count a transfer between
// two of the org's own accounts on both sides — out of one, into the other —
// while the movement above leaves transfers out because they are not cash flow.
// Compared as they were, every transfer showed up as money the bank had and the
// records did not, and raised the "does not tie" alert on books that tied
// exactly. So the transfers are taken off the bank's figures before comparing.
//
// A positive gap means the records show more than the bank; a negative one
// means the bank shows more than the records. Which it is decides what to go
// and look for, so the sign is kept rather than folded into a magnitude.
function _buildUnreconciled({ movement = {}, bankIn = 0, bankOut = 0 } = {}) {
  const tIn  = Number(movement.transfers?.in  || 0);
  const tOut = Number(movement.transfers?.out || 0);
  const round = v => Math.round(v * 100) / 100;
  const inGap  = round(Number(movement.cashIn  || 0) - (bankIn  - tIn));
  const outGap = round(Number(movement.cashOut || 0) - (bankOut - tOut));
  return {
    inGap, outGap,
    transfersIn: round(tIn), transfersOut: round(tOut),
    material: Math.abs(inGap) > 1 || Math.abs(outGap) > 1,
  };
}

// Pure. What is owed in each direction, and how much of what was invoiced has
// actually turned into money.

// Xero's SDK hands dates back as Date OBJECTS, not ISO strings. String(date)
// on one yields "Sun May 10", which compares as a string against "2026-04-01"
// without erroring — it passes a lower-bound check because "S" sorts above "2",
// then fails the upper bound, so every bill was silently dropped. Normalising
// through Date is the only safe way to get a comparable day.
function _isoDay(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Pure. Who the money actually goes to.
//
// The revenue side has had Top Customers since the beginning; the cost side only
// ever had expense ACCOUNTS — "Rent", "Payroll" — and never suppliers. For an
// app whose primary document is a bill, that was a blind spot: "Rent 12,000"
// names a category, while "Landlord X is 40% of your fixed costs" is something
// you might act on.
//
// Filtered by DATE to the period on screen. The invoice fetch deliberately
// reaches back further than the period so the forecast can see older unpaid
// bills, so aggregating it unfiltered would report a two-year total under a
// heading that says this quarter.
function _buildSupplierSpend(invoices, { baseCurrency = '', fromISO = null, toISO = null } = {}) {
  const bills = (invoices || []).filter(inv => {
    if (inv.type !== 'ACCPAY') return false;
    if (!fromISO && !toISO) return true;
    const d = _isoDay(inv.date);
    // An undated bill cannot be placed in a period, so it is excluded rather
    // than silently counted in whichever one happens to be on screen.
    if (!d) return false;
    if (fromISO && d < fromISO) return false;
    if (toISO && d > toISO) return false;
    return true;
  });

  const byContact = new Map();
  for (const inv of bills) {
    const name = inv.contact?.name || 'Unknown';
    // Base currency, so a USD supplier and an SGD one are ranked on like numbers.
    const amount = _toBase(inv, inv.total, baseCurrency);
    if (!byContact.has(name)) byContact.set(name, { name, spend: 0, bills: 0 });
    const c = byContact.get(name);
    c.spend += amount;
    c.bills += 1;
  }

  const suppliers = [...byContact.values()].sort((a, b) => b.spend - a.spend);
  const total = suppliers.reduce((s, c) => s + c.spend, 0);

  return {
    suppliers,
    total,
    count: suppliers.length,
    // Share of spend going to the single largest supplier — the concentration
    // question. Null rather than zero when nothing was billed, because a
    // concentration of no spend is meaningless, not 0%.
    topShare: total > 0 && suppliers.length ? suppliers[0].spend / total : null,
    average: suppliers.length ? total / suppliers.length : null,
    currency: _foreignCurrency(bills, baseCurrency),
    available: suppliers.length > 0,
  };
}

// The month a document is dated in. An ISO string's own month is taken as
// written: parsing "2026-04-01T00:00:00", which carries no offset, reads it in
// the server's local time, and east of UTC that lands it in March. A Date
// object (some Xero records arrive as one) goes through the usual UTC reading.
function _monthOfDoc(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}/.test(value)) return value.slice(0, 7);
  return _monthKeyOfDate(value);
}

// Pure. What was invoiced to customers and billed by suppliers in each month,
// as { 'YYYY-MM': { sales, bills } }, in base currency and INCLUDING tax — the
// same basis as the amounts still owed, which include tax too. A draft has not
// been sent and a voided or deleted document was never owed, so neither counts.
function _raisedByMonth(invoices = [], baseCurrency = '') {
  const out = {};
  for (const inv of invoices || []) {
    if (/^(DRAFT|SUBMITTED|DELETED|VOIDED)$/i.test(String(inv?.status || ''))) continue;
    const side = inv?.type === 'ACCREC' ? 'sales' : inv?.type === 'ACCPAY' ? 'bills' : null;
    const key = side ? _monthOfDoc(inv.date) : null;
    if (!key) continue;
    if (!out[key]) out[key] = { sales: 0, bills: 0 };
    out[key][side] += Number(_toBase(inv, inv.total, baseCurrency) || 0);
  }
  for (const m of Object.values(out)) {
    m.sales = Math.round(m.sales * 100) / 100;
    m.bills = Math.round(m.bills * 100) / 100;
  }
  return out;
}

function _daysInMonthKey(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
  return m ? _lastDayOfMonth(+m[1], +m[2]) : 0;
}

// Pure. Debtor days (DSO) and creditor days (DPO), defined in this one place.
// getPerformance works them out once for the period and the Overview, the Cash
// Flow tab, the alerts and the AI commentary all read that one figure; the
// Overview used to compute a second, different one of its own.
//
// Three things were wrong with the old figures, and each moved them a lot:
//   * they divided by every day of the period, months not yet begun included,
//     so a financial year viewed in its fifth month spread five months of sales
//     over a whole year of days;
//   * what customers owe includes tax, while the P&L revenue it was divided by
//     does not, so taxed sales inflated debtor days by the tax rate;
//   * creditor days were measured against every overhead — wages, depreciation,
//     costs no supplier ever bills for — which pulled them towards nothing.
// So both are measured over the period's CLOSED months only, and each side of
// each ratio comes from the same documents with tax treated alike: what
// customers owe now against what was invoiced to them in those months, and what
// is owed to suppliers now against what suppliers billed in those months. Bills
// are where cost of sales and supplier-charged overheads arrive; payroll and
// depreciation never do.
//
// Null rather than a guess when there is no closed month, or nothing was
// invoiced or billed in them.
function _buildPaymentDays({ receivable = 0, payable = 0, raisedByMonth = {}, months = [], today } = {}) {
  const n = _closedCount(months, today);
  const closed = months.slice(0, n);
  let invoiced = 0, billed = 0, days = 0;
  for (const m of closed) {
    const r = raisedByMonth?.[m.key];
    invoiced += Number(r?.sales || 0);
    billed   += Number(r?.bills || 0);
    days     += _daysInMonthKey(m.key);
  }
  const rec = Number(receivable || 0), pay = Number(payable || 0);
  return {
    available: n > 0,
    // Why there is no figure, so the screen can say which: no closed month yet
    // is a fact about the calendar, not a fault.
    reason: n > 0 ? null : 'no-closed-month',
    dso: n > 0 && invoiced > 0 ? (rec / invoiced) * days : null,
    dpo: n > 0 && billed   > 0 ? (pay / billed)   * days : null,
    receivable: rec, payable: pay,
    invoiced: Math.round(invoiced * 100) / 100,
    billed:   Math.round(billed * 100) / 100,
    days,
    closedMonths: n,
    fromLabel: n ? closed[0].label || closed[0].key : null,
    toLabel:   n ? closed[n - 1].label || closed[n - 1].key : null,
  };
}

// Debtor and creditor days are not worked out here: they come in as
// `paymentDays` from _buildPaymentDays, so this tab cannot disagree with the
// Overview about them.
function _buildWorkingCapital({ invoices = [], today, baseCurrency = '', paymentDays = null }) {
  const ar = { raised: 0, due: 0, count: 0 }, ap = { raised: 0, due: 0, count: 0 };
  const buckets = { current: 0, d1_30: 0, d31_60: 0, d60plus: 0 };
  const now = today ? _dateFromParts(today) : new Date();

  for (const inv of invoices) {
    const g = inv.type === 'ACCREC' ? ar : inv.type === 'ACCPAY' ? ap : null;
    if (!g) continue;
    // Base currency, so a USD invoice and an SGD one add up to something that
    // means anything, and the totals sit beside report figures Xero gives in base.
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
    dso: paymentDays?.dso ?? null,
    dpo: paymentDays?.dpo ?? null,
    // What the two figures were measured over, so the screen can say so.
    paymentDays: paymentDays ? {
      available: !!paymentDays.available, reason: paymentDays.reason || null,
      closedMonths: paymentDays.closedMonths, fromLabel: paymentDays.fromLabel, toLabel: paymentDays.toLabel,
      days: paymentDays.days, invoiced: paymentDays.invoiced, billed: paymentDays.billed,
    } : null,
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
  // Share of spend going to one supplier. Relative like every other threshold
  // here, so it means the same thing whatever the size of the business.
  supplierConcentrationWarn: 0.50,
};

const _SEVERITY_ORDER = { critical: 0, warn: 1, info: 2 };

// What the "does not tie" alert says, by which way the records and the bank
// disagree. It used to say payments were recorded but missing from the bank
// whatever the sign, so a bank showing MORE than the records — every transfer
// between the org's own accounts did that — was described backwards, and sent
// the reader looking for the wrong thing.
function _unreconciledDetail(u = {}) {
  const gaps  = [Number(u.inGap || 0), Number(u.outGap || 0)];
  const over  = gaps.some(g => g > 1);    // the records show more than the bank
  const under = gaps.some(g => g < -1);   // the bank shows more than the records
  const parts = [];
  if (over) {
    parts.push('Some payments recorded in Xero are not in the bank accounts’ totals, usually because they were posted to an account that is not a bank account, or not yet reconciled.');
  }
  if (under) {
    parts.push('The bank accounts show money moving that no payment or bank transaction in Xero accounts for, usually an entry posted straight to a bank account, such as a manual journal.');
  }
  return parts.length ? parts.join(' ') : 'Xero’s payment records and the bank accounts’ totals disagree for this period.';
}

function _buildAlerts({ runway = {}, workingCapital = {}, forecast = {}, unreconciled = {}, cash = {}, supplierSpend = {} } = {}, thresholds = ALERT_THRESHOLDS) {
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

  // 8. One supplier taking most of the spend. The panel already coloured this
  //    amber, but it was not an alert — so it never reached the band, the AI, or
  //    anything else that reads alerts. A signal shown in only one place is a
  //    signal that gets missed.
  if (supplierSpend.available && supplierSpend.topShare !== null && supplierSpend.topShare !== undefined
      && supplierSpend.count > 1 && supplierSpend.topShare >= thresholds.supplierConcentrationWarn) {
    const pct = Math.round(supplierSpend.topShare * 100);
    add('warn', 'supplier-concentration', 'Most of your spend goes to one supplier',
      `${pct}% of what you were billed this period went to ${supplierSpend.suppliers[0].name} — {amount}.`,
      supplierSpend.suppliers[0].spend);
  }

  // 9. The records disagree with the bank. Not a business problem — a
  //    bookkeeping one — but it undermines every figure above it.
  if (unreconciled.material) {
    add('info', 'unreconciled', 'Payment records do not tie to the bank', _unreconciledDetail(unreconciled));
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

module.exports = {
  _buildSupplierSpend, _isoDay, ALERT_THRESHOLDS, _buildAlerts, _buildCashForecast, _buildCashMovement, _buildCashWaterfall, _buildRunway, _buildWorkingCapital, _isReceiptPayment, _isTransfer,
  _isLive, _isInvoicePayment, _paymentBucket, _buildUnreconciled, _unreconciledDetail, _raisedByMonth, _buildPaymentDays, _monthOfDoc,
  _bankByCurrency, _recordAccountId,
};
