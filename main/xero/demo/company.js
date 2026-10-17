// The Demo Company: "Demo Company Pte Ltd", a Singapore B2B trader of goods
// and services, invented here from one fixed seed with a few years of
// history, so a demo account can open every dashboard tab, run every check
// and post a document without a Xero organisation behind it.
//
// Nothing here is copied from anyone. The names are made up, the figures are
// drawn from seeded random numbers (./rng), and the only input is the day it
// is generated for: the history runs from 1 January 2023 to that day, and the
// same day gives the same company on every call.
//
// Consistency is the point. Everything is posted to ONE ledger first — every
// sales invoice, bill, payment, Spend/Receive Money, transfer, credit note,
// payroll run, loan repayment, depreciation and tax journal, each as balanced
// lines on the chart of accounts — and every report the facade answers
// (./reports.js) is derived from that ledger, so the Balance Sheet balances
// to the cent, the Trial Balance agrees with it on the same day, the Bank
// Summary's closing balance is the bank account's ledger balance, and the
// P&L of a month is what the ledger holds for it.
//
// Money is in whole cents throughout (`cents`); the facade (./api.js) turns
// it into the numbers and formatted strings xero-node hands the app.

const { rngFor, guidFor } = require('./rng');

// ── Calendar ────────────────────────────────────────────────────────────────
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad2 = n => String(n).padStart(2, '0');
// A day in a month, held to the month's length.
const iso = (y, m, d) => `${y}-${pad2(m)}-${pad2(Math.min(d, lastDayOfMonth(y, m)))}`;
const parts = day => { const [y, m, d] = day.split('-').map(Number); return { y, m, d }; };
function addDays(day, n) {
  const { y, m, d } = parts(day);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}
const monthKey = day => day.slice(0, 7);
const utcOf = day => { const { y, m, d } = parts(day); return Date.UTC(y, m - 1, d); };
const daysBetween = (a, b) => Math.round((utcOf(b) - utcOf(a)) / 86400000);

const FIRST_YEAR = 2023;
const FIRST_MONTH = `${FIRST_YEAR}-01`;

// GST: 8% through 2023, 9% from 1 January 2024.
const gstPercent = day => (day < '2024-01-01' ? 8 : 9);
const taxOn = (netCents, day) => Math.round(netCents * gstPercent(day) / 100);

// ── The chart of accounts ───────────────────────────────────────────────────
// Xero's standard Singapore chart, with the codes, names, types and system
// accounts Xero issues. `cls` is Xero's Class.
const CHART = [
  ['090', 'Business Bank Account',          'BANK',        'NONE',   'ASSET',     null,            { bank: '021-310044-7' }],
  ['091', 'Business Savings Account',       'BANK',        'NONE',   'ASSET',     null,            { bank: '021-310045-5' }],
  ['200', 'Sales',                          'REVENUE',     'OUTPUT', 'REVENUE'],
  ['260', 'Other Revenue',                  'OTHERINCOME', 'OUTPUT', 'REVENUE'],
  ['270', 'Interest Income',                'OTHERINCOME', 'NONE',   'REVENUE'],
  ['310', 'Cost of Goods Sold',             'DIRECTCOSTS', 'INPUT',  'EXPENSE'],
  ['400', 'Advertising',                    'EXPENSE',     'INPUT',  'EXPENSE'],
  ['404', 'Bank Fees',                      'EXPENSE',     'NONE',   'EXPENSE'],
  ['408', 'Cleaning',                       'EXPENSE',     'INPUT',  'EXPENSE'],
  ['412', 'Consulting & Accounting',        'EXPENSE',     'INPUT',  'EXPENSE'],
  ['416', 'Depreciation',                   'DEPRECIATN',  'NONE',   'EXPENSE'],
  ['420', 'Entertainment',                  'EXPENSE',     'INPUT',  'EXPENSE'],
  ['425', 'Freight & Courier',              'EXPENSE',     'INPUT',  'EXPENSE'],
  ['429', 'General Expenses',               'EXPENSE',     'INPUT',  'EXPENSE'],
  ['433', 'Insurance',                      'EXPENSE',     'INPUT',  'EXPENSE'],
  ['437', 'Interest Expense',               'EXPENSE',     'NONE',   'EXPENSE'],
  ['441', 'Legal expenses',                 'EXPENSE',     'INPUT',  'EXPENSE'],
  ['445', 'Light, Power, Heating',          'EXPENSE',     'INPUT',  'EXPENSE'],
  ['449', 'Motor Vehicle Expenses',         'EXPENSE',     'INPUT',  'EXPENSE'],
  ['453', 'Office Expenses',                'EXPENSE',     'INPUT',  'EXPENSE'],
  ['461', 'Printing & Stationery',          'EXPENSE',     'INPUT',  'EXPENSE'],
  ['469', 'Rent',                           'EXPENSE',     'INPUT',  'EXPENSE'],
  ['473', 'Repairs and Maintenance',        'EXPENSE',     'INPUT',  'EXPENSE'],
  ['477', 'Wages and Salaries',             'EXPENSE',     'NONE',   'EXPENSE'],
  ['478', 'CPF Contributions',              'EXPENSE',     'NONE',   'EXPENSE'],
  ['485', 'Subscriptions',                  'EXPENSE',     'INPUT',  'EXPENSE'],
  ['489', 'Telephone & Internet',           'EXPENSE',     'INPUT',  'EXPENSE'],
  ['493', 'Travel - National',              'EXPENSE',     'INPUT',  'EXPENSE'],
  ['494', 'Travel - International',         'EXPENSE',     'NONE',   'EXPENSE'],
  ['505', 'Income Tax Expense',             'EXPENSE',     'NONE',   'EXPENSE'],
  ['610', 'Accounts Receivable',            'CURRENT',     'NONE',   'ASSET',     'DEBTORS'],
  ['620', 'Prepayments',                    'PREPAYMENT',  'NONE',   'ASSET'],
  ['630', 'Inventory',                      'INVENTORY',   'NONE',   'ASSET'],
  ['710', 'Office Equipment',               'FIXED',       'INPUT',  'ASSET'],
  ['711', 'Less Accumulated Depreciation on Office Equipment',   'FIXED', 'NONE', 'ASSET'],
  ['720', 'Computer Equipment',             'FIXED',       'INPUT',  'ASSET'],
  ['721', 'Less Accumulated Depreciation on Computer Equipment', 'FIXED', 'NONE', 'ASSET'],
  ['800', 'Accounts Payable',               'CURRLIAB',    'NONE',   'LIABILITY', 'CREDITORS'],
  ['801', 'Unpaid Expense Claims',          'CURRLIAB',    'NONE',   'LIABILITY', 'UNPAIDEXPCLM'],
  ['814', 'Wages Payable',                  'CURRLIAB',    'NONE',   'LIABILITY', 'WAGEPAYABLES'],
  ['820', 'GST',                            'CURRLIAB',    'NONE',   'LIABILITY', 'GST'],
  ['826', 'CPF Payable',                    'CURRLIAB',    'NONE',   'LIABILITY'],
  ['830', 'Income Tax Payable',             'CURRLIAB',    'NONE',   'LIABILITY'],
  ['835', 'Historical Adjustment',          'CURRLIAB',    'NONE',   'LIABILITY', 'HISTORICAL'],
  ['840', 'Rounding',                       'CURRLIAB',    'NONE',   'LIABILITY', 'ROUNDING'],
  ['850', 'Suspense',                       'CURRLIAB',    'NONE',   'LIABILITY'],
  ['860', 'Loan',                           'TERMLIAB',    'NONE',   'LIABILITY'],
  ['880', 'Owner A Drawings',               'EQUITY',      'NONE',   'EQUITY'],
  ['881', 'Owner A Funds Introduced',       'EQUITY',      'NONE',   'EQUITY'],
  ['960', 'Retained Earnings',              'EQUITY',      'NONE',   'EQUITY',    'RETAINEDEARNINGS'],
  ['970', 'Owner A Share Capital',          'EQUITY',      'NONE',   'EQUITY'],
];
const PNL_TYPES = new Set(['REVENUE', 'OTHERINCOME', 'DIRECTCOSTS', 'EXPENSE', 'DEPRECIATN']);

function buildAccounts() {
  return CHART.map(([code, name, type, taxType, cls, systemAccount, extra]) => ({
    accountID: guidFor('account', code), code, name, type, taxType, _class: cls, status: 'ACTIVE',
    systemAccount: systemAccount || '', description: '',
    bankAccountNumber: extra?.bank || '', bankAccountType: type === 'BANK' ? 'BANK' : '',
    currencyCode: type === 'BANK' ? 'SGD' : '',
    enablePaymentsToAccount: type === 'BANK' || type === 'CURRLIAB', showInExpenseClaims: type === 'EXPENSE' || type === 'DIRECTCOSTS',
    reportingCode: '', reportingCodeName: '', hasAttachments: false,
    updatedDateUTC: new Date('2022-12-01T02:15:00Z'),
    isPnl: PNL_TYPES.has(type),
  }));
}

// ── Tax rates ───────────────────────────────────────────────────────────────
function buildTaxRates() {
  const rate = (name, taxType, pct, { expenses, revenue, status = 'ACTIVE', reportTaxType = 'INPUT' }) => ({
    name, taxType, status, reportTaxType,
    taxComponents: [{ name: 'GST', rate: pct, isCompound: false, isNonRecoverable: false }],
    displayTaxRate: pct, effectiveRate: pct,
    canApplyToAssets: true, canApplyToEquity: false, canApplyToExpenses: expenses, canApplyToLiabilities: true, canApplyToRevenue: revenue,
  });
  return [
    rate('Standard-Rated Supplies',  'OUTPUT',          9, { expenses: false, revenue: true,  reportTaxType: 'OUTPUT' }),
    rate('Standard-Rated Purchases', 'INPUT',           9, { expenses: true,  revenue: false }),
    rate('No Tax',                   'NONE',            0, { expenses: true,  revenue: true,  reportTaxType: 'NONE' }),
    rate('Zero-Rated Supplies',      'ZERORATEDOUTPUT', 0, { expenses: false, revenue: true,  reportTaxType: 'OUTPUT' }),
    rate('Zero-Rated Purchases',     'ZERORATEDINPUT',  0, { expenses: true,  revenue: false }),
    rate('Exempt Supplies',          'EXEMPTOUTPUT',    0, { expenses: false, revenue: true,  reportTaxType: 'EXEMPTOUTPUT' }),
    rate('Exempt Purchases',         'EXEMPTINPUT',     0, { expenses: true,  revenue: false, reportTaxType: 'EXEMPTINPUT' }),
    rate('Standard-Rated Supplies (8%)',  'OUTPUT8', 8, { expenses: false, revenue: true, status: 'ARCHIVED', reportTaxType: 'OUTPUT' }),
    rate('Standard-Rated Purchases (8%)', 'INPUT8',  8, { expenses: true,  revenue: false, status: 'ARCHIVED' }),
  ];
}

// ── The people the company deals with ───────────────────────────────────────
// Customers: [name, email, typical invoice (S$), weight, paying habit, terms].
// Orchid Grove is invoiced every month and pays two months late, so the aged
// receivables always carry something long overdue; Lion City Events is
// invoiced every other month and pays late; Toa Payoh is the retainer, raised
// from a repeating template.
const CUSTOMERS = [
  ['Harbourline Logistics Pte Ltd',          'accounts@harbourline.example.sg',    42000, 5, 'ontime',  30],
  ['Meridian Fitouts Pte Ltd',               'ap@meridianfitouts.example.sg',      36000, 4, 'late10',  30],
  ['Tan & Lim Associates',                   'finance@tanlim.example.sg',           9000, 3, 'early',   14],
  ['Keppel Vista Hospitality Pte Ltd',       'payables@keppelvista.example.sg',    18000, 3, 'late20',  30],
  ['Orchid Grove Clinics',                   'admin@orchidgrove.example.sg',        7500, 0, 'chronic', 30],
  ['Straits Marine Supplies Pte Ltd',        'accounts@straitsmarine.example.sg',  22000, 3, 'ontime',  30],
  ['Jurong Precision Engineering Pte Ltd',   'ap@jurongprecision.example.sg',      38000, 4, 'late10',  45],
  ['Bukit Timah Learning Centre',            'office@btlc.example.sg',              4500, 2, 'early',   14],
  ['Lion City Events Pte Ltd',               'finance@lioncityevents.example.sg',  11000, 0, 'late20',  30],
  ['Novena Dental Group',                    'accounts@novenadental.example.sg',    8500, 3, 'ontime',  30],
  ['Sentosa Resorts Management',             'payables@sentosaresorts.example.sg', 30000, 3, 'late20',  30],
  ['Changi Freight Forwarders Pte Ltd',      'ap@changifreight.example.sg',        16000, 3, 'ontime',  30],
  ['Tampines Retail Holdings',               'finance@tampinesretail.example.sg',  14000, 3, 'late10',  30],
  ['Raffles Quay Advisory LLP',              'accounts@rafflesquay.example.sg',    12000, 2, 'early',   14],
  ['Pasir Ris Community Services',           'admin@prcs.example.sg',               5000, 2, 'ontime',  30],
  ['Woodlands Food Manufacturing Pte Ltd',   'ap@woodlandsfood.example.sg',        34000, 4, 'late10',  30],
  ['Clementi Tech Labs Pte Ltd',             'finance@clementitech.example.sg',    15000, 3, 'ontime',  30],
  ['Marina Bay Interiors',                   'accounts@mbinteriors.example.sg',    20000, 2, 'late20',  30],
  ['Ang Mo Kio Auto Services',               'office@amkauto.example.sg',           4000, 2, 'ontime',  14],
  ['Serangoon Garden Landscapes',            'admin@sglandscapes.example.sg',       6000, 2, 'late10',  30],
  ['Punggol Digital Pte Ltd',                'ap@punggoldigital.example.sg',       13000, 3, 'early',   30],
  ['Kallang Sports Academy',                 'finance@kallangsports.example.sg',    5500, 2, 'late20',  30],
  ['Bedok Logistics Hub Pte Ltd',            'accounts@bedoklogistics.example.sg', 17000, 3, 'ontime',  30],
  ['Holland Village Boutique Hotels',        'payables@hvbh.example.sg',           19000, 3, 'late10',  30],
  ['Toa Payoh Healthcare Services Pte Ltd',  'accounts@tphs.example.sg',           12000, 0, 'early',   30],
];
// Which days after the due date each habit pays on.
const HABITS = {
  early:   [-6, -2], ontime: [0, 3], late10: [5, 12], late20: [14, 24], chronic: [62, 80],
};

// Suppliers: [name, email, account code, kind, typical net (S$), terms, days
// we take to pay]. Goods suppliers share the cost of sales; the rest bill
// their overhead on a schedule (`every` months, or a chance per month).
const SUPPLIERS = [
  ['Westgate Commercial Properties Pte Ltd', 'leasing@westgatecp.example.sg',   '469', 'rent',     8500,  7,  [2, 5]],
  ['Pacific Trade Distributors Pte Ltd',     'ar@pacifictrade.example.sg',      '310', 'goods',    0,     30, [14, 24]],
  ['Shenton Industrial Supplies',            'accounts@shentonind.example.sg',  '310', 'goods',    0,     14, [28, 40]],
  ['Eastpoint Wholesale Pte Ltd',            'billing@eastpointwh.example.sg',  '310', 'goods',    0,     30, [12, 20]],
  ['Meridian Components Asia',               'ar@meridiancomponents.example.sg','310', 'goods',    0,     30, [15, 25]],
  ['Tuas Materials Co',                      'accounts@tuasmaterials.example.sg','310', 'goods',   0,     30, [10, 18]],
  ['Island Power Services',                  'billing@islandpower.example.sg',  '445', 'monthly',  1150,  21, [8, 14]],
  ['Starline Telecom Pte Ltd',               'billing@starline.example.sg',     '489', 'monthly',  440,   21, [6, 12]],
  ['CloudStack Software Pte Ltd',            'ar@cloudstack.example.sg',        '485', 'monthly',  900,   14, [4, 10]],
  ['Bright Ideas Media',                     'accounts@brightideas.example.sg', '400', 'monthly',  3000,  14, [24, 34]],
  ['Lim & Partners Chartered Accountants',   'office@limpartners.example.sg',   '412', 'monthly',  1500,  30, [12, 20]],
  ['SparkleClean Services',                  'admin@sparkleclean.example.sg',   '408', 'monthly',  600,   14, [5, 11]],
  ['SwiftCourier Express Pte Ltd',           'billing@swiftcourier.example.sg', '425', 'freight',  650,   14, [26, 38]],
  ['Guardian Assurance Pte Ltd',             'policies@guardianassure.example.sg','620', 'insurance', 6000, 14, [12, 15]],
  ['Chua Legal LLC',                         'accounts@chualegal.example.sg',   '441', 'sometimes', 2500, 30, [14, 24]],
  ['AutoCare Workshop',                      'service@autocare.example.sg',     '449', 'monthly',  780,   14, [16, 24]],
  ['OfficeMart Supplies',                    'orders@officemart.example.sg',    '453', 'monthly',  520,   30, [10, 20]],
  ['FixIt Facilities Pte Ltd',               'jobs@fixitfacilities.example.sg', '473', 'sometimes', 1400, 30, [10, 20]],
  ['Skyways Travel Agency',                  'bookings@skyways.example.sg',     '493', 'sometimes', 1200, 14, [5, 10]],
  ['TechHub Equipment Pte Ltd',              'sales@techhub.example.sg',        '720', 'equipment', 0,    30, [0, 0]],
];
// Contacts that are neither customers nor suppliers in the ordinary sense.
const OTHERS = [
  ['DBS Bank Ltd', 'business@dbs.example.sg'],
  ['IRAS', 'gst@iras.example.sg'],
  ['CPF Board', 'employer@cpf.example.sg'],
  ['Payroll', ''],
  ['Alicia Tan (Director)', 'alicia@democompany.example.sg'],
  ['SG Enterprise Grants Office', 'grants@sgego.example.sg'],
];

function buildContacts() {
  const stamp = new Date('2023-01-02T01:00:00Z');
  const contact = (name, email, { isCustomer = false, isSupplier = false, sales = null, purchases = null } = {}) => ({
    contactID: guidFor('contact', name), contactStatus: 'ACTIVE', name, emailAddress: email,
    isCustomer, isSupplier, firstName: '', lastName: '',
    accountsReceivableTaxType: isCustomer ? 'OUTPUT' : null, accountsPayableTaxType: isSupplier ? 'INPUT' : null,
    salesDefaultAccountCode: sales, purchasesDefaultAccountCode: purchases,
    defaultCurrency: 'SGD', addresses: [], phones: [], contactPersons: [], hasAttachments: false, hasValidationErrors: false,
    updatedDateUTC: stamp,
  });
  const customers = CUSTOMERS.map(([name, email, size, weight, habit, terms]) =>
    ({ ...contact(name, email, { isCustomer: true, sales: '200' }), _size: size, _weight: weight, _habit: habit, _terms: terms }));
  const suppliers = SUPPLIERS.map(([name, email, code, kind, amount, terms, pay]) =>
    ({ ...contact(name, email, { isSupplier: true, purchases: code }), _code: code, _kind: kind, _amount: amount, _terms: terms, _pay: pay }));
  const others = OTHERS.map(([name, email]) => contact(name, email));
  return { customers, suppliers, others, all: [...customers, ...suppliers, ...others] };
}

// ── The business ────────────────────────────────────────────────────────────
// Revenue of about S$1.6M in 2023, growing about a fifth a year (S$2.4M in
// 2025); Q4 the strongest quarter, February the weakest.
const SEASON = [0.88, 0.78, 0.95, 0.98, 1.00, 1.02, 0.98, 1.00, 1.05, 1.08, 1.12, 1.16];
const GROWTH = 1.20;
const yearRevenue = y => Math.round(1600000 * Math.pow(GROWTH, y - FIRST_YEAR));
const monthRevenue = (y, m) => Math.round(yearRevenue(y) / 12 * SEASON[m - 1]);
// Gross wages a month, by year; CPF at 17% employer and 20% employee. Set so
// the net margin before tax stays between 8% and 14% as the revenue grows.
const WAGES = { 2023: 32000, 2024: 41000, 2025: 51000, 2026: 64000 };
const monthWages = y => (WAGES[y] || Math.round(WAGES[2026] * Math.pow(1.18, y - 2026)));
const CPF_EMPLOYER = 0.17, CPF_EMPLOYEE = 0.20;
const COGS_SHARE = 0.45;
// Overheads drift up a little each year.
const inflate = (amount, y) => Math.round(amount * (1 + 0.06 * (y - FIRST_YEAR)));

const LOAN = { amount: 200000, rate: 0.06, months: 60, drawn: '2023-02-10', firstPayment: '2023-03' };
// PMT of a 60-month 6% loan, to the cent.
const LOAN_PAYMENT_CENTS = Math.round(LOAN.amount * 100 * (LOAN.rate / 12) / (1 - Math.pow(1 + LOAN.rate / 12, -LOAN.months)));
const SHARE_CAPITAL = 150000;
const SAVINGS_RATE = 0.025;
const DRAWINGS = { 12: 110000, 6: 25000 }; // dividends: every December from 2023, every June from 2024
// Customers' typical invoices in the table above are scaled up: fewer, larger
// invoices keep the open sales invoices to about ten at a time.
const INVOICE_SCALE = 1.8;
const INCOME_TAX_RATE = 0.17 * 0.85;        // 17% after partial exemption, roughly

// ── The ledger ──────────────────────────────────────────────────────────────
// A journal is balanced lines on account codes: debit positive, credit
// negative, in cents. `meta` ties it to the document it came from.
class Book {
  constructor() { this.journals = []; }
  post(date, kind, lines, meta = {}) {
    const clean = lines.filter(([, cents]) => cents !== 0).map(([code, cents]) => [code, Math.round(cents)]);
    const sum = clean.reduce((s, [, c]) => s + c, 0);
    if (sum !== 0) throw new Error(`Demo Company: journal does not balance on ${date} (${kind}): ${sum}`);
    this.journals.push({ id: this.journals.length + 1, date, kind, lines: clean, ...meta });
  }
}

const round = (cents, to = 100) => Math.round(cents / to) * to;

// One line of a document: a net amount on an account, taxed by the account's
// tax type on the document's day.
function line(code, netCents, description, day, { taxType = null } = {}) {
  const type = taxType ?? (CHART.find(a => a[0] === code) || [])[3] ?? 'NONE';
  const taxed = type === 'OUTPUT' || type === 'INPUT';
  return { code, net: netCents, tax: taxed ? taxOn(netCents, day) : 0, taxType: type, description };
}
const totalOf = lines => lines.reduce((s, l) => s + l.net + l.tax, 0);
const netOf   = lines => lines.reduce((s, l) => s + l.net, 0);
const taxOf   = lines => lines.reduce((s, l) => s + l.tax, 0);

// ── Generating ──────────────────────────────────────────────────────────────

function generate(todayISO) {
  const today = parts(todayISO);
  const accounts = buildAccounts();
  const byCode = new Map(accounts.map(a => [a.code, a]));
  const contacts = buildContacts();
  const C = Object.fromEntries(contacts.all.map(c => [c.name, c]));
  const book = new Book();

  const invoices = [], payments = [], bankTransactions = [], bankTransfers = [], creditNotes = [];
  const state = {
    invoiceSeq: 0, billSeq: new Map(), paymentSeq: 0, txSeq: 0, journalSeq: 0, creditSeq: 0,
    loanBalance: 0, savings: 0, prepaidInsurance: 0, depreciation: [], lastPayroll: null, taxProvision: {},
    quarterGst: 0, pendingCredits: new Map(), // customer name -> [{ kind, cents, from }]
  };

  // ── Documents ──
  const sequential = n => String(n).padStart(4, '0');

  function invoiceRecord({ type, contact, date, due, lines, reference = '', repeatingInvoiceID = null, number = null, seqKey = null }) {
    let invoiceNumber = number;
    if (!invoiceNumber) {
      if (type === 'ACCREC') invoiceNumber = `INV-${sequential(++state.invoiceSeq)}`;
      else {
        const n = (state.billSeq.get(seqKey) || 0) + 1;
        state.billSeq.set(seqKey, n);
        invoiceNumber = `${seqKey}-${date.slice(0, 4)}-${String(n).padStart(3, '0')}`;
      }
    }
    const inv = {
      invoiceID: guidFor('invoice', type, invoiceNumber, date), type, invoiceNumber, reference, contact,
      date, dueDate: due, lines, subTotal: netOf(lines), totalTax: taxOf(lines), total: totalOf(lines),
      repeatingInvoiceID, settlements: [], expectedPaymentDate: null, plannedPaymentDate: null,
    };
    invoices.push(inv);
    const ar = type === 'ACCREC';
    book.post(date, ar ? 'invoice' : 'bill', [
      [ar ? '610' : '800', ar ? inv.total : -inv.total],
      ...lines.map(l => [l.code, ar ? -l.net : l.net]),
      ['820', ar ? -inv.totalTax : inv.totalTax],
    ], { invoiceID: inv.invoiceID });
    return inv;
  }

  // A payment against an invoice, through the current account.
  function pay(inv, date, cents, { reference = '' } = {}) {
    if (cents <= 0) return;
    const ar = inv.type === 'ACCREC';
    const p = {
      paymentID: guidFor('payment', inv.invoiceID, date, ++state.paymentSeq), invoice: inv, date, amount: cents,
      paymentType: ar ? 'ACCRECPAYMENT' : 'ACCPAYPAYMENT', bankCode: '090', reference,
    };
    payments.push(p);
    inv.settlements.push({ kind: 'payment', date, cents, payment: p });
    book.post(date, 'payment', [['090', ar ? cents : -cents], [ar ? '610' : '800', ar ? -cents : cents]], { invoiceID: inv.invoiceID, paymentID: p.paymentID });
  }

  // Money in or out with no invoice behind it.
  function bankTx({ type, date, contact = null, bank = '090', lines, reference = '', isReconciled = true, extra = {}, meta = {} }) {
    const receive = /^RECEIVE/.test(type);
    const total = totalOf(lines);
    const t = {
      bankTransactionID: guidFor('banktx', type, date, ++state.txSeq), type, date, contact, bankCode: bank,
      lines, subTotal: netOf(lines), totalTax: taxOf(lines), total, reference, isReconciled, ...extra,
    };
    bankTransactions.push(t);
    book.post(date, 'banktx', [
      [bank, receive ? total : -total],
      ...lines.map(l => [l.code, receive ? -l.net : l.net]),
      ['820', receive ? -t.totalTax : t.totalTax],
    ], { bankTransactionID: t.bankTransactionID, receive, ...meta });
    return t;
  }

  function transfer(date, cents, reference) {
    const from = bankTx({ type: 'SPEND-TRANSFER', date, lines: [line('091', cents, 'Transfer to savings', date, { taxType: 'NONE' })], reference });
    const to   = bankTx({ type: 'RECEIVE-TRANSFER', date, bank: '091', lines: [line('090', cents, 'Transfer from current account', date, { taxType: 'NONE' })], reference });
    // The two legs posted the whole transfer twice (one Dr 091 / Cr 090 each);
    // undo one so the ledger moves the money once.
    book.journals.pop();
    bankTransfers.push({
      bankTransferID: guidFor('transfer', date, cents), date, amount: cents, reference,
      fromBankCode: '090', toBankCode: '091', fromBankTransactionID: from.bankTransactionID, toBankTransactionID: to.bankTransactionID,
    });
    state.savings += cents;
  }

  function journal(date, kind, lines, narration) {
    book.post(date, kind, lines, { narration, manualJournalID: guidFor('journal', kind, date, ++state.journalSeq) });
  }

  // ── Sales ──
  const weighted = CUSTOMERS.filter(c => c[3] > 0);
  const weightSum = weighted.reduce((s, c) => s + c[3], 0);
  function pickCustomer(rng) {
    let r = rng.float(0, weightSum);
    for (const c of weighted) { r -= c[3]; if (r <= 0) return C[c[0]]; }
    return C[weighted[weighted.length - 1][0]];
  }
  const SERVICES = ['Consulting services', 'Installation and commissioning', 'Maintenance visit', 'Project management', 'Technical support', 'Training workshop'];
  const GOODS    = ['Industrial fittings', 'Control units', 'Replacement parts', 'Safety equipment', 'Cabling and connectors', 'Mounting hardware'];

  function salesInvoice(rng, customer, date, netCents, { reference = '', repeatingInvoiceID = null, lineLabels = null } = {}) {
    const n = lineLabels ? lineLabels.length : rng.int(1, 3);
    const lines = [];
    let left = netCents;
    for (let i = 0; i < n; i++) {
      const share = i === n - 1 ? left : round(left * rng.float(0.3, 0.7));
      left -= share;
      const label = lineLabels ? lineLabels[i] : (rng.chance(0.5) ? rng.pick(SERVICES) : rng.pick(GOODS));
      lines.push(line('200', share, label, date));
    }
    const due = addDays(date, customer._terms);
    const inv = invoiceRecord({ type: 'ACCREC', contact: customer, date, due, lines, reference, repeatingInvoiceID });
    // When it is paid: the customer's habit, plus credit already owed to them.
    const [lo, hi] = HABITS[customer._habit];
    const paidOn = addDays(due, rng.int(lo, hi));
    let owed = inv.total;
    const credits = state.pendingCredits.get(customer.name) || [];
    while (credits.length && owed > 0) {
      const cr = credits.shift();
      const take = Math.min(cr.cents, owed);
      const when = cr.from > date ? cr.from : date;
      inv.settlements.push({ kind: cr.kind, date: when, cents: take, source: cr.source });
      cr.onAllocate?.(inv, take, when);
      owed -= take;
      if (cr.cents > take) credits.unshift({ ...cr, cents: cr.cents - take });
    }
    // Every fifteenth invoice is paid in two parts.
    if (owed > 0 && state.invoiceSeq % 15 === 0) {
      const part = round(owed / 2);
      pay(inv, addDays(due, -2), part, { reference: 'Part payment' });
      owed -= part;
    }
    pay(inv, paidOn, owed);
    inv.paidOn = paidOn;
    return inv;
  }

  function bill(rng, supplier, date, lines, { reference = '', repeatingInvoiceID = null, seqKey } = {}) {
    const due = addDays(date, supplier._terms);
    const inv = invoiceRecord({ type: 'ACCPAY', contact: supplier, date, due, lines, reference, repeatingInvoiceID, seqKey: seqKey || supplier._key });
    const paidOn = addDays(date, rng.int(supplier._pay[0], supplier._pay[1]));
    let owed = inv.total;
    const credits = state.pendingCredits.get(supplier.name) || [];
    while (credits.length && owed > 0) {
      const cr = credits.shift();
      const take = Math.min(cr.cents, owed);
      const when = cr.from > date ? cr.from : date;
      inv.settlements.push({ kind: cr.kind, date: when, cents: take, source: cr.source });
      cr.onAllocate?.(inv, take, when);
      owed -= take;
    }
    pay(inv, paidOn, owed);
    inv.paidOn = paidOn;
    return inv;
  }
  for (const s of contacts.suppliers) s._key = s.name.split(/\s+/).map(w => w[0]).join('').replace(/[^A-Z]/g, '').slice(0, 3);

  // A credit note against a customer (or from a supplier), applied to their
  // next invoice unless it is to stay unallocated.
  function creditNote(date, contact, netCents, reason, { allocate = true } = {}) {
    const ar = contact.isCustomer;
    const lines = [line(ar ? '200' : '310', netCents, reason, date)];
    const cn = {
      creditNoteID: guidFor('creditnote', date, contact.name), creditNoteNumber: `CN-${String(++state.creditSeq).padStart(4, '0')}`,
      type: ar ? 'ACCRECCREDIT' : 'ACCPAYCREDIT', contact, date, lines, reference: reason,
      subTotal: netOf(lines), totalTax: taxOf(lines), total: totalOf(lines), allocations: [],
    };
    creditNotes.push(cn);
    book.post(date, 'creditnote', [
      [ar ? '610' : '800', ar ? -cn.total : cn.total],
      ...lines.map(l => [l.code, ar ? l.net : -l.net]),
      ['820', ar ? cn.totalTax : -cn.totalTax],
    ], { creditNoteID: cn.creditNoteID });
    if (allocate) {
      const list = state.pendingCredits.get(contact.name) || [];
      list.push({ kind: 'credit', cents: cn.total, from: date, source: cn, onAllocate: (inv, cents, when) => cn.allocations.push({ invoice: inv, amount: cents, date: when }) });
      state.pendingCredits.set(contact.name, list);
    }
    return cn;
  }

  // ── The months ──
  const endMonth = `${today.y}-${pad2(today.m)}`;
  const landlord = C['Westgate Commercial Properties Pte Ltd'];
  const retainer = C['Toa Payoh Healthcare Services Pte Ltd'];
  let y = FIRST_YEAR, m = 1;
  while (`${y}-${pad2(m)}` <= endMonth) {
    const ym = `${y}-${pad2(m)}`;
    const rng = rngFor('month', ym);
    const day = d => iso(y, m, d);
    const eom = day(31);

    // Capital and the loan, in the first weeks.
    if (ym === FIRST_MONTH) {
      bankTx({ type: 'RECEIVE', date: day(3), contact: C['Alicia Tan (Director)'], lines: [line('970', SHARE_CAPITAL * 100, 'Share capital', day(3), { taxType: 'NONE' })], reference: 'Share capital' });
      transfer(day(20), 80000 * 100, 'Opening savings');
    }
    if (ym === '2023-02') {
      bankTx({ type: 'RECEIVE', date: LOAN.drawn, contact: C['DBS Bank Ltd'], lines: [line('860', LOAN.amount * 100, 'Business term loan drawdown', LOAN.drawn, { taxType: 'NONE' })], reference: 'Term loan' });
      state.loanBalance = LOAN.amount * 100;
    }

    // Rent on the 1st, raised from the repeating bill template.
    bill(rng, landlord, day(1), [line('469', 850000, 'Office rent, unit 03-12 Westgate Tower', day(1))],
      { reference: `Rent ${MONTHS_SHORT[m - 1]} ${y}`, repeatingInvoiceID: guidFor('repeating', 'rent') });

    // The retainer on the 1st, raised from the repeating sales template.
    salesInvoice(rng, retainer, day(1), 1200000, {
      reference: `Monthly retainer ${MONTHS_SHORT[m - 1]} ${y}`, repeatingInvoiceID: guidFor('repeating', 'retainer'),
      lineLabels: ['Monthly managed services retainer'],
    });

    // Loan repayment on the 5th: interest then principal.
    if (state.loanBalance > 0 && ym >= LOAN.firstPayment) {
      const interest = Math.round(state.loanBalance * LOAN.rate / 12);
      const principal = Math.min(state.loanBalance, LOAN_PAYMENT_CENTS - interest);
      bankTx({ type: 'SPEND', date: day(5), contact: C['DBS Bank Ltd'], reference: 'Term loan repayment', lines: [
        line('860', principal, 'Loan principal', day(5), { taxType: 'NONE' }),
        line('437', interest, 'Loan interest', day(5), { taxType: 'NONE' }),
      ] });
      state.loanBalance -= principal;
    }

    // Last month's CPF, paid on the 14th.
    if (state.lastPayroll) {
      bankTx({ type: 'SPEND', date: day(14), contact: C['CPF Board'], reference: `CPF contributions ${state.lastPayroll.label}`,
        lines: [line('826', state.lastPayroll.cpf, 'CPF contributions', day(14), { taxType: 'NONE' })] });
      state.lastPayroll = null;
    }

    // GST for the quarter just ended, paid (or refunded) on the 25th of the
    // month after it: the net of every tax line dated in the quarter.
    if ([1, 4, 7, 10].includes(m) && ym !== FIRST_MONTH) {
      const qEnd = addDays(day(1), -1);
      const qStart = iso(parts(qEnd).y, parts(qEnd).m - 2, 1);
      let net = 0;
      for (const j of book.journals) {
        if (j.date < qStart || j.date > qEnd || j.gst) continue;
        for (const [code, cents] of j.lines) if (code === '820') net += cents;
      }
      // Credit balance (negative) is owed to IRAS.
      if (net < 0) {
        bankTx({ type: 'SPEND', date: day(25), contact: C['IRAS'], reference: `GST F5 quarter to ${qEnd}`, lines: [line('820', -net, 'GST payment', day(25), { taxType: 'NONE' })], meta: { gst: true } });
      } else if (net > 0) {
        bankTx({ type: 'RECEIVE', date: day(25), contact: C['IRAS'], reference: `GST refund quarter to ${qEnd}`, lines: [line('820', net, 'GST refund', day(25), { taxType: 'NONE' })], meta: { gst: true } });
      }
    }

    // Last year's income tax, paid in November.
    if (m === 11 && state.taxProvision[y - 1] > 0) {
      bankTx({ type: 'SPEND', date: day(20), contact: C['IRAS'], reference: `Income tax YA${y}`, lines: [line('830', state.taxProvision[y - 1], 'Corporate income tax', day(20), { taxType: 'NONE' })] });
    }

    // Insurance for the year, billed in January and prepaid; a twelfth expensed each month.
    if (m === 1) {
      const ins = C['Guardian Assurance Pte Ltd'];
      bill(rng, ins, day(5), [line('620', inflate(600000, y), 'Business insurance, annual premium', day(5), { taxType: 'INPUT' })], { reference: `Policy ${y}` });
      state.prepaidInsurance = inflate(600000, y);
      state.insuranceMonthly = Math.round(state.prepaidInsurance / 12);
    }
    if (state.prepaidInsurance > 0) {
      const amt = Math.min(state.prepaidInsurance, state.insuranceMonthly);
      journal(eom, 'prepayment', [['433', amt], ['620', -amt]], 'Insurance expensed for the month');
      state.prepaidInsurance -= amt;
    }

    // Sales for the month, to a seasonal target, in 1–3 line invoices. The
    // retainer and the two monthly customers below are part of the target.
    const target = monthRevenue(y, m) * 100 - 1200000 - 750000 - 1100000;
    let raised = 0;
    const dates = [];
    for (let k = 0; raised < target * 0.97; k++) {
      const r = rngFor('sale', ym, k);
      const customer = pickCustomer(r);
      let net = round(customer._size * 100 * INVOICE_SCALE * r.float(0.65, 1.35), 1000);
      // The last invoice of the month is cut to what is left of the target.
      if (raised + net > target) net = Math.max(round(target - raised, 1000), 300000);
      const d = day(r.int(2, 28));
      dates.push(d);
      salesInvoice(r, customer, d, net);
      raised += net;
    }
    // The slow payers, invoiced on their own days: Orchid Grove every month,
    // Lion City Events every other month for twice as much.
    salesInvoice(rngFor('orchid', ym), C['Orchid Grove Clinics'], day(10), round(750000 * rngFor('orchid-amt', ym).float(0.85, 1.15), 1000));
    if (m % 2 === 0) salesInvoice(rngFor('lion', ym), C['Lion City Events Pte Ltd'], day(24), round(2200000 * rngFor('lion-amt', ym).float(0.8, 1.2), 1000));

    // Cost of sales: goods bought from five suppliers, about 45% of the
    // month's sales, in 4–7 bills.
    const monthSales = raised + 1200000 + 750000 + (m % 2 === 0 ? 2200000 : 0);
    const goods = contacts.suppliers.filter(s => s._kind === 'goods');
    const nBills = rng.int(4, 7);
    let cogsLeft = Math.round(monthSales * COGS_SHARE);
    for (let k = 0; k < nBills; k++) {
      const r = rngFor('cogs', ym, k);
      const supplier = r.pick(goods);
      const net = k === nBills - 1 ? round(cogsLeft, 100) : round(cogsLeft / (nBills - k) * r.float(0.7, 1.3), 100);
      cogsLeft -= net;
      if (net <= 0) continue;
      const d = day(r.int(1, 27));
      bill(r, supplier, d, [line('310', net, r.pick(GOODS), d)], { reference: `PO-${y}${pad2(m)}-${k + 1}` });
    }

    // Overheads, each supplier on its schedule.
    for (const s of contacts.suppliers) {
      const r = rngFor('overhead', ym, s.name);
      const d = day(r.int(3, 26));
      if (s._kind === 'monthly') {
        bill(r, s, d, [line(s._code, round(inflate(s._amount * 100, y) * r.float(0.85, 1.15), 100), `${byCode.get(s._code).name} for ${MONTHS_SHORT[m - 1]}`, d)]);
      } else if (s._kind === 'freight') {
        for (let k = 0, n = r.int(1, 3); k < n; k++) {
          const dd = day(r.int(2, 27));
          bill(r, s, dd, [line('425', round(inflate(s._amount * 100, y) * r.float(0.5, 1.6), 100), 'Freight and courier charges', dd)]);
        }
      } else if (s._kind === 'sometimes' && r.chance(0.3)) {
        const code = s._code === '493' && r.chance(0.35) ? '494' : s._code;
        bill(r, s, d, [line(code, round(inflate(s._amount * 100, y) * r.float(0.6, 2.2), 100), byCode.get(code).name, d)]);
      }
    }

    // Spend Money: bank fees, a little entertainment, the odd general expense.
    bankTx({ type: 'SPEND', date: day(28), contact: C['DBS Bank Ltd'], reference: 'Account fees', lines: [line('404', 4500, 'Monthly account fee', day(28), { taxType: 'NONE' })], isReconciled: true });
    for (let k = 0, n = rng.int(1, 2); k < n; k++) {
      const d = day(rng.int(4, 27));
      bankTx({ type: 'SPEND', date: d, contact: null, reference: 'Client lunch', lines: [line('420', round(rng.float(12000, 48000), 100), 'Client entertainment', d)] });
    }
    if (rng.chance(0.6)) {
      const d = day(rng.int(4, 27));
      bankTx({ type: 'SPEND', date: d, contact: C['OfficeMart Supplies'], reference: 'Sundries', lines: [line('429', round(rng.float(8000, 40000), 100), 'Sundry expenses', d)] });
    }
    if (ym === '2023-03') {
      bankTx({ type: 'SPEND', date: day(15), contact: C['TechHub Equipment Pte Ltd'], reference: 'Workstations and server', lines: [line('720', 3600000, 'Computer equipment', day(15))] });
      state.depreciation.push({ from: '2023-04', months: 36, monthly: 100000, code: '721' });
    }
    if (ym === '2025-04') {
      bankTx({ type: 'SPEND', date: day(10), contact: C['TechHub Equipment Pte Ltd'], reference: 'Office fit-out equipment', lines: [line('710', 2400000, 'Office equipment', day(10))] });
      state.depreciation.push({ from: '2025-05', months: 60, monthly: 40000, code: '711' });
    }

    // Receive Money: a grant now and then, interest on the savings at month end.
    if (ym === '2024-06') bankTx({ type: 'RECEIVE', date: day(15), contact: C['SG Enterprise Grants Office'], reference: 'Productivity grant', lines: [line('260', 1000000, 'Enterprise development grant', day(15), { taxType: 'NONE' })] });
    if (ym === '2025-07') bankTx({ type: 'RECEIVE', date: day(10), contact: C['SG Enterprise Grants Office'], reference: 'Digitalisation grant', lines: [line('260', 800000, 'Digitalisation grant', day(10), { taxType: 'NONE' })] });

    // Transfers to savings, March and September from 2024.
    if (y >= 2024 && m === 3) transfer(day(14), 1000000, 'To savings');
    if (y >= 2024 && m === 9) transfer(day(12), 1000000, 'To savings');

    // A customer paid an invoice twice once; another paid before being invoiced.
    if (ym === '2024-05') {
      const who = C['Tampines Retail Holdings'];
      const t = bankTx({ type: 'RECEIVE-OVERPAYMENT', date: day(21), contact: who, reference: 'Duplicate payment', lines: [line('610', 100000, 'Overpayment', day(21), { taxType: 'NONE' })],
        extra: { overpaymentID: guidFor('overpayment', ym) } });
      const list = state.pendingCredits.get(who.name) || [];
      list.push({ kind: 'overpayment', cents: 100000, from: day(21), source: t });
      state.pendingCredits.set(who.name, list);
    }
    if (ym === '2025-02') {
      const who = C['Clementi Tech Labs Pte Ltd'];
      const t = bankTx({ type: 'RECEIVE-PREPAYMENT', date: day(11), contact: who, reference: 'Deposit on order', lines: [line('610', 500000, 'Prepayment', day(11), { taxType: 'NONE' })],
        extra: { prepaymentID: guidFor('prepayment', ym) } });
      const list = state.pendingCredits.get(who.name) || [];
      list.push({ kind: 'prepayment', cents: 500000, from: day(11), source: t });
      state.pendingCredits.set(who.name, list);
    }

    // Credit notes: a few over the years, the last two still unallocated.
    if (ym === '2023-09') creditNote(day(14), C['Meridian Fitouts Pte Ltd'], 250000, 'Returned fittings');
    if (ym === '2024-05') creditNote(day(8),  C['Sentosa Resorts Management'], 180000, 'Service credit');
    if (ym === '2024-11') creditNote(day(19), C['Pacific Trade Distributors Pte Ltd'], 320000, 'Short delivery');
    if (ym === '2025-08') creditNote(day(6),  C['Jurong Precision Engineering Pte Ltd'], 400000, 'Pricing adjustment');
    const unalloc1 = iso(today.y, today.m - 1, 9), unalloc2 = iso(today.y, today.m, 3);
    if (ym === monthKey(unalloc1)) creditNote(unalloc1, C['Orchid Grove Clinics'], 150000, 'Goodwill credit', { allocate: false });
    if (ym === monthKey(unalloc2)) creditNote(unalloc2, C['Eastpoint Wholesale Pte Ltd'], 210000, 'Damaged stock', { allocate: false });

    // Payroll on the 25th: the run as a journal, net pay from the bank.
    const gross = monthWages(y) * 100;
    const employer = Math.round(gross * CPF_EMPLOYER), employee = Math.round(gross * CPF_EMPLOYEE);
    const net = gross - employee;
    journal(day(25), 'payroll', [['477', gross], ['478', employer], ['826', -(employer + employee)], ['814', -net]], `Payroll ${MONTHS_SHORT[m - 1]} ${y}`);
    bankTx({ type: 'SPEND', date: day(25), contact: C['Payroll'], reference: `Salaries ${MONTHS_SHORT[m - 1]} ${y}`, lines: [line('814', net, 'Net salaries', day(25), { taxType: 'NONE' })] });
    state.lastPayroll = { cpf: employer + employee, label: `${MONTHS_SHORT[m - 1]} ${y}` };

    // Depreciation at month end.
    for (const dep of state.depreciation) {
      const idx = (y - Number(dep.from.slice(0, 4))) * 12 + (m - Number(dep.from.slice(5, 7)));
      if (idx >= 0 && idx < dep.months) journal(eom, 'depreciation', [['416', dep.monthly], [dep.code, -dep.monthly]], 'Monthly depreciation');
    }

    // Interest on savings at month end.
    const interest = Math.round(state.savings * SAVINGS_RATE / 12);
    if (interest > 0) {
      bankTx({ type: 'RECEIVE', date: eom, contact: C['DBS Bank Ltd'], bank: '091', reference: 'Interest', lines: [line('270', interest, 'Savings interest', eom, { taxType: 'NONE' })] });
      state.savings += interest;
    }

    // Dividends in June and December; the year's income tax provided at year end.
    if (DRAWINGS[m] && (m === 12 || y > FIRST_YEAR)) {
      bankTx({ type: 'SPEND', date: day(20), contact: C['Alicia Tan (Director)'], reference: 'Dividend', lines: [line('880', DRAWINGS[m] * 100, 'Dividend to shareholder', day(20), { taxType: 'NONE' })] });
    }
    if (m === 12) {
      let profit = 0;
      for (const j of book.journals) {
        if (j.date < `${y}-01-01` || j.date > eom) continue;
        for (const [code, cents] of j.lines) if (byCode.get(code).isPnl) profit -= cents;
      }
      const tax = profit > 0 ? round(profit * INCOME_TAX_RATE, 100) : 0;
      if (tax > 0) journal(eom, 'tax', [['505', tax], ['830', -tax]], `Income tax provision ${y}`);
      state.taxProvision[y] = tax;
    }

    m++; if (m > 12) { m = 1; y++; }
  }

  // ── Up to today ──
  // Everything dated after today is dropped: an invoice not yet raised, a
  // payment not yet made. The few things Xero would hold dated ahead are
  // added below.
  const onOrBefore = r => r.date <= todayISO;
  const kept = {
    invoices: invoices.filter(onOrBefore),
    payments: payments.filter(onOrBefore),
    bankTransactions: bankTransactions.filter(onOrBefore),
    bankTransfers: bankTransfers.filter(onOrBefore),
    creditNotes: creditNotes.filter(onOrBefore),
    journals: book.journals.filter(onOrBefore),
  };
  const keptPayments = new Set(kept.payments.map(p => p.paymentID));

  // Settle each invoice as of today.
  for (const inv of kept.invoices) {
    const done = inv.settlements.filter(s => s.date <= todayISO && (s.kind !== 'payment' || keptPayments.has(s.payment.paymentID)));
    inv.amountPaid = done.filter(s => s.kind === 'payment').reduce((s, x) => s + x.cents, 0);
    inv.amountCredited = done.filter(s => s.kind !== 'payment').reduce((s, x) => s + x.cents, 0);
    inv.amountDue = inv.total - inv.amountPaid - inv.amountCredited;
    inv.status = inv.amountDue <= 0 ? 'PAID' : 'AUTHORISED';
    inv.fullyPaidOnDate = inv.status === 'PAID' ? done.reduce((d, s) => (s.date > d ? s.date : d), '') : null;
    inv.updatedDateUTC = inv.status === 'PAID' ? inv.fullyPaidOnDate : (done.length ? done[done.length - 1].date : inv.date);
    inv.payments = done.filter(s => s.kind === 'payment').map(s => s.payment);
  }
  for (const cn of kept.creditNotes) {
    const applied = cn.allocations.filter(a => a.date <= todayISO).reduce((s, a) => s + a.amount, 0);
    cn.appliedAmount = applied;
    cn.remainingCredit = cn.total - applied;
    cn.status = cn.remainingCredit <= 0 ? 'PAID' : 'AUTHORISED';
    cn.fullyPaidOnDate = cn.status === 'PAID' ? cn.allocations.reduce((d, a) => (a.date > d ? a.date : d), '') : null;
    cn.updatedDateUTC = cn.fullyPaidOnDate || cn.date;
  }
  // A few open invoices carry the dates a person set in Xero.
  const openSales = kept.invoices.filter(i => i.type === 'ACCREC' && i.status === 'AUTHORISED').sort((a, b) => a.date.localeCompare(b.date));
  const openBills = kept.invoices.filter(i => i.type === 'ACCPAY' && i.status === 'AUTHORISED').sort((a, b) => a.date.localeCompare(b.date));
  for (const inv of openSales.slice(-2)) inv.expectedPaymentDate = addDays(inv.dueDate, 5);
  for (const inv of openBills.slice(-1)) inv.plannedPaymentDate = addDays(inv.dueDate, -1);

  // Dated ahead: what the bookkeeper has entered for the next two weeks.
  const futureBook = new Book();
  const future = [];
  const ahead = (n, spec) => {
    const date = addDays(todayISO, n);
    const receive = /^RECEIVE/.test(spec.type);
    const total = totalOf(spec.lines);
    const t = {
      bankTransactionID: guidFor('banktx-ahead', spec.type, date, n), type: spec.type, date, contact: spec.contact, bankCode: '090',
      lines: spec.lines, subTotal: netOf(spec.lines), totalTax: taxOf(spec.lines), total, reference: spec.reference, isReconciled: false,
      ...(spec.extra || {}),
    };
    future.push(t);
    futureBook.post(date, 'banktx', [[t.bankCode, receive ? total : -total], ...spec.lines.map(l => [l.code, receive ? -l.net : l.net]), ['820', receive ? -t.totalTax : t.totalTax]],
      { bankTransactionID: t.bankTransactionID, receive });
  };
  ahead(4,  { type: 'SPEND', contact: C['CloudStack Software Pte Ltd'], reference: 'Annual licence top-up', lines: [line('485', 180000, 'Additional licences', addDays(todayISO, 4))] });
  ahead(9,  { type: 'SPEND', contact: C['SwiftCourier Express Pte Ltd'], reference: 'Scheduled courier run', lines: [line('425', 120000, 'Courier run', addDays(todayISO, 9))] });
  ahead(11, { type: 'RECEIVE-PREPAYMENT', contact: C['Lion City Events Pte Ltd'], reference: 'Deposit on event order', lines: [line('610', 300000, 'Deposit', addDays(todayISO, 11), { taxType: 'NONE' })], extra: { prepaymentID: guidFor('prepayment-ahead', todayISO) } });

  // ── Lines, accrual and cash ──
  const journals = [...kept.journals, ...futureBook.journals];
  const lines = [];
  for (const j of journals) for (const [code, cents] of j.lines) lines.push({ date: j.date, code, cents, kind: j.kind });
  lines.sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));

  // The cash basis: no invoices, bills or credit notes; a payment hits the
  // invoice's own lines, in proportion; money received against the debtors
  // account before an invoice is sales.
  const invById = new Map(kept.invoices.map(i => [i.invoiceID, i]));
  const cashLines = [];
  for (const j of journals) {
    if (j.kind === 'invoice' || j.kind === 'bill' || j.kind === 'creditnote') continue;
    if (j.kind === 'payment') {
      const inv = invById.get(j.invoiceID);
      const bankLine = j.lines.find(([code]) => code === '090' || code === '091');
      const amount = Math.abs(bankLine[1]);
      const sign = bankLine[1] > 0 ? -1 : 1;     // money in credits the lines
      cashLines.push({ date: j.date, code: bankLine[0], cents: bankLine[1], kind: j.kind });
      let left = amount;
      const parts2 = [...inv.lines.map(l => [l.code, l.net]), ['820', inv.totalTax]].filter(([, c]) => c);
      parts2.forEach(([code, c], k) => {
        const share = k === parts2.length - 1 ? left : Math.round(amount * c / inv.total);
        left -= share;
        cashLines.push({ date: j.date, code, cents: sign * share, kind: j.kind });
      });
      continue;
    }
    for (const [code, cents] of j.lines) cashLines.push({ date: j.date, code: code === '610' || code === '800' ? (code === '610' ? '200' : '310') : code, cents, kind: j.kind });
  }
  cashLines.sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));

  // ── Templates, quotes, budget ──
  const nextFirst = iso(today.y, today.m + 1, 1);
  const repeatingInvoices = [
    {
      repeatingInvoiceID: guidFor('repeating', 'retainer'), type: 'ACCREC', contact: retainer, status: 'AUTHORISED', reference: 'Monthly retainer',
      lines: [line('200', 1200000, 'Monthly managed services retainer', nextFirst)],
      schedule: { period: 1, unit: 'MONTHLY', dueDate: 30, dueDateType: 'DAYSAFTERINVOICEDATE', startDate: '2023-01-01', nextScheduledDate: nextFirst, endDate: null },
    },
    {
      repeatingInvoiceID: guidFor('repeating', 'rent'), type: 'ACCPAY', contact: landlord, status: 'AUTHORISED', reference: 'Office rent',
      lines: [line('469', 850000, 'Office rent, unit 03-12 Westgate Tower', nextFirst)],
      schedule: { period: 1, unit: 'MONTHLY', dueDate: 7, dueDateType: 'DAYSAFTERBILLDATE', startDate: '2023-01-01', nextScheduledDate: nextFirst, endDate: null },
    },
  ];
  for (const t of repeatingInvoices) { t.subTotal = netOf(t.lines); t.totalTax = taxOf(t.lines); t.total = totalOf(t.lines); }

  const quotes = [
    ['SENT',     -6,  C['Punggol Digital Pte Ltd'],        1850000, 'Network upgrade, phase 2'],
    ['SENT',     -13, C['Straits Marine Supplies Pte Ltd'], 960000,  'Replacement control units'],
    ['ACCEPTED', -21, C['Harbourline Logistics Pte Ltd'],  4200000, 'Warehouse fit-out'],
    ['SENT',     -58, C['Kallang Sports Academy'],          520000,  'Scoreboard installation'],   // expired
    ['INVOICED', -40, C['Novena Dental Group'],             800000,  'Clinic maintenance contract'],
    ['DECLINED', -33, C['Marina Bay Interiors'],            2100000, 'Showroom lighting'],
  ].map(([status, daysAgo, contact, net, title], k) => {
    const date = addDays(todayISO, daysAgo);
    const ls = [line('200', net, title, date)];
    return {
      quoteID: guidFor('quote', k), quoteNumber: `QU-${String(k + 1).padStart(4, '0')}`, status, contact, date, expiryDate: addDays(date, 30),
      title, reference: '', lines: ls, subTotal: netOf(ls), totalTax: taxOf(ls), total: totalOf(ls),
    };
  });

  const budget = buildBudget(today.y, lines, byCode);

  const organisation = {
    organisationID: guidFor('organisation'), apiKey: '', name: 'Demo Company Pte Ltd', legalName: 'Demo Company Pte Ltd',
    paysTax: true, version: 'GLOBAL', organisationType: 'COMPANY', baseCurrency: 'SGD', countryCode: 'SG', isDemoCompany: true,
    organisationStatus: 'ACTIVE', registrationNumber: '202212345D', taxNumber: 'M90012345X', financialYearEndDay: 31, financialYearEndMonth: 12,
    salesTaxBasis: 'ACCRUALS', salesTaxPeriod: 'QUARTERLY', defaultSalesTax: 'Standard-Rated Supplies', defaultPurchasesTax: 'Standard-Rated Purchases',
    periodLockDate: null, endOfYearLockDate: null, createdDateUTC: new Date('2022-12-01T02:00:00Z'), timezone: 'SINGAPORESTANDARDTIME',
    organisationEntityType: 'COMPANY', shortCode: '!DEM01', _class: 'STANDARD', edition: 'BUSINESS', lineOfBusiness: 'Industrial supplies and services',
    addresses: [{ addressType: 'STREET', addressLine1: '3 Westgate Tower', addressLine2: '#03-12', city: 'Singapore', postalCode: '608532', country: 'Singapore' }],
    phones: [{ phoneType: 'DEFAULT', phoneNumber: '6100 0000', phoneAreaCode: '', phoneCountryCode: '65' }],
    externalLinks: [], paymentTerms: { bills: { day: 30, type: 'DAYSAFTERBILLDATE' }, sales: { day: 30, type: 'DAYSAFTERBILLDATE' } },
  };

  return {
    todayISO, organisation, accounts, byCode, taxRates: buildTaxRates(), contacts,
    invoices: kept.invoices, payments: kept.payments, bankTransactions: [...kept.bankTransactions, ...future], bankTransfers: kept.bankTransfers,
    creditNotes: kept.creditNotes, repeatingInvoices, quotes, budget, journals, lines, cashLines,
    brandingThemes: [{ brandingThemeID: guidFor('branding', 'standard'), name: 'Standard', sortOrder: 0, createdDateUTC: new Date('2022-12-01T02:00:00Z') }],
  };
}

// ── The budget ──────────────────────────────────────────────────────────────
// An Overall Budget for the financial year `year` and the next, by account by
// month: last year's actual grown, with some noise either way, so the
// variances on screen go both ways. Cents, as the ledger.
function buildBudget(year, lines, byCode) {
  const actual = new Map();   // 'YYYY-MM' -> Map(code -> cents, expense-positive)
  for (const l of lines) {
    if (!byCode.get(l.code)?.isPnl) continue;
    const key = l.date.slice(0, 7);
    if (!actual.has(key)) actual.set(key, new Map());
    const m = actual.get(key);
    m.set(l.code, (m.get(l.code) || 0) + l.cents);
  }
  const growthFor = code => {
    const a = byCode.get(code);
    if (a.type === 'REVENUE' || a.type === 'DIRECTCOSTS') return 1.17;
    if (code === '477' || code === '478') return 1.16;
    if (a.type === 'OTHERINCOME') return 1.0;
    return 1.08;
  };
  const months = new Map();
  const baseYear = year - 1;
  for (const y of [year, year + 1]) {
    for (let m = 1; m <= 12; m++) {
      const key = `${y}-${pad2(m)}`;
      const row = new Map();
      for (const a of byCode.values()) {
        if (!a.isPnl) continue;
        let base;
        if (y === year) base = actual.get(`${baseYear}-${pad2(m)}`)?.get(a.code) || 0;
        else base = months.get(`${year}-${pad2(m)}`)?.get(a.code) || 0;
        if (!base) continue;
        const g = growthFor(a.code);
        const noise = rngFor('budget', key, a.code).float(0.92, 1.08);
        const v = Math.round(base * g * noise / 5000) * 5000;
        if (v) row.set(a.code, v);
      }
      months.set(key, row);
    }
  }
  return {
    budgetID: guidFor('budget', 'overall'), type: 'OVERALL', description: 'Overall Budget',
    updatedDateUTC: new Date(`${year - 1}-12-18T09:30:00Z`), months, years: [year, year + 1],
  };
}

// ── Memo ────────────────────────────────────────────────────────────────────
// One company per day: regenerated when the day changes, kept otherwise.
let _memo = null;
function demoCompany(todayISO) {
  if (!_memo || _memo.todayISO !== todayISO) _memo = generate(todayISO);
  return _memo;
}

module.exports = {
  demoCompany, generate, buildBudget, CHART, CUSTOMERS, SUPPLIERS, HABITS, PNL_TYPES,
  iso, addDays, monthKey, lastDayOfMonth, parts, gstPercent, taxOn, daysBetween, MONTHS_SHORT, FIRST_YEAR,
  LOAN_PAYMENT_CENTS, yearRevenue, monthRevenue,
};
