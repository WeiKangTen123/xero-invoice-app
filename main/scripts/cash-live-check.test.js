// The live check is run on the server against a real organisation, so the one
// thing that must never happen is a write to Xero. Every AccountingApi method
// of the real SDK is replaced by a jest.fn here, the whole run is played
// against canned answers, and no method that creates, updates, deletes, puts,
// posts, emails or voids is allowed to have been called. Each question's
// answer logic is then checked on canned data of its own.
jest.mock('xero-node', () => {
  const actual = jest.requireActual('xero-node');
  const proto = actual.AccountingApi.prototype;
  const names = Object.getOwnPropertyNames(proto)
    .filter(n => n !== 'constructor' && typeof Object.getOwnPropertyDescriptor(proto, n).value === 'function');
  const instances = [];
  class AccountingApi {
    constructor() {
      for (const n of names) this[n] = jest.fn(async () => { throw new Error(`no canned answer for ${n}`); });
      instances.push(this);
    }
    set accessToken(v) { this._token = v; }
  }
  return { ...actual, AccountingApi, __names: names, __instances: instances };
});

const xeroNode = require('xero-node');
const check = require('./cash-live-check');

const TODAY = '2026-10-15';
// A date the way Xero's JSON sends it, which xero-node passes through as is.
const xd = iso => { const [y, m, d] = iso.split('-').map(Number); return `/Date(${Date.UTC(y, m - 1, d)}+0000)/`; };

const bankRows = lines => [
  { rowType: 'Header', cells: ['Bank Accounts', 'Opening Balance', 'Cash Received', 'Cash Spent', 'Closing Balance'].map(value => ({ value })) },
  { rowType: 'Section', title: '', rows: [
    ...lines.map(l => ({ rowType: 'Row', cells: [
      { value: l.name, ...(l.id ? { attributes: [{ id: 'accountID', value: l.id }] } : {}) },
      { value: (l.open || 0).toFixed(2) }, { value: (l.in || 0).toFixed(2) },
      { value: (l.out || 0).toFixed(2) }, { value: (l.close || 0).toFixed(2) },
    ] })),
    { rowType: 'SummaryRow', cells: [{ value: 'Total' }, { value: '0.00' }, { value: '0.00' }, { value: '0.00' }, { value: '0.00' }] },
  ] },
];

const budgetRows = (sections, months = 12) => [
  { rowType: 'Header', cells: [{ value: 'Account' }, ...Array.from({ length: months }, (_, i) => ({ value: `M${i + 1}` }))] },
  ...sections.map(s => ({ rowType: 'Section', title: s.title, rows: s.rows.map(r => ({
    rowType: r.summary ? 'SummaryRow' : 'Row',
    cells: [{ value: r.label }, ...Array.from({ length: months }, () => ({ value: (r.value || 0).toFixed(2) }))],
  })) })),
];

const ORG  = { name: 'Demo Co', baseCurrency: 'SGD', createdDateUTC: new Date('2020-01-01T00:00:00Z'), financialYearEndDay: 31, financialYearEndMonth: 12 };
const BANK = [
  { accountID: 'acc-1', name: 'Business Cheque', status: 'ACTIVE',   currencyCode: 'SGD', type: 'BANK' },
  { accountID: 'acc-2', name: 'Savings',         status: 'ACTIVE',   currencyCode: 'SGD', type: 'BANK' },
  { accountID: 'acc-3', name: 'Old Account',     status: 'ARCHIVED', currencyCode: 'SGD', type: 'BANK' },
];

// The list leaves out INV-1's expected date, which its single read carries.
const LIST = [
  { invoiceID: 'i-1', invoiceNumber: 'INV-1', type: 'ACCREC', status: 'AUTHORISED', amountDue: 500, total: 700 },
  { invoiceID: 'b-1', invoiceNumber: 'BILL-1', type: 'ACCPAY', status: 'AUTHORISED', amountDue: 300, total: 300, plannedPaymentDate: '2026-11-05T00:00:00' },
  { invoiceID: 'i-0', invoiceNumber: 'INV-0', type: 'ACCREC', status: 'PAID', amountDue: 0, total: 100, fullyPaidOnDate: xd('2026-09-20') },
];
const SINGLE = {
  'i-1': { ...LIST[0], amountPaid: 200, amountCredited: 0, expectedPaymentDate: xd('2026-10-30'),
           payments: [{ paymentID: 'p-f1', date: xd('2026-10-20'), amount: 200 }] },
  'b-1': { ...LIST[1], amountPaid: 0, amountCredited: 0, payments: [] },
  'i-0': { ...LIST[2], amountPaid: 100, amountCredited: 0 },
};
const FUTURE = [{ paymentID: 'p-f1', date: xd('2026-10-20'), amount: 200, status: 'AUTHORISED', paymentType: 'ACCRECPAYMENT',
  invoice: { invoiceID: 'i-1', invoiceNumber: 'INV-1' }, account: { accountID: 'acc-1' } }];

const TEMPLATES = [
  { repeatingInvoiceID: 'rep-000001', type: 'ACCREC', status: 'AUTHORISED', total: 1000, currencyCode: 'SGD',
    schedule: { period: 1, unit: 'MONTHLY', dueDate: 14, dueDateType: 'DAYSAFTERBILLDATE', startDate: xd('2026-01-31'), nextScheduledDate: xd('2026-10-31') } },
  { repeatingInvoiceID: 'rep-000002', type: 'ACCPAY', status: 'AUTHORISED', total: 50, currencyCode: 'SGD',
    schedule: { period: 1, unit: 'WEEKLY', dueDate: 0, dueDateType: 'DAYSAFTERBILLDATE', startDate: xd('2026-01-01'), nextScheduledDate: xd('2026-10-01') } },
];

const TRANSFERS = [
  { bankTransferID: 'tr-1', date: xd('2026-08-03'), amount: 1000, fromBankTransactionID: 'bt-1', toBankTransactionID: 'bt-2',
    fromBankAccount: { accountID: 'acc-1' }, toBankAccount: { accountID: 'acc-2' } },
  { bankTransferID: 'tr-2', date: xd('2026-09-10'), amount: 250, fromBankTransactionID: 'bt-3', toBankTransactionID: 'bt-4',
    fromBankAccount: { accountID: 'acc-2' }, toBankAccount: { accountID: 'acc-1' } },
];
const LEGS = [
  { bankTransactionID: 'bt-1', type: 'SPEND-TRANSFER',   date: xd('2026-08-03'), total: 1000, status: 'AUTHORISED', bankAccount: { accountID: 'acc-1' } },
  { bankTransactionID: 'bt-2', type: 'RECEIVE-TRANSFER', date: xd('2026-08-03'), total: 1000, status: 'AUTHORISED', bankAccount: { accountID: 'acc-2' } },
  { bankTransactionID: 'bt-3', type: 'SPEND-TRANSFER',   date: xd('2026-09-10'), total: 250,  status: 'AUTHORISED', bankAccount: { accountID: 'acc-2' } },
];

// September: the Bank Summary's 1,500 in is both payments, the unreconciled one included.
const MONTH_PAYMENTS = [
  { paymentID: 'p-1', date: xd('2026-09-05'), amount: 1000, status: 'AUTHORISED', paymentType: 'ACCRECPAYMENT', isReconciled: true,  account: { accountID: 'acc-1' } },
  { paymentID: 'p-2', date: xd('2026-09-25'), amount: 500,  status: 'AUTHORISED', paymentType: 'ACCRECPAYMENT', isReconciled: false, account: { accountID: 'acc-1' } },
];
const MONTH_TX = [
  { bankTransactionID: 't-1', type: 'SPEND', date: xd('2026-09-12'), total: 300, status: 'AUTHORISED', isReconciled: true, bankAccount: { accountID: 'acc-1' } },
];

const BUDGET_NEXT = budgetRows([
  { title: 'Income', rows: [{ label: 'Sales', value: 1000 }, { label: 'Total Income', value: 1000, summary: true }] },
  { title: 'Less Cost of Sales', rows: [{ label: 'Purchases', value: 400 }] },
  { title: 'Less Operating Expenses', rows: [{ label: 'Wages', value: 300 }] },
  { title: 'Weird Section', rows: [{ label: 'Something', value: 10 }] },
  { title: '', rows: [{ label: 'Net Profit', value: 290 }] },
]);

const BANK_SUMMARIES = {
  '2026-09-14': bankRows([{ name: 'Business Cheque', id: 'acc-1', open: 100, in: 1500, out: 300, close: 1300 },
    { name: 'Savings', id: 'acc-2', open: 1000, close: 1000 }, { name: 'Petty Cash', open: 50, close: 50 }]),
  '2016-10-01': bankRows([]),
  '2026-10-01': bankRows([{ name: 'Business Cheque', open: 1300, in: 200, close: 1500 }, { name: 'Savings', open: 1000, close: 1000 }]),
  '2026-09-01': bankRows([{ name: 'Business Cheque', open: 100, in: 1500, out: 300, close: 1300 }, { name: 'Savings', open: 1000, close: 1000 }]),
};

function canned(api, { failRepeating = false } = {}) {
  api.getOrganisations.mockResolvedValue({ body: { organisations: [ORG] } });
  api.getAccounts.mockResolvedValue({ body: { accounts: BANK } });
  api.getInvoices.mockImplementation(async (t, ims, where, order, ids, nums, cids, statuses) => (ids
    ? { body: { invoices: ids.map(id => SINGLE[id]).filter(Boolean) } }
    : { body: { invoices: LIST.filter(i => (statuses || []).includes(i.status)) } }));
  api.getInvoice.mockImplementation(async (t, id) => ({ body: { invoices: [SINGLE[id]] } }));
  api.getPayments.mockImplementation(async (t, ims, where) => ({ body: { payments: /DateTime\(2026,10,16\)/.test(where) ? FUTURE : MONTH_PAYMENTS } }));
  api.getReportBankSummary.mockImplementation(async (t, from) => ({ body: { reports: [{ rows: BANK_SUMMARIES[from] || [] }] } }));
  api.getReportBudgetSummary.mockImplementation(async (t, date) => ({ body: { reports: [{ rows: date.startsWith('2029') ? budgetRows([]) : BUDGET_NEXT }] } }));
  api.getBankTransfers.mockResolvedValue({ body: { bankTransfers: TRANSFERS } });
  api.getBankTransactions.mockImplementation(async (t, ims, where) => ({ body: { bankTransactions: /TRANSFER/.test(where) ? LEGS : MONTH_TX } }));
  if (failRepeating) {
    api.getRepeatingInvoices.mockRejectedValue(JSON.stringify({ response: { statusCode: 500, body: { Message: 'Xero fell over' } } }));
  } else {
    api.getRepeatingInvoices.mockResolvedValue({ body: { repeatingInvoices: TEMPLATES } });
  }
  return api;
}

const fakeToken = `x.${Buffer.from(JSON.stringify({ scope: ['accounting.invoices', 'accounting.payments.read', 'offline_access'] })).toString('base64')}.y`;

function deps(opts = {}) {
  return {
    findUser: email => (email === 'owner@example.com' ? { id: 'u1' } : null),
    tenants: () => [{ tenantId: 'tenant-1111-2222', tenantName: 'Demo Co' }],
    token: async () => fakeToken,
    timezone: () => 'Asia/Singapore',
    apiFor: token => canned(require('../xero/report-fetch')._apiFor(token), opts),
  };
}

async function play(opts = {}) {
  const out = [];
  const res = await check.run({ email: 'owner@example.com', deps: deps(opts), print: l => out.push(String(l)), gapMs: 0, todayISO: TODAY });
  return { ...res, out: out.join('\n') };
}

const answers = results => Object.fromEntries(results.map(r => [r.n, r.answer]));

beforeEach(() => { xeroNode.__instances.length = 0; });

describe('cash-live-check — never writes to Xero', () => {
  it('runs every question on GET calls alone', async () => {
    const res = await play();
    expect(res.ok).toBe(true);
    expect(xeroNode.__instances.length).toBeGreaterThan(0);
    const writes = xeroNode.__names.filter(n => check.WRITE_RE.test(n));
    expect(writes.length).toBeGreaterThan(50);            // the real SDK's writers are all mocked
    for (const api of xeroNode.__instances) {
      for (const n of writes) expect({ method: n, calls: api[n].mock.calls.length }).toEqual({ method: n, calls: 0 });
      for (const n of xeroNode.__names) if (api[n].mock.calls.length) expect(n).toMatch(/^get/);
    }
    const used = new Set(xeroNode.__names.filter(n => xeroNode.__instances.some(a => a[n].mock.calls.length)));
    for (const n of ['getOrganisations', 'getInvoices', 'getInvoice', 'getPayments', 'getAccounts', 'getReportBankSummary',
      'getRepeatingInvoices', 'getReportBudgetSummary', 'getBankTransfers', 'getBankTransactions']) expect(used.has(n)).toBe(true);
    expect(res.calls).toBeLessThanOrEqual(25);
  });

  it('answers each question from the canned organisation', async () => {
    const res = await play();
    expect(answers(res.results)).toEqual({ 1: 'NO', 2: 'YES', 3: 'NO', 4: 'NO', 5: 'NO', 6: 'YES', 7: 'NO', 8: 'YES', 9: 'NO' });
    for (let n = 1; n <= 9; n++) expect(res.out).toMatch(new RegExp(`^Q${n} (YES|NO|UNKNOWN) — `, 'm'));
    expect(res.out).toMatch(/the list WITHOUT summaryOnly carries it on 1\/1/);
    expect(res.out).toMatch(/only in the Bank Summary: Petty Cash/);
    expect(res.out).not.toContain(fakeToken);
  });

  it('a failed call costs its own question only', async () => {
    const res = await play({ failRepeating: true });
    const q4 = res.results.find(r => r.n === 4);
    expect(q4.answer).toBe('UNKNOWN');
    expect(q4.evidence).toMatch(/Xero fell over/);
    expect(answers(res.results)[5]).toBe('NO');
    expect(res.results).toHaveLength(9);
  });

  it('the guard refuses every method that is not a read, before it reaches the SDK', async () => {
    const api = new xeroNode.AccountingApi();
    const guarded = check._readOnly(api, { gapMs: 0 });
    for (const n of ['createInvoices', 'updateInvoice', 'deleteAccount', 'emailInvoice', 'postSetup', 'updateOrCreateInvoices', 'setApiKey']) {
      expect(() => guarded[n]('t', {})).toThrow(/refused/);
      expect(api[n]).not.toHaveBeenCalled();
    }
    expect(() => { guarded.accessToken = 'x'; }).toThrow(/refused/);
    api.getAccounts.mockResolvedValue({ body: { accounts: [] } });
    await expect(guarded.getAccounts('t')).resolves.toEqual({ body: { accounts: [] } });
  });

  it('stops at the call budget and counts what it sent', async () => {
    const api = new xeroNode.AccountingApi();
    api.getAccounts.mockResolvedValue({ body: {} });
    const stats = { calls: 0, byMethod: {} };
    const guarded = check._readOnly(api, { gapMs: 0, maxCalls: 2, stats });
    await guarded.getAccounts('t');
    await guarded.getAccounts('t');
    await expect(guarded.getAccounts('t')).rejects.toThrow(/call budget/);
    expect(api.getAccounts).toHaveBeenCalledTimes(2);
    expect(stats).toEqual({ calls: 2, byMethod: { getAccounts: 2 } });
  });
});

describe('cash-live-check — arguments', () => {
  it('reads --email and --tenant in both spellings', () => {
    expect(check.parseArgs(['--email', 'a@b.co', '--tenant', 'Demo Co'])).toMatchObject({ email: 'a@b.co', tenant: 'Demo Co', errors: [] });
    expect(check.parseArgs(['--email=a@b.co', '--tenant=t-1'])).toMatchObject({ email: 'a@b.co', tenant: 't-1', errors: [] });
  });
  it('asks for --email, and --help needs nothing', () => {
    expect(check.parseArgs([]).errors).toContain('--email is required');
    expect(check.parseArgs(['--email']).errors).toContain('--email needs a value');
    expect(check.parseArgs(['--email', 'nope']).errors).toContain('--email does not look like an email address');
    expect(check.parseArgs(['--wat', '--email', 'a@b.co']).errors).toContain('unknown argument: --wat');
    expect(check.parseArgs(['--help'])).toMatchObject({ help: true, errors: [] });
  });
  it('picks the organisation by id, name or a unique part of it', () => {
    const t = [{ tenantId: 't-1', tenantName: 'Demo Co' }, { tenantId: 't-2', tenantName: 'Other Pte Ltd' }];
    expect(check._pickTenant(t).tenant.tenantId).toBe('t-1');
    expect(check._pickTenant(t).others).toEqual(['Other Pte Ltd']);
    expect(check._pickTenant(t, 't-2').tenant.tenantId).toBe('t-2');
    expect(check._pickTenant(t, 'demo co').tenant.tenantId).toBe('t-1');
    expect(check._pickTenant(t, 'other').tenant.tenantId).toBe('t-2');
    expect(check._pickTenant(t, 'nothing').error).toMatch(/no connected organisation/);
    expect(check._pickTenant([]).error).toMatch(/no Xero organisation/);
  });
});

describe('cash-live-check — the answers', () => {
  it('Q1: a date on the single invoice but not in the list is NO; one in the list is YES', () => {
    const no = check.answerQ1({ appList: LIST, openList: LIST.slice(0, 2), singles: [SINGLE['i-1'], SINGLE['b-1']] });
    expect(no.answer).toBe('NO');
    expect(no.evidence).toMatch(/in list: Expected NO, Planned YES, FullyPaid YES; on single: Expected YES, Planned YES/);
    expect(no.followUp.missedIds).toEqual(['i-1']);
    const yes = check.answerQ1({ appList: [{ ...LIST[0], expectedPaymentDate: xd('2026-10-30') }], singles: [SINGLE['i-1']] });
    expect(yes.answer).toBe('YES');
    const unknown = check.answerQ1({ appList: [LIST[0]], singles: [{ ...LIST[0] }] });
    expect(unknown.answer).toBe('UNKNOWN');
    expect(unknown.lines.join('\n')).toMatch(/set one on an open invoice in Xero/);
    expect(check.answerQ1({ appList: [{ ...LIST[2], fullyPaidOnDate: undefined }] }).followUp.needPaidSingle).toBe(true);
  });

  it('Q1: the sample takes a dated invoice first, and a sale and a bill', () => {
    const pick = check._pickOpenSample([...LIST, { invoiceID: 'i-9', type: 'ACCREC', status: 'AUTHORISED', amountDue: 5 }], 3);
    expect(pick.map(i => i.invoiceID)).toEqual(['b-1', 'i-1', 'i-9']);
  });

  it('Q2: YES when AmountDue is already net of the future payment, NO when not, UNKNOWN with none', () => {
    expect(check.answerQ2({ todayISO: TODAY, futurePayments: FUTURE, invoices: [SINGLE['i-1']] }).answer).toBe('YES');
    const still = { ...SINGLE['i-1'], amountDue: 700, amountPaid: 0 };
    expect(check.answerQ2({ todayISO: TODAY, futurePayments: FUTURE, invoices: [still] }).answer).toBe('NO');
    expect(check.answerQ2({ todayISO: TODAY, futurePayments: [], invoices: [] }).answer).toBe('UNKNOWN');
    const noPayments = { ...SINGLE['i-1'], payments: undefined };
    expect(check.answerQ2({ todayISO: TODAY, futurePayments: FUTURE, invoices: [noPayments] }).answer).toBe('UNKNOWN');
  });

  it('Q3: names only in the summary are NO; IDs in cell attributes are reported', () => {
    const no = check.answerQ3({ rows: BANK_SUMMARIES['2026-09-14'], bankAccounts: BANK });
    expect(no.answer).toBe('NO');
    expect(no.evidence).toMatch(/only in summary: Petty Cash; only in list: Old Account \(ARCHIVED\)/);
    expect(no.evidence).toMatch(/IDs in attributes: yes \(accountID\)/);
    const yes = check.answerQ3({ rows: bankRows([{ name: 'business  cheque' }, { name: 'Savings' }]), bankAccounts: BANK });
    expect(yes.answer).toBe('YES');
    expect(yes.evidence).toMatch(/no IDs in cell attributes/);
    expect(yes.lines.join('\n')).toMatch(/case\/spacing/);
    expect(check.answerQ3({ rows: [], bankAccounts: BANK }).answer).toBe('UNKNOWN');
  });

  it('Q4: a NextScheduledDate before today is NO, and marked', () => {
    const no = check.answerQ4({ templates: TEMPLATES, todayISO: TODAY });
    expect(no.answer).toBe('NO');
    expect(no.lines.join('\n')).toMatch(/NEXT BEFORE TODAY/);
    expect(no.lines.join('\n')).toMatch(/2026-10-31 .*2026-11-14/);   // next date, then its due date (14 days after)
    expect(check.answerQ4({ templates: TEMPLATES.slice(0, 1), todayISO: TODAY }).answer).toBe('YES');
    expect(check.answerQ4({ templates: [], todayISO: TODAY }).answer).toBe('UNKNOWN');
  });

  it('Q5: YES only when accounts with no movement are always listed', () => {
    const win = { from: '2016-10-01', to: '2016-10-31' };
    const now = { rows: BANK_SUMMARIES['2026-10-01'], window: { from: '2026-10-01', to: TODAY } };
    const mixed = check.answerQ5({ old: { rows: bankRows([]), window: win }, now, bankAccounts: BANK });
    expect(mixed.answer).toBe('NO');
    expect(mixed.evidence).toMatch(/no accounts listed; this month: 1 listed with no movement, 0 ACTIVE not listed/);
    const zeros = check.answerQ5({ old: { rows: bankRows([{ name: 'Business Cheque' }, { name: 'Savings' }]), window: win }, now, bankAccounts: BANK });
    expect(zeros.answer).toBe('YES');
    const absent = check.answerQ5({ old: { error: 'boom', window: win }, now: { rows: bankRows([{ name: 'Business Cheque', in: 5 }]), window: now.window }, bankAccounts: BANK });
    expect(absent.answer).toBe('NO');
    expect(absent.evidence).toMatch(/1 ACTIVE not listed/);
  });

  it('Q6: a no-budget period the app reads as no budget is YES, zero lines or lines of zeros; a 400 is NO', () => {
    const yes = check.answerQ6({ far: { rows: budgetRows([]) }, next: { rows: BUDGET_NEXT } });
    expect(yes.answer).toBe('YES');
    expect(yes.sections).toEqual(['Income', 'Less Cost of Sales', 'Less Operating Expenses', 'Weird Section']);
    expect(yes.evidence).toMatch(/next 12 months: 6 lines/);
    // What Xero sent on the first live run: lines, every one at nought.
    const zeros = budgetRows([{ title: 'Income', rows: [{ label: 'Sales', value: 0 }] }]);
    expect(check.answerQ6({ far: { rows: zeros }, next: { rows: BUDGET_NEXT } }).answer).toBe('YES');
    const figures = budgetRows([{ title: 'Income', rows: [{ label: 'Sales', value: 40 }] }]);
    expect(check.answerQ6({ far: { rows: figures }, next: { rows: BUDGET_NEXT } }).answer).toBe('UNKNOWN');
    expect(check.answerQ6({ far: { error: 'HTTP 400: no budget', status: 400 }, next: { rows: BUDGET_NEXT } }).answer).toBe('NO');
    expect(check.answerQ6({ far: { error: 'HTTP 500: down', status: 500 }, next: { error: 'down' } }).answer).toBe('UNKNOWN');
  });

  it('Q7: a transfer with a missing leg is NO; all legs found is YES', () => {
    const no = check.answerQ7({ transfers: TRANSFERS, legs: LEGS });
    expect(no.answer).toBe('NO');
    expect(no.evidence).toMatch(/2 transfers, 3\/4 legs found \(3 by ID\), 1 with a leg missing/);
    expect(no.lines.join('\n')).toMatch(/2026-09-10 250\.00: receive leg missing/);
    const legs = [...LEGS, { bankTransactionID: 'bt-x', type: 'RECEIVE-TRANSFER', date: xd('2026-09-10'), total: 250, bankAccount: { accountID: 'acc-1' } }];
    const byMatch = check.answerQ7({ transfers: TRANSFERS, legs });
    expect(byMatch.answer).toBe('YES');                // found by date, amount and account when the ID is not among them
    expect(check.answerQ7({ transfers: [], legs: [] }).answer).toBe('UNKNOWN');
  });

  it('Q8: matches all entries is YES, reconciled only is NO, no unreconciled entries is UNKNOWN', () => {
    const win = { from: '2026-09-01', to: '2026-09-30' };
    const base = { payments: MONTH_PAYMENTS, bankTransactions: MONTH_TX, bankAccounts: BANK, baseCurrency: 'SGD', window: win };
    expect(check.answerQ8({ ...base, rows: BANK_SUMMARIES['2026-09-01'] }).answer).toBe('YES');
    const recOnly = bankRows([{ name: 'Business Cheque', in: 1000, out: 300 }]);
    expect(check.answerQ8({ ...base, rows: recOnly }).answer).toBe('NO');
    const allRec = MONTH_PAYMENTS.map(p => ({ ...p, isReconciled: true }));
    expect(check.answerQ8({ ...base, payments: allRec, rows: BANK_SUMMARIES['2026-09-01'] }).answer).toBe('UNKNOWN');
    expect(check.answerQ8({ ...base, rows: BANK_SUMMARIES['2026-09-01'], capped: true }).answer).toBe('UNKNOWN');
  });

  it('Q8: a payment is counted in the bank account currency', () => {
    expect(check._bankAmountCents({ amount: 100, bankAmount: 74.5 })).toBe(7450);
    expect(check._bankAmountCents({ amount: 150, currencyRate: 1.5 })).toBe(10000);
    expect(check._bankAmountCents({ amount: 12.34 })).toBe(1234);
  });

  it('Q9: a title _sectionKind does not know is NO', () => {
    const no = check.answerQ9({ sections: ['Income', 'Less Cost of Sales', 'Less Operating Expenses', 'Weird Section'] });
    expect(no.answer).toBe('NO');
    expect(no.evidence).toMatch(/"Weird Section"/);
    expect(no.lines.join('\n')).toMatch(/"Income" → revenue/);
    expect(check.answerQ9({ sections: ['Income', 'Less Operating Expenses', 'Plus Other Income'] }).answer).toBe('YES');
    expect(check.answerQ9({ sections: [] }).answer).toBe('UNKNOWN');
  });
});
