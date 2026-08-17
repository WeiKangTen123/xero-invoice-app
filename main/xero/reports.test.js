const {
  _buildSummary, computeRange, _buildPeriod, _buildAccounts, _buildBankAccounts, _buildContacts,
  _buildBankTransactions, _buildPayments, _buildProfitAndLoss, _buildBankSummary, _flattenReportRows,
  _splitIntoReportWindows, _clampReportFrom,
  _fiscalYearMonths, _actualThroughIndex, _rowValuesByLabel, _skeletonFromBudget, _buildBudgetVariance,
} = require('./reports');

// Helper matching Xero's real report cell shape: { value }.
function cell(value) { return { value }; }
function row(title, cells, rowType = 'Row') { return { rowType, title, cells: cells.map(cell) }; }
function section(title, rows) { return { rowType: 'Section', title, rows }; }

describe('xero/reports — _buildSummary (pure)', () => {
  const ORG = { name: 'Blacklab Pte. Ltd.', countryCode: 'SG', baseCurrency: 'SGD', financialYearEndDay: 31, financialYearEndMonth: 12 };

  test('no invoices — zeroed KPIs, empty list, org profile still populated', () => {
    const result = _buildSummary(ORG, []);
    expect(result.connected).toBe(true);
    expect(result.kpis).toEqual({
      totalReceivables: 0, totalPayables: 0, receivablesCount: 0, payablesCount: 0, overdueAmount: 0,
      statusBreakdown: { paid: 0, awaiting: 0, overdue: 0 },
    });
    expect(result.invoices).toEqual([]);
    expect(result.organisation).toEqual({ name: 'Blacklab Pte. Ltd.', country: 'SG', currency: 'SGD', yearEnd: '31/12' });
  });

  test('falls back to legalName, and to em-dashes, when fields are missing', () => {
    const result = _buildSummary({ legalName: 'Blacklab Legal Pte. Ltd.' }, []);
    expect(result.organisation).toEqual({ name: 'Blacklab Legal Pte. Ltd.', country: '—', currency: '—', yearEnd: '—' });
  });

  test('sums AUTHORISED receivables and payables separately, ignores everything else for the totals', () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const invoices = [
      { type: 'ACCREC', status: 'AUTHORISED', amountDue: 300, dueDate: future },
      { type: 'ACCREC', status: 'AUTHORISED', amountDue: 150, dueDate: future },
      { type: 'ACCPAY', status: 'AUTHORISED', amountDue: 90,  dueDate: future },
      { type: 'ACCREC', status: 'PAID',       amountDue: 0,   dueDate: future }, // paid — excluded from totals
    ];
    const { kpis } = _buildSummary(ORG, invoices);
    expect(kpis.totalReceivables).toBe(450);
    expect(kpis.totalPayables).toBe(90);
    expect(kpis.receivablesCount).toBe(2);
    expect(kpis.payablesCount).toBe(1);
  });

  test('status classification: paid (by status or zero due), overdue (past due date), awaiting (everything else)', () => {
    const past   = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const invoices = [
      { type: 'ACCREC', status: 'PAID',       amountDue: 0,   dueDate: past },   // paid (status)
      { type: 'ACCREC', status: 'AUTHORISED', amountDue: 0,   dueDate: future }, // paid (fully paid down)
      { type: 'ACCPAY', status: 'AUTHORISED', amountDue: 50,  dueDate: past },   // overdue
      { type: 'ACCREC', status: 'AUTHORISED', amountDue: 75,  dueDate: future }, // awaiting
      { type: 'ACCPAY', status: 'AUTHORISED', amountDue: 20,  dueDate: null },   // awaiting — no due date to compare
    ];
    const { kpis, invoices: list } = _buildSummary(ORG, invoices);
    expect(kpis.statusBreakdown).toEqual({ paid: 2, awaiting: 2, overdue: 1 });
    expect(list.map(i => i.status)).toEqual(['paid', 'paid', 'overdue', 'awaiting', 'awaiting']);
    expect(kpis.overdueAmount).toBe(50); // only the one overdue ACCPAY line
  });

  test('maps ACCREC/ACCPAY to Sale/Bill and falls back invoice currency to the org base currency', () => {
    const { invoices } = _buildSummary(ORG, [
      { type: 'ACCREC', status: 'AUTHORISED', amountDue: 10, total: 10, currencyCode: 'USD' },
      { type: 'ACCPAY', status: 'AUTHORISED', amountDue: 10, total: 10 }, // no currencyCode of its own
    ]);
    expect(invoices[0]).toMatchObject({ type: 'Sale', currency: 'USD' });
    expect(invoices[1]).toMatchObject({ type: 'Bill', currency: 'SGD' }); // falls back to org.baseCurrency
  });

  test('unknown contact falls back to "Unknown", not undefined/blank', () => {
    const { invoices } = _buildSummary(ORG, [{ type: 'ACCREC', status: 'AUTHORISED', amountDue: 1, total: 1 }]);
    expect(invoices[0].contact).toBe('Unknown');
  });

  test('caps the returned invoice list at 50, most recent first (input order preserved)', () => {
    const many = Array.from({ length: 55 }, (_, i) => ({
      type: 'ACCREC', status: 'AUTHORISED', amountDue: 1, total: 1, invoiceNumber: `INV-${i}`,
    }));
    const { invoices } = _buildSummary(ORG, many);
    expect(invoices).toHaveLength(50);
    expect(invoices[0].invoiceNumber).toBe('INV-0');
  });

  // Mirrors Xero's own "Invoices owed to you" / "Bills to pay" widgets —
  // outstanding amounts bucketed by how soon they're due.
  test('aging: buckets outstanding receivables and payables by days-until-due, separately', () => {
    const days = n => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
    const invoices = [
      { type: 'ACCREC', status: 'AUTHORISED', amountDue: 100, dueDate: days(-3) },  // overdue
      { type: 'ACCREC', status: 'AUTHORISED', amountDue: 200, dueDate: days(5) },   // within7
      { type: 'ACCREC', status: 'AUTHORISED', amountDue: 300, dueDate: days(20) },  // within30
      { type: 'ACCREC', status: 'AUTHORISED', amountDue: 400, dueDate: days(90) },  // later
      { type: 'ACCPAY', status: 'AUTHORISED', amountDue: 50,  dueDate: days(2) },   // within7
    ];
    const { aging } = _buildSummary(ORG, invoices);
    expect(aging.receivables).toEqual({
      overdue: { count: 1, amount: 100 }, within7: { count: 1, amount: 200 },
      within30: { count: 1, amount: 300 }, later: { count: 1, amount: 400 },
    });
    expect(aging.payables).toEqual({
      overdue: { count: 0, amount: 0 }, within7: { count: 1, amount: 50 },
      within30: { count: 0, amount: 0 }, later: { count: 0, amount: 0 },
    });
  });

  test('aging: a missing due date falls into "later" rather than crashing', () => {
    const { aging } = _buildSummary(ORG, [{ type: 'ACCREC', status: 'AUTHORISED', amountDue: 10, dueDate: null }]);
    expect(aging.receivables.later).toEqual({ count: 1, amount: 10 });
  });

  test('aging: paid invoices and drafts (no amountDue) never enter any bucket', () => {
    const { aging } = _buildSummary(ORG, [
      { type: 'ACCREC', status: 'PAID', amountDue: 0, dueDate: new Date().toISOString() },
      { type: 'ACCREC', status: 'DRAFT', amountDue: 0, dueDate: new Date().toISOString() },
    ]);
    const total = b => Object.values(b).reduce((s, x) => s + x.count, 0);
    expect(total(aging.receivables)).toBe(0);
  });
});

describe('xero/reports — computeRange (pure, date math only)', () => {
  // Pin "now" so every preset resolves deterministically. Wednesday, so the
  // week-start (Monday) case actually crosses a few days, not a no-op.
  beforeEach(() => { jest.useFakeTimers().setSystemTime(new Date('2026-08-12T10:00:00Z')); }); // Wed
  afterEach(() => { jest.useRealTimers(); });

  test('day — from and to are both today', () => {
    const r = computeRange('day', 'UTC');
    expect(r).toMatchObject({ preset: 'day', fromISO: '2026-08-12', toISO: '2026-08-12', days: 1 });
    expect(r.where).toBe('Date >= DateTime(2026,8,12) && Date < DateTime(2026,8,13)');
  });

  test('week — from is Monday of this week, to is today', () => {
    const r = computeRange('week', 'UTC');
    expect(r.fromISO).toBe('2026-08-10'); // Monday
    expect(r.toISO).toBe('2026-08-12');   // today (Wednesday)
  });

  test('month — from is the 1st of this month', () => {
    const r = computeRange('month', 'UTC');
    expect(r.fromISO).toBe('2026-08-01');
    expect(r.toISO).toBe('2026-08-12');
  });

  test('year — from is Jan 1 of this year (default, no fiscal year end given)', () => {
    const r = computeRange('year', 'UTC');
    expect(r.fromISO).toBe('2026-01-01');
    expect(r.toISO).toBe('2026-08-12');
  });

  test('year — with a non-calendar fiscal year end, follows the fiscal year instead of Jan 1', () => {
    // "Today" (Aug 12) is after this calendar year's Mar 31 fiscal-year-end,
    // so the current fiscal year started Apr 1 of THIS year — matches what
    // Xero's own "Year to date" dashboard widget shows for such an org.
    const r = computeRange('year', 'UTC', undefined, undefined, { month: 3, day: 31 });
    expect(r.fromISO).toBe('2026-04-01');
  });

  test('year — fiscal year end still ahead this calendar year falls back to the fiscal year that started last year', () => {
    jest.setSystemTime(new Date('2026-02-15T10:00:00Z')); // before this year's Mar 31 fiscal year end
    const r = computeRange('year', 'UTC', undefined, undefined, { month: 3, day: 31 });
    expect(r.fromISO).toBe('2025-04-01');
  });

  test('year — a fiscal year end of Dec 31 behaves exactly like the calendar-year default', () => {
    const r = computeRange('year', 'UTC', undefined, undefined, { month: 12, day: 31 });
    expect(r.fromISO).toBe('2026-01-01');
  });

  test('all — from is a fixed far-past anchor, to is today', () => {
    const r = computeRange('all', 'UTC');
    expect(r).toMatchObject({ preset: 'all', fromISO: '2000-01-01', toISO: '2026-08-12' });
  });

  test('custom — uses the given from/to verbatim', () => {
    const r = computeRange('custom', 'UTC', '2026-01-15', '2026-03-01');
    expect(r).toMatchObject({ preset: 'custom', fromISO: '2026-01-15', toISO: '2026-03-01' });
    expect(r.where).toBe('Date >= DateTime(2026,1,15) && Date < DateTime(2026,3,2)');
  });

  test('custom — rejects "from" after "to"', () => {
    expect(() => computeRange('custom', 'UTC', '2026-03-01', '2026-01-15')).toThrow(/must not be after/i);
  });

  test('custom — rejects missing/malformed dates', () => {
    expect(() => computeRange('custom', 'UTC', 'not-a-date', '2026-01-15')).toThrow(/valid/i);
    expect(() => computeRange('custom', 'UTC', undefined, undefined)).toThrow(/valid/i);
  });

  test('an unrecognised preset falls back to month, not a crash', () => {
    const r = computeRange('bogus', 'UTC');
    expect(r.preset).toBe('month');
    expect(r.fromISO).toBe('2026-08-01');
  });

  test('"today" is resolved per the given timezone, not the server\'s', () => {
    // 2026-08-12T23:30 UTC is already 2026-08-13 in Singapore (UTC+8).
    jest.setSystemTime(new Date('2026-08-12T23:30:00Z'));
    const utc = computeRange('day', 'UTC');
    const sgt = computeRange('day', 'Asia/Singapore');
    expect(utc.fromISO).toBe('2026-08-12');
    expect(sgt.fromISO).toBe('2026-08-13');
  });
});

describe('xero/reports — _buildPeriod (pure)', () => {
  const shortRange = { preset: 'week', fromISO: '2026-08-10', toISO: '2026-08-12', days: 3 };
  const longRange  = { preset: 'year', fromISO: '2026-01-01', toISO: '2026-08-12', days: 224 };

  test('totals sales and bills separately, computes net', () => {
    const invoices = [
      { type: 'ACCREC', total: 300, date: '2026-08-10T00:00:00Z' },
      { type: 'ACCREC', total: 150, date: '2026-08-11T00:00:00Z' },
      { type: 'ACCPAY', total: 90,  date: '2026-08-11T00:00:00Z' },
    ];
    const { totals } = _buildPeriod(invoices, shortRange);
    expect(totals).toEqual({ salesTotal: 450, billsTotal: 90, salesCount: 2, billsCount: 1, net: 360 });
  });

  test('short ranges (<=31 days) bucket by day', () => {
    const invoices = [
      { type: 'ACCREC', total: 100, date: '2026-08-10T00:00:00Z' },
      { type: 'ACCREC', total: 50,  date: '2026-08-10T00:00:00Z' },
      { type: 'ACCPAY', total: 20,  date: '2026-08-11T00:00:00Z' },
    ];
    const { granularity, trend } = _buildPeriod(invoices, shortRange);
    expect(granularity).toBe('day');
    expect(trend).toEqual([
      { bucket: '2026-08-10', sales: 150, bills: 0 },
      { bucket: '2026-08-11', sales: 0, bills: 20 },
    ]);
  });

  test('long ranges (>31 days) bucket by month', () => {
    const invoices = [
      { type: 'ACCREC', total: 100, date: '2026-01-05T00:00:00Z' },
      { type: 'ACCREC', total: 200, date: '2026-01-20T00:00:00Z' },
      { type: 'ACCPAY', total: 30,  date: '2026-03-01T00:00:00Z' },
    ];
    const { granularity, trend } = _buildPeriod(invoices, longRange);
    expect(granularity).toBe('month');
    expect(trend).toEqual([
      { bucket: '2026-01', sales: 300, bills: 0 },
      { bucket: '2026-03', sales: 0, bills: 30 },
    ]);
  });

  test('an invoice with no date is totalled but excluded from the trend', () => {
    const { totals, trend } = _buildPeriod([{ type: 'ACCREC', total: 75, date: null }], shortRange);
    expect(totals.salesTotal).toBe(75);
    expect(trend).toEqual([]);
  });

  test('no invoices — zeroed totals, empty trend', () => {
    const { totals, trend } = _buildPeriod([], shortRange);
    expect(totals).toEqual({ salesTotal: 0, billsTotal: 0, salesCount: 0, billsCount: 0, net: 0 });
    expect(trend).toEqual([]);
  });
});

describe('xero/reports — directory builders (pure)', () => {
  test('_buildAccounts maps the fields the Chart of Accounts table needs', () => {
    const accounts = _buildAccounts([{ accountID: 'a1', code: '200', name: 'Sales', type: 'REVENUE', taxType: 'OUTPUT', status: 'ACTIVE' }]);
    expect(accounts).toEqual([{ accountId: 'a1', code: '200', name: 'Sales', type: 'REVENUE', taxType: 'OUTPUT', status: 'ACTIVE' }]);
  });

  test('_buildBankAccounts keeps only Type==BANK accounts', () => {
    const accounts = _buildBankAccounts([
      { accountID: 'a1', type: 'BANK', code: '090', name: 'Main Account', bankAccountNumber: '123-456', currencyCode: 'SGD', status: 'ACTIVE' },
      { accountID: 'a2', type: 'REVENUE', code: '200', name: 'Sales' },
    ]);
    expect(accounts).toEqual([{ accountId: 'a1', code: '090', name: 'Main Account', accountNumber: '123-456', currency: 'SGD', status: 'ACTIVE' }]);
  });

  test('_buildContacts maps customer/supplier flags and falls back name to "Unknown"', () => {
    const contacts = _buildContacts([
      { contactID: 'c1', name: 'Acme Corp', emailAddress: 'a@acme.com', isCustomer: true, isSupplier: false, contactStatus: 'ACTIVE' },
      { contactID: 'c2', isCustomer: false, isSupplier: true },
    ]);
    expect(contacts[0]).toMatchObject({ name: 'Acme Corp', isCustomer: true, isSupplier: false });
    expect(contacts[1]).toMatchObject({ name: 'Unknown', isSupplier: true });
  });

  test('_buildBankTransactions maps RECEIVE/SPEND to Money In/Out, sorts newest first', () => {
    const txs = _buildBankTransactions([
      { bankTransactionID: 't1', type: 'SPEND', contact: { name: 'Landlord' }, reference: 'Rent', date: '2026-08-01', total: 2000, isReconciled: true, status: 'AUTHORISED' },
      { bankTransactionID: 't2', type: 'RECEIVE', contact: { name: 'Kind Living' }, date: '2026-08-10', total: 2400, isReconciled: false, status: 'AUTHORISED' },
    ]);
    expect(txs.map(t => t.transactionId)).toEqual(['t2', 't1']); // newest first
    expect(txs[0]).toMatchObject({ type: 'Money In', contact: 'Kind Living', isReconciled: false });
    expect(txs[1]).toMatchObject({ type: 'Money Out', contact: 'Landlord', reference: 'Rent', isReconciled: true });
  });

  // xero-node's real getBankTransactions response returns .date as an actual
  // Date object, not a string (confirmed against a live response) — a plain
  // string fixture wouldn't have caught the ".localeCompare is not a
  // function" crash this shape causes if the sort ever stops normalizing it.
  test('handles a real Date-object .date (not a string) without crashing, and normalizes it to an ISO date string', () => {
    const txs = _buildBankTransactions([
      { bankTransactionID: 't1', type: 'SPEND', date: new Date('2026-07-20T00:00:00.000Z'), total: 100 },
      { bankTransactionID: 't2', type: 'RECEIVE', date: new Date('2026-07-22T00:00:00.000Z'), total: 200 },
    ]);
    expect(txs.map(t => t.transactionId)).toEqual(['t2', 't1']); // newest first
    expect(txs[0].date).toBe('2026-07-22');
    expect(txs[1].date).toBe('2026-07-20');
  });
});

// Payment records capture cash movement that never appears in
// getBankTransactions — paying a bill or receiving payment against an
// invoice, confirmed against live data.
describe('xero/reports — _buildPayments (pure)', () => {
  test('the two common payment types (confirmed live) classify correctly: ACCRECPAYMENT in, ACCPAYPAYMENT out', () => {
    const payments = _buildPayments([
      { paymentID: 'p1', paymentType: 'ACCRECPAYMENT', date: '2026-08-05', amount: 500, invoice: { contact: { name: 'Customer Co' } } },
      { paymentID: 'p2', paymentType: 'ACCPAYPAYMENT', date: '2026-08-07', amount: 300, invoice: { contact: { name: 'Supplier Co' } } },
    ]);
    expect(payments[0]).toMatchObject({ transactionId: 'p2', type: 'Money Out', contact: 'Supplier Co', total: 300 });
    expect(payments[1]).toMatchObject({ transactionId: 'p1', type: 'Money In', contact: 'Customer Co', total: 500 });
  });

  // All 8 real PaymentTypeEnum values (per the xero-node SDK) — only 6 of
  // them actually start with AR/AP, the other 2 (the most common ones) don't.
  test('every real PaymentTypeEnum value classifies to the correct direction, not just the ones that happen to start with AR/AP', () => {
    const IN  = ['ACCRECPAYMENT', 'ARCREDITPAYMENT', 'AROVERPAYMENTPAYMENT', 'ARPREPAYMENTPAYMENT'];
    const OUT = ['ACCPAYPAYMENT', 'APCREDITPAYMENT', 'APPREPAYMENTPAYMENT', 'APOVERPAYMENTPAYMENT'];
    for (const paymentType of IN) {
      expect(_buildPayments([{ paymentID: 'p', paymentType, date: '2026-08-05', amount: 1 }])[0].type).toBe('Money In');
    }
    for (const paymentType of OUT) {
      expect(_buildPayments([{ paymentID: 'p', paymentType, date: '2026-08-05', amount: 1 }])[0].type).toBe('Money Out');
    }
  });

  test('falls back to a "Payment - <invoice number>" reference when Xero gives no explicit reference', () => {
    const payments = _buildPayments([
      { paymentID: 'p1', paymentType: 'ACCPAYPAYMENT', date: '2026-08-07', amount: 2983, invoice: { invoiceNumber: 'Payroll - Jul' } },
    ]);
    expect(payments[0].reference).toBe('Payment - Payroll - Jul');
  });

  test('handles a real Date-object .date the same way _buildBankTransactions does', () => {
    const payments = _buildPayments([
      { paymentID: 'p1', paymentType: 'ACCPAYPAYMENT', date: new Date('2026-08-07T00:00:00.000Z'), amount: 100 },
    ]);
    expect(payments[0].date).toBe('2026-08-07');
  });

  test('an unknown contact falls back to "Unknown", same as bank transactions', () => {
    const payments = _buildPayments([{ paymentID: 'p1', paymentType: 'ACCPAYPAYMENT', date: '2026-08-07', amount: 100 }]);
    expect(payments[0].contact).toBe('Unknown');
  });
});

describe('xero/reports — _flattenReportRows (pure)', () => {
  test('walks nested sections into a flat title/cells list', () => {
    const tree = [
      section('Income', [row('Sales', ['Sales', '50,000.00'])]),
      row('Net Profit', ['Net Profit', '40,000.00'], 'SummaryRow'),
    ];
    const flat = _flattenReportRows(tree);
    expect(flat).toEqual([
      { title: 'Sales', cells: ['Sales', '50,000.00'] },
      { title: 'Net Profit', cells: ['Net Profit', '40,000.00'] },
    ]);
  });

  test('rows with neither nested rows nor cells are skipped, not crashed on', () => {
    const tree = [{ rowType: 'Header', title: 'Empty header' }];
    expect(_flattenReportRows(tree)).toEqual([]);
  });
});

describe('xero/reports — _buildProfitAndLoss (pure)', () => {
  test('extracts income, expenses, and net profit from a realistic report tree', () => {
    const tree = [
      section('Income', [
        row('Sales', ['Sales', '50,000.00']),
        row('Total Income', ['Total Income', '50,000.00'], 'SummaryRow'),
      ]),
      section('Expenses', [
        row('Rent', ['Rent', '10,000.00']),
        row('Total Expenses', ['Total Expenses', '10,000.00'], 'SummaryRow'),
      ]),
      row('Net Profit', ['Net Profit', '40,000.00'], 'SummaryRow'),
    ];
    expect(_buildProfitAndLoss(tree)).toEqual({ income: 50000, expenses: 10000, netProfit: 40000, netMargin: 0.8 });
  });

  test('a net LOSS renders in parentheses and parses as negative', () => {
    const tree = [
      row('Total Income', ['Total Income', '10,000.00'], 'SummaryRow'),
      row('Total Expenses', ['Total Expenses', '15,000.00'], 'SummaryRow'),
      row('Net Loss', ['Net Loss', '(5,000.00)'], 'SummaryRow'),
    ];
    expect(_buildProfitAndLoss(tree).netProfit).toBe(-5000);
  });

  test('falls back to income-minus-expenses if no explicit Net Profit/Loss row is found', () => {
    const tree = [
      row('Total Income', ['Total Income', '10,000.00'], 'SummaryRow'),
      row('Total Expenses', ['Total Expenses', '4,000.00'], 'SummaryRow'),
    ];
    expect(_buildProfitAndLoss(tree)).toEqual({ income: 10000, expenses: 4000, netProfit: 6000, netMargin: 0.6 });
  });

  test('an empty report tree yields all zeros, not a crash (no division by zero income)', () => {
    expect(_buildProfitAndLoss([])).toEqual({ income: 0, expenses: 0, netProfit: 0, netMargin: 0 });
  });
});

// Xero's real Bank Summary report is COLUMNAR, not "one section per account
// with labeled rows" — confirmed against a live response (see git history/PR
// description): one Header row spells out what each cell position means, then
// every bank account is a plain Row with values at those same positions,
// followed by a SummaryRow "Total" line. These fixtures mirror that exactly.
function bankSummaryHeader(...columns) { return { rowType: 'Header', cells: columns.map(cell) }; }
function bankSummaryAccountRow(...values) { return { rowType: 'Row', cells: values.map(cell) }; }

describe('xero/reports — _buildBankSummary (pure)', () => {
  test('reads column positions off the real Header row and extracts one row per account, plus totals', () => {
    const tree = [
      bankSummaryHeader('Bank Accounts', 'Opening Balance', 'Cash Received', 'Cash Spent', 'Closing Balance'),
      section('', [
        bankSummaryAccountRow('Business Bank Account', '1,000.00', '5,000.00', '(2,000.00)', '4,000.00'),
        bankSummaryAccountRow('Savings Account', '500.00', '100.00', '(50.00)', '550.00'),
        row('Total', ['Total', '1,500.00', '5,100.00', '(2,050.00)', '4,550.00'], 'SummaryRow'),
      ]),
    ];
    const result = _buildBankSummary(tree);
    expect(result.accounts).toEqual([
      { name: 'Business Bank Account', cashReceived: 5000, cashSpent: 2000, closingBalance: 4000 },
      { name: 'Savings Account', cashReceived: 100, cashSpent: 50, closingBalance: 550 },
    ]);
    expect(result).toMatchObject({ cashIn: 5100, cashOut: 2050, net: 3050 });
  });

  test('the report-wide "Total" SummaryRow is excluded from the account list (cashIn/cashOut are summed independently, not read off it)', () => {
    const tree = [
      bankSummaryHeader('Bank Accounts', 'Opening Balance', 'Cash Received', 'Cash Spent', 'Closing Balance'),
      section('', [
        bankSummaryAccountRow('Business Bank Account', '100.00', '100.00', '(50.00)', '50.00'),
        row('Total', ['Total', '100.00', '100.00', '(50.00)', '50.00'], 'SummaryRow'),
      ]),
    ];
    const result = _buildBankSummary(tree);
    expect(result.accounts).toHaveLength(1);
  });

  test('no Header row (unexpected report shape) — zeroed totals, not a crash', () => {
    expect(_buildBankSummary([section('', [row('Something', ['Something', '1.00'])])]))
      .toEqual({ accounts: [], cashIn: 0, cashOut: 0, net: 0 });
  });

  test('no sections — zeroed totals, empty account list', () => {
    expect(_buildBankSummary([])).toEqual({ accounts: [], cashIn: 0, cashOut: 0, net: 0 });
  });
});

// Xero's Report endpoints (ProfitAndLoss, BankSummary) reject any
// fromDate/toDate pair more than 365 days apart — confirmed via a live 400
// ValidationException triggered by the "All Time" preset. These two pure
// helpers are what keeps getProfitAndLoss/getBankSummary inside that limit.
describe('xero/reports — _splitIntoReportWindows (pure)', () => {
  test('a range within the limit is a single window, unchanged', () => {
    expect(_splitIntoReportWindows('2026-01-01', '2026-01-31')).toEqual([
      { from: '2026-01-01', to: '2026-01-31' },
    ]);
  });

  test('a range of exactly 365 days is still a single window', () => {
    const windows = _splitIntoReportWindows('2026-01-01', '2026-12-31');
    expect(windows).toHaveLength(1);
    expect(windows[0]).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });

  test('a wider range splits into consecutive <=365-day windows covering every day exactly once, no gaps or overlaps', () => {
    const windows = _splitIntoReportWindows('2024-01-01', '2026-08-10', 365);
    expect(windows[0].from).toBe('2024-01-01');
    expect(windows[windows.length - 1].to).toBe('2026-08-10');
    for (let i = 1; i < windows.length; i++) {
      // the next window starts exactly the day after the previous one ends
      const prevEnd = new Date(windows[i - 1].to + 'T00:00:00Z');
      const nextStart = new Date(windows[i].from + 'T00:00:00Z');
      expect(nextStart - prevEnd).toBe(24 * 60 * 60 * 1000);
    }
  });

  test('a single-day range is a single one-day window, not zero windows', () => {
    expect(_splitIntoReportWindows('2026-08-10', '2026-08-10')).toEqual([
      { from: '2026-08-10', to: '2026-08-10' },
    ]);
  });
});

describe('xero/reports — _clampReportFrom (pure)', () => {
  test('a recent range is left untouched', () => {
    expect(_clampReportFrom('2026-01-01', '2026-08-10')).toBe('2026-01-01');
  });

  test('an ultra-wide range (e.g. the "All Time" preset\'s anchor) is clamped to 10 years back from "to"', () => {
    expect(_clampReportFrom('2000-01-01', '2026-08-10')).toBe('2016-01-01');
  });
});

describe('xero/reports — getSummary caching', () => {
  let reports, tokenCacheMock, getOrganisations, getInvoices;

  beforeEach(() => {
    jest.resetModules();

    getOrganisations = jest.fn().mockResolvedValue({ body: { organisations: [{ name: 'Org', baseCurrency: 'SGD' }] } });
    getInvoices      = jest.fn().mockResolvedValue({ body: { invoices: [] } });

    jest.doMock('xero-node', () => ({
      AccountingApi: jest.fn().mockImplementation(() => ({ getOrganisations, getInvoices })),
    }));
    jest.doMock('../utils/token-cache', () => ({
      forUser: jest.fn(() => ({ getValidToken: jest.fn().mockResolvedValue('fake-token') })),
    }));

    reports = require('./reports');
  });

  test('fetches from Xero on first call, serves from cache on a second call within the TTL', async () => {
    await reports.getSummary('user-1', 'tenant-1');
    await reports.getSummary('user-1', 'tenant-1');
    expect(getOrganisations).toHaveBeenCalledTimes(1);
    expect(getInvoices).toHaveBeenCalledTimes(1);
  });

  test('the cached response is marked cached:true, the fresh one is not', async () => {
    const first  = await reports.getSummary('user-1', 'tenant-1');
    const second = await reports.getSummary('user-1', 'tenant-1');
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
  });

  test('force:true bypasses the cache even within the TTL', async () => {
    await reports.getSummary('user-1', 'tenant-1');
    await reports.getSummary('user-1', 'tenant-1', { force: true });
    expect(getOrganisations).toHaveBeenCalledTimes(2);
  });

  test('different tenants (or users) never share a cache entry', async () => {
    await reports.getSummary('user-1', 'tenant-1');
    await reports.getSummary('user-1', 'tenant-2');
    await reports.getSummary('user-2', 'tenant-1');
    expect(getOrganisations).toHaveBeenCalledTimes(3);
  });

  test('clearCache forces the next call to refetch, and only for that user', async () => {
    await reports.getSummary('user-1', 'tenant-1');
    await reports.getSummary('user-2', 'tenant-1');
    reports.clearCache('user-1');

    await reports.getSummary('user-1', 'tenant-1'); // refetches
    await reports.getSummary('user-2', 'tenant-1'); // still cached
    expect(getOrganisations).toHaveBeenCalledTimes(3); // 2 initial + 1 refetch, not 4
  });
});

describe('xero/reports — getPeriod / getAccounts / getBankAccounts / getContacts caching', () => {
  let reports, getInvoices, getAccounts, getContacts, getOrganisations;

  beforeEach(() => {
    jest.resetModules();
    getInvoices = jest.fn().mockResolvedValue({ body: { invoices: [] } });
    getAccounts = jest.fn().mockResolvedValue({ body: { accounts: [] } });
    getContacts = jest.fn().mockResolvedValue({ body: { contacts: [] } });
    getOrganisations = jest.fn().mockResolvedValue({ body: { organisations: [{ financialYearEndMonth: 3, financialYearEndDay: 31 }] } });

    jest.doMock('xero-node', () => ({
      AccountingApi: jest.fn().mockImplementation(() => ({ getInvoices, getAccounts, getContacts, getOrganisations })),
    }));
    jest.doMock('../utils/token-cache', () => ({
      forUser: jest.fn(() => ({ getValidToken: jest.fn().mockResolvedValue('fake-token') })),
    }));

    reports = require('./reports');
  });

  test('getPeriod passes the computed Xero `where` filter through to getInvoices', async () => {
    await reports.getPeriod('user-1', 'tenant-1', { preset: 'custom', from: '2026-01-01', to: '2026-01-31', timezone: 'UTC' });
    const whereArg = getInvoices.mock.calls[0][2];
    expect(whereArg).toBe('Date >= DateTime(2026,1,1) && Date < DateTime(2026,2,1)');
  });

  test('getPeriod caches per distinct range — a different preset refetches, the same one does not', async () => {
    await reports.getPeriod('user-1', 'tenant-1', { preset: 'month', timezone: 'UTC' });
    await reports.getPeriod('user-1', 'tenant-1', { preset: 'month', timezone: 'UTC' }); // same range, cached
    await reports.getPeriod('user-1', 'tenant-1', { preset: 'year', timezone: 'UTC' });   // different range, refetches
    expect(getInvoices).toHaveBeenCalledTimes(2);
  });

  test('getPeriod only looks up the org (for fiscal-year-end) on the "year" preset, not the others', async () => {
    await reports.getPeriod('user-1', 'tenant-1', { preset: 'month', timezone: 'UTC' });
    await reports.getPeriod('user-1', 'tenant-1', { preset: 'week', timezone: 'UTC' });
    expect(getOrganisations).not.toHaveBeenCalled();

    await reports.getPeriod('user-1', 'tenant-1', { preset: 'year', timezone: 'UTC' });
    expect(getOrganisations).toHaveBeenCalledTimes(1);
  });

  test('getPeriod\'s "year" preset applies the org\'s real fiscal year end to the Xero filter, not Jan 1', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-12T10:00:00Z'));
    // mocked org above has financialYearEndMonth: 3, day: 31 — fiscal year
    // starting Apr 1 2026, not the calendar-year Jan 1 2026.
    await reports.getPeriod('user-1', 'tenant-1', { preset: 'year', timezone: 'UTC' });
    const whereArg = getInvoices.mock.calls[0][2];
    expect(whereArg).toBe('Date >= DateTime(2026,4,1) && Date < DateTime(2026,8,13)');
    jest.useRealTimers();
  });

  test('getAccounts and getBankAccounts cache independently of getSummary/getPeriod', async () => {
    await reports.getAccounts('user-1', 'tenant-1');
    await reports.getAccounts('user-1', 'tenant-1');
    await reports.getBankAccounts('user-1', 'tenant-1');
    expect(getAccounts).toHaveBeenCalledTimes(2); // one per distinct cache key (accounts vs bank)
  });

  test('getContacts fetches once, then serves from cache', async () => {
    await reports.getContacts('user-1', 'tenant-1');
    await reports.getContacts('user-1', 'tenant-1');
    expect(getContacts).toHaveBeenCalledTimes(1);
  });

  test('clearCache also clears period/accounts/bank/contacts entries for that user', async () => {
    await reports.getPeriod('user-1', 'tenant-1', { preset: 'month', timezone: 'UTC' });
    await reports.getAccounts('user-1', 'tenant-1');
    await reports.getContacts('user-1', 'tenant-1');
    reports.clearCache('user-1');

    await reports.getPeriod('user-1', 'tenant-1', { preset: 'month', timezone: 'UTC' });
    await reports.getAccounts('user-1', 'tenant-1');
    await reports.getContacts('user-1', 'tenant-1');
    expect(getInvoices).toHaveBeenCalledTimes(2);
    expect(getAccounts).toHaveBeenCalledTimes(2);
    expect(getContacts).toHaveBeenCalledTimes(2);
  });
});

describe('xero/reports — getBankTransactions / getProfitAndLoss / getBankSummary caching', () => {
  let reports, getBankTransactions, getPayments, getReportProfitAndLoss, getReportBankSummary;

  beforeEach(() => {
    jest.resetModules();
    getBankTransactions   = jest.fn().mockResolvedValue({ body: { bankTransactions: [] } });
    getPayments            = jest.fn().mockResolvedValue({ body: { payments: [] } });
    getReportProfitAndLoss = jest.fn().mockResolvedValue({ body: { reports: [{ rows: [] }] } });
    getReportBankSummary   = jest.fn().mockResolvedValue({ body: { reports: [{ rows: [] }] } });

    jest.doMock('xero-node', () => ({
      AccountingApi: jest.fn().mockImplementation(() => ({ getBankTransactions, getPayments, getReportProfitAndLoss, getReportBankSummary })),
    }));
    jest.doMock('../utils/token-cache', () => ({
      forUser: jest.fn(() => ({ getValidToken: jest.fn().mockResolvedValue('fake-token') })),
    }));

    reports = require('./reports');
  });

  test('getBankTransactions filters by the given account and caches per account', async () => {
    await reports.getBankTransactions('user-1', 'tenant-1', 'acct-1');
    await reports.getBankTransactions('user-1', 'tenant-1', 'acct-1'); // cached
    await reports.getBankTransactions('user-1', 'tenant-1', 'acct-2'); // different account, refetches
    expect(getBankTransactions).toHaveBeenCalledTimes(2);
    expect(getBankTransactions.mock.calls[0][2]).toBe('BankAccount.AccountID==Guid("acct-1")');
  });

  // A bank account's real cash movement isn't fully captured by
  // BankTransactions alone — paying a bill or receiving a customer payment
  // against an invoice creates a Payment record instead (confirmed against
  // live data, never appears in getBankTransactions at all).
  test('getBankTransactions also fetches Payments for the same account and merges both into one date-sorted statement', async () => {
    getBankTransactions.mockResolvedValue({ body: { bankTransactions: [
      { bankTransactionID: 'bt1', type: 'RECEIVE', contact: { name: 'Customer Co' }, date: '2026-08-05', total: 500 },
    ] } });
    getPayments.mockResolvedValue({ body: { payments: [
      { paymentID: 'p1', paymentType: 'ACCPAYPAYMENT', invoice: { invoiceNumber: 'Payroll - Jul', contact: { name: 'Chua Jia Hern' } }, date: '2026-08-07', amount: 2983 },
    ] } });

    const { transactions } = await reports.getBankTransactions('user-1', 'tenant-1', 'acct-1');

    expect(getPayments.mock.calls[0][2]).toBe('Account.AccountID==Guid("acct-1")');
    expect(transactions.map(t => t.transactionId)).toEqual(['p1', 'bt1']); // newest (Aug 7) first
    expect(transactions[0]).toMatchObject({ type: 'Money Out', contact: 'Chua Jia Hern', total: 2983, source: 'payment' });
    expect(transactions[1]).toMatchObject({ type: 'Money In', contact: 'Customer Co', total: 500, source: 'bank' });
  });

  // Xero's real shape for "valid token, missing scope" — confirmed live
  // requesting Payments without accounting.payments.read — is xero-node
  // throwing a raw STRING (not an Error, no .message) holding the
  // JSON-stringified response, a 401 with a WWW-Authenticate:
  // insufficient_scope header. Using the exact real shape here (not a
  // convenient object mock) is what would have caught this failing before
  // it shipped.
  test('getBankTransactions falls back to bank-transactions-only if Payments comes back insufficient_scope (not yet reconnected under accounting.payments.read)', async () => {
    getBankTransactions.mockResolvedValue({ body: { bankTransactions: [
      { bankTransactionID: 'bt1', type: 'RECEIVE', date: '2026-08-05', total: 500 },
    ] } });
    getPayments.mockRejectedValue(JSON.stringify({ response: { statusCode: 401, headers: { 'www-authenticate': 'insufficient_scope' }, body: {} } }));

    const { transactions } = await reports.getBankTransactions('user-1', 'tenant-1', 'acct-1');
    expect(transactions).toHaveLength(1);
    expect(transactions[0].transactionId).toBe('bt1');
  });

  test('getBankTransactions also falls back on a bare 403 (kept as a defensive fallback shape)', async () => {
    getBankTransactions.mockResolvedValue({ body: { bankTransactions: [] } });
    getPayments.mockRejectedValue({ response: { statusCode: 403, body: {} } });
    const { transactions } = await reports.getBankTransactions('user-1', 'tenant-1', 'acct-1');
    expect(transactions).toEqual([]);
  });

  test('getBankTransactions still throws on a real failure — a plain 401 with no insufficient_scope header is NOT treated as a missing scope', async () => {
    getPayments.mockRejectedValue({ response: { statusCode: 401, headers: {}, body: {} } }); // e.g. an actually invalid/expired token
    await expect(reports.getBankTransactions('user-1', 'tenant-1', 'acct-1')).rejects.toBeTruthy();
  });

  test('getBankTransactions still throws on a real 500 Payments failure, not a silent empty result', async () => {
    getPayments.mockRejectedValue({ response: { statusCode: 500, body: {} } });
    await expect(reports.getBankTransactions('user-1', 'tenant-1', 'acct-1')).rejects.toBeTruthy();
  });

  test('getProfitAndLoss passes from/to through and caches per date range', async () => {
    await reports.getProfitAndLoss('user-1', 'tenant-1', { from: '2026-01-01', to: '2026-01-31' });
    await reports.getProfitAndLoss('user-1', 'tenant-1', { from: '2026-01-01', to: '2026-01-31' }); // cached
    await reports.getProfitAndLoss('user-1', 'tenant-1', { from: '2026-02-01', to: '2026-02-28' }); // different range
    expect(getReportProfitAndLoss).toHaveBeenCalledTimes(2);
    expect(getReportProfitAndLoss).toHaveBeenCalledWith('tenant-1', '2026-01-01', '2026-01-31');
  });

  test('getBankSummary passes from/to through and caches per date range', async () => {
    await reports.getBankSummary('user-1', 'tenant-1', { from: '2026-01-01', to: '2026-01-31' });
    await reports.getBankSummary('user-1', 'tenant-1', { from: '2026-01-01', to: '2026-01-31' });
    expect(getReportBankSummary).toHaveBeenCalledTimes(1);
  });

  // Xero's Report API 400s on a >365-day range — a range wider than that
  // must never reach api.getReportProfitAndLoss/getReportBankSummary in one
  // call; every call this mock records must itself span <=365 days.
  test('getProfitAndLoss splits a >365-day range into multiple calls, each within the limit, and sums the results', async () => {
    getReportProfitAndLoss
      .mockResolvedValueOnce({ body: { reports: [{ rows: [
        row('Total Income', ['Total Income', '10,000.00'], 'SummaryRow'),
        row('Total Expenses', ['Total Expenses', '4,000.00'], 'SummaryRow'),
      ] }] } })
      .mockResolvedValueOnce({ body: { reports: [{ rows: [
        row('Total Income', ['Total Income', '5,000.00'], 'SummaryRow'),
        row('Total Expenses', ['Total Expenses', '1,000.00'], 'SummaryRow'),
      ] }] } });

    const result = await reports.getProfitAndLoss('user-1', 'tenant-1', { from: '2024-01-01', to: '2026-08-10' });

    expect(getReportProfitAndLoss.mock.calls.length).toBeGreaterThan(1);
    for (const [, callFrom, callTo] of getReportProfitAndLoss.mock.calls) {
      const days = (new Date(callTo) - new Date(callFrom)) / 86400000;
      expect(days).toBeLessThanOrEqual(365);
    }
    expect(result).toMatchObject({ income: 15000, expenses: 5000, netProfit: 10000 });
  });

  test('getBankSummary merges per-window results: cash received/spent add up across windows, closing balance keeps only the most recent window\'s value', async () => {
    const header = row('Bank Accounts', ['Bank Accounts', 'Opening Balance', 'Cash Received', 'Cash Spent', 'Closing Balance'], 'Header');
    getReportBankSummary
      .mockResolvedValueOnce({ body: { reports: [{ rows: [
        header, row('Aspire SGD account', ['Aspire SGD account', '0.00', '1,000.00', '(200.00)', '800.00']),
      ] }] } })
      .mockResolvedValueOnce({ body: { reports: [{ rows: [
        header, row('Aspire SGD account', ['Aspire SGD account', '800.00', '500.00', '(300.00)', '1,000.00']),
      ] }] } });

    const result = await reports.getBankSummary('user-1', 'tenant-1', { from: '2024-01-01', to: '2026-08-10' });

    expect(getReportBankSummary.mock.calls.length).toBeGreaterThan(1);
    expect(result.accounts).toEqual([
      { name: 'Aspire SGD account', cashReceived: 1500, cashSpent: 500, closingBalance: 1000 }, // 1000 (2nd/latest window), not 800+1000
    ]);
    expect(result).toMatchObject({ cashIn: 1500, cashOut: 500, net: 1000 });
  });

  test('an ultra-wide range (e.g. "All Time") is clamped before windowing — never generates decades of near-empty calls', async () => {
    await reports.getProfitAndLoss('user-1', 'tenant-1', { from: '2000-01-01', to: '2026-08-10' });
    // 10-year lookback cap → ~10 windows, nowhere near the ~27 a literal 2000-2026 split would need.
    expect(getReportProfitAndLoss.mock.calls.length).toBeLessThanOrEqual(11);
    expect(getReportProfitAndLoss.mock.calls[0][1]).toBe('2016-01-01'); // clamped from, not 2000-01-01
  });

  test('force:true bypasses the cache for all three', async () => {
    await reports.getBankTransactions('user-1', 'tenant-1', 'acct-1');
    await reports.getBankTransactions('user-1', 'tenant-1', 'acct-1', { force: true });
    expect(getBankTransactions).toHaveBeenCalledTimes(2);
  });

  test('clearCache clears bank-transaction/P&L/bank-summary entries too', async () => {
    await reports.getBankTransactions('user-1', 'tenant-1', 'acct-1');
    await reports.getProfitAndLoss('user-1', 'tenant-1', { from: '2026-01-01', to: '2026-01-31' });
    reports.clearCache('user-1');

    await reports.getBankTransactions('user-1', 'tenant-1', 'acct-1');
    await reports.getProfitAndLoss('user-1', 'tenant-1', { from: '2026-01-01', to: '2026-01-31' });
    expect(getBankTransactions).toHaveBeenCalledTimes(2);
    expect(getReportProfitAndLoss).toHaveBeenCalledTimes(2);
  });
});

// ── Budget vs Actual ─────────────────────────────────────────────────────────
// Fixtures below are the REAL shapes returned by a live Xero org (Nexsoss Pte
// Ltd, FY Apr 2026–Mar 2027), captured from a read-only probe — including the
// two traps that make the endpoints easy to misalign:
//   * ProfitAndLoss returns columns NEWEST-first; BudgetSummary OLDEST-first.
//   * BudgetSummary's header first cell is "Account"; ProfitAndLoss's is "".
// The expected numbers are the ones printed on the org's own Xero PDF.
describe('xero/reports — Budget vs Actual (pure)', () => {
  const FY_END = { month: 3, day: 31 };
  const TODAY  = { year: 2026, month: 8, day: 17 }; // mid-August: Aug is NOT complete

  // 12 monthly values, oldest-first (Apr 2026 → Mar 2027), exactly as
  // BudgetSummary(date=2026-04-30, periods=12) returned them.
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
  const bRow  = (label, vals, rowType = 'Row') => row(label, [label, ...vals.map(money)], rowType);
  const pick  = label => BUDGET.find(([l]) => l === label)[1];

  const budgetRows = [
    { rowType: 'Header', cells: ['Account','Apr-26','May-26','Jun-26','Jul-26','Aug-26','Sep-26','Oct-26','Nov-26','Dec-26','Jan-27','Feb-27','Mar-27'].map(cell) },
    section('Income', [
      bRow('Sales - Implementation', pick('Sales - Implementation')),
      bRow('Sales - Maintenance (Recurring)', pick('Sales - Maintenance (Recurring)')),
      bRow('Total Income', pick('Total Income'), 'SummaryRow'),
    ]),
    section('Less Cost of Sales', [
      bRow('Cost of Goods Sold', pick('Cost of Goods Sold')),
      bRow('Total Cost of Sales', pick('Total Cost of Sales'), 'SummaryRow'),
    ]),
    section('', [bRow('Gross Profit', pick('Gross Profit'), 'SummaryRow')]),
    section('Other Income', [
      bRow('Other Income - Grant', pick('Other Income - Grant')),
      bRow('Total Other Income', pick('Total Other Income'), 'SummaryRow'),
    ]),
    section('Less Operating Expenses', [
      bRow('Bank Fees', pick('Bank Fees')),
      bRow('Consulting & Accounting', pick('Consulting & Accounting')),
      bRow('Insurance', pick('Insurance')),
      bRow('Legal expenses', pick('Legal expenses')),
      bRow('Subscriptions', pick('Subscriptions')),
      bRow('Wages and Salaries', pick('Wages and Salaries')),
      bRow('Total Operating Expenses', pick('Total Operating Expenses'), 'SummaryRow'),
    ]),
    section('', [bRow('Net Profit', pick('Net Profit'), 'SummaryRow')]),
  ];

  // ProfitAndLoss(anchor Mar-2027, periods=11) — NEWEST-first, and it omits every
  // account with no actual transactions (no Cost of Sales, no overheads at all).
  const pnlNewestFirst = {
    'Sales - Implementation':          [0,0,0,0,0,0,0,37000,-17670,0,0,0],
    'Sales - Maintenance (Recurring)': [0,0,0,0,0,0,0,15000,75000,0,0,0],
    'Total Income':                    [0,0,0,0,0,0,0,52000,57330,0,0,0],
    'Gross Profit':                    [0,0,0,0,0,0,0,52000,57330,0,0,0],
    'Wages and Salaries':              [0,0,0,0,0,0,0,0,24603,0,0,0],
    'Total Operating Expenses':        [0,0,0,0,0,0,0,0,24603,0,0,0],
    'Net Profit':                      [0,0,0,0,0,0,0,52000,32727,0,0,0],
  };
  const p = label => row(label, [label, ...pnlNewestFirst[label].map(money)]);
  const pnlRows = [
    { rowType: 'Header', cells: ['','31 Mar 27','28 Feb 27','31 Jan 27','31 Dec 26','30 Nov 26','31 Oct 26','30 Sep 26','31 Aug 26','31 Jul 26','30 Jun 26','31 May 26','30 Apr 26'].map(cell) },
    section('Income', [p('Sales - Implementation'), p('Sales - Maintenance (Recurring)'), row('Total Income', ['Total Income', ...pnlNewestFirst['Total Income'].map(money)], 'SummaryRow')]),
    section('', [p('Gross Profit')]),
    section('Less Operating Expenses', [p('Wages and Salaries'), row('Total Operating Expenses', ['Total Operating Expenses', ...pnlNewestFirst['Total Operating Expenses'].map(money)], 'SummaryRow')]),
    section('', [p('Net Profit')]),
  ];

  const months = _fiscalYearMonths(TODAY, FY_END);
  const build  = () => _buildBudgetVariance({ budgetRows, pnlRows, months, actualThroughIdx: _actualThroughIndex(months, TODAY) });
  const find   = (rows, label) => rows.find(r => r.label === label);

  test('the fiscal year runs Apr 2026 → Mar 2027, not Jan → Dec', () => {
    expect(months).toHaveLength(12);
    expect(months[0]).toMatchObject({ key: '2026-04', label: 'Apr 2026', startISO: '2026-04-01', endISO: '2026-04-30' });
    expect(months[11]).toMatchObject({ key: '2027-03', label: 'Mar 2027', endISO: '2027-03-31' });
  });

  test('a part-way-through month counts as budget, not actual', () => {
    // 17 Aug: Jul (index 3) is the last COMPLETE month.
    expect(_actualThroughIndex(months, TODAY)).toBe(3);
    // On the 1st of a month the previous month has just closed...
    expect(_actualThroughIndex(months, { year: 2026, month: 8, day: 1 })).toBe(3);
    // ...and on the final day, that month itself still isn't complete.
    expect(_actualThroughIndex(months, { year: 2026, month: 8, day: 31 })).toBe(3);
    // Before any month of the FY has closed at all.
    expect(_actualThroughIndex(months, { year: 2026, month: 4, day: 15 })).toBe(-1);
  });

  test('ProfitAndLoss columns are reversed into month order; BudgetSummary are not', () => {
    const actual = _rowValuesByLabel(pnlRows, { reverse: true });
    // Jul 2026 = index 3. Newest-first the same value sits at index 8.
    expect(actual.get('Sales - Implementation')[3]).toBe(-17670);
    expect(actual.get('Sales - Implementation')[4]).toBe(37000); // Aug
    const budget = _rowValuesByLabel(budgetRows);
    expect(budget.get('Cost of Goods Sold')[4]).toBe(7330); // Aug, already oldest-first
  });

  test('the skeleton keeps Xero\'s reading order, with floating summary lines', () => {
    const skel = _skeletonFromBudget(budgetRows);
    expect(skel.slice(0, 4)).toEqual([
      { kind: 'section',  label: 'Income' },
      { kind: 'account',  label: 'Sales - Implementation' },
      { kind: 'account',  label: 'Sales - Maintenance (Recurring)' },
      { kind: 'subtotal', label: 'Total Income' },
    ]);
    // Gross Profit / Net Profit live in untitled sections -> 'summary', not 'subtotal'.
    expect(find(skel, 'Gross Profit').kind).toBe('summary');
    expect(find(skel, 'Net Profit').kind).toBe('summary');
  });

  test('every row matches the org\'s own Xero PDF, actual months and budget months', () => {
    const { rows } = build();
    // Apr–Jul come from the P&L (actuals), Aug–Mar from BudgetSummary.
    expect(find(rows, 'Sales - Implementation').cells)
      .toEqual([0, 0, 0, -17670, 37000, 0, 0, 0, 54500, 0, 27000, 27500]);
    expect(find(rows, 'Total Income').cells)
      .toEqual([0, 0, 0, 57330, 52000, 0, 0, 0, 54500, 0, 37000, 42500]);
    expect(find(rows, 'Net Profit').cells)
      .toEqual([0, 0, 0, 32727, 17615, -11418, -19752, -19752, 34748, -20852, 1215, 6415]);
    // Budget-only accounts survive even though the P&L never mentions them.
    expect(find(rows, 'Cost of Goods Sold').cells[4]).toBe(7330);
    expect(find(rows, 'Other Income - Grant').cells[5]).toBe(16667);
  });

  test('row totals reproduce the PDF\'s blended TOTAL column', () => {
    const { rows } = build();
    expect(find(rows, 'Sales - Implementation').total).toBe(128330);
    expect(find(rows, 'Sales - Maintenance (Recurring)').total).toBe(115000);
    expect(find(rows, 'Total Income').total).toBe(243330);
    expect(find(rows, 'Cost of Goods Sold').total).toBe(28040);
    expect(find(rows, 'Gross Profit').total).toBe(215290);
    expect(find(rows, 'Other Income - Grant').total).toBe(49999);
    expect(find(rows, 'Total Operating Expenses').total).toBe(244343);
    expect(find(rows, 'Net Profit').total).toBe(20946);
  });

  test('variance covers elapsed months only, and a zero budget yields null not Infinity', () => {
    const { rows } = build();
    const net = find(rows, 'Net Profit');
    expect(net.actualToDate).toBe(32727);            // Apr–Jul actual
    expect(net.budgetToDate).toBe(32727);            // this org back-filled elapsed budget from actuals
    expect(net.variance).toBe(0);
    // Nothing budgeted for Apr–Jul on this line, so a percentage is meaningless.
    expect(find(rows, 'Bank Fees').budgetToDate).toBe(0);
    expect(find(rows, 'Bank Fees').variancePct).toBeNull();
    // A real difference does produce a percentage.
    const cogs = find(rows, 'Cost of Goods Sold');
    expect(cogs.variancePct === null || Number.isFinite(cogs.variancePct)).toBe(true);
  });

  test('KPIs split the year at the actual/budget boundary', () => {
    const { kpis } = build();
    expect(kpis).toEqual({
      monthsElapsed: 4, monthsTotal: 12,
      ytdActualNet:  32727,
      restOfYearNet: 20946 - 32727, // budget Aug–Mar
      forecastNet:   20946,
    });
  });

  test('an account with actuals but no budget is appended, never dropped', () => {
    const withOrphan = [...pnlRows, section('Less Operating Expenses', [
      row('Surprise Expense', ['Surprise Expense', ...Array(12).fill('0.00').map((v, i) => (i === 8 ? '99.00' : v))]),
    ])];
    const { rows } = _buildBudgetVariance({ budgetRows, pnlRows: withOrphan, months, actualThroughIdx: 3 });
    const orphan = find(rows, 'Surprise Expense');
    expect(orphan).toBeDefined();
    expect(orphan.cells[3]).toBe(99); // Jul, after the newest-first reversal
    expect(find(rows, 'Other (actuals only, not budgeted)').kind).toBe('section');
  });

  test('an empty pair of reports yields no rows and zeroed KPIs, not a crash', () => {
    const out = _buildBudgetVariance({ budgetRows: [], pnlRows: [], months, actualThroughIdx: 3 });
    expect(out.rows).toEqual([]);
    expect(out.kpis.forecastNet).toBe(0);
  });
});

// ── Budget Variance report ───────────────────────────────────────────────────
// Asserted against the org's own Xero "Budget Variance" PDF (for the month ended
// 31 Aug 2026). Note this report compares the CURRENT, part-elapsed month using
// the actuals booked so far — the opposite of the monthly grid, which shows the
// current month as budget. Both PDFs came from the same day and disagree on that
// point, because Xero treats the two reports differently.
describe('xero/reports — Budget Variance per month (pure)', () => {
  const { _variancePct } = require('./reports');

  test('variance % divides by the ABSOLUTE budget, keeping Xero\'s sign', () => {
    // Sep gross profit: nil actual against a budget of -1,030 reads +100%, not -100%.
    expect(_variancePct(1030, -1030)).toBeCloseTo(1, 10);
    expect(_variancePct(-7330, 7330)).toBeCloseTo(-1, 10);
    // 34,385 over a 17,615 budget = the PDF's 195.20%.
    expect(_variancePct(34385, 17615) * 100).toBeCloseTo(195.20, 2);
    // 7,330 over 44,670 = the PDF's 16.41%.
    expect(_variancePct(7330, 44670) * 100).toBeCloseTo(16.41, 2);
  });

  test('a nil budget yields null, never Infinity or NaN', () => {
    expect(_variancePct(500, 0)).toBeNull();
    expect(_variancePct(0, 0)).toBeNull();
    expect(Number.isFinite(_variancePct(1, -0.5))).toBe(true);
  });

  test('every Aug and Sep 2026 figure matches the Budget Variance PDF', () => {
    const FY_END = { month: 3, day: 31 };
    const TODAY  = { year: 2026, month: 8, day: 17 };
    const months = _fiscalYearMonths(TODAY, FY_END);

    // Minimal fixtures: only the rows the PDF shows figures for. Budget is
    // oldest-first; the P&L is newest-first, as each endpoint really returns.
    const oldest = (augVal, sepVal) => { const a = Array(12).fill(0); a[4] = augVal; a[5] = sepVal; return a; };
    const newest = (augVal, sepVal) => { const a = Array(12).fill(0); a[7] = augVal; a[6] = sepVal; return a; };
    const money  = v => v.toFixed(2);
    const bRow   = (l, vals, t = 'Row') => row(l, [l, ...vals.map(money)], t);

    const budgetRows = [
      { rowType: 'Header', cells: ['Account', ...months.map(m => m.label)].map(cell) },
      section('Income', [
        bRow('Sales - Implementation', oldest(37000, 0)),
        bRow('Total Income', oldest(52000, 0), 'SummaryRow'),
      ]),
      section('Less Cost of Sales', [bRow('Cost of Goods Sold', oldest(7330, 1030))]),
      section('', [bRow('Gross Profit', oldest(44670, -1030), 'SummaryRow')]),
      section('Other Income', [bRow('Other Income - Grant', oldest(0, 16667))]),
      section('Less Operating Expenses', [
        bRow('Bank Fees', oldest(10, 10)),
        bRow('Wages and Salaries', oldest(24603, 24603)),
        bRow('Total Operating Expenses', oldest(27055, 27055), 'SummaryRow'),
      ]),
      section('', [bRow('Net Profit', oldest(17615, -11418), 'SummaryRow')]),
    ];
    const pnlRows = [
      { rowType: 'Header', cells: ['', ...months.map(m => m.label).reverse()].map(cell) },
      section('Income', [
        bRow('Sales - Implementation', newest(37000, 0)),
        bRow('Total Income', newest(52000, 0), 'SummaryRow'),
      ]),
      section('', [bRow('Gross Profit', newest(52000, 0), 'SummaryRow')]),
      section('', [bRow('Net Profit', newest(52000, 0), 'SummaryRow')]),
    ];

    const { rows } = _buildBudgetVariance({ budgetRows, pnlRows, months, actualThroughIdx: 3 });
    const at = (label, monthIdx) => rows.find(r => r.label === label).monthly[monthIdx];
    const AUG = 4, SEP = 5;

    // ---- August: actuals ARE compared, even though August hasn't closed ----
    expect(at('Sales - Implementation', AUG)).toMatchObject({ actual: 37000, budget: 37000, variance: 0 });
    expect(at('Total Income', AUG)).toMatchObject({ actual: 52000, budget: 52000, variance: 0 });
    expect(at('Cost of Goods Sold', AUG)).toMatchObject({ actual: 0, budget: 7330, variance: -7330 });
    expect(at('Cost of Goods Sold', AUG).variancePct * 100).toBeCloseTo(-100.00, 2);
    expect(at('Gross Profit', AUG)).toMatchObject({ actual: 52000, budget: 44670, variance: 7330 });
    expect(at('Gross Profit', AUG).variancePct * 100).toBeCloseTo(16.41, 2);
    expect(at('Wages and Salaries', AUG)).toMatchObject({ actual: 0, budget: 24603, variance: -24603 });
    expect(at('Total Operating Expenses', AUG)).toMatchObject({ actual: 0, budget: 27055, variance: -27055 });
    expect(at('Net Profit', AUG)).toMatchObject({ actual: 52000, budget: 17615, variance: 34385 });
    expect(at('Net Profit', AUG).variancePct * 100).toBeCloseTo(195.20, 2);

    // ---- September: nothing actual yet, so variance is the budget inverted ----
    expect(at('Other Income - Grant', SEP)).toMatchObject({ actual: 0, budget: 16667, variance: -16667 });
    expect(at('Other Income - Grant', SEP).variancePct * 100).toBeCloseTo(-100.00, 2);
    expect(at('Gross Profit', SEP)).toMatchObject({ actual: 0, budget: -1030, variance: 1030 });
    expect(at('Gross Profit', SEP).variancePct * 100).toBeCloseTo(100.00, 2); // positive, per Xero
    expect(at('Net Profit', SEP)).toMatchObject({ actual: 0, budget: -11418, variance: 11418 });
    expect(at('Net Profit', SEP).variancePct * 100).toBeCloseTo(100.00, 2);
  });

  test('monthly[] covers all 12 months, so any month can be compared', () => {
    const months = _fiscalYearMonths({ year: 2026, month: 8, day: 17 }, { month: 3, day: 31 });
    const budgetRows = [
      { rowType: 'Header', cells: ['Account', ...months.map(m => m.label)].map(cell) },
      section('Income', [row('X', ['X', ...Array(12).fill('1.00')])]),
    ];
    const { rows } = _buildBudgetVariance({ budgetRows, pnlRows: [], months, actualThroughIdx: 3 });
    expect(rows.find(r => r.label === 'X').monthly).toHaveLength(12);
  });
});
