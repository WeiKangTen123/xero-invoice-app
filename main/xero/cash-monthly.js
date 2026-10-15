const crypto             = require('crypto');
const logger             = require('../utils/logger');
const { withRetry, isScopeError, xeroErrMsg } = require('./xero-utils');
const { _cacheGet, _cacheSet, _dedupe, _periodCacheTtl } = require('./report-cache');
const { _apiFor, _allPages, getAccounts } = require('./report-fetch');
const { _buildBankSummary, _bankAccountsOrNull } = require('./bank');
const { _bankByCurrency, _isInvoicePayment, _isLive, _isReceiptPayment, _isTransfer } = require('./cash-flow');
const { getCashManager, HORIZON_DAYS, MAX_HORIZON_DAYS } = require('./cash-manager');
const { getBudgetVariance, _mapWithConcurrency, _norm, _pnlCallPlan, _sectionKind } = require('./budget-variance');
const { _xeroDay } = require('./performance');
const { _toBase } = require('./currency');
const { _addDays, _chunkMonths, _dateFromParts, _fmtXeroDate, _monthMeta, _parseISODate, _todayPartsInTz } = require('./periods');

// The monthly cash forecast: the months before this one as they happened, this
// month as it has gone so far and is expected to go, and the months after it
// as the Cash Flow Manager expects them, each one opening where the one before
// closed. The daily Cash Flow Manager (cash-manager.js) answers "will we have
// enough on the 23rd?"; this answers "where are we heading over the year?".
//
// Built from:
//   * Xero's Bank Summary for each past month, for the balances it opened and
//     closed on, across the bank accounts the Cash Flow Manager counts;
//   * the payments and bank transactions recorded in Xero over the past
//     months and this month to today, for what the money was: a payment
//     settles a sales invoice or a bill, and each bank transaction line is
//     put under a row by the account it is coded to (the chart of accounts);
//   * the Cash Flow Manager's own forecast, read with its horizon stretched to
//     the last month shown, so every item is placed and changed exactly as on
//     that tab;
//   * the Overall Budget in Xero, optionally, for what the months ahead are
//     expected to bring beyond what is already scheduled.
//
// Xero publishes no cash flow statement, and the journals that would explain
// every movement are a scope this app's connection is refused. So whatever the
// Bank Summary shows moving that no payment or bank transaction explains (a
// pay run, a manual journal, an entry posted straight to a bank account) is
// shown as "Other / unexplained" rather than left out: every past month then
// adds up to Xero's own closing balance to the cent. Every Xero call is a GET.

const PAST_MAX       = 12;
const FUTURE_MAX     = 12;
const PAST_DEFAULT   = 6;
const FUTURE_DEFAULT = 6;
const FILLS = ['budget', 'none'];
// The payload, and the payments and bank transactions behind it, are kept ten
// minutes: this month's records are still being reconciled, as the Cash Flow
// Manager's own reads are.
const PAYLOAD_TTL_MS = 10 * 60 * 1000;
const RECORDS_TTL_MS = 10 * 60 * 1000;
// Bank Summary months two at a time, as the budget's report chunks are: twelve
// at once would burst against Xero's five calls in flight per organisation.
const BANK_CONCURRENCY = 2;

// The rows, in the order the screen and the exports print them.
const ROWS = [
  { key: 'opening',       label: 'Opening balance',          group: 'balance' },
  { key: 'in_customer',   label: 'Customer receipts',        group: 'in' },
  { key: 'in_other',      label: 'Other income & refunds',   group: 'in' },
  { key: 'in_finance',    label: 'Loans & capital',          group: 'in' },
  { key: 'in_total',      label: 'Total cash in',            group: 'in' },
  { key: 'out_supplier',  label: 'Supplier payments',        group: 'out' },
  { key: 'out_wages',     label: 'Wages & salaries',         group: 'out' },
  { key: 'out_tax',       label: 'GST & tax',                group: 'out' },
  { key: 'out_overheads', label: 'Overheads',                group: 'out' },
  { key: 'out_finance',   label: 'Loan repayments & capex',  group: 'out' },
  { key: 'out_other',     label: 'Other / unexplained',      group: 'out' },
  { key: 'out_total',     label: 'Total cash out',           group: 'out' },
  { key: 'net',           label: 'Net movement',             group: 'net' },
  // The bank options' opening adjustments, this month only: not cash in or
  // out, but where the Cash Flow Manager's balance starts from.
  { key: 'adjustment',    label: 'Your bank adjustments',    group: 'balance' },
  { key: 'closing',       label: 'Closing balance',          group: 'balance' },
  { key: 'overdue',       label: 'Overdue, not yet scheduled', group: 'info' },
];
const LINES_IN  = ['in_customer', 'in_other', 'in_finance'];
const LINES_OUT = ['out_supplier', 'out_wages', 'out_tax', 'out_overheads', 'out_finance', 'out_other'];
const LINES     = [...LINES_IN, ...LINES_OUT];
// The rows going out that the budget's cost of sales and expenses fill.
const BUDGET_OUT = ['out_supplier', 'out_wages', 'out_overheads'];

// What a cell's figure was made from, in the words the screen shows on hover.
const SRC = {
  bank:        'bank',
  payments:    'payments',
  bankTx:      'bank transactions',
  unexplained: 'unexplained',
  transfers:   'transfers with accounts left out',
  adjustment:  'opening adjustment',
  previous:    'previous closing',
  forecast:    'forecast',
  budget:      'budget',
};
const ITEM_SOURCE = {
  invoice:   'open invoices',
  bill:      'open bills',
  repeating: 'repeating',
  payment:   'payments dated ahead',
  banktx:    'bank transactions dated ahead',
  manual:    'your entries',
};

// Names that say what an account or an entry is for. Wages are matched on the
// account's name because Xero types a payroll expense as an ordinary expense
// outside the regions with payroll account types; tax likewise. "Staff" alone
// is not wages ("Staff welfare", "Staff training" are overheads): only staff
// costs, pay, salaries or wages are. Superannuation is wages, as CPF is.
const WAGES_RE       = /\bwage|salar|payroll|cpf|bonus|\bstaff\s+(costs?|pay|salary|salaries|wages?)\b|\bsuper(annuation)?\b/i;
// Tax as whole words, payroll taxes with it, so "Private loan" is not VAT and
// "Union fees" not National Insurance. PAYE, PAYG and NI held for the tax
// office are tax, not a loan.
const TAX_ACCOUNT_RE = /\b(gst|vat|tax|taxes|taxation|paye|payg|withholdings?|national\s+insurance|ni|nics?)\b/i;
// An entry's description is free text, so tax is matched as a word: "Taxi
// fares" is not tax, "GST Q3" and "BAS" are.
const TAX_ENTRY_RE   = /\b(gst|vat|bas|paye|payg|iras|hmrc|ato|ird|tax|taxes)\b/i;
// Depreciation and amortisation move no cash; budgeted, they are not money
// that will leave the bank.
const NON_CASH_RE    = /depreciat|amorti[sz]/i;
// Income tax budgeted by the month is not when it is paid.
const INCOME_TAX_RE  = /income tax|taxation/i;

const INCOME_TYPES  = new Set(['REVENUE', 'SALES', 'OTHERINCOME']);
const EXPENSE_TYPES = new Set(['EXPENSE', 'OVERHEADS', 'DIRECTCOSTS', 'DEPRECIATN']);
const WAGE_TYPES    = new Set(['WAGESEXPENSE', 'SUPERANNUATIONEXPENSE', 'SUPERANNUATIONLIABILITY']);
const FINANCE_TYPES = new Set(['TERMLIAB', 'LIABILITY', 'EQUITY']);

// Whole cents, as everywhere money is added here, so the months, the totals
// and the closing balance agree to the last cent.
const toCents   = v => Math.round(Number(v || 0) * 100);
const fromCents = c => (c === null || c === undefined ? null : c === 0 ? 0 : c / 100);
const sum = list => list.reduce((s, v) => s + (v || 0), 0);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const money = cents => (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Which row money belongs in ──────────────────────────────────────────────

// Pure. The row for money moving `direction` ('in' or 'out') through a line
// coded to `account` (getAccounts' { type, name, systemAccount }). A cash
// sale is a customer's money and a direct cost a supplier's, as the budget
// fills the months ahead, so the past compares with them; other income is
// other. Money coming back through an expense or income account is a refund,
// under "Other income & refunds" or "Other / unexplained"; an account this
// cannot place is "other" too, never guessed into a named row.
function _accountCategory(account, direction) {
  const into = direction === 'in';
  if (!account) return into ? 'in_other' : 'out_other';
  const type = String(account.type || '').toUpperCase();
  const name = String(account.name || '');
  // Xero's system accounts say what they are outright, where the chart of
  // accounts carries them.
  const sys  = String(account.systemAccount || account.SystemAccount || '').toUpperCase();
  if (sys === 'DEBTORS')   return into ? 'in_customer' : 'out_other';
  if (sys === 'CREDITORS') return into ? 'in_other' : 'out_supplier';
  if (sys === 'GST' || sys === 'GSTONIMPORTS') return into ? 'in_other' : 'out_tax';
  if (sys === 'WAGEPAYABLES') return into ? 'in_other' : 'out_wages';
  if (INCOME_TYPES.has(type)) return into ? (type === 'OTHERINCOME' ? 'in_other' : 'in_customer') : 'out_other';
  if (WAGE_TYPES.has(type))   return into ? 'in_other' : 'out_wages';
  if (EXPENSE_TYPES.has(type)) {
    if (into) return 'in_other';
    if (WAGES_RE.test(name)) return 'out_wages';
    return type === 'DIRECTCOSTS' ? 'out_supplier' : 'out_overheads';
  }
  if (type === 'PAYGLIABILITY') return into ? 'in_other' : 'out_tax';
  if (type === 'CURRLIAB') {
    // A GST refund from the tax office comes in through the same account the
    // GST is paid from.
    if (TAX_ACCOUNT_RE.test(name)) return into ? 'in_other' : 'out_tax';
    if (WAGES_RE.test(name))       return into ? 'in_other' : 'out_wages';
    return into ? 'in_finance' : 'out_finance';
  }
  if (FINANCE_TYPES.has(type)) return into ? 'in_finance' : 'out_finance';
  // Buying equipment is capital spent; selling it is other income.
  if (type === 'FIXED')     return into ? 'in_other' : 'out_finance';
  if (type === 'INVENTORY') return into ? 'in_other' : 'out_supplier';
  return into ? 'in_other' : 'out_other';
}

// Pure. A payment settling a sales invoice is a customer's money, one
// settling a bill a supplier's. Every other payment is a refund (see
// cash-flow.js#_isReceiptPayment), which is neither.
function _paymentCategory(p) {
  if (p.invoicePayment) return p.receipt ? 'in_customer' : 'out_supplier';
  return p.receipt ? 'in_other' : 'out_other';
}

// Pure. An entry made in the Cash Flow Manager going out, by what its
// description says it is for. Tax is tried first: "Payroll tax" is tax.
function _entryCategory(description) {
  const d = String(description || '');
  if (TAX_ENTRY_RE.test(d)) return 'out_tax';
  if (WAGES_RE.test(d)) return 'out_wages';
  return 'out_overheads';
}

// Pure. A bank transaction dated ahead's lines ({ code, amount }, in base
// currency) in cents, their codes as `accountsByCode` keys them, and whether
// the item can be split by them: not when a line is below nothing, or when
// they do not add up to the item's own amount (an amount changed here, say).
function _itemLines(item, cents) {
  const lines = (Array.isArray(item?.accounts) ? item.accounts : [])
    .map(l => ({ code: String(l?.code || '').toUpperCase(), cents: toCents(l?.amount) }))
    .filter(l => l.cents);
  if (!lines.length) return { lines, whole: false };
  return { lines, whole: !lines.some(l => l.cents < 0) && sum(lines.map(l => l.cents)) === cents };
}

// Pure. The row a Cash Flow Manager item lands in. Repeating invoices and
// payments dated ahead are trade, a customer's or a supplier's, by their
// direction; an entry made here coming in is other income. A bank
// transaction dated ahead goes by the account its largest line is coded to
// (see _itemParts for its split), or is other with no line to go by.
function _itemCategory(item, accountsByCode = new Map()) {
  const into = item?.direction === 'in';
  switch (item?.source) {
    case 'invoice':   return into ? 'in_customer' : 'out_supplier';
    case 'bill':      return into ? 'in_other' : 'out_supplier';
    case 'repeating':
    case 'payment':   return into ? 'in_customer' : 'out_supplier';
    case 'manual':    return into ? 'in_other' : _entryCategory(item.description || item.reference);
    case 'banktx': {
      const { lines } = _itemLines(item, toCents(item.amount));
      if (!lines.length) return into ? 'in_other' : 'out_other';
      const largest = lines.reduce((a, b) => (Math.abs(b.cents) > Math.abs(a.cents) ? b : a));
      return _accountCategory(accountsByCode.get(largest.code) || null, into ? 'in' : 'out');
    }
    default:          return into ? 'in_other' : 'out_other';
  }
}

// Pure. A Cash Flow Manager item as cents under rows. A bank transaction
// dated ahead is split by its lines, each under the row of the account it is
// coded to, as a past one is; when its lines do not add up to its amount it
// goes whole under its largest line's row. Everything else is one row.
function _itemParts(item, accountsByCode = new Map()) {
  const cents = toCents(item?.amount);
  if (item?.source === 'banktx') {
    const { lines, whole } = _itemLines(item, cents);
    const dir = item.direction === 'in' ? 'in' : 'out';
    if (whole) return lines.map(l => ({ row: _accountCategory(accountsByCode.get(l.code) || null, dir), cents: l.cents }));
  }
  return [{ row: _itemCategory(item, accountsByCode), cents }];
}

// ── The records ─────────────────────────────────────────────────────────────

// Pure. The payments of the months shown, cut down to what the rows need.
function _monthlyPaymentsOf(list = []) {
  return (list || []).filter(p => p && _isLive(p)).map(p => ({
    paymentId:      p.paymentID || null,
    date:           _xeroDay(p.date),
    receipt:        _isReceiptPayment(p),
    invoicePayment: _isInvoicePayment(p),
    amount:         Number(p.amount || 0),
    // A payment carries a rate but no currency; the invoice it pays names it.
    currencyRate:   p.currencyRate ?? null,
    currencyCode:   p.invoice?.currencyCode ? String(p.invoice.currencyCode) : '',
    accountId:      p.account?.accountID || null,
  }));
}

// Pure. The bank transactions of the months shown, with their lines: the
// account a line is coded to is what says whether the money was wages, tax,
// rent or a loan. A line's cash is what it adds to the transaction's total,
// tax included, so a line entered exclusive of tax counts its tax too.
function _monthlyBankTransactionsOf(list = []) {
  return (list || []).filter(t => t && _isLive(t)).map(t => {
    const inclusive = /^(INCLUSIVE|NOTAX)$/i.test(String(t.lineAmountTypes || ''));
    return {
      bankTransactionId: t.bankTransactionID || null,
      date:         _xeroDay(t.date),
      type:         String(t.type || '').toUpperCase(),
      receipt:      /^RECEIVE/i.test(String(t.type || '')),
      transfer:     _isTransfer(t),
      amount:       Number(t.total || 0),
      currencyRate: t.currencyRate ?? null,
      currencyCode: t.currencyCode ? String(t.currencyCode) : '',
      accountId:    t.bankAccount?.accountID || null,
      lines: (t.lineItems || []).map(l => ({
        accountCode: l?.accountCode ? String(l.accountCode) : '',
        accountId:   l?.accountID || null,
        amount:      Number(l?.lineAmount || 0) + (inclusive ? 0 : Number(l?.taxAmount || 0)),
      })),
    };
  });
}

// Pure. `totalCents` split across `weights` in proportion, in whole cents
// that add up to exactly the total: each share is the rounded running total
// less the one before, so no cent is lost or made in the rounding. Null when
// the weights add to nothing and there is no proportion to follow.
function _allocate(totalCents, weights) {
  const whole = sum(weights);
  if (!whole) return null;
  let run = 0, prev = 0;
  return weights.map(w => {
    run += w;
    const upto = Math.round((totalCents * run) / whole);
    const share = upto - prev;
    prev = upto;
    return share;
  });
}

// Pure. `totalCents` split across `weights` in proportion, in whole cents,
// each share rounded down and the cents that leaves over put on the largest
// weight, so the shares add up to exactly the total and no row is ever below
// nothing. Null when the weights add to nothing.
function _splitToLargest(totalCents, weights) {
  const whole = sum(weights);
  if (!whole) return null;
  const shares = weights.map(w => Math.floor((totalCents * w) / whole));
  let largest = 0;
  weights.forEach((w, k) => { if (w > weights[largest]) largest = k; });
  shares[largest] += totalCents - sum(shares);
  return shares;
}

// Pure. A bank transaction as cents under rows, in base currency. A customer's
// or supplier's overpayment or prepayment is trade money whatever its lines
// say. A transaction with no lines to go by is other.
function _bankTransactionParts(t, { accountsByCode, accountsById, base }) {
  const cents = Math.abs(toCents(_toBase(t, t.amount, base)));
  if (!cents) return [];
  const dir = t.receipt ? 'in' : 'out';
  if (/(OVERPAYMENT|PREPAYMENT)$/.test(t.type)) return [{ row: t.receipt ? 'in_customer' : 'out_supplier', cents }];
  const lines = (t.lines || []).filter(l => toCents(l.amount));
  const shares = lines.length ? _allocate(cents, lines.map(l => toCents(l.amount))) : null;
  if (!shares) return [{ row: dir === 'in' ? 'in_other' : 'out_other', cents }];
  return lines.map((l, k) => {
    const account = (l.accountId && accountsById.get(l.accountId)) || accountsByCode.get(String(l.accountCode).toUpperCase()) || null;
    return { row: _accountCategory(account, dir), cents: shares[k] };
  });
}

// Pure. The chart of accounts by code (upper case) and by Xero id.
function _accountMaps(accounts = []) {
  const accountsByCode = new Map(), accountsById = new Map();
  for (const a of accounts || []) {
    if (a?.code) accountsByCode.set(String(a.code).toUpperCase(), a);
    if (a?.accountId) accountsById.set(a.accountId, a);
  }
  return { accountsByCode, accountsById };
}

// Pure. What moved in each month from `fromISO` to `toISO`: cents under each
// row with the records it came from, and transfers between bank accounts kept
// apart, since one between two counted accounts is no money in or out. `keep`
// says whether a record went through a counted bank account.
function _movementByMonth({ payments = [], bankTransactions = [], accounts = [], base = '', keep = () => true, fromISO, toISO }) {
  const { accountsByCode, accountsById } = _accountMaps(accounts);
  const out = new Map();
  const at = key => {
    if (!out.has(key)) out.set(key, { rows: {}, sources: {}, transfersIn: 0, transfersOut: 0 });
    return out.get(key);
  };
  const put = (m, row, cents, source) => {
    m.rows[row] = (m.rows[row] || 0) + cents;
    if (!m.sources[row]) m.sources[row] = new Set();
    m.sources[row].add(source);
  };
  const inSpan = r => !!r?.date && r.date >= fromISO && r.date <= toISO && _isLive(r) && keep(r);
  for (const p of payments || []) {
    if (!inSpan(p)) continue;
    const cents = Math.abs(toCents(_toBase(p, p.amount, base)));
    if (cents) put(at(p.date.slice(0, 7)), _paymentCategory(p), cents, SRC.payments);
  }
  for (const t of bankTransactions || []) {
    if (!inSpan(t)) continue;
    const m = at(t.date.slice(0, 7));
    if (t.transfer) {
      m[t.receipt ? 'transfersIn' : 'transfersOut'] += Math.abs(toCents(_toBase(t, t.amount, base)));
      continue;
    }
    for (const part of _bankTransactionParts(t, { accountsByCode, accountsById, base })) put(m, part.row, part.cents, SRC.bankTx);
  }
  return out;
}

// ── The bank ────────────────────────────────────────────────────────────────

// Pure. A Bank Summary cut to the accounts the Cash Flow Manager counts: base
// currency (see cash-flow.js#_bankByCurrency) and not switched off in its bank
// options, matched by Xero id or, for an account the list does not name, by
// name, as the Cash Flow Manager matches them. In cents. Null for a summary
// with no account lines at all: that is no balance, not a balance of nil.
// Lines that are all switched off or foreign are a nil balance of the
// accounts chosen to count, as on the Cash Flow Manager.
function _countedBank(bank, bankAccounts = [], base = '', bankOptions = {}) {
  if (!bank || !(bank.accounts || []).length) return null;
  const byCur = _bankByCurrency(bank, bankAccounts, base);
  const lines = byCur.accounts.filter(a => bankOptions?.[a.accountId || `name:${a.name}`]?.included !== false);
  const total = field => lines.reduce((s, a) => s + toCents(a[field]), 0);
  return {
    opening: total('openingBalance'), closing: total('closingBalance'),
    received: total('cashReceived'), spent: total('cashSpent'),
    accounts: lines.length, foreign: byCur.foreignAccounts.length,
  };
}

// Pure. The bank accounts the records of which are left out: another
// currency, or switched off in the bank options. An account switched off by
// its Xero id is left out even when the list could not be read (null).
function _leftOutIds(bankAccounts = [], base = '', bankOptions = {}) {
  const out = new Set();
  const b = String(base || '').toUpperCase();
  for (const a of bankAccounts || []) {
    if (!a?.accountId) continue;
    const cur = String(a.currency || '').toUpperCase();
    if ((b && cur && cur !== b) || bankOptions?.[a.accountId]?.included === false) out.add(a.accountId);
  }
  for (const [id, o] of Object.entries(bankOptions || {})) {
    if (o?.included === false && !id.startsWith('name:')) out.add(id);
  }
  return out;
}

// ── The budget ──────────────────────────────────────────────────────────────

// Pure. The Overall Budget's cash rows for each month it covers, in cents:
// revenue to customer receipts, cost of sales to supplier payments, and every
// other expense to wages or overheads, by the same names the actuals go by
// (the account's own type where the chart of accounts names it). What is left
// out, and why, is totalled for the notes.
function _budgetByMonth(budget, accounts = []) {
  const byMonth = new Map();
  const left = { nonCash: 0, incomeTax: 0, otherIncome: 0 };
  if (!budget || budget.budgetMissing) return { byMonth, left };
  const byName = new Map((accounts || []).map(a => [_norm(a?.name), a]));
  (budget.months || []).forEach((m, i) => {
    const sums = {};
    for (const r of budget.rows || []) {
      if (r?.kind !== 'account') continue;
      const cents = toCents(r.monthly?.[i]?.budget);
      if (!cents) continue;
      const kind = _sectionKind(r.section);
      const account = byName.get(_norm(r.label));
      let row = null;
      if (kind === 'revenue') row = 'in_customer';
      else if (kind === 'cogs') row = 'out_supplier';
      else if (kind === 'opex' || kind === 'otherExpense') {
        if (NON_CASH_RE.test(r.label) || NON_CASH_RE.test(r.section) || String(account?.type || '').toUpperCase() === 'DEPRECIATN') {
          left.nonCash += cents; continue;
        }
        if (INCOME_TAX_RE.test(r.section) || /^income tax/i.test(String(r.label || ''))) { left.incomeTax += cents; continue; }
        row = _accountCategory(account || { type: 'EXPENSE', name: r.label }, 'out') === 'out_wages' ? 'out_wages' : 'out_overheads';
      } else if (kind === 'otherIncome') { left.otherIncome += cents; continue; }
      if (row) sums[row] = (sums[row] || 0) + cents;
    }
    byMonth.set(m.key, sums);
  });
  return { byMonth, left };
}

// Pure. Whether the budget holds any figure, of any line, for the months
// `keys`: a budget set up in Xero but left at nought fills nothing.
function _budgetHasFigures(budget, keys = []) {
  if (!budget || budget.budgetMissing) return false;
  const wanted = new Set(keys);
  return (budget.months || []).some((m, i) => wanted.has(m?.key)
    && (budget.rows || []).some(r => r?.kind === 'account' && toCents(r.monthly?.[i]?.budget) !== 0));
}

// ── The forecast ────────────────────────────────────────────────────────────

// Pure. The months shown, `past` before today's, today's, and `future` after.
function _monthsAround(today, past, future) {
  const out = [];
  for (let k = -past; k <= future; k++) {
    const m = _monthMeta(today.year, today.month + k);
    out.push({ ...m, kind: k < 0 ? 'actual' : k === 0 ? 'current' : 'forecast' });
  }
  return out;
}

// Pure. The span asked for, held to what is offered: a bad value is the
// default rather than a throw, since the route has refused it already and
// anything reaching here otherwise is a caller of this module.
function _monthlySpan({ past, future, fill } = {}) {
  const int = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
  };
  return {
    past:   int(past, 0, PAST_MAX, PAST_DEFAULT),
    future: int(future, 1, FUTURE_MAX, FUTURE_DEFAULT),
    fill:   FILLS.includes(fill) ? fill : 'budget',
  };
}

// Pure. Everything the Monthly tab shows, as of `todayISO`.
//
// `cm` is the Cash Flow Manager's payload (getCashManager), read with its
// horizon reaching the last month shown. `bankMonths` is the Bank Summary of
// each past month (bank.js#_buildBankSummary's shape), null where one could
// not be read; `currentBank` this month's to today, read only when no past
// month is shown to open it. `payments` and `bankTransactions` are the
// records from the first month shown to today, null when either could not be
// read; `accounts` the chart of accounts, null likewise; `bankAccounts` the
// bank account list, null when it could not be read. `budget` is
// getBudgetVariance's payload over the months ahead, null when not asked for
// or not read (`budgetFailure` says which: 'scope' or 'error').
function _buildCashMonthly({
  todayISO, past = PAST_DEFAULT, future = FUTURE_DEFAULT, fill = 'budget',
  cm = {}, bankAccounts = [], bankOptions = {},
  bankMonths = [], currentBank = null,
  payments = null, bankTransactions = null, recordsFailure = null,
  accounts = null,
  budget = null, budgetFailure = null,
}) {
  const span   = _monthlySpan({ past, future, fill });
  const today  = _parseISODate(todayISO);
  const base   = cm?.organisation?.currency || '';
  const months = _monthsAround(today, span.past, span.future);
  const n      = months.length;
  const cur    = span.past;
  const index  = new Map(months.map((m, i) => [m.key, i]));
  const notes  = [];

  const values  = Object.fromEntries(ROWS.map(r => [r.key, Array(n).fill(null)]));
  const sources = Object.fromEntries(ROWS.map(r => [r.key, months.map(() => new Set())]));
  const add = (row, i, cents, source) => {
    values[row][i] = (values[row][i] || 0) + cents;
    if (source) sources[row][i].add(source);
  };
  const addSources = (row, i, set) => { for (const s of set || []) sources[row][i].add(s); };
  const lineIn  = i => sum(LINES_IN.map(k => values[k][i]));
  const lineOut = i => sum(LINES_OUT.map(k => values[k][i]));
  const zeroLines = i => { for (const k of LINES) if (values[k][i] === null) values[k][i] = 0; };

  // ── What moved, from the first month shown to today.
  const recordsRead = payments !== null && bankTransactions !== null;
  // Without the bank account list (null) which Bank Summary line is which
  // account, and which are in another currency, is not known: the balances
  // read from it are left blank rather than guessed.
  const listRead = bankAccounts !== null;
  const countBank = raw => (listRead ? _countedBank(raw, bankAccounts, base, bankOptions) : null);
  const { accountsByCode } = _accountMaps(accounts);
  const leftOut = _leftOutIds(bankAccounts, base, bankOptions);
  const bankIds = new Set((bankAccounts || []).map(a => a?.accountId).filter(Boolean));
  // A record through an account the balance leaves out, or through an account
  // that is not a bank account at all (a payment posted to a clearing
  // account), moved no money the Bank Summary below counts.
  const keep = r => !r.accountId || (!leftOut.has(r.accountId) && (!bankIds.size || bankIds.has(r.accountId)));
  const moved = recordsRead
    ? _movementByMonth({ payments, bankTransactions, accounts: accounts || [], base, keep, fromISO: months[0].startISO, toISO: todayISO })
    : null;
  const empty = { rows: {}, sources: {}, transfersIn: 0, transfersOut: 0 };

  // Puts a month's records under its rows, and what moved to or from an
  // account left out of the balance under "other": that money did leave (or
  // join) the balance counted, whatever the account it went to.
  const takeRecords = (i, mv) => {
    zeroLines(i);
    for (const [row, cents] of Object.entries(mv.rows)) {
      add(row, i, cents, null);
      addSources(row, i, mv.sources[row]);
    }
    const oneSided = mv.transfersIn - mv.transfersOut;
    if (oneSided > 0) add('in_other', i, oneSided, SRC.transfers);
    if (oneSided < 0) add('out_other', i, -oneSided, SRC.transfers);
  };

  // ── The months before this one, as they happened.
  const ties = [];
  const unreadBank = [], emptyBank = [];
  const pastBank = [];
  let prevBankClosing = null;
  for (let i = 0; i < cur; i++) {
    const m = months[i];
    const b = pastBank[i] = countBank(bankMonths[i]);
    const mv = moved ? (moved.get(m.key) || empty) : null;
    if (listRead && !bankMonths[i]) unreadBank.push(m.label);
    else if (listRead && !b) emptyBank.push(m.label);
    if (mv) {
      const catIn = sum(Object.entries(mv.rows).filter(([k]) => LINES_IN.includes(k)).map(([, v]) => v));
      const catOut = sum(Object.entries(mv.rows).filter(([k]) => LINES_OUT.includes(k)).map(([, v]) => v));
      takeRecords(i, mv);
      if (b) {
        // The Bank Summary's cash received and spent, less the transfers
        // between the org's own accounts that it counts on both sides, set
        // against what the records explain. What is left on each side is
        // unexplained: money the bank shows that no record the app can read
        // accounts for.
        let uIn  = (b.received - mv.transfersIn) - catIn;
        let uOut = (b.spent - mv.transfersOut) - catOut;
        // Opening plus received less spent is the closing balance on every
        // Bank Summary line Xero gives. Should it ever not be, the closing
        // balance is the figure that is right, and the difference is said.
        const drift = (b.closing - b.opening) - (b.received - b.spent);
        if (drift > 0) uIn += drift;
        if (drift < 0) uOut -= drift;
        if (drift) {
          notes.push(`Xero's Bank Summary for ${m.label} does not add up: its opening balance plus cash received less cash spent `
            + `is ${money(drift)} ${drift > 0 ? 'less' : 'more'} than its closing balance. The difference is in Other / unexplained.`);
        }
        // Records showing more than the bank on one side are netted against
        // the other, so neither row is ever negative and the month still ties.
        if (uIn < 0)  { uOut -= uIn; uIn = 0; }
        if (uOut < 0) { uIn -= uOut; uOut = 0; }
        if (uIn)  add('in_other', i, uIn, SRC.unexplained);
        if (uOut) add('out_other', i, uOut, SRC.unexplained);
      }
    }
    // Each past month opens and closes on Xero's own balances. Without the
    // month's Bank Summary it opens where the month before closed, which the
    // totals below work out in order.
    if (b) {
      values.opening[i] = b.opening; sources.opening[i].add(SRC.bank);
      values.closing[i] = b.closing; sources.closing[i].add(SRC.bank);
      if (prevBankClosing !== null && b.opening !== prevBankClosing) {
        notes.push(`Xero's opening balance for ${m.label} is ${money(b.opening - prevBankClosing)} `
          + `${b.opening > prevBankClosing ? 'more' : 'less'} than ${months[i - 1].label}'s closing balance: usually a bank account `
          + 'added or switched in the bank options, or an entry dated back into the month before after it was read.');
      }
    }
    prevBankClosing = b ? b.closing : null;
  }

  // ── This month: what has moved to today, then what is expected after it.
  const bank = cm?.bank || {};
  const countedToday = (bank.accounts || []).filter(a => a && a.included && !a.foreign);
  const todayRaw = bank.available ? sum(countedToday.map(a => toCents(a.balance))) : null;
  // The bank options' opening adjustments, which the Cash Flow Manager starts
  // from, so this forecast starts from the same balance. They are not cash
  // in or out, so they are a line of their own; unknown without the bank.
  const adjustment = bank.available ? sum(countedToday.map(a => toCents(a.openingAdjustment))) : null;
  let currentOpeningGap = null;
  {
    const i = cur;
    if (i > 0 && values.closing[i - 1] !== null) {
      values.opening[i] = values.closing[i - 1];
      addSources('opening', i, sources.closing[i - 1]);
    } else if (i === 0) {
      const cb = countBank(currentBank);
      if (cb) { values.opening[i] = cb.opening; sources.opening[i].add(SRC.bank); }
      else if (listRead) currentOpeningGap = currentBank ? 'empty' : 'unread';
    }
    // Without the records this month's rows are blank, as an unread past
    // month's are: its movement is worked out from the balances below.
    if (moved) {
      takeRecords(i, moved.get(months[i].key) || empty);
      // Today's balance, less what the records explain since the month
      // opened, is the movement nothing the app reads accounts for.
      if (values.opening[i] !== null && todayRaw !== null) {
        const u = (todayRaw - values.opening[i]) - (lineIn(i) - lineOut(i));
        if (u > 0) add('in_other', i, u, SRC.unexplained);
        if (u < 0) add('out_other', i, -u, SRC.unexplained);
      }
    }
    values.adjustment[i] = adjustment;
    if (adjustment !== null) sources.adjustment[i].add(SRC.adjustment);
  }

  // ── What the Cash Flow Manager expects, month by month. Excluded items count
  // nowhere; overdue ones stand apart, as on that tab. What is expected in the
  // rest of this month is kept apart too, for its closing balance: today's
  // balance does not hold it yet.
  const lastEnd = months[n - 1].endISO;
  const overdue = { in: 0, out: 0, count: 0 };
  let restOfMonth = 0, restCount = 0;
  for (let i = cur + 1; i < n; i++) zeroLines(i);
  for (const it of cm?.items || []) {
    if (!it || it.excluded) continue;
    const cents = toCents(it.amount);
    if (it.overdue) {
      overdue[it.direction === 'in' ? 'in' : 'out'] += cents;
      overdue.count++;
      continue;
    }
    if (!it.date || it.date > lastEnd) continue;
    const i = index.get(String(it.date).slice(0, 7));
    if (i === undefined || i < cur || !cents) continue;
    if (i === cur) { restOfMonth += it.direction === 'in' ? cents : -cents; restCount++; }
    // This month's rows are blank without its records: what is expected in
    // it then shows in its net movement and closing balance only.
    if (i === cur && !moved) continue;
    for (const part of _itemParts(it, accountsByCode)) {
      if (part.cents) add(part.row, i, part.cents, ITEM_SOURCE[it.source] || SRC.forecast);
    }
  }

  // ── The budget, for what the months ahead are expected to bring beyond what
  // is already scheduled. Never below nothing: a month already scheduled past
  // its budget is not taken down to it. Revenue is set against what is
  // scheduled from customers. Going out, the budget's cost of sales, wages and
  // overheads together are set against everything scheduled under those three
  // rows: a rent bill already scheduled is a supplier payment here and Rent in
  // the budget, and must not be counted twice. What the budget expects beyond
  // it is shared across the rows as the budget shares it.
  const { byMonth: budgetRows, left } = span.fill === 'budget' ? _budgetByMonth(budget, accounts) : { byMonth: new Map(), left: null };
  let filled = 0;
  for (let i = cur + 1; i < n; i++) {
    const rows = budgetRows.get(months[i].key) || {};
    const inGap = Math.max(0, (rows.in_customer || 0) - (values.in_customer[i] || 0));
    if (inGap) { add('in_customer', i, inGap, SRC.budget); filled++; }
    const budgeted = BUDGET_OUT.map(k => Math.max(0, rows[k] || 0));
    const outGap = Math.max(0, sum(budgeted) - sum(BUDGET_OUT.map(k => values[k][i] || 0)));
    const shares = outGap ? _splitToLargest(outGap, budgeted) : null;
    (shares || []).forEach((c, k) => { if (c) { add(BUDGET_OUT[k], i, c, SRC.budget); filled++; } });
  }

  // ── Totals, and each month's balance carried into the next.
  for (let i = 0; i < n; i++) {
    const kind = months[i].kind;
    const known = values.in_customer[i] !== null;
    if (known) {
      values.in_total[i]  = lineIn(i);
      values.out_total[i] = lineOut(i);
      values.net[i]       = values.in_total[i] - values.out_total[i];
      for (const k of LINES_IN) { addSources('in_total', i, sources[k][i]); addSources('net', i, sources[k][i]); }
      for (const k of LINES_OUT) { addSources('out_total', i, sources[k][i]); addSources('net', i, sources[k][i]); }
    }
    if (kind === 'actual') {
      if (!known && values.opening[i] !== null && values.closing[i] !== null) {
        values.net[i] = values.closing[i] - values.opening[i];
        sources.net[i].add(SRC.bank);
      }
      if (values.opening[i] === null && i > 0 && values.closing[i - 1] !== null) {
        values.opening[i] = values.closing[i - 1]; sources.opening[i].add(SRC.previous);
      }
      if (values.closing[i] === null && values.opening[i] !== null && values.net[i] !== null) {
        values.closing[i] = values.opening[i] + values.net[i]; sources.closing[i].add(SRC.previous);
      }
    } else if (kind === 'current') {
      // Today's balance, the adjustments and what is expected after today.
      // With the records and the opening known this is also the opening plus
      // the month's net movement plus the adjustments, by construction.
      if (todayRaw !== null) {
        values.closing[i] = todayRaw + adjustment + restOfMonth;
        sources.closing[i].add(SRC.bank); sources.closing[i].add(SRC.forecast);
      }
      // Without the records, the net movement is what the balances say.
      if (!known && values.opening[i] !== null && values.closing[i] !== null) {
        values.net[i] = values.closing[i] - adjustment - values.opening[i];
        sources.net[i].add(SRC.bank);
        if (restCount) sources.net[i].add(SRC.forecast);
      }
    } else {
      if (values.closing[i - 1] !== null) {
        values.opening[i] = values.closing[i - 1]; sources.opening[i].add(SRC.previous);
        values.closing[i] = values.opening[i] + values.net[i]; sources.closing[i].add(SRC.forecast);
      }
    }
  }

  // Every past month must close on Xero's closing balance to the cent; the
  // unexplained rows exist so that it does. Checked rather than assumed, and
  // said if it does not.
  for (let i = 0; i < cur; i++) {
    const b = pastBank[i];
    if (!b || values.in_total[i] === null) continue;
    const difference = b.closing - (b.opening + values.net[i]);
    ties.push({ key: months[i].key, agrees: difference === 0, difference: fromCents(difference) });
    if (difference) {
      notes.push(`${months[i].label} does not tie to Xero's Bank Summary: its rows come to ${money(difference)} `
        + `${difference > 0 ? 'less' : 'more'} than the closing balance Xero gives.`);
    }
  }

  // The overdue items, in this month's column and in no total.
  values.overdue[cur] = overdue.in - overdue.out;
  if (overdue.count) {
    sources.overdue[cur].add(`${plural(overdue.count, 'overdue item', 'overdue items')}: ${money(overdue.in)} to come in, ${money(overdue.out)} to go out`);
  }

  // ── What the figures are, and what they leave out, plainly.
  const curLabel = months[cur].label;
  if (cur > 0) {
    notes.push(`${months[0].label} to ${months[cur - 1].label} are what happened: each month opens and closes on Xero's Bank `
      + 'Summary for the bank accounts the Cash Flow Manager counts, and its cash in and out are the payments and bank '
      + 'transactions recorded in Xero that month, each bank transaction line under the row of the account it is coded to: '
      + 'cash sales under Customer receipts and direct costs under Supplier payments, as the budget fills the months ahead. '
      + 'Transfers between your own counted accounts are left out.');
  }
  notes.push('"Other / unexplained" holds refunds, spending coded to no row above, and whatever the Bank Summary shows moving '
    + 'that no payment or bank transaction the app can read accounts for: pay runs, manual journals and other entries posted '
    + 'straight to a bank account, which this app cannot read. Money that arrived that way is under "Other income & refunds". '
    + 'With them, every past month adds up to Xero\'s closing balance to the cent.');
  notes.push(`${curLabel} is actual to today, ${todayISO}, and forecast for the rest of the month.`);
  notes.push('The months ahead each open on the month before\'s closing balance and hold the Cash Flow Manager\'s forecast: '
    + 'open invoices and bills on their expected, planned, predicted or due dates, repeating invoices, payments dated ahead, '
    + 'bank transactions dated ahead (each line under the row of the account it is coded to) and your entries, with your '
    + 'changes and exclusions and unallocated credit notes netted off.');
  const aheadKeys = months.slice(cur + 1).map(m => m.key);
  if (span.fill === 'none') {
    notes.push('Nothing is filled in from the budget: the months ahead hold only what is scheduled.');
  } else if (budget && !budget.budgetMissing && !_budgetHasFigures(budget, aheadKeys)) {
    notes.push('The Overall Budget in Xero has no figures for the months ahead, so nothing is filled in from it.');
  } else if (budget && !budget.budgetMissing) {
    notes.push('Where the Overall Budget in Xero expects more than is scheduled, the difference is added as "budget", never '
      + 'below nothing. Coming in, budgeted revenue is set against Customer receipts. Going out, budgeted cost of sales and '
      + 'expenses are set against everything scheduled under Supplier payments, Wages & salaries and Overheads together, so '
      + 'a bill already scheduled is not counted again under another row; what the budget expects beyond that is shared '
      + 'across those rows as the budget shares it, cost of sales to Supplier payments and other expenses to Wages & '
      + 'salaries or Overheads by name. Budgets are entered in Xero before GST, while invoices and bills include it.');
    if (left.nonCash) notes.push('Depreciation and amortisation in the budget are left out: they move no cash.');
    if (left.incomeTax) notes.push('Income tax in the budget is left out: it is paid on the tax office\'s dates, not month by month. Add it as an entry.');
    if (left.otherIncome) notes.push('Other income in the budget is not added.');
    notes.push('GST is not in a budget, so GST & tax holds only what is scheduled. Add GST or BAS payments as quarterly entries.');
    if (!filled) {
      const anyCash = aheadKeys.some(k => Object.values(budgetRows.get(k) || {}).some(Boolean));
      notes.push(anyCash
        ? 'Everything the budget expects is already scheduled, so nothing is added from it.'
        : 'Nothing the budget holds for the months ahead is cash this fills in, so nothing is added from it.');
    }
  } else if (budget && budget.budgetMissing) {
    notes.push('Xero has no Overall Budget for the months ahead, so nothing is filled in from one.');
  } else if (budgetFailure) {
    notes.push(budgetFailure === 'scope'
      ? 'The budget could not be read: the Xero connection does not allow it. Reconnect in Setup to fill the months ahead from it.'
      : 'The budget could not be read from Xero just now, so nothing is filled in from it.');
  }
  notes.push(`Overdue items, dated before today and not yet paid, are in the last row under ${curLabel} and in no total, `
    + 'as the Cash Flow Manager keeps them apart. Set a date on one there to place it in a month.');
  if (adjustment) {
    notes.push(`The opening adjustments set in the bank options (${adjustment < 0 ? '-' : ''}${money(adjustment)}) are on their `
      + `own line, Your bank adjustments, under ${curLabel}: they are not cash in or out, but ${curLabel} closes on them, so `
      + 'the forecast starts from the same balance as the Cash Flow Manager.');
  }
  if (!recordsRead) {
    const blank = cur > 0 ? `${months[0].label} to ${curLabel}` : curLabel;
    notes.push((recordsFailure === 'scope'
      ? 'Payments and bank transactions could not be read: the Xero connection does not allow it. Reconnect in Setup to split cash by what it was. '
      : 'Payments or bank transactions could not be read from Xero just now. ')
      + `Without them cash in and out are blank for ${blank}, and each month's net movement is the change in its bank `
      + `balance; ${curLabel}'s includes what is expected for the rest of the month, which shows only in its net movement `
      + 'and closing balance.');
  } else if (accounts === null) {
    notes.push('The chart of accounts could not be read from Xero just now, so bank transactions are under Other rather than split by account.');
  }
  if (!listRead) {
    notes.push('Xero\'s list of bank accounts could not be read just now, so which accounts are in another currency or '
      + 'switched off is not known: the balances from Xero\'s Bank Summary are left blank rather than guessed, and nothing '
      + 'is shown as unexplained. Cash in and out count the payments and bank transactions, past and dated ahead, of every '
      + 'bank account not switched off here, any in another currency included.');
  }
  if (unreadBank.length) {
    notes.push(`Xero's Bank Summary for ${unreadBank.join(', ')} could not be read just now, so ${unreadBank.length === 1 ? 'that month opens' : 'those months open'} `
      + 'where the month before closed and nothing in them is unexplained.');
  }
  if (emptyBank.length) {
    const one = emptyBank.length === 1;
    notes.push(`Xero's Bank Summary for ${emptyBank.join(', ')} lists no bank accounts, so ${one ? 'that month has' : 'those months have'} `
      + `no balance from it: ${one ? 'it opens' : 'each opens'} where the month before closed, where that is known, and nothing `
      + `in ${one ? 'it' : 'them'} is unexplained.`);
  }
  if (currentOpeningGap) {
    notes.push(currentOpeningGap === 'empty'
      ? `Xero's Bank Summary for ${curLabel} lists no bank accounts, so its opening balance is blank.`
      : `Xero's Bank Summary for ${curLabel} could not be read just now, so its opening balance is blank.`);
  }
  if (!bank.available) {
    if (bank.unavailableReason === 'accounts' && !listRead) {
      notes.push('For the same reason today\'s bank balance is not known, so no balance is carried into the months ahead.');
    } else if (bank.unavailableReason === 'accounts') {
      notes.push('Today\'s bank balance is not known: Xero\'s list of bank accounts could not be read just now, so which '
        + 'accounts to count is not known either. No balance is carried into the months ahead.');
    } else {
      notes.push('Today\'s bank balances could not be read from Xero just now, so no balance is carried into the months ahead.');
    }
  } else {
    const foreign = (bank.accounts || []).filter(a => a?.foreign);
    if (foreign.length) {
      notes.push(`${foreign.map(a => `${a.name} (${a.currency})`).join(', ')} ${foreign.length === 1 ? 'is' : 'are'} in another currency `
        + 'and left out, as in the Cash Flow Manager.');
    }
  }
  // The Cash Flow Manager's own gaps (a read that failed) are this forecast's too.
  // Its past cash, today's balance and its bank account list are said above in
  // this view's words.
  for (const note of cm?.notes || []) {
    if (/could not be read/i.test(note) && !/^(Past cash|Bank balances|Xero's list of bank accounts)/i.test(note)) notes.push(note);
  }

  return {
    organisation: { name: cm?.organisation?.name || 'Organisation', currency: base },
    today: todayISO,
    currentMonth: months[cur].key,
    past: span.past,
    future: span.future,
    fill: span.fill,
    months: months.map(m => ({ key: m.key, label: m.label, kind: m.kind })),
    rows: ROWS.map(r => ({
      key: r.key, label: r.label, group: r.group,
      values: values[r.key].map(fromCents),
      sources: sources[r.key].map(s => [...s].join(' + ')),
    })),
    overdue: { in: fromCents(overdue.in), out: fromCents(overdue.out), count: overdue.count },
    // The bank options' overdraft limits, which the closing balance is
    // coloured against.
    overdraft: Number(bank.overdraft || 0),
    ties,
    notes,
  };
}

// ── Fetching ────────────────────────────────────────────────────────────────

// One month's Bank Summary (or this month's to today). A month that closed a
// while ago is settled and kept for hours; the last one, still being
// reconciled, for minutes (report-cache.js#_periodCacheTtl). Keyed so a
// change seen in Xero (report-cache.js#clearTenant) drops it.
async function _getMonthBankSummaryRaw(userId, tenantId, { from, to, todayISO, force = false } = {}) {
  const key    = `cmbanksum:${userId}:${tenantId}:${from}:${to}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;
  const tokenCache = require('../utils/token-cache').forUser(userId);
  const api  = _apiFor(await tokenCache.getValidToken(tenantId));
  const res  = await withRetry(() => api.getReportBankSummary(tenantId, from, to));
  const bank = _buildBankSummary(res?.body?.reports?.[0]?.rows || []);
  return _cacheSet(key, { bank, calls: 1 }, _periodCacheTtl([{ endISO: to }], _parseISODate(todayISO)));
}
const _getMonthBankSummary = _dedupe('_getMonthBankSummary', _getMonthBankSummaryRaw, { force: false });

const _span = (fromISO, toISO) =>
  `Date >= ${_fmtXeroDate(_parseISODate(fromISO))} && Date < ${_fmtXeroDate(_addDays(_parseISODate(toISO), 1))} && Status=="AUTHORISED"`;

// Approved payments from the first month shown to today, paged. `calls` is
// how many pages it took, for the payload's count.
async function _getMonthlyPaymentsRaw(userId, tenantId, { fromISO, toISO, force = false } = {}) {
  const key    = `cmmpayments:${userId}:${tenantId}:${fromISO}:${toISO}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;
  const tokenCache = require('../utils/token-cache').forUser(userId);
  const api = _apiFor(await tokenCache.getValidToken(tenantId));
  let calls = 0;
  const list = await _allPages(page => { calls++; return api.getPayments(tenantId, undefined, _span(fromISO, toISO), 'Date ASC', page); },
    'payments', { what: 'Payment', tenantId });
  return _cacheSet(key, { payments: _monthlyPaymentsOf(list), calls }, RECORDS_TTL_MS);
}
const _getMonthlyPayments = _dedupe('_getMonthlyPayments', _getMonthlyPaymentsRaw, { force: false });

// Approved bank transactions over the same span, reconciled or not (the Bank
// Summary counts both), paged; a paged read carries each one's lines.
async function _getMonthlyBankTransactionsRaw(userId, tenantId, { fromISO, toISO, force = false } = {}) {
  const key    = `cmmbanktx:${userId}:${tenantId}:${fromISO}:${toISO}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;
  const tokenCache = require('../utils/token-cache').forUser(userId);
  const api = _apiFor(await tokenCache.getValidToken(tenantId));
  let calls = 0;
  const list = await _allPages(page => { calls++; return api.getBankTransactions(tenantId, undefined, _span(fromISO, toISO), 'Date ASC', page); },
    'bankTransactions', { what: 'Bank transaction', tenantId });
  return _cacheSet(key, { bankTransactions: _monthlyBankTransactionsOf(list), calls }, RECORDS_TTL_MS);
}
const _getMonthlyBankTransactions = _dedupe('_getMonthlyBankTransactions', _getMonthlyBankTransactionsRaw, { force: false });

// A part that could not be read costs what it adds, not the forecast: the
// notes say what is missing. The Cash Flow Manager itself is the forecast, so
// a failure there is this one's failure.
function _soft(what, promise, ctx) {
  return Promise.resolve(promise).then(value => ({ value }), error => {
    logger.warn(`Monthly cash: ${what} unavailable`, { ...ctx, error: xeroErrMsg(error) });
    return { error, failure: isScopeError(error) ? 'scope' : 'error' };
  });
}

// What a budget read cost when it went to Xero: the budget list, then for each
// twelve months one BudgetSummary and one or two ProfitAndLoss calls
// (budget-variance.js#_pnlCallPlan).
function _budgetCalls(months) {
  return 1 + _chunkMonths(months, 12).reduce((s, chunk) => s + 1 + _pnlCallPlan(chunk).length, 0);
}

// The entries, changes and bank options kept here, as a short fingerprint for
// the payload's cache key: an edit made on the Cash Flow Manager is on the
// very next load of this view, as it is on that one.
function _storeStamp(store) {
  return crypto.createHash('sha1')
    .update(JSON.stringify([store.listEntries(), store.overrides(), store.bankOptions()]))
    .digest('hex').slice(0, 16);
}

// Pure. What this view takes from the Cash Flow Manager's payload, as a short
// fingerprint for the same key: today, the bank (its balances, which accounts
// count and their adjustments) and every item as placed. Any change the
// Cash Flow Manager shows, whichever of its reads it came from, builds this
// again; the age of its oldest read, which barely moves, would not.
function _cmStamp(cm) {
  const bank = cm?.bank || {};
  return crypto.createHash('sha1').update(JSON.stringify([
    cm?.today || null,
    cm?.organisation?.name || '', cm?.organisation?.currency || '',
    !!bank.available, bank.unavailableReason || null, bank.overdraft ?? null,
    (bank.accounts || []).map(a => [a?.accountId || null, a?.name || '', a?.currency || '', a?.balance ?? null,
      !!a?.included, a?.openingAdjustment ?? null, !!a?.foreign]),
    (cm?.items || []).map(it => [it?.key, it?.date ?? null, it?.amount ?? null, !!it?.excluded, !!it?.overdue,
      it?.direction || null, it?.source || null, it?.description ?? null, it?.accounts ?? null]),
    cm?.notes || [],
  ])).digest('hex').slice(0, 16);
}

async function _getCashMonthlyRaw(userId, tenantId, { timezone = 'UTC', past = PAST_DEFAULT, future = FUTURE_DEFAULT, fill = 'budget', force = false } = {}) {
  const span = _monthlySpan({ past, future, fill });
  const todayParts = _todayPartsInTz(timezone);
  const last = _monthMeta(todayParts.year, todayParts.month + span.future);
  // To the last day of the last month shown, and a day over for a request
  // that crosses midnight between here and the Cash Flow Manager's own
  // reading of today. Never shorter than that tab's own horizon, so a short
  // span asks for exactly what the tab asks for.
  const toLast = Math.round((_dateFromParts(_parseISODate(last.endISO)) - _dateFromParts(todayParts)) / 86400000) + 2;
  const horizonDays = Math.min(MAX_HORIZON_DAYS, Math.max(HORIZON_DAYS, toLast));
  const cm = await getCashManager(userId, tenantId, { timezone, force, horizonDays });
  const todayISO = cm.today;

  // Required here: the store opens the database, which no other report needs.
  const store = require('../utils/cash-manager-store').forTenant(userId, tenantId);
  const bankOptions = store.bankOptions();
  // What the Cash Flow Manager shows is in the key by its content, so a
  // payload never shows other figures than the tab it sits on: anything that
  // changes there, from a Refresh or a change seen in Xero, builds this again.
  const key = `cashmonthly:${userId}:${tenantId}:${todayISO}:${span.past}:${span.future}:${span.fill}:${_cmStamp(cm)}:${_storeStamp(store)}`;
  const hit = _cacheGet(key, force);
  if (hit) {
    const { readAt, ...rest } = hit;
    return { ...rest, calls: 0, cached: true, fetchedAt: readAt };
  }

  const months = _monthsAround(_parseISODate(todayISO), span.past, span.future);
  const pastMonths = months.slice(0, span.past);
  const ahead = months.slice(span.past + 1);
  const ctx = { userId, tenantId };
  const records = { fromISO: months[0].startISO, toISO: todayISO, force };
  // The account lists and the records first, then the months' balances and
  // the budget: at most four calls in flight, inside Xero's five per
  // organisation.
  const [bankAccounts, accountsRead, paymentsRead, bankTxRead] = await Promise.all([
    // Null when it could not be read: the balances are then left blank
    // rather than a foreign account added in as base currency.
    _bankAccountsOrNull(userId, tenantId, force),
    _soft('chart of accounts', getAccounts(userId, tenantId, { force }), ctx),
    _soft('payments', _getMonthlyPayments(userId, tenantId, records), ctx),
    _soft('bank transactions', _getMonthlyBankTransactions(userId, tenantId, records), ctx),
  ]);
  const [bankReads, currentRead, budgetRead] = await Promise.all([
    _mapWithConcurrency(pastMonths, BANK_CONCURRENCY, m =>
      _soft(`bank summary ${m.key}`, _getMonthBankSummary(userId, tenantId, { from: m.startISO, to: m.endISO, todayISO, force }), ctx)),
    // This month's opening, read only when there is no past month to close on
    // it.
    span.past === 0
      ? _soft('bank summary this month', _getMonthBankSummary(userId, tenantId, { from: months[0].startISO, to: todayISO, todayISO, force }), ctx)
      : null,
    span.fill === 'budget' && ahead.length
      ? _soft('budget', getBudgetVariance(userId, tenantId, { timezone, force, period: { from: ahead[0].key, to: ahead[ahead.length - 1].key } }), ctx)
      : null,
  ]);

  const data = _buildCashMonthly({
    todayISO, ...span, cm, bankAccounts, bankOptions,
    bankMonths: bankReads.map(r => (r.value ? r.value.bank : null)),
    currentBank: currentRead?.value ? currentRead.value.bank : null,
    payments: paymentsRead.value ? paymentsRead.value.payments : null,
    bankTransactions: bankTxRead.value ? bankTxRead.value.bankTransactions : null,
    recordsFailure: paymentsRead.failure || bankTxRead.failure || null,
    accounts: accountsRead.value ? accountsRead.value.accounts : null,
    budget: budgetRead?.value || null, budgetFailure: budgetRead?.failure || null,
  });

  // The Xero calls this view made itself; the Cash Flow Manager's reads are
  // that tab's, which the page has normally just made or found cached.
  const fresh = r => !!r?.value && r.value.cached === false;
  let calls = 0;
  for (const r of [...bankReads, currentRead, paymentsRead, bankTxRead]) if (fresh(r)) calls += r.value.calls || 0;
  if (fresh(accountsRead)) calls += 1;
  if (fresh(budgetRead)) calls += _budgetCalls(ahead);

  const reads = [...bankReads, currentRead, accountsRead, paymentsRead, bankTxRead, budgetRead].filter(Boolean);
  const stamps = [cm.fetchedAt, ...reads.map(r => r.value?.fetchedAt)].filter(Number.isFinite);
  const fetchedAt = stamps.length ? Math.min(...stamps) : Date.now();
  logger.info('Monthly cash forecast built', {
    userId, tenantId, past: span.past, future: span.future, fill: span.fill, calls,
    ties: data.ties.filter(t => !t.agrees).length ? 'no' : 'yes',
  });
  // Kept only when every read landed: one that failed is asked for again on
  // the next load rather than its gap served for ten minutes.
  if (bankAccounts !== null && reads.every(r => r.value)) _cacheSet(key, { ...data, readAt: fetchedAt }, PAYLOAD_TTL_MS);
  return {
    ...data,
    calls,
    // True when nothing in this request went to Xero.
    cached: cm.cached !== false && reads.every(r => !r.value || r.value.cached !== false),
    fetchedAt,
  };
}
const getCashMonthly = _dedupe('getCashMonthly', _getCashMonthlyRaw,
  { timezone: 'UTC', past: PAST_DEFAULT, future: FUTURE_DEFAULT, fill: 'budget', force: false });

module.exports = {
  getCashMonthly, _buildCashMonthly,
  _accountCategory, _paymentCategory, _entryCategory, _itemCategory, _itemParts,
  _monthlyPaymentsOf, _monthlyBankTransactionsOf, _bankTransactionParts, _allocate, _splitToLargest, _movementByMonth,
  _countedBank, _leftOutIds, _budgetByMonth, _budgetHasFigures, _monthsAround, _monthlySpan, _budgetCalls, _cmStamp,
  ROWS, PAST_MAX, FUTURE_MAX, PAST_DEFAULT, FUTURE_DEFAULT, FILLS, PAYLOAD_TTL_MS,
};
