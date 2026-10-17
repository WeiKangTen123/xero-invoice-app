// The facade: its contract, Xero's paging and arguments, the shapes it
// answers, what it refuses, the reports it derives, and the writes it keeps
// per user. Nothing here touches the database or the SDK.
const api = require('./api');
const { _buildBankSummary } = require('../bank');
const { _reportLines } = require('../budget-variance');
const { isScopeError, xeroErrMsg, _parseXeroErr } = require('../xero-utils');

const T = 'demo-company';
const NOW = new Date('2026-10-17T06:00:00Z');   // 14:00 in Singapore
const REAL = ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance'];
const list = (tenant, ...args) => args;
void list;

let a;
beforeAll(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: REAL });
  a = api.demoApiFor('user-a');
});
afterAll(() => jest.useRealTimers());

const invoices = (opts = {}) => a.getInvoices(T, opts.since, opts.where, opts.order, opts.iDs, undefined, undefined, opts.statuses, opts.page, undefined, undefined, undefined, opts.summaryOnly, opts.pageSize)
  .then(r => r.body.invoices);
const allPages = async (fetch, field) => {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const batch = (await fetch(page)).body[field];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
};

describe('the contract', () => {
  test('exports exactly what the seam codes against', () => {
    expect(Object.keys(api).sort()).toEqual(['DEMO_TENANT', 'DEMO_TOKEN_PREFIX', 'demoApiFor', 'isDemoToken', 'userIdFromDemoToken']);
    expect(api.DEMO_TENANT).toEqual({ tenantId: 'demo-company', tenantName: 'Demo Company Pte Ltd' });
    expect(api.DEMO_TOKEN_PREFIX).toBe('demo:');
    expect(api.isDemoToken('demo:u1')).toBe(true);
    expect(api.isDemoToken('tok')).toBe(false);
    expect(api.isDemoToken(undefined)).toBe(false);
    expect(api.isDemoToken(42)).toBe(false);
    expect(api.userIdFromDemoToken('demo:u1')).toBe('u1');
    expect(api.userIdFromDemoToken('tok')).toBeNull();
  });

  test('one facade per user, kept; another user is another facade with its own writes', async () => {
    expect(api.demoApiFor('user-a')).toBe(a);
    const b = api.demoApiFor('user-b');
    expect(b).not.toBe(a);
    await b.createContacts(T, { contacts: [{ name: 'Only B Knows Pte Ltd' }] });
    expect((await b.getContacts(T, undefined, undefined, undefined, undefined, undefined, true, false, 'only b')).body.contacts).toHaveLength(1);
    expect((await a.getContacts(T, undefined, undefined, undefined, undefined, undefined, true, false, 'only b')).body.contacts).toHaveLength(0);
  });

  test('every answer is { response: { statusCode: 200 }, body }', async () => {
    const res = await a.getOrganisations(T);
    expect(res.response).toEqual({ statusCode: 200, headers: {} });
    expect(res.body.organisations[0]).toMatchObject({ name: 'Demo Company Pte Ltd', legalName: 'Demo Company Pte Ltd', baseCurrency: 'SGD', countryCode: 'SG', financialYearEndDay: 31, financialYearEndMonth: 12, shortCode: expect.any(String), organisationID: expect.any(String), isDemoCompany: true });
    expect(res.body.organisations[0].createdDateUTC).toBeInstanceOf(Date);
  });

  test('getJournals is refused for want of the scope, exactly as Xero refuses it', async () => {
    let err;
    try { await a.getJournals(T, undefined, undefined); } catch (e) { err = e; }
    expect(typeof err).toBe('string');
    expect(isScopeError(err)).toBe(true);
    expect(_parseXeroErr(err).status).toBe(401);
  });
});

describe('invoices: paging, filters and the summary answer', () => {
  test('a hundred a page, a short last page, every invoice once, and at most a hundred without a page', async () => {
    const page1 = await invoices({ order: 'Date DESC', statuses: ['AUTHORISED', 'PAID'], page: 1, summaryOnly: true });
    expect(page1).toHaveLength(100);
    const all = await allPages(page => a.getInvoices(T, undefined, undefined, 'Date DESC', undefined, undefined, undefined, ['AUTHORISED', 'PAID'], page, undefined, undefined, undefined, true), 'invoices');
    expect(all.length).toBeGreaterThan(1000);
    expect(new Set(all.map(i => i.invoiceID)).size).toBe(all.length);
    expect(all.length % 100).not.toBe(0);
    const unpaged = await invoices({ statuses: ['AUTHORISED', 'PAID'] });
    expect(unpaged).toHaveLength(100);
    // Newest first, as asked.
    for (let i = 1; i < all.length; i++) expect(all[i].date <= all[i - 1].date).toBe(true);
    // A smaller page size is honoured too.
    expect(await invoices({ page: 1, pageSize: 7 })).toHaveLength(7);
  });

  test('asked by IDs the answer is whole, whatever the count', async () => {
    const all = await allPages(page => a.getInvoices(T, undefined, undefined, 'Date DESC', undefined, undefined, undefined, undefined, page, undefined, undefined, undefined, true), 'invoices');
    const ids = all.slice(0, 120).map(i => i.invoiceID.toUpperCase());
    const got = await invoices({ iDs: ids, summaryOnly: true });
    expect(got).toHaveLength(120);
  });

  test('summaryOnly leaves out the line items, the payments and FullyPaidOnDate; the full answer carries them', async () => {
    const [summary] = await invoices({ statuses: ['PAID'], page: 1, summaryOnly: true });
    expect(summary).not.toHaveProperty('lineItems');
    expect(summary).not.toHaveProperty('fullyPaidOnDate');
    expect(summary).not.toHaveProperty('payments');
    expect(summary).toMatchObject({ status: 'PAID', amountDue: 0, currencyCode: 'SGD', currencyRate: 1, contact: { contactID: expect.any(String), name: expect.any(String) } });
    expect(summary.date).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00$/);
    expect(summary.updatedDateUTC).toBeInstanceOf(Date);
    const [full] = await invoices({ iDs: [summary.invoiceID] });
    expect(full.fullyPaidOnDate).toBeInstanceOf(Date);
    expect(full.lineItems.length).toBeGreaterThan(0);
    expect(full.lineItems[0]).toMatchObject({ accountCode: expect.any(String), taxType: expect.any(String), lineAmount: expect.any(Number), taxAmount: expect.any(Number) });
    expect(full.payments.length).toBeGreaterThan(0);
    expect(full.total).toBeCloseTo(full.subTotal + full.totalTax, 2);
    expect(full.total).toBeCloseTo(full.amountDue + full.amountPaid + full.amountCredited, 2);
  });

  test('the where clauses the reports send, and statuses', async () => {
    const sept = await invoices({ where: 'Type=="ACCREC" && Date >= DateTime(2026,9,1) && Date < DateTime(2026,10,1)', page: 1, summaryOnly: true });
    expect(sept.length).toBeGreaterThan(5);
    expect(sept.every(i => i.type === 'ACCREC' && i.date.startsWith('2026-09'))).toBe(true);
    const open = await invoices({ where: 'AmountDue>0', statuses: ['AUTHORISED'], page: 1, summaryOnly: true });
    expect(open.every(i => i.amountDue > 0 && i.status === 'AUTHORISED')).toBe(true);
    const byContact = await invoices({ where: `Contact.ContactID==Guid("${open[0].contact.contactID}")`, page: 1 });
    expect(byContact.every(i => i.contact.contactID === open[0].contact.contactID)).toBe(true);
    const lookback = await invoices({ where: 'Date >= DateTime(2024,1,1)', page: 1 });
    expect(lookback.every(i => i.date >= '2024-01-01')).toBe(true);
  });

  test('a clause this does not know fails the call, loudly', async () => {
    await expect(invoices({ where: 'Widget=="x"' })).rejects.toThrow(/does not support/);
    await expect(a.getPayments(T, undefined, 'Contact.Name=="x"', 'Date ASC', 1)).rejects.toThrow(/does not support/);
  });

  test('ordering by DueDate with summaryOnly is refused as Xero refuses it', async () => {
    let err;
    try { await invoices({ order: 'DueDate ASC', summaryOnly: true }); } catch (e) { err = e; }
    expect(_parseXeroErr(err).status).toBe(400);
    expect(xeroErrMsg(err)).toMatch(/Ordering by DueDate is unavailable/);
  });

  test('If-Modified-Since answers only what changed since', async () => {
    const recent = await invoices({ since: new Date('2026-10-10T00:00:00Z'), page: 1, summaryOnly: true });
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.every(i => i.updatedDateUTC >= new Date('2026-10-10T00:00:00Z'))).toBe(true);
    expect(await invoices({ since: new Date('2030-01-01T00:00:00Z'), page: 1 })).toEqual([]);
  });
});

describe('the other lists', () => {
  test('accounts: Code ASC, Type=="BANK", Code=="…"; a bank account carries its number and currency', async () => {
    const all = (await a.getAccounts(T, undefined, undefined, 'Code ASC')).body.accounts;
    expect(all[0].code).toBe('090');
    expect(all.find(x => x.code === '610')).toMatchObject({ name: 'Accounts Receivable', type: 'CURRENT', systemAccount: 'DEBTORS', status: 'ACTIVE' });
    expect(all.every(x => !('isPnl' in x))).toBe(true);
    const bank = (await a.getAccounts(T, undefined, 'Type=="BANK"', 'Name ASC')).body.accounts;
    expect(bank.map(x => [x.name, x.currencyCode, x.bankAccountNumber.length > 0])).toEqual([['Business Bank Account', 'SGD', true], ['Business Savings Account', 'SGD', true]]);
    expect((await a.getAccounts(T, undefined, 'Code=="469"')).body.accounts[0].taxType).toBe('INPUT');
  });

  test('tax rates: the Singapore rates, 9% in and out, archived 8%', async () => {
    const rates = (await a.getTaxRates(T)).body.taxRates;
    const active = rates.filter(r => r.status === 'ACTIVE');
    expect(active.find(r => r.taxType === 'OUTPUT')).toMatchObject({ displayTaxRate: 9, effectiveRate: 9, canApplyToRevenue: true, canApplyToExpenses: false });
    expect(active.find(r => r.taxType === 'INPUT')).toMatchObject({ displayTaxRate: 9, canApplyToExpenses: true, canApplyToRevenue: false });
    expect(active.find(r => r.taxType === 'NONE')).toMatchObject({ displayTaxRate: 0 });
    expect(rates.filter(r => r.status === 'ARCHIVED').map(r => r.displayTaxRate)).toEqual([8, 8]);
    expect((await a.getBrandingThemes(T)).body.brandingThemes[0]).toMatchObject({ name: 'Standard', brandingThemeID: expect.any(String) });
  });

  test('contacts: by searchTerm as contacts.js asks, paged and summarised as report-fetch asks', async () => {
    const found = (await a.getContacts(T, undefined, undefined, undefined, undefined, undefined, true, false, 'tan & lim')).body.contacts;
    expect(found.map(c => c.name)).toEqual(['Tan & Lim Associates']);
    expect(found[0]).toMatchObject({ isCustomer: true, isSupplier: false, contactStatus: 'ACTIVE', accountsReceivableTaxType: 'OUTPUT', salesDefaultAccountCode: '200' });
    const page = (await a.getContacts(T, undefined, undefined, 'Name ASC', undefined, 1, undefined, true)).body.contacts;
    expect(page.length).toBeGreaterThan(45);
    expect(page.length).toBeLessThanOrEqual(100);
    expect(Object.keys(page[0]).sort()).toEqual(['contactID', 'contactStatus', 'emailAddress', 'firstName', 'hasAttachments', 'hasValidationErrors', 'isCustomer', 'isSupplier', 'lastName', 'name', 'updatedDateUTC']);
    for (let i = 1; i < page.length; i++) expect(page[i].name.localeCompare(page[i - 1].name)).toBeGreaterThanOrEqual(0);
    expect((await a.getContacts(T, undefined, 'IsSupplier==true')).body.contacts.every(c => c.isSupplier)).toBe(true);
    expect((await a.getContacts(T, undefined, 'Name=="Chua Legal LLC"')).body.contacts).toHaveLength(1);
  });

  test('payments and bank transactions: Date objects, the accounts they went through, the where clauses bank.js and the cash manager send', async () => {
    const [opAccount] = (await a.getAccounts(T, undefined, 'Type=="BANK"', 'Name ASC')).body.accounts;
    const pays = (await a.getPayments(T, undefined, `Account.AccountID==Guid("${opAccount.accountID}") && Date >= DateTime(2026,9,11)`, 'Date DESC', 1)).body.payments;
    expect(pays.length).toBeGreaterThan(10);
    expect(pays[0].date).toBeInstanceOf(Date);
    expect(pays[0]).toMatchObject({ status: 'AUTHORISED', paymentType: expect.stringMatching(/^ACC(REC|PAY)PAYMENT$/), account: { accountID: opAccount.accountID }, invoice: { invoiceID: expect.any(String), invoiceNumber: expect.any(String), contact: { name: expect.any(String) } } });
    const since = (await a.getPayments(T, undefined, 'Date >= DateTime(2025,10,10) && Status=="AUTHORISED"', 'Date DESC', 1)).body.payments;
    expect(since).toHaveLength(100);
    const tx = (await a.getBankTransactions(T, undefined, `BankAccount.AccountID==Guid("${opAccount.accountID}") && Date >= DateTime(2026,9,11)`, 'Date DESC', 1)).body.bankTransactions;
    expect(tx.length).toBeGreaterThan(5);
    expect(tx[0].date).toBeInstanceOf(Date);
    expect(tx[0]).toMatchObject({ bankAccount: { accountID: opAccount.accountID, code: '090' }, lineAmountTypes: 'Exclusive', status: 'AUTHORISED' });
    expect(tx[0].lineItems[0]).toMatchObject({ accountCode: expect.any(String), lineAmount: expect.any(Number), taxAmount: expect.any(Number) });
    // Dated ahead, as the cash manager reads them: three inside two weeks.
    const ahead = (await a.getBankTransactions(T, undefined, 'Date >= DateTime(2026,10,18) && Status=="AUTHORISED"', 'Date ASC', 1)).body.bankTransactions;
    expect(ahead.map(t => t.type)).toEqual(['SPEND', 'SPEND', 'RECEIVE-PREPAYMENT']);
    expect(ahead.every(t => t.date <= new Date('2026-10-31T00:00:00Z'))).toBe(true);
    expect(ahead[2].prepaymentID).toEqual(expect.any(String));
    // The live check's two legs of a transfer, by an OR (Q7: both legs on file, found by ID).
    const legs = (await a.getBankTransactions(T, undefined, 'Date >= DateTime(2026,1,1) && (Type=="SPEND-TRANSFER" || Type=="RECEIVE-TRANSFER")', 'Date ASC', 1)).body.bankTransactions;
    expect(legs.map(t => t.type).sort()).toEqual(['RECEIVE-TRANSFER', 'RECEIVE-TRANSFER', 'SPEND-TRANSFER', 'SPEND-TRANSFER']);
    const transfers = (await a.getBankTransfers(T, undefined, 'Date >= DateTime(2026,1,1)', 'Date ASC')).body.bankTransfers;
    expect(transfers).toHaveLength(2);
    for (const t of transfers) {
      expect(legs.find(l => l.bankTransactionID === t.fromBankTransactionID)).toMatchObject({ type: 'SPEND-TRANSFER', total: t.amount, bankAccount: { code: '090' } });
      expect(legs.find(l => l.bankTransactionID === t.toBankTransactionID)).toMatchObject({ type: 'RECEIVE-TRANSFER', total: t.amount, bankAccount: { code: '091' } });
    }
  });

  test('credit notes, repeating invoices, quotes and the budget list', async () => {
    const open = (await a.getCreditNotes(T, undefined, 'Status=="AUTHORISED"', 'Date DESC', 1)).body.creditNotes;
    expect(open.map(c => c.type).sort()).toEqual(['ACCPAYCREDIT', 'ACCRECCREDIT']);
    expect(open[0]).toMatchObject({ remainingCredit: expect.any(Number), creditNoteNumber: expect.stringMatching(/^CN-\d{4}$/), currencyCode: 'SGD', contact: { contactID: expect.any(String) } });
    expect(open[0].date).toMatch(/T00:00:00$/);
    const all = (await a.getCreditNotes(T, undefined, undefined, 'Date ASC', 1)).body.creditNotes;
    expect(all).toHaveLength(6);
    expect(all.filter(c => c.status === 'PAID')[0].allocations[0]).toMatchObject({ amount: expect.any(Number), invoice: { invoiceID: expect.any(String) } });

    const rep = (await a.getRepeatingInvoices(T, 'Status=="AUTHORISED"')).body.repeatingInvoices;
    expect(rep.map(r => [r.type, r.schedule.unit, r.schedule.nextScheduledDate, r.schedule.dueDateType])).toEqual([
      ['ACCREC', 'MONTHLY', '2026-11-01T00:00:00', 'DAYSAFTERINVOICEDATE'], ['ACCPAY', 'MONTHLY', '2026-11-01T00:00:00', 'DAYSAFTERBILLDATE'],
    ]);
    expect(rep[0].total).toBe(13080);
    expect(rep[1].total).toBe(9265);

    const quotes = (await a.getQuotes(T, undefined, '2026-07-01', undefined, undefined, undefined, undefined, undefined, 1)).body.quotes;
    expect(quotes).toHaveLength(6);
    expect(quotes[0]).toMatchObject({ quoteNumber: 'QU-0001', expiryDateString: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), total: expect.any(Number) });
    expect((await a.getQuotes(T, undefined, undefined, undefined, undefined, undefined, undefined, 'ACCEPTED')).body.quotes).toHaveLength(1);
    expect((await a.getQuotes(T, undefined, '2026-10-10')).body.quotes).toHaveLength(1);

    const budgets = (await a.getBudgets(T)).body.budgets;
    expect(budgets).toHaveLength(1);
    expect(budgets[0]).toMatchObject({ type: 'OVERALL', description: 'Overall Budget', budgetID: expect.any(String), budgetLines: [] });
    expect(budgets[0].updatedDateUTC).toBeInstanceOf(Date);
    const withLines = (await a.getBudgets(T, [budgets[0].budgetID], '2026-12-31', '2026-10-01')).body.budgets[0];
    expect(withLines.budgetLines.find(l => l.accountCode === '200').budgetBalances.map(b => b.period)).toEqual(['2026-10', '2026-11', '2026-12']);
    expect((await a.getBudgets(T, ['not-a-budget'])).body.budgets).toEqual([]);
  });
});

describe('the reports', () => {
  test('Bank Summary: the columnar shape, every account listed, closing = opening + received − spent, 365 days at most', async () => {
    const rows = (await a.getReportBankSummary(T, '2026-09-11', '2026-10-17')).body.reports[0].rows;
    expect(rows[0]).toEqual({ rowType: 'Header', cells: ['Bank Accounts', 'Opening Balance', 'Cash Received', 'Cash Spent', 'Closing Balance'].map(value => ({ value })) });
    const body = rows[1].rows;
    expect(body.map(r => r.rowType)).toEqual(['Row', 'Row', 'SummaryRow']);
    expect(body[0].cells[0].attributes).toEqual([{ id: 'account', value: expect.any(String) }]);
    expect(body[0].cells[3].value).toMatch(/^\(/);   // spent is negative, in brackets
    const built = _buildBankSummary(rows);
    for (const acc of built.accounts) expect(acc.openingBalance + acc.cashReceived - acc.cashSpent).toBeCloseTo(acc.closingBalance, 2);
    // A day with no movement on the savings account still lists it (Q5).
    const quiet = _buildBankSummary((await a.getReportBankSummary(T, '2026-10-02', '2026-10-02')).body.reports[0].rows);
    expect(quiet.accounts.map(x => x.name)).toEqual(['Business Bank Account', 'Business Savings Account']);
    expect(quiet.accounts[1]).toMatchObject({ cashReceived: 0, cashSpent: 0 });
    expect(quiet.accounts[1].closingBalance).toBe(quiet.accounts[1].openingBalance);
    let err;
    try { await a.getReportBankSummary(T, '2025-01-01', '2026-10-17'); } catch (e) { err = e; }
    expect(xeroErrMsg(err)).toMatch(/365 days/);
  });

  test('Balance Sheet: as at the month end, two columns when none are asked for, n+1 stepping back otherwise, totals in untitled sections', async () => {
    const two = (await a.getReportBalanceSheet(T, '2026-09-30', undefined, undefined, undefined, undefined, true)).body.reports[0].rows;
    expect(two[0].cells.map(c => c.value)).toEqual(['', '30 Sep 2026', '30 Sep 2025']);
    const titles = two.filter(r => r.rowType === 'Section').map(r => r.title);
    expect(titles).toEqual(['Assets', 'Bank', 'Current Assets', 'Fixed Assets', '', 'Liabilities', 'Current Liabilities', 'Non-current Liabilities', '', '', 'Equity']);
    const untitled = two.filter(r => r.rowType === 'Section' && !r.title).map(r => r.rows[0].cells[0].value);
    expect(untitled).toEqual(['Total Assets', 'Total Liabilities', 'Net Assets']);
    const bank = two.find(r => r.title === 'Bank').rows;
    expect(bank.map(r => r.rowType)).toEqual(['Row', 'Row', 'SummaryRow']);
    expect(bank[0].cells[0].attributes[0].id).toBe('account');
    const three = (await a.getReportBalanceSheet(T, '2026-09-14', 2, 'MONTH', undefined, undefined, true)).body.reports[0].rows;
    expect(three[0].cells.map(c => c.value)).toEqual(['', '30 Sep 2026', '31 Aug 2026', '31 Jul 2026']);
    const years = (await a.getReportBalanceSheet(T, '2026-09-30', 2, 'YEAR', undefined, undefined, true)).body.reports[0].rows;
    expect(years[0].cells.map(c => c.value)).toEqual(['', '30 Sep 2026', '30 Sep 2025', '30 Sep 2024']);
    const equity = two.find(r => r.title === 'Equity').rows.map(r => r.cells[0].value);
    expect(equity).toEqual(['Current Year Earnings', 'Owner A Drawings', 'Retained Earnings', 'Owner A Share Capital', 'Total Equity']);
  });

  test('Trial Balance: the named columns, "Name (Code)" rows with the AccountID on every cell, debits equal credits', async () => {
    const rows = (await a.getReportTrialBalance(T, '2026-10-05')).body.reports[0].rows;
    expect(rows[0].cells.map(c => c.value)).toEqual(['Account', 'Debit', 'Credit', 'YTD Debit', 'YTD Credit']);
    expect(rows.filter(r => r.rowType === 'Section').map(r => r.title)).toEqual(['Revenue', 'Expenses', 'Assets', 'Liabilities', 'Equity', '']);
    const ar = rows.find(r => r.title === 'Assets').rows.find(r => r.cells[0].value.startsWith('Accounts Receivable'));
    expect(ar.cells[0].value).toBe('Accounts Receivable (610)');
    expect(ar.cells.every(c => c.attributes[0].id === 'account')).toBe(true);
    expect(ar.cells[3].value).toMatch(/^\d+\.\d{2}$/);
    expect(ar.cells[4].value).toBe('');
    const total = rows.at(-1).rows[0];
    expect(total.rowType).toBe('SummaryRow');
    expect(total.cells[3].value).toBe(total.cells[4].value);
  });

  test('P&L: newest first, the anchor\'s day count on every comparison, accounts with nothing left out, the two floating lines', async () => {
    const rows = (await a.getReportProfitAndLoss(T, '2026-08-01', '2026-08-31', 10, 'MONTH', undefined, undefined, undefined, undefined, true)).body.reports[0].rows;
    expect(rows[0].cells.map(c => c.value)).toEqual(['', '31 Aug 26', '31 Jul 26', '30 Jun 26', '31 May 26', '30 Apr 26', '31 Mar 26', '28 Feb 26', '31 Jan 26', '31 Dec 25', '30 Nov 25', '31 Oct 25']);
    const lines = _reportLines(rows, { reverse: true, n: 11 });
    expect(lines.filter(l => l.kind === 'summary').map(l => l.label)).toEqual(['Gross Profit', 'Net Profit']);
    expect(lines.filter(l => l.kind === 'subtotal').map(l => l.label)).toEqual(['Total Income', 'Total Cost of Sales', 'Total Other Income', 'Total Operating Expenses']);
    expect(lines.find(l => l.label === 'Sales').values.every(v => v > 100000)).toBe(true);
    // Only accounts with something in the span: no Income Tax Expense in a run that misses December.
    const spring = _reportLines((await a.getReportProfitAndLoss(T, '2026-08-01', '2026-08-31', 5, 'MONTH', undefined, undefined, undefined, undefined, true)).body.reports[0].rows, { reverse: true, n: 6 });
    expect(spring.some(l => l.label === 'Income Tax Expense')).toBe(false);
    expect(lines.some(l => l.label === 'Income Tax Expense')).toBe(true);   // the run above reaches back to Dec 2025
    const dec = _reportLines((await a.getReportProfitAndLoss(T, '2025-12-01', '2025-12-31', undefined, undefined, undefined, undefined, undefined, undefined, true)).body.reports[0].rows, { n: 1 });
    expect(dec.find(l => l.label === 'Income Tax Expense').values[0]).toBeGreaterThan(0);
    // A 30-day anchor clips the 31st of the month before, as Xero does.
    const sep = (await a.getReportProfitAndLoss(T, '2026-09-01', '2026-09-30', 1, 'MONTH', undefined, undefined, undefined, undefined, true)).body.reports[0].rows;
    const aug = (await a.getReportProfitAndLoss(T, '2026-08-01', '2026-08-30', undefined, undefined, undefined, undefined, undefined, undefined, true)).body.reports[0].rows;
    expect(_reportLines(sep, { n: 2 }).find(l => l.label === 'Net Profit').values[1]).toBe(_reportLines(aug, { n: 1 }).find(l => l.label === 'Net Profit').values[0]);
  });

  test('Budget Summary: oldest first from the anchor month, "Account" first, a quarter at a time, nought where there is no budget', async () => {
    const rows = (await a.getReportBudgetSummary(T, '2026-01-31', 12, 1)).body.reports[0].rows;
    expect(rows[0].cells.map(c => c.value)).toEqual(['Account', 'Jan-26', 'Feb-26', 'Mar-26', 'Apr-26', 'May-26', 'Jun-26', 'Jul-26', 'Aug-26', 'Sep-26', 'Oct-26', 'Nov-26', 'Dec-26']);
    const lines = _reportLines(rows, { n: 12 });
    expect(lines.filter(l => l.kind === 'summary').map(l => l.label)).toEqual(['Gross Profit', 'Net Profit']);
    expect(lines.find(l => l.label === 'Wages and Salaries').values.every(v => v > 0)).toBe(true);
    const quarters = (await a.getReportBudgetSummary(T, '2026-01-31', 4, 3)).body.reports[0].rows;
    expect(quarters[0].cells.map(c => c.value)).toEqual(['Account', 'Jan-Mar 26', 'Apr-Jun 26', 'Jul-Sep 26', 'Oct-Dec 26']);
    const q = _reportLines(quarters, { n: 4 }).find(l => l.label === 'Sales').values;
    const m = lines.find(l => l.label === 'Sales').values;
    expect(q[0]).toBeCloseTo(m[0] + m[1] + m[2], 2);
    const none = _reportLines((await a.getReportBudgetSummary(T, '2031-01-31', 12, 1)).body.reports[0].rows, { n: 12 });
    expect(none.map(l => [l.label, l.kind, l.values.every(v => v === 0)])).toEqual([['Gross Profit', 'summary', true], ['Total Expenses', 'summary', true], ['Net Profit', 'summary', true]]);
  });
});

describe('writes, per user', () => {
  const contactOf = async name => (await a.getContacts(T, undefined, undefined, undefined, undefined, undefined, true, false, name)).body.contacts[0];

  test('createContacts adds a contact that getContacts then finds; a second of the same name is refused as Xero refuses it', async () => {
    const [made] = (await a.createContacts(T, { contacts: [{ name: 'Acme Corp', emailAddress: 'ap@acme.example', isSupplier: true, isCustomer: false }] })).body.contacts;
    expect(made).toMatchObject({ contactID: expect.any(String), name: 'Acme Corp', contactStatus: 'ACTIVE', isSupplier: true, isCustomer: false, emailAddress: 'ap@acme.example' });
    expect((await contactOf('acme corp')).contactID).toBe(made.contactID);
    let err;
    try { await a.createContacts(T, { contacts: [{ name: 'ACME CORP' }] }); } catch (e) { err = e; }
    expect(xeroErrMsg(err)).toMatch(/already assigned to another contact/);
    try { await a.createContacts(T, { contacts: [{ name: '' }] }); } catch (e) { err = e; }
    expect(xeroErrMsg(err)).toMatch(/Name is a required field/);
  });

  test('createInvoices: totals from the lines and tax, a generated number, the same positional arguments as the SDK', async () => {
    const acme = await contactOf('acme corp');
    const body = { invoices: [{
      type: 'ACCPAY', status: 'DRAFT', contact: { contactID: acme.contactID }, date: '2026-10-01', dueDate: '2026-10-31', reference: 'PO 7',
      currencyCode: 'SGD', lineAmountTypes: 'Exclusive',
      lineItems: [
        { description: 'Widgets', quantity: 2, unitAmount: 50, accountCode: '453', taxType: 'INPUT' },
        { description: 'Delivery', quantity: 1, unitAmount: 10, accountCode: '425', taxType: 'NONE' },
        { description: 'Payment details:\nPayNow', unitAmount: 0 },
      ],
    }] };
    const [made] = (await a.createInvoices(T, body, undefined, undefined, 'create-1-abc')).body.invoices;
    expect(made).toMatchObject({
      invoiceID: expect.stringMatching(/^[0-9a-f-]{36}$/), invoiceNumber: 'INV-DEMO-001', type: 'ACCPAY', status: 'DRAFT', reference: 'PO 7',
      contact: { contactID: acme.contactID, name: 'Acme Corp' }, date: '2026-10-01T00:00:00', dueDate: '2026-10-31T00:00:00',
      subTotal: 110, totalTax: 9, total: 119, amountDue: 119, amountPaid: 0, amountCredited: 0, currencyCode: 'SGD', fullyPaidOnDate: null,
    });
    expect(made.lineItems.map(l => [l.lineAmount, l.taxAmount])).toEqual([[100, 9], [10, 0], [0, 0]]);
    expect(made.updatedDateUTC).toBeInstanceOf(Date);
    // The same idempotency key inside six minutes is the same invoice.
    const [again] = (await a.createInvoices(T, body, undefined, undefined, 'create-1-abc')).body.invoices;
    expect(again.invoiceID).toBe(made.invoiceID);
    const [other] = (await a.createInvoices(T, body, undefined, undefined, 'create-1-xyz')).body.invoices;
    expect(other.invoiceID).not.toBe(made.invoiceID);
    expect(other.invoiceNumber).toBe('INV-DEMO-002');
    // Inclusive amounts carry their tax inside.
    const [incl] = (await a.createInvoices(T, { invoices: [{ type: 'ACCREC', contact: { contactID: acme.contactID }, invoiceNumber: 'S-1', lineAmountTypes: 'Inclusive',
      lineItems: [{ description: 'Service', unitAmount: 109, accountCode: '200', taxType: 'OUTPUT' }] }] })).body.invoices;
    expect(incl).toMatchObject({ invoiceNumber: 'S-1', subTotal: 100, totalTax: 9, total: 109, dueDate: expect.stringMatching(/T00:00:00$/) });
  });

  test('what createInvoices refuses: another currency, an unknown contact, an unknown account', async () => {
    const acme = await contactOf('acme corp');
    const refuse = async inv => { try { await a.createInvoices(T, { invoices: [inv] }); } catch (e) { return xeroErrMsg(e); } return null; };
    expect(await refuse({ type: 'ACCPAY', contact: { contactID: acme.contactID }, currencyCode: 'USD', lineItems: [] })).toMatch(/not subscribed to currency USD/);
    expect(await refuse({ type: 'ACCPAY', contact: { contactID: 'nobody' }, lineItems: [] })).toMatch(/ContactID could not be found/);
    expect(await refuse({ type: 'ACCPAY', contact: { contactID: acme.contactID }, lineItems: [{ unitAmount: 1, accountCode: '999' }] })).toMatch(/Account code '999' is not a valid code/);
  });

  test('a created invoice is listed, found by ID with FullyPaidOnDate null, updated, and posted to the ledger once approved', async () => {
    const acme = await contactOf('acme corp');
    const [made] = (await a.createInvoices(T, { invoices: [{ type: 'ACCPAY', contact: { contactID: acme.contactID }, invoiceNumber: 'LEDGER-1', date: '2026-10-02',
      lineItems: [{ description: 'Stock', unitAmount: 1000, accountCode: '310', taxType: 'INPUT' }] }] })).body.invoices;
    const [summary] = await invoices({ iDs: [made.invoiceID], summaryOnly: true });
    expect(summary).toMatchObject({ invoiceNumber: 'LEDGER-1', status: 'DRAFT', amountDue: 1090, amountPaid: 0, total: 1090 });
    expect(summary).not.toHaveProperty('fullyPaidOnDate');
    const [full] = await invoices({ iDs: [made.invoiceID] });
    expect(full.fullyPaidOnDate).toBeNull();
    expect((await invoices({ statuses: ['DRAFT'], page: 1 })).some(i => i.invoiceID === made.invoiceID)).toBe(true);

    const ap = async () => _reportLines((await a.getReportBalanceSheet(T, '2026-10-31')).body.reports[0].rows.find(r => r.title === 'Current Liabilities').rows.filter(r => r.rowType === 'Row'), { n: 1 }).find(l => l.label === 'Accounts Payable').values[0];
    const before = await ap();
    // A draft is not in the books.
    expect(before).toBe(await ap());
    const [approved] = (await a.updateInvoice(T, made.invoiceID, { invoices: [{ status: 'AUTHORISED' }] })).body.invoices;
    expect(approved).toMatchObject({ invoiceID: made.invoiceID, status: 'AUTHORISED', total: 1090, amountDue: 1090 });
    expect(approved.lineItems).toHaveLength(1);
    expect(await ap()).toBeCloseTo(before + 1090, 2);
    expect((await invoices({ statuses: ['AUTHORISED'], where: 'Date >= DateTime(2026,10,2)', page: 1 })).some(i => i.invoiceID === made.invoiceID)).toBe(true);

    // Back to draft is refused once approved, and an ID nobody has is not found.
    let err;
    try { await a.updateInvoice(T, made.invoiceID, { invoices: [{ status: 'DRAFT' }] }); } catch (e) { err = e; }
    expect(xeroErrMsg(err)).toMatch(/not of valid status/);
    try { await a.updateInvoice(T, 'no-such-id', { invoices: [{ status: 'AUTHORISED' }] }); } catch (e) { err = e; }
    expect(_parseXeroErr(err).status).toBe(404);
    expect((await a.getInvoiceAttachments(T, made.invoiceID)).body).toEqual({ attachments: [] });
  });

  test('a correction keeps the lines it does not resend, and changes what it does', async () => {
    const acme = await contactOf('acme corp');
    const [made] = (await a.createInvoices(T, { invoices: [{ type: 'ACCPAY', contact: { contactID: acme.contactID }, invoiceNumber: 'FIX-1',
      lineItems: [{ description: 'Widgets', unitAmount: 100, accountCode: '453', taxType: 'INPUT' }] }] })).body.invoices;
    const [same] = (await a.updateInvoice(T, made.invoiceID, { invoices: [{ reference: 'corrected' }] })).body.invoices;
    expect(same).toMatchObject({ total: 109, reference: 'corrected', invoiceNumber: 'FIX-1' });
    const [changed] = (await a.updateInvoice(T, made.invoiceID, { invoices: [{ lineItems: [{ description: 'Widgets', unitAmount: 200, accountCode: '453', taxType: 'INPUT' }] }] })).body.invoices;
    expect(changed).toMatchObject({ total: 218, amountDue: 218 });
  });
});
