const { _buildSummary } = require('./reports');

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
