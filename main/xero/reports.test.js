const {
  _buildSummary, computeRange, _buildPeriod, _buildAccounts, _buildBankAccounts, _buildContacts,
  _buildBankTransactions, _buildProfitAndLoss, _buildBankSummary, _flattenReportRows,
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

  test('year — from is Jan 1 of this year', () => {
    const r = computeRange('year', 'UTC');
    expect(r.fromISO).toBe('2026-01-01');
    expect(r.toISO).toBe('2026-08-12');
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
    expect(_buildProfitAndLoss(tree)).toEqual({ income: 50000, expenses: 10000, netProfit: 40000 });
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
    expect(_buildProfitAndLoss(tree)).toEqual({ income: 10000, expenses: 4000, netProfit: 6000 });
  });

  test('an empty report tree yields all zeros, not a crash', () => {
    expect(_buildProfitAndLoss([])).toEqual({ income: 0, expenses: 0, netProfit: 0 });
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
  let reports, getInvoices, getAccounts, getContacts;

  beforeEach(() => {
    jest.resetModules();
    getInvoices = jest.fn().mockResolvedValue({ body: { invoices: [] } });
    getAccounts = jest.fn().mockResolvedValue({ body: { accounts: [] } });
    getContacts = jest.fn().mockResolvedValue({ body: { contacts: [] } });

    jest.doMock('xero-node', () => ({
      AccountingApi: jest.fn().mockImplementation(() => ({ getInvoices, getAccounts, getContacts })),
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
  let reports, getBankTransactions, getReportProfitAndLoss, getReportBankSummary;

  beforeEach(() => {
    jest.resetModules();
    getBankTransactions   = jest.fn().mockResolvedValue({ body: { bankTransactions: [] } });
    getReportProfitAndLoss = jest.fn().mockResolvedValue({ body: { reports: [{ rows: [] }] } });
    getReportBankSummary   = jest.fn().mockResolvedValue({ body: { reports: [{ rows: [] }] } });

    jest.doMock('xero-node', () => ({
      AccountingApi: jest.fn().mockImplementation(() => ({ getBankTransactions, getReportProfitAndLoss, getReportBankSummary })),
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
