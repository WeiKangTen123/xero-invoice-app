// The Demo Company itself: invented from one seed, the same on every call,
// its history unchanged by the day it is generated for, every journal
// balanced, and the business the brief describes — the revenue, the margin,
// the bank, what is open and what is overdue.
const { generate, demoCompany, CHART, PNL_TYPES, addDays } = require('./company');

const TODAY = '2026-10-17';
const sumLines = (co, from, to, pred) => {
  let s = 0;
  for (const l of co.lines) { if (l.date < from || l.date > to) continue; if (pred(l)) s += l.cents; }
  return s;
};
const balance = (co, code, to) => sumLines(co, '0000-00-00', to, l => l.code === code);
const yearOf = (co, y) => {
  const rev  = -sumLines(co, `${y}-01-01`, `${y}-12-31`, l => l.code === '200');
  const cogs =  sumLines(co, `${y}-01-01`, `${y}-12-31`, l => l.code === '310');
  const tax  =  sumLines(co, `${y}-01-01`, `${y}-12-31`, l => l.code === '505');
  const net  = -sumLines(co, `${y}-01-01`, `${y}-12-31`, l => co.byCode.get(l.code).isPnl);
  return { rev: rev / 100, grossMargin: (rev - cogs) / rev, netBeforeTax: (net + tax) / rev, net: net / 100 };
};
const overdueDays = (inv, today) => Math.round((Date.UTC(...today.split('-').map((v, i) => (i === 1 ? v - 1 : +v))) - Date.UTC(...inv.dueDate.split('-').map((v, i) => (i === 1 ? v - 1 : +v)))) / 86400000);

describe('one seed, one company', () => {
  const co = generate(TODAY);

  const invoiceFacts = list => list.map(i => [i.invoiceID, i.invoiceNumber, i.date, i.dueDate, i.total, i.status, i.amountDue, i.fullyPaidOnDate, i.contact.name]);
  const txFacts = list => list.map(t => [t.bankTransactionID, t.type, t.date, t.total, t.bankCode]);

  test('generated twice for the same day, it is the same company to the last cent', () => {
    const again = generate(TODAY);
    expect(invoiceFacts(again.invoices)).toEqual(invoiceFacts(co.invoices));
    expect(again.lines).toEqual(co.lines);
    expect(txFacts(again.bankTransactions)).toEqual(txFacts(co.bankTransactions));
    expect(again.payments.map(p => [p.paymentID, p.date, p.amount])).toEqual(co.payments.map(p => [p.paymentID, p.date, p.amount]));
    expect([...again.budget.months.get('2026-10')]).toEqual([...co.budget.months.get('2026-10')]);
  });

  test('a later day adds history; it never rewrites what came before', () => {
    // The only things dated by the day they are generated for are the two
    // credit notes left unallocated "now" (last month and this), so a few
    // months before the earlier day everything is identical.
    const earlier = generate('2026-06-30');
    const stable = i => i.date <= '2026-04-30';
    // Settled as of each day, so a document's status may differ; the document itself may not.
    const docFacts = list => list.map(i => [i.invoiceID, i.invoiceNumber, i.date, i.dueDate, i.total, i.contact.name, i.lines.map(l => [l.code, l.net, l.tax])]);
    expect(docFacts(co.invoices.filter(stable))).toEqual(docFacts(earlier.invoices.filter(stable)));
    expect(invoiceFacts(co.invoices.filter(i => i.date <= '2025-12-31'))).toEqual(invoiceFacts(earlier.invoices.filter(i => i.date <= '2025-12-31')));
    expect(co.journals.filter(stable).map(j => [j.date, j.kind, j.lines])).toEqual(earlier.journals.filter(stable).map(j => [j.date, j.kind, j.lines]));
    // And the invoices up to the earlier day are the same documents, only their settlement to date differs.
    const upTo = i => i.date <= '2026-06-30';
    expect(co.invoices.filter(upTo).map(i => [i.invoiceID, i.invoiceNumber, i.total])).toEqual(earlier.invoices.filter(upTo).map(i => [i.invoiceID, i.invoiceNumber, i.total]));
  });

  test('every journal balances, the lines are in date order, and so is the cash-basis ledger', () => {
    for (const j of co.journals) expect(j.lines.reduce((s, [, c]) => s + c, 0)).toBe(0);
    expect(co.lines.reduce((s, l) => s + l.cents, 0)).toBe(0);
    expect(co.cashLines.reduce((s, l) => s + l.cents, 0)).toBe(0);
    for (let i = 1; i < co.lines.length; i++) expect(co.lines[i].date >= co.lines[i - 1].date).toBe(true);
    expect(co.lines.every(l => Number.isInteger(l.cents))).toBe(true);
  });

  test('the chart is Xero\'s Singapore chart, with the system accounts Xero runs', () => {
    const codes = CHART.map(a => a[0]);
    for (const c of ['090', '091', '200', '260', '270', '310', '400', '404', '416', '469', '477', '478', '485', '505', '610', '620', '630', '710', '711', '720', '721', '800', '820', '826', '830', '860', '960', '970']) {
      expect(codes).toContain(c);
    }
    const byCode = Object.fromEntries(co.accounts.map(a => [a.code, a]));
    expect(byCode['610']).toMatchObject({ type: 'CURRENT', systemAccount: 'DEBTORS' });
    expect(byCode['800']).toMatchObject({ type: 'CURRLIAB', systemAccount: 'CREDITORS' });
    expect(byCode['820']).toMatchObject({ type: 'CURRLIAB', systemAccount: 'GST' });
    expect(byCode['310']).toMatchObject({ type: 'DIRECTCOSTS' });
    expect(byCode['416']).toMatchObject({ type: 'DEPRECIATN' });
    expect(byCode['860']).toMatchObject({ type: 'TERMLIAB' });
    expect(co.accounts.filter(a => a.type === 'BANK').map(a => a.name)).toEqual(['Business Bank Account', 'Business Savings Account']);
    expect([...PNL_TYPES]).toEqual(['REVENUE', 'OTHERINCOME', 'DIRECTCOSTS', 'EXPENSE', 'DEPRECIATN']);
    expect(co.organisation).toMatchObject({ name: 'Demo Company Pte Ltd', baseCurrency: 'SGD', countryCode: 'SG', financialYearEndDay: 31, financialYearEndMonth: 12, timezone: 'SINGAPORESTANDARDTIME' });
    expect(co.organisation.createdDateUTC.toISOString()).toMatch(/^2022-12-01/);
  });

  test('the business: S$1.6M growing a fifth a year, 55% gross margin, 8–14% before tax', () => {
    const y23 = yearOf(co, 2023), y24 = yearOf(co, 2024), y25 = yearOf(co, 2025);
    expect(y23.rev).toBeGreaterThan(1500000); expect(y23.rev).toBeLessThan(1750000);
    expect(y24.rev / y23.rev).toBeGreaterThan(1.12); expect(y24.rev / y23.rev).toBeLessThan(1.28);
    expect(y25.rev).toBeGreaterThan(2200000); expect(y25.rev).toBeLessThan(2500000);
    for (const y of [y23, y24, y25]) {
      expect(y.grossMargin).toBeGreaterThan(0.53); expect(y.grossMargin).toBeLessThan(0.57);
      expect(y.netBeforeTax).toBeGreaterThan(0.08); expect(y.netBeforeTax).toBeLessThan(0.14);
    }
    // GST was 8% in 2023 and 9% after.
    const inv23 = co.invoices.find(i => i.type === 'ACCREC' && i.date.startsWith('2023-06'));
    const inv24 = co.invoices.find(i => i.type === 'ACCREC' && i.date.startsWith('2024-06'));
    expect(inv23.totalTax / inv23.subTotal).toBeCloseTo(0.08, 3);
    expect(inv24.totalTax / inv24.subTotal).toBeCloseTo(0.09, 3);
  });

  test('the bank today: a current account in the low hundreds of thousands, savings around 150k, a loan being repaid', () => {
    const current = balance(co, '090', TODAY) / 100, savings = balance(co, '091', TODAY) / 100;
    expect(current).toBeGreaterThan(180000); expect(current).toBeLessThan(350000);
    expect(savings).toBeGreaterThan(140000); expect(savings).toBeLessThan(165000);
    expect(-balance(co, '860', TODAY)).toBeGreaterThan(0);
    expect(-balance(co, '860', TODAY)).toBeLessThan(20000000);
    // Two transfers to savings last year, both legs on file.
    const last = co.bankTransfers.filter(t => t.date.startsWith('2025'));
    expect(last).toHaveLength(2);
    for (const t of last) {
      expect(co.bankTransactions.find(x => x.bankTransactionID === t.fromBankTransactionID)).toMatchObject({ type: 'SPEND-TRANSFER', bankCode: '090', total: t.amount });
      expect(co.bankTransactions.find(x => x.bankTransactionID === t.toBankTransactionID)).toMatchObject({ type: 'RECEIVE-TRANSFER', bankCode: '091', total: t.amount });
    }
  });

  test('what is open: about ten sales invoices, a few overdue, one long overdue; a handful of bills', () => {
    const open = co.invoices.filter(i => i.status === 'AUTHORISED');
    const sales = open.filter(i => i.type === 'ACCREC'), bills = open.filter(i => i.type === 'ACCPAY');
    expect(sales.length).toBeGreaterThanOrEqual(6); expect(sales.length).toBeLessThanOrEqual(14);
    const late = sales.map(i => overdueDays(i, TODAY)).filter(d => d > 0);
    expect(late.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...late)).toBeGreaterThanOrEqual(45);
    expect(bills.length).toBeGreaterThanOrEqual(5); expect(bills.length).toBeLessThanOrEqual(12);
    // Every open one still owes something, every paid one nothing, and the
    // amounts add up as Xero's do.
    for (const i of co.invoices) {
      expect(i.amountDue).toBe(i.total - i.amountPaid - i.amountCredited);
      if (i.status === 'PAID') { expect(i.amountDue).toBe(0); expect(i.fullyPaidOnDate <= TODAY).toBe(true); }
      else expect(i.amountDue).toBeGreaterThan(0);
    }
    // The receivables ledger is the open invoices less the unallocated credit.
    const unalloc = co.creditNotes.filter(cn => cn.status === 'AUTHORISED');
    expect(unalloc.map(cn => cn.type).sort()).toEqual(['ACCPAYCREDIT', 'ACCRECCREDIT']);
    const arCredit = unalloc.find(cn => cn.type === 'ACCRECCREDIT').remainingCredit;
    expect(balance(co, '610', TODAY)).toBe(sales.reduce((s, i) => s + i.amountDue, 0) - arCredit);
    const apCredit = unalloc.find(cn => cn.type === 'ACCPAYCREDIT').remainingCredit;
    expect(-balance(co, '800', TODAY)).toBe(bills.reduce((s, i) => s + i.amountDue, 0) - apCredit);
    // The expected and planned payment dates a person set on a few.
    expect(sales.filter(i => i.expectedPaymentDate)).toHaveLength(2);
    expect(bills.filter(i => i.plannedPaymentDate)).toHaveLength(1);
    // Six credit notes over the years, four of them applied.
    expect(co.creditNotes).toHaveLength(6);
    expect(co.creditNotes.filter(cn => cn.status === 'PAID').every(cn => cn.allocations.length > 0)).toBe(true);
  });

  test('the retainer and the rent come from the two repeating templates, next due on the 1st', () => {
    expect(co.repeatingInvoices.map(t => [t.type, t.schedule.unit, t.schedule.nextScheduledDate])).toEqual([
      ['ACCREC', 'MONTHLY', '2026-11-01'], ['ACCPAY', 'MONTHLY', '2026-11-01'],
    ]);
    const fromTemplate = co.invoices.filter(i => i.repeatingInvoiceID);
    expect(fromTemplate.filter(i => i.type === 'ACCREC' && i.date.startsWith('2025')).map(i => i.subTotal)).toEqual(Array(12).fill(1200000));
    expect(fromTemplate.filter(i => i.type === 'ACCPAY' && i.date.startsWith('2025')).map(i => i.subTotal)).toEqual(Array(12).fill(850000));
  });

  test('a few things are dated ahead, inside two weeks, and the quotes are recent', () => {
    const ahead = co.bankTransactions.filter(t => t.date > TODAY);
    expect(ahead.map(t => t.type).sort()).toEqual(['RECEIVE-PREPAYMENT', 'SPEND', 'SPEND']);
    for (const t of ahead) expect(t.date <= addDays(TODAY, 14)).toBe(true);
    expect(co.quotes.map(q => q.status)).toEqual(['SENT', 'SENT', 'ACCEPTED', 'SENT', 'INVOICED', 'DECLINED']);
    expect(co.quotes.filter(q => q.status === 'SENT' && q.expiryDate < TODAY)).toHaveLength(1);
  });

  test('the Overall Budget covers this financial year and the next, by account by month, near last year grown', () => {
    expect(co.budget).toMatchObject({ type: 'OVERALL', description: 'Overall Budget' });
    expect(co.budget.years).toEqual([2026, 2027]);
    expect(co.budget.months.has('2025-12')).toBe(false);
    expect(co.budget.months.has('2026-01')).toBe(true);
    expect(co.budget.months.has('2027-12')).toBe(true);
    const sales26 = -co.budget.months.get('2026-03').get('200');
    const sales25 = -sumLines(co, '2025-03-01', '2025-03-31', l => l.code === '200');
    expect(sales26 / sales25).toBeGreaterThan(1.05); expect(sales26 / sales25).toBeLessThan(1.3);
    // Variances go both ways over the year.
    const diffs = [];
    for (let m = 1; m <= 9; m++) {
      const key = `2026-${String(m).padStart(2, '0')}`;
      diffs.push(-sumLines(co, `${key}-01`, `${key}-31`, l => l.code === '200') + co.budget.months.get(key).get('200'));
    }
    expect(diffs.some(d => d > 0)).toBe(true);
    expect(diffs.some(d => d < 0)).toBe(true);
  });
});

describe('on other days', () => {
  test.each(['2027-03-05', '2025-11-11', '2024-02-29', '2026-01-02'])('%s: balanced, open invoices in range, something long overdue', today => {
    const co = generate(today);
    for (const j of co.journals) expect(j.lines.reduce((s, [, c]) => s + c, 0)).toBe(0);
    const sales = co.invoices.filter(i => i.status === 'AUTHORISED' && i.type === 'ACCREC');
    expect(sales.length).toBeGreaterThanOrEqual(5); expect(sales.length).toBeLessThanOrEqual(16);
    expect(Math.max(...sales.map(i => overdueDays(i, today)))).toBeGreaterThanOrEqual(45);
    expect(co.invoices.every(i => i.date <= today)).toBe(true);
    expect(co.payments.every(p => p.date <= today)).toBe(true);
    expect(co.budget.years).toEqual([Number(today.slice(0, 4)), Number(today.slice(0, 4)) + 1]);
  });

  test('demoCompany keeps one company per day', () => {
    const a = demoCompany('2026-10-17');
    expect(demoCompany('2026-10-17')).toBe(a);
    const b = demoCompany('2026-10-18');
    expect(b).not.toBe(a);
    expect(b.todayISO).toBe('2026-10-18');
  });
});
