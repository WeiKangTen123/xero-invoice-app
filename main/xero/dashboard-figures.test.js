// The Dashboard's calculated figures, pinned after a review found each of them
// wrong in a way no existing test looked at:
//
//   * "Overdue" added bills you owe to invoices customers owe you;
//   * debtor and creditor days divided by months not yet begun, set receivables
//     that include tax against revenue that does not, measured creditor days
//     against every overhead, and the Overview worked out a second figure of
//     its own;
//   * the "does not tie to the bank" alert fired on transfers between the org's
//     own accounts, and described the gap backwards;
//   * deleted payments and bank transactions counted as cash, customer refunds
//     counted as money in, and the bank statement printed transfers in and
//     prepayments received as money out;
//   * P&L totals were found by exact label, so "Trading Income" and "Less
//     Overheads" headings left revenue and overheads at zero.
//
// Pure functions are tested directly. The end-to-end cases below mock Xero the
// way reports-contract.test.js does; nothing here ever reaches Xero.

jest.mock('xero-node', () => {
  const api = {
    getOrganisations:       jest.fn(),
    getReportProfitAndLoss: jest.fn(),
    getReportBudgetSummary: jest.fn(),
    getReportBankSummary:   jest.fn(),
    getBudgets:             jest.fn(),
    getInvoices:            jest.fn(),
    getPayments:            jest.fn(),
    getBankTransactions:    jest.fn(),
  };
  return { AccountingApi: jest.fn(() => api), __api: api };
});
jest.mock('../utils/token-cache', () => ({
  forUser: () => ({ getValidToken: jest.fn().mockResolvedValue('fake-token') }),
  getPersistedTenants: () => [],
}));
jest.mock('../utils/gemini-client', () => ({ callGemini: jest.fn().mockRejectedValue(new Error('no model in tests')), GEMINI_MODELS: [] }));

const { __api: api } = require('xero-node');
const reports = require('./reports');
const {
  _buildSummary, _buildBankTransactions, _buildPayments, _buildCashMovement, _isReceiptPayment,
  _buildAlerts, _buildBudgetVariance, _buildPerformance, _buildWatchList, _sectionKind, _monthsBetween,
  _fiscalYearMonths, _actualThroughIndex,
} = reports;
const { _raisedByMonth, _buildPaymentDays, _buildUnreconciled, _isLive, _monthOfDoc } = require('./cash-flow');

const cell = value => ({ value });
const row = (label, values, rowType = 'Row') => ({ rowType, cells: [label, ...values].map(cell) });
const section = (title, rows) => ({ rowType: 'Section', title, rows });
const days = n => new Date(Date.now() + n * 86400000).toISOString();

// ── 1. Overdue, per direction ───────────────────────────────────────────────
describe('summary — overdue is reported per direction, never summed', () => {
  const ORG = { name: 'Org', baseCurrency: 'SGD' };

  test('an overdue invoice is overdue receivables and an overdue bill overdue payables', () => {
    const { kpis } = _buildSummary(ORG, [
      { type: 'ACCREC', status: 'AUTHORISED', amountDue: 300, total: 300, dueDate: days(-10) },
      { type: 'ACCREC', status: 'AUTHORISED', amountDue: 200, total: 250, dueDate: days(-40) },
      { type: 'ACCREC', status: 'AUTHORISED', amountDue: 999, total: 999, dueDate: days(10) },   // not yet due
      { type: 'ACCPAY', status: 'AUTHORISED', amountDue: 50,  total: 50,  dueDate: days(-3) },
      { type: 'ACCPAY', status: 'PAID',       amountDue: 0,   total: 70,  dueDate: days(-30) },  // paid
    ]);
    expect(kpis.overdueReceivables).toBe(500);
    expect(kpis.overdueReceivablesCount).toBe(2);
    expect(kpis.overduePayables).toBe(50);
    expect(kpis.overduePayablesCount).toBe(1);
    // The old single figure, 550, described neither position. Nothing reads it now.
    expect(kpis).not.toHaveProperty('overdueAmount');
  });

  test('each direction is converted to base currency on its own', () => {
    const { kpis } = _buildSummary(ORG, [
      { type: 'ACCREC', status: 'AUTHORISED', amountDue: 74, total: 74, currencyCode: 'USD', currencyRate: 0.74, dueDate: days(-5) },
      { type: 'ACCPAY', status: 'AUTHORISED', amountDue: 37, total: 37, currencyCode: 'USD', currencyRate: 0.74, dueDate: days(-5) },
    ]);
    expect(kpis.overdueReceivables).toBeCloseTo(100, 2);
    expect(kpis.overduePayables).toBeCloseTo(50, 2);
  });

  test('the summary carries what was invoiced and billed each month, from every invoice not just the fifty listed', () => {
    const many = Array.from({ length: 60 }, () => ({ type: 'ACCREC', status: 'PAID', amountDue: 0, total: 10, date: '2025-02-10T00:00:00' }));
    const s = _buildSummary(ORG, [...many, { type: 'ACCPAY', status: 'AUTHORISED', amountDue: 5, total: 5, date: '2025-02-11T00:00:00' }]);
    expect(s.invoices).toHaveLength(50);
    expect(s.raisedByMonth['2025-02']).toEqual({ sales: 600, bills: 5 });
  });
});

// ── 2. Debtor and creditor days ─────────────────────────────────────────────
describe('_raisedByMonth', () => {
  test('sums invoice and bill totals INCLUDING tax per month, in base currency', () => {
    const r = _raisedByMonth([
      { type: 'ACCREC', status: 'PAID',       total: 1100, date: '2025-01-15T00:00:00' },
      { type: 'ACCREC', status: 'AUTHORISED', total: 74,   date: '2025-01-20', currencyCode: 'USD', currencyRate: 0.74 },
      { type: 'ACCPAY', status: 'AUTHORISED', total: 330,  date: '2025-02-01T00:00:00' },
    ], 'SGD');
    expect(r['2025-01'].sales).toBeCloseTo(1200, 2);
    expect(r['2025-01'].bills).toBe(0);
    expect(r['2025-02']).toEqual({ sales: 0, bills: 330 });
  });

  test('a draft was never sent, and a voided or deleted document was never owed', () => {
    const r = _raisedByMonth(['DRAFT', 'SUBMITTED', 'VOIDED', 'DELETED'].map(status =>
      ({ type: 'ACCREC', status, total: 100, date: '2025-01-15' })));
    expect(r).toEqual({});
  });

  test('an ISO date is placed in its own month whatever the server time zone', () => {
    // "2025-04-01T00:00:00" has no offset; parsed, it is local time, which east
    // of UTC is still March.
    expect(_monthOfDoc('2025-04-01T00:00:00')).toBe('2025-04');
    expect(_monthOfDoc(new Date('2025-04-01T00:00:00Z'))).toBe('2025-04');
    expect(_monthOfDoc(null)).toBeNull();
  });
});

describe('_buildPaymentDays — closed months only, tax alike on both sides', () => {
  // A financial year Jan–Dec 2025 seen on 15 May: Jan–Apr are closed (120 days),
  // May is in progress and Jun–Dec have not begun.
  const months = _monthsBetween('2025-01', '2025-12');
  const today = { year: 2025, month: 5, day: 15 };
  // 1,100 invoiced each month (1,000 + 10% tax), and 330 billed.
  const raised = Object.fromEntries(months.map(m => [m.key, { sales: 1100, bills: 330 }]));

  test('divides by the days of the closed months, not the whole year', () => {
    const pd = _buildPaymentDays({ receivable: 1100, payable: 330, raisedByMonth: raised, months, today });
    expect(pd.closedMonths).toBe(4);
    expect(pd.days).toBe(31 + 28 + 31 + 30);
    expect(pd.invoiced).toBe(4400);
    // One month's invoicing outstanding reads as about a month — 30 days.
    expect(pd.dso).toBeCloseTo(1100 / 4400 * 120, 6);
    expect(pd.dso).toBeCloseTo(30, 6);
    expect(pd.fromLabel).toBe('Jan 2025');
    expect(pd.toLabel).toBe('Apr 2025');
    // The old figure — receivables with tax over ex-tax P&L revenue (4,000 to
    // date) across all 365 days of the year — read more than three times that.
    const old = 1100 / 4000 * 365;
    expect(old).toBeGreaterThan(100);
  });

  test('the current month and future months contribute nothing, whatever was raised in them', () => {
    const loaded = { ...raised, '2025-05': { sales: 999999, bills: 999999 }, '2025-09': { sales: 5e6, bills: 5e6 } };
    const pd = _buildPaymentDays({ receivable: 1100, payable: 330, raisedByMonth: loaded, months, today });
    expect(pd.invoiced).toBe(4400);
    expect(pd.billed).toBe(1320);
  });

  test('creditor days are measured against bills, the documents that create a payable', () => {
    const pd = _buildPaymentDays({ receivable: 0, payable: 330, raisedByMonth: raised, months, today });
    expect(pd.dpo).toBeCloseTo(330 / 1320 * 120, 6);
  });

  test('no closed month: no figure, and the reason says so', () => {
    const pd = _buildPaymentDays({ receivable: 1100, payable: 330, raisedByMonth: raised, months, today: { year: 2025, month: 1, day: 20 } });
    expect(pd.available).toBe(false);
    expect(pd.reason).toBe('no-closed-month');
    expect(pd.dso).toBeNull();
    expect(pd.dpo).toBeNull();
  });

  test('nothing invoiced or billed in the closed months is null, not zero or Infinity', () => {
    const pd = _buildPaymentDays({ receivable: 500, payable: 500, raisedByMonth: {}, months, today });
    expect(pd.available).toBe(true);
    expect(pd.dso).toBeNull();
    expect(pd.dpo).toBeNull();
  });

  test('a period wholly in the past counts every month', () => {
    const pd = _buildPaymentDays({ receivable: 1100, payable: 0, raisedByMonth: raised, months, today: { year: 2026, month: 3, day: 1 } });
    expect(pd.closedMonths).toBe(12);
    expect(pd.days).toBe(365);
  });
});

// ── 3 & 4. Cash movement: transfers, deleted records, refunds ───────────────
describe('cash movement — what counts as cash', () => {
  const MONTHS = [{ key: '2025-03' }];

  test('deleted payments and deleted or voided bank transactions moved no money', () => {
    const m = _buildCashMovement({
      months: MONTHS,
      payments: [
        { paymentType: 'ACCRECPAYMENT', status: 'AUTHORISED', date: '2025-03-01', amount: 100 },
        { paymentType: 'ACCRECPAYMENT', status: 'DELETED',    date: '2025-03-02', amount: 5000 },
        { paymentType: 'ACCPAYPAYMENT', status: 'DELETED',    date: '2025-03-02', amount: 4000 },
      ],
      bankTransactions: [
        { type: 'RECEIVE', status: 'AUTHORISED', date: '2025-03-03', total: 10 },
        { type: 'RECEIVE', status: 'DELETED',    date: '2025-03-03', total: 3000 },
        { type: 'SPEND',   status: 'VOIDED',     date: '2025-03-03', total: 2000 },
      ],
    });
    expect(m.customerReceipts).toBe(100);
    expect(m.supplierPayments).toBe(0);
    expect(m.otherReceipts).toBe(10);
    expect(m.otherPayments).toBe(0);
    expect(_isLive({ status: 'AUTHORISED' })).toBe(true);
    expect(_isLive({})).toBe(true);
  });

  test('a refund to a customer is money OUT, and a refund from a supplier money IN', () => {
    const m = _buildCashMovement({
      months: MONTHS,
      payments: [
        { paymentType: 'ARCREDITPAYMENT',      status: 'AUTHORISED', date: '2025-03-05', amount: 100 },
        { paymentType: 'AROVERPAYMENTPAYMENT', status: 'AUTHORISED', date: '2025-03-05', amount: 20 },
        { paymentType: 'APCREDITPAYMENT',      status: 'AUTHORISED', date: '2025-03-06', amount: 40 },
      ],
    });
    // Neither is trade with a customer or supplier, so neither is filed as one.
    expect(m.customerReceipts).toBe(0);
    expect(m.supplierPayments).toBe(0);
    expect(m.otherPayments).toBe(120);
    expect(m.otherReceipts).toBe(40);
    expect(m.cashIn).toBe(40);
    expect(m.cashOut).toBe(120);
    expect(_isReceiptPayment({ paymentType: 'ARCREDITPAYMENT' })).toBe(false);
  });

  test('transfers stay out of cash in and out, but are totalled for the tie-out', () => {
    const m = _buildCashMovement({
      months: MONTHS,
      bankTransactions: [
        { type: 'SPEND-TRANSFER',   status: 'AUTHORISED', date: '2025-03-02', total: 1000 },
        { type: 'RECEIVE-TRANSFER', status: 'AUTHORISED', date: '2025-03-02', total: 1000 },
        { type: 'RECEIVE-TRANSFER', status: 'DELETED',    date: '2025-03-02', total: 9999 },
      ],
    });
    expect(m.cashIn).toBe(0);
    expect(m.cashOut).toBe(0);
    expect(m.transfers).toEqual({ in: 1000, out: 1000 });
  });
});

describe('the bank statement — direction and deleted records', () => {
  test('every RECEIVE type is money in: transfers in, prepayments and overpayments received', () => {
    const txs = _buildBankTransactions([
      { bankTransactionID: 'a', type: 'RECEIVE-TRANSFER',    date: '2025-03-01', total: 1 },
      { bankTransactionID: 'b', type: 'RECEIVE-PREPAYMENT',  date: '2025-03-02', total: 1 },
      { bankTransactionID: 'c', type: 'RECEIVE-OVERPAYMENT', date: '2025-03-03', total: 1 },
      { bankTransactionID: 'd', type: 'SPEND-TRANSFER',      date: '2025-03-04', total: 1 },
      { bankTransactionID: 'e', type: 'SPEND-PREPAYMENT',    date: '2025-03-05', total: 1 },
    ]);
    const type = id => txs.find(t => t.transactionId === id).type;
    expect(['a', 'b', 'c'].map(type)).toEqual(['Money In', 'Money In', 'Money In']);
    expect(['d', 'e'].map(type)).toEqual(['Money Out', 'Money Out']);
  });

  test('deleted and voided records are left off the statement', () => {
    const txs = _buildBankTransactions([
      { bankTransactionID: 'live', type: 'SPEND',   status: 'AUTHORISED', date: '2025-03-01', total: 1 },
      { bankTransactionID: 'del',  type: 'RECEIVE', status: 'DELETED',    date: '2025-03-01', total: 1 },
      { bankTransactionID: 'void', type: 'SPEND',   status: 'VOIDED',     date: '2025-03-01', total: 1 },
    ]);
    expect(txs.map(t => t.transactionId)).toEqual(['live']);
    const pays = _buildPayments([
      { paymentID: 'p1', paymentType: 'ACCRECPAYMENT', status: 'AUTHORISED', date: '2025-03-01', amount: 1 },
      { paymentID: 'p2', paymentType: 'ACCRECPAYMENT', status: 'DELETED',    date: '2025-03-01', amount: 1 },
    ]);
    expect(pays.map(p => p.transactionId)).toEqual(['p1']);
  });

  test('a customer refund on the statement is money out', () => {
    const [p] = _buildPayments([{ paymentID: 'r', paymentType: 'ARCREDITPAYMENT', date: '2025-03-01', amount: 50 }]);
    expect(p.type).toBe('Money Out');
  });
});

describe('the tie-out against the Bank Summary compares like with like', () => {
  const movement = { cashIn: 2450, cashOut: 760, transfers: { in: 1000, out: 1000 } };

  test('transfers between the org\'s own accounts are not a disagreement', () => {
    // The Bank Summary counts the 1,000 transfer as received into one account
    // and spent from another; the records leave it out.
    const u = _buildUnreconciled({ movement, bankIn: 3450, bankOut: 1760 });
    expect(u).toMatchObject({ inGap: 0, outGap: 0, material: false, transfersIn: 1000, transfersOut: 1000 });
    // Compared as before, the same books raised the alert.
    expect(Math.abs(movement.cashIn - 3450)).toBeGreaterThan(1);
  });

  test('a real gap keeps its sign', () => {
    expect(_buildUnreconciled({ movement, bankIn: 3000, bankOut: 1760 }).inGap).toBe(450);    // records > bank
    expect(_buildUnreconciled({ movement, bankIn: 3450, bankOut: 2000 }).outGap).toBe(-240);  // bank > records
  });

  test('the alert says which way the records and the bank disagree', () => {
    const detail = u => _buildAlerts({ unreconciled: u }).alerts.find(a => a.code === 'unreconciled').detail;
    expect(detail({ material: true, inGap: 450, outGap: 0 })).toMatch(/recorded in Xero are not in the bank/);
    expect(detail({ material: true, inGap: 450, outGap: 0 })).not.toMatch(/no payment or bank transaction/);
    expect(detail({ material: true, inGap: 0, outGap: -240 })).toMatch(/bank accounts show money moving that no payment/);
    expect(detail({ material: true, inGap: 0, outGap: -240 })).not.toMatch(/recorded in Xero are not/);
    expect(detail({ material: true, inGap: 450, outGap: -240 })).toMatch(/recorded in Xero.*bank accounts show/s);
    expect(detail({ material: true })).toMatch(/disagree/);
  });
});

// ── 6. P&L totals, whatever the headings ────────────────────────────────────
describe('P&L totals are found by their section, not an exact label', () => {
  const months = _monthsBetween('2025-01', '2025-03');
  const header = { rowType: 'Header', cells: ['Account', 'Jan-25', 'Feb-25', 'Mar-25'].map(cell) };
  const pnlHeader = { rowType: 'Header', cells: ['', '31 Mar 25', '28 Feb 25', '31 Jan 25'].map(cell) };
  const money = v => v.toFixed(2);
  // BudgetSummary is oldest-first; ProfitAndLoss newest-first.
  const b = (label, vals, t) => row(label, vals.map(money), t);
  const p = (label, vals, t) => row(label, [...vals].reverse().map(money), t);

  const tradingPnl = [
    pnlHeader,
    section('Trading Income', [p('Sales', [100, 110, 120]), p('Total Trading Income', [100, 110, 120], 'SummaryRow')]),
    section('Less Cost of Sales', [p('Purchases', [10, 10, 10]), p('Total Cost of Sales', [10, 10, 10], 'SummaryRow')]),
    section('', [p('Gross Profit', [90, 100, 110])]),
    section('Plus Other Income', [p('Interest Income', [1, 1, 1]), p('Total Other Income', [1, 1, 1], 'SummaryRow')]),
    section('Less Overheads', [p('Rent', [40, 40, 40]), p('Wages', [20, 20, 20]), p('Total Overheads', [60, 60, 60], 'SummaryRow')]),
    section('', [p('Net Profit', [31, 41, 51])]),
  ];
  const actual = (totals, k) => totals[k].actual;

  test('"Trading Income" and "Less Overheads" headings no longer leave revenue and overheads at zero', () => {
    // No budget, so every label is the P&L's own.
    const { rows } = _buildBudgetVariance({ budgetRows: [], pnlRows: tradingPnl, months, actualThroughIdx: 2 });
    const { totals } = _buildPerformance({ months, rows, cash: {} });
    expect(actual(totals, 'revenue')).toEqual([100, 110, 120]);
    expect(actual(totals, 'cogs')).toEqual([10, 10, 10]);
    expect(actual(totals, 'opex')).toEqual([60, 60, 60]);
    expect(actual(totals, 'grossProfit')).toEqual([90, 100, 110]);
    expect(actual(totals, 'netProfit')).toEqual([31, 41, 51]);
  });

  test('"Plus Other Income" is other income, not revenue', () => {
    expect(_sectionKind('Plus Other Income')).toBe('otherIncome');
    expect(_sectionKind('Other Income')).toBe('otherIncome');
    const { rows } = _buildBudgetVariance({ budgetRows: [], pnlRows: tradingPnl, months, actualThroughIdx: 2 });
    const { totals, serviceLines } = _buildPerformance({ months, rows, cash: {} });
    expect(actual(totals, 'otherIncome')).toEqual([1, 1, 1]);
    expect(actual(totals, 'revenue')).toEqual([100, 110, 120]);
    expect(serviceLines.find(l => l.label === 'Interest Income').otherIncome).toBe(true);
  });

  test('a budget headed "Trading Income" gives budget and actual totals both', () => {
    // BudgetSummary has no standard-layout switch, so its headings are the
    // org's; the layout keeps them, and the total is "Total Trading Income".
    const budgetRows = [
      header,
      section('Trading Income', [b('Sales', [90, 90, 90]), b('Total Trading Income', [90, 90, 90], 'SummaryRow')]),
      section('Less Overheads', [b('Rent', [50, 50, 50]), b('Total Overheads', [50, 50, 50], 'SummaryRow')]),
      section('', [b('Net Profit', [40, 40, 40], 'SummaryRow')]),
    ];
    const pnlRows = [
      pnlHeader,
      section('Income', [p('Sales', [100, 110, 120]), p('Total Income', [100, 110, 120], 'SummaryRow')]),
      section('Less Operating Expenses', [p('Rent', [55, 45, 50]), p('Total Operating Expenses', [55, 45, 50], 'SummaryRow')]),
      section('', [p('Net Profit', [45, 65, 70])]),
    ];
    const { rows } = _buildBudgetVariance({ budgetRows, pnlRows, months, actualThroughIdx: 2 });
    const { totals } = _buildPerformance({ months, rows, cash: {} });
    expect(totals.revenue).toEqual({ actual: [100, 110, 120], budget: [90, 90, 90] });
    expect(totals.opex).toEqual({ actual: [55, 45, 50], budget: [50, 50, 50] });
  });

  test('a section with no subtotal is the sum of its accounts', () => {
    const mk = (label, kind, sec, vals) => ({ label, kind, section: sec, monthly: vals.map(v => ({ actual: v, budget: 0 })) });
    const rows = [
      { kind: 'section', label: 'Income', section: 'Income' },
      mk('Sales', 'account', 'Income', [5, 6, 7]),
      mk('Fees',  'account', 'Income', [1, 1, 1]),
    ];
    expect(_buildPerformance({ months, rows, cash: {} }).totals.revenue.actual).toEqual([6, 7, 8]);
  });

  test('"Gross Loss" is the gross line too', () => {
    const rows = [{ label: 'Gross Loss', kind: 'summary', section: '', monthly: [-5, -5, -5].map(v => ({ actual: v, budget: 0 })) }];
    expect(_buildPerformance({ months, rows, cash: {} }).totals.grossProfit.actual).toEqual([-5, -5, -5]);
  });
});

// ── End to end, Xero mocked ─────────────────────────────────────────────────
describe('Overview and Cash Flow read one debtor-days figure; the tie-out survives transfers', () => {
  const U = 'u-dash', T = 't-dash';
  const PERIOD = { from: '2025-01', to: '2025-03' };   // wholly past: every month closed, 90 days

  const INVOICES = [
    { type: 'ACCREC', status: 'PAID',       total: 1100, amountDue: 0,    date: '2025-01-15T00:00:00', dueDate: '2025-02-14T00:00:00', invoiceNumber: 'INV-1' },
    { type: 'ACCREC', status: 'PAID',       total: 1100, amountDue: 0,    date: '2025-02-15T00:00:00', dueDate: '2025-03-14T00:00:00', invoiceNumber: 'INV-2' },
    { type: 'ACCREC', status: 'AUTHORISED', total: 1100, amountDue: 1100, date: '2025-03-15T00:00:00', dueDate: '2025-04-14T00:00:00', invoiceNumber: 'INV-3' },
    { type: 'ACCPAY', status: 'PAID',       total: 330,  amountDue: 0,    date: '2025-01-10T00:00:00', dueDate: '2025-02-10T00:00:00', invoiceNumber: 'B-1' },
    { type: 'ACCPAY', status: 'PAID',       total: 330,  amountDue: 0,    date: '2025-02-10T00:00:00', dueDate: '2025-03-10T00:00:00', invoiceNumber: 'B-2' },
    { type: 'ACCPAY', status: 'AUTHORISED', total: 330,  amountDue: 330,  date: '2025-03-10T00:00:00', dueDate: '2025-04-10T00:00:00', invoiceNumber: 'B-3' },
  ];
  const PAYMENTS = [
    { paymentType: 'ACCRECPAYMENT',   status: 'AUTHORISED', date: '2025-01-20', amount: 1100 },
    { paymentType: 'ACCRECPAYMENT',   status: 'AUTHORISED', date: '2025-02-20', amount: 1100 },
    { paymentType: 'ACCRECPAYMENT',   status: 'DELETED',    date: '2025-02-21', amount: 5000 },
    { paymentType: 'ARCREDITPAYMENT', status: 'AUTHORISED', date: '2025-03-05', amount: 100 },
    { paymentType: 'ACCPAYPAYMENT',   status: 'AUTHORISED', date: '2025-01-25', amount: 330 },
    { paymentType: 'ACCPAYPAYMENT',   status: 'AUTHORISED', date: '2025-02-25', amount: 330 },
  ];
  const BANK_TX = [
    { type: 'RECEIVE',            status: 'AUTHORISED', date: '2025-03-01', total: 200 },
    { type: 'RECEIVE-PREPAYMENT', status: 'AUTHORISED', date: '2025-03-04', total: 50 },
    { type: 'SPEND-TRANSFER',     status: 'AUTHORISED', date: '2025-03-02', total: 1000 },
    { type: 'RECEIVE-TRANSFER',   status: 'AUTHORISED', date: '2025-03-02', total: 1000 },
    { type: 'SPEND',              status: 'DELETED',    date: '2025-03-03', total: 777 },
  ];
  // Received 2,450 and spent 760 of real money, plus a 1,000 transfer from the
  // operating account to savings — which the Bank Summary counts on both sides.
  const BANK_SUMMARY = [
    { rowType: 'Header', cells: ['Bank Accounts', 'Opening Balance', 'Cash Received', 'Cash Spent', 'Closing Balance'].map(cell) },
    section('', [
      row('Operating', ['10,000.00', '2,450.00', '(1,760.00)', '10,690.00']),
      row('Savings',   ['0.00', '1,000.00', '0.00', '1,000.00']),
      row('Total',     ['10,000.00', '3,450.00', '(1,760.00)', '11,690.00'], 'SummaryRow'),
    ]),
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    reports._cache.clear();
    const empty = { body: { reports: [{ rows: [] }] } };
    api.getOrganisations.mockResolvedValue({ body: { organisations: [
      { name: 'Test Org', baseCurrency: 'SGD', financialYearEndDay: 31, financialYearEndMonth: 12 },
    ] } });
    api.getReportProfitAndLoss.mockResolvedValue(empty);
    api.getReportBudgetSummary.mockResolvedValue(empty);
    api.getBudgets.mockResolvedValue({ body: { budgets: [] } });
    api.getReportBankSummary.mockResolvedValue({ body: { reports: [{ rows: BANK_SUMMARY }] } });
    api.getInvoices.mockResolvedValue({ body: { invoices: INVOICES } });
    api.getPayments.mockResolvedValue({ body: { payments: PAYMENTS } });
    api.getBankTransactions.mockResolvedValue({ body: { bankTransactions: BANK_TX } });
  });

  test('debtor and creditor days: closed months, invoices and bills on both sides, one figure everywhere', async () => {
    const perf = await reports.getPerformance(U, T, { period: PERIOD });
    expect(perf.paymentDays).toMatchObject({ available: true, closedMonths: 3, days: 90, invoiced: 3300, billed: 990 });
    expect(perf.paymentDays.dso).toBeCloseTo(1100 / 3300 * 90, 6);   // 30
    expect(perf.paymentDays.dpo).toBeCloseTo(330 / 990 * 90, 6);     // 30

    const cf = await reports.getCashFlow(U, T, { period: PERIOD });
    expect(cf.workingCapital.dso).toBe(perf.paymentDays.dso);
    expect(cf.workingCapital.dpo).toBe(perf.paymentDays.dpo);
    expect(cf.workingCapital.paymentDays).toMatchObject({ closedMonths: 3, toLabel: 'Mar 2025' });
  });

  test('deleted records are ignored, refunds go out, and a transfer does not raise the tie-out alert', async () => {
    const cf = await reports.getCashFlow(U, T, { period: PERIOD });
    expect(cf.movement).toMatchObject({
      customerReceipts: 2200, otherReceipts: 250, supplierPayments: 660, otherPayments: 100,
      cashIn: 2450, cashOut: 760, transfers: { in: 1000, out: 1000 },
    });
    // Cash in and out are the bank's, less the transfer.
    expect(cf.cash).toMatchObject({ cashIn: 2450, cashOut: 760, transfersIn: 1000, transfersOut: 1000 });
    expect(cf.unreconciled.material).toBe(false);
    expect(cf.alerts.alerts.map(a => a.code)).not.toContain('unreconciled');
    expect(cf.waterfall.reconciles).toBe(true);
  });

  test('with no bank figure to compare against, nothing is reported as unreconciled', async () => {
    api.getReportBankSummary.mockRejectedValue(new Error('bank summary down'));
    const cf = await reports.getCashFlow(U, 't-dash-nobank', { period: PERIOD });
    expect(cf.cash.available).toBe(false);
    expect(cf.unreconciled.material).toBe(false);
  });

  test('a failed summary leaves debtor days unavailable without failing the report', async () => {
    api.getInvoices.mockRejectedValue(new Error('rate limited'));
    const perf = await reports.getPerformance(U, 't-dash-nosummary', { period: PERIOD });
    expect(perf.paymentDays).toMatchObject({ available: false, reason: 'unavailable', dso: null, dpo: null });
  });
});

// ── The Dashboard and the Budget tab compare the same months ────────────────
// Rebuilt from the live fixture in reports.test.js (Nexsoss Pte Ltd, FY Apr
// 2026–Mar 2027, seen on 17 August): Apr–Jul closed, August part-booked. The
// Budget tab compares closed months only. The dashboard summed the whole
// selected range — so with the year to date selected, Overview said 109,330
// of revenue against the Budget tab's 57,330, Profitability said net profit
// was 34,385 ahead of a budget the Budget tab said it was exactly on, and the
// variance list put September's wages down as a saving of 24,603. The UI's
// arithmetic is lifted out of primitives.jsx and run over the same rows.
describe('every "vs budget" figure on the Dashboard is the Budget tab\'s closed-month figure', () => {
  const fs   = require('fs');
  const path = require('path');
  const UI   = path.join(__dirname, '../../ui/src/components/performance/primitives.jsx');
  const src  = fs.readFileSync(UI, 'utf8');
  const functionSource = name => {
    const start = src.indexOf(`export function ${name}(`);
    if (start < 0) throw new Error(`${name} not found`);
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    return src.slice(start, i + 1).replace(/^export /, '');
  };
  const lift = (name, deps = {}) => new Function(...Object.keys(deps), `${functionSource(name)}\nreturn ${name};`)(...Object.values(deps));
  const closedSpan          = lift('closedSpan');
  const closedSum           = lift('closedSum');
  const closedCaption       = lift('closedCaption');
  const closedAttainment    = lift('closedAttainment', { closedSpan, closedSum });
  const closedVarianceItems = lift('closedVarianceItems', { closedSum });
  const sum = lift('sum'), slice = lift('slice');
  const sliceSum = lift('sliceSum', { slice, sum });
  const useRangeTotals = lift('useRangeTotals', { useMemo: f => f(), sliceSum, closedSpan, closedSum, closedAttainment });

  const FY_END = { month: 3, day: 31 };
  const TODAY  = { year: 2026, month: 8, day: 17 };
  const BUDGET = [
    ['Sales - Implementation',          [0,0,0,57330,37000,0,0,0,54500,0,27000,27500]],
    ['Sales - Maintenance (Recurring)', [0,0,0,0,15000,0,0,0,0,0,10000,15000]],
    ['Total Income',                    [0,0,0,57330,52000,0,0,0,54500,0,37000,42500]],
    ['Cost of Goods Sold',              [0,0,0,0,7330,1030,1030,1030,1030,1030,7630,7930]],
    ['Total Cost of Sales',             [0,0,0,0,7330,1030,1030,1030,1030,1030,7630,7930]],
    ['Gross Profit',                    [0,0,0,57330,44670,-1030,-1030,-1030,53470,-1030,29370,34570]],
    ['Other Income - Grant',            [0,0,0,0,0,16667,8333,8333,8333,8333,0,0]],
    ['Total Other Income',              [0,0,0,0,0,16667,8333,8333,8333,8333,0,0]],
    ['Bank Fees',                       [0,0,0,0,10,10,10,10,10,10,10,10]],
    ['Consulting & Accounting',         [0,0,0,0,500,500,500,500,500,500,500,500]],
    ['Insurance',                       [0,0,0,0,800,800,800,800,800,1400,1400,1400]],
    ['Legal expenses',                  [0,0,0,0,1000,1000,1000,1000,1000,1000,1000,1000]],
    ['Subscriptions',                   [0,0,0,0,142,142,142,142,142,642,642,642]],
    ['Wages and Salaries',              [0,0,0,24603,24603,24603,24603,24603,24603,24603,24603,24603]],
    ['Total Operating Expenses',        [0,0,0,24603,27055,27055,27055,27055,27055,28155,28155,28155]],
    ['Net Profit',                      [0,0,0,32727,17615,-11418,-19752,-19752,34748,-20852,1215,6415]],
  ];
  const money = v => (v === 0 ? '0.00' : String(v.toFixed(2)));
  const bRow  = (label, rowType = 'Row') => row(label, BUDGET.find(([l]) => l === label)[1].map(money), rowType);
  const budgetRows = [
    { rowType: 'Header', cells: ['Account','Apr-26','May-26','Jun-26','Jul-26','Aug-26','Sep-26','Oct-26','Nov-26','Dec-26','Jan-27','Feb-27','Mar-27'].map(cell) },
    section('Income', [bRow('Sales - Implementation'), bRow('Sales - Maintenance (Recurring)'), bRow('Total Income', 'SummaryRow')]),
    section('Less Cost of Sales', [bRow('Cost of Goods Sold'), bRow('Total Cost of Sales', 'SummaryRow')]),
    section('', [bRow('Gross Profit', 'SummaryRow')]),
    section('Other Income', [bRow('Other Income - Grant'), bRow('Total Other Income', 'SummaryRow')]),
    section('Less Operating Expenses', [
      bRow('Bank Fees'), bRow('Consulting & Accounting'), bRow('Insurance'), bRow('Legal expenses'), bRow('Subscriptions'),
      bRow('Wages and Salaries'), bRow('Total Operating Expenses', 'SummaryRow'),
    ]),
    section('', [bRow('Net Profit', 'SummaryRow')]),
  ];
  // Newest-first, as the P&L comes: Aug (part-booked) then Jul.
  const PNL = {
    'Sales - Implementation':          [0,0,0,0,0,0,0,37000,-17670,0,0,0],
    'Sales - Maintenance (Recurring)': [0,0,0,0,0,0,0,15000,75000,0,0,0],
    'Total Income':                    [0,0,0,0,0,0,0,52000,57330,0,0,0],
    'Gross Profit':                    [0,0,0,0,0,0,0,52000,57330,0,0,0],
    'Wages and Salaries':              [0,0,0,0,0,0,0,0,24603,0,0,0],
    'Total Operating Expenses':        [0,0,0,0,0,0,0,0,24603,0,0,0],
    'Net Profit':                      [0,0,0,0,0,0,0,52000,32727,0,0,0],
  };
  const p = (label, rowType = 'Row') => row(label, PNL[label].map(money), rowType);
  const pnlRows = [
    { rowType: 'Header', cells: ['','31 Mar 27','28 Feb 27','31 Jan 27','31 Dec 26','30 Nov 26','31 Oct 26','30 Sep 26','31 Aug 26','31 Jul 26','30 Jun 26','31 May 26','30 Apr 26'].map(cell) },
    section('Income', [p('Sales - Implementation'), p('Sales - Maintenance (Recurring)'), p('Total Income', 'SummaryRow')]),
    section('', [p('Gross Profit')]),
    section('Less Operating Expenses', [p('Wages and Salaries'), p('Total Operating Expenses', 'SummaryRow')]),
    section('', [p('Net Profit')]),
  ];

  const months = _fiscalYearMonths(TODAY, FY_END);
  const actualThroughIdx = _actualThroughIndex(months, TODAY);
  const bv = _buildBudgetVariance({ budgetRows, pnlRows, months, actualThroughIdx, currentIdx: 4, asOfISO: '2026-08-17' });
  const built = _buildPerformance({ months, rows: bv.rows, cash: null });
  // The /performance payload as the panels read it.
  const d = { months, actualThroughIdx, closedThroughIdx: actualThroughIdx, organisation: { currency: 'SGD' }, ...built };
  const find = label => bv.rows.find(r => r.label === label);
  const YTD = [0, 4];   // financial year to date on 17 August: April to August

  test('the fixture is the one the Budget tab is pinned to', () => {
    expect(actualThroughIdx).toBe(3);
    expect(find('Net Profit')).toMatchObject({ actualToDate: 32727, budgetToDate: 32727, variance: 0 });
    expect(bv.kpis.currentMonth).toMatchObject({ label: 'Aug 2026', actualNet: 52000 });
  });

  test('Overview revenue: the headline includes August so far, the comparison is the Budget tab\'s 57,330', () => {
    const T = useRangeTotals(d, ...YTD);
    expect(T.revenue).toBe(109330);
    expect(T.openMonthLabel).toBe('Aug 2026');
    expect(T.actualClosed.revenue).toBe(find('Total Income').actualToDate);
    expect(T.budgetClosed.revenue).toBe(find('Total Income').budgetToDate);
    expect(T.actualClosed.revenue).toBe(57330);
    expect(T.attainment).toBe(1);
    expect(closedCaption(closedSpan(d, ...YTD))).toBe('Closed months: Apr 2026 – Jul 2026 (4)');
  });

  test('Profitability net profit vs budget is the Budget tab\'s 0, not the whole range\'s +34,385', () => {
    const T = useRangeTotals(d, ...YTD);
    expect(T.netProfit - T.netProfitBudget).toBe(34385);
    expect(T.actualClosed.netProfit - T.budgetClosed.netProfit).toBe(find('Net Profit').variance);
    expect(T.actualClosed.netProfit).toBe(32727);
    // The whole period's plan, the one place it is shown.
    expect(useRangeTotals(d, 0, 11)).toMatchObject({ wholeMonths: 12, netProfitBudget: 20946, revenueBudget: 243330 });
  });

  test('the Overview and Analysis variance lists agree with the Budget tab line for line', () => {
    const lines = [...d.serviceLines, ...d.expenseLines];
    const items = closedVarianceItems(lines, closedSpan(d, ...YTD), 100);
    for (const it of items) expect(it.v).toBe(find(it.label).variance);
    const differing = bv.rows.filter(r => r.kind === 'account' && r.variance !== 0).map(r => r.label).sort();
    expect(items.map(i => i.label).sort()).toEqual(differing);
    expect(items.map(i => i.label)).toEqual(['Sales - Implementation', 'Sales - Maintenance (Recurring)']);
    // September's wages are no longer a saving.
    const wages = lines.find(l => l.label === 'Wages and Salaries');
    expect(sliceSum(wages.actual, ...YTD) - sliceSum(wages.budget, ...YTD)).toBe(-24603);
    expect(items.find(i => i.label === 'Wages and Salaries')).toBeUndefined();
  });

  test('with nothing closed there is no comparison, and the watch list says what the figures are', () => {
    const T = useRangeTotals({ ...d, actualThroughIdx: -1, closedThroughIdx: -1 }, 0, 11);
    expect(T).toMatchObject({ closedMonths: 0, attainment: null, actualClosed: { netProfit: 0 }, budgetClosed: { netProfit: 0 } });
    const list = _buildWatchList({ months, totals: built.totals, actualThroughIdx: -1 });
    const note = list.find(w => /No month of this period has closed yet/.test(w.text));
    expect(note.text).toBe('No month of this period has closed yet — figures are what has been booked so far; budget comparisons start when a month closes.');
    expect(list.some(w => /every figure shown is budget/.test(w.text))).toBe(false);
  });
});
