// The Demo Company's reports, each built from the ledger lines (./company.js)
// in the shape xero-node hands the app for Xero's Reports endpoints: a Header
// row, Sections with Rows and SummaryRows, every cell a { value } with money
// written as Xero writes it ("1,234.56", negatives in brackets), and the
// AccountID on account rows as a cell attribute.
//
// The shapes were taken from the fixtures the app's own tests were captured
// from (reports.test.js for the P&L and Budget Summary, balance-sheet.test.js
// and trial-balance.test.js for the two balance reports, bank*.test.js,
// cash-manager.test.js and cash-monthly.test.js for the Bank Summary), and
// their quirks are kept: the P&L answers its comparison columns NEWEST first
// and applies the anchor's day count to each; the Budget Summary answers
// OLDEST first with "Account" as its first header cell; the Balance Sheet is
// always as at a month end and answers two columns when asked for one; the
// Trial Balance names its columns in the Header and writes plain numbers.

const { parts, iso, addDays, lastDayOfMonth, MONTHS_SHORT, PNL_TYPES } = require('./company');

// ── Cells and money ─────────────────────────────────────────────────────────
function money(cents) {
  const abs = Math.abs(cents);
  const s = `${Math.floor(abs / 100)}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + String(abs % 100).padStart(2, '0');
  return cents < 0 ? `(${s})` : s;
}
const plain = cents => (Math.abs(cents) / 100).toFixed(2);
const cell = (value, accountID = null) => (accountID ? { value, attributes: [{ id: 'account', value: accountID }] } : { value });
const row = (cells, rowType = 'Row') => ({ rowType, cells });
const section = (title, rows) => ({ rowType: 'Section', title, rows });
const header = cells => ({ rowType: 'Header', cells: cells.map(c => cell(c)) });

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate  = day => { const p = parts(day); return `${p.d} ${MONTHS_LONG[p.m - 1]} ${p.y}`; };
const shortDate = day => { const p = parts(day); return `${p.d} ${MONTHS_SHORT[p.m - 1]} ${p.y}`; };
const pnlLabel  = day => { const p = parts(day); return `${p.d} ${MONTHS_SHORT[p.m - 1]} ${String(p.y).slice(2)}`; };
const monthEnd  = (y, m) => iso(y, m, 31);
// A month `n` months after (y, m), as [y, m].
function shiftMonth(y, m, n) { const idx = y * 12 + (m - 1) + n; return [Math.floor(idx / 12), (idx % 12) + 1]; }

function envelope(id, name, titles, rows, today) {
  return {
    reports: [{
      reportID: id, reportName: name, reportType: id, reportTitles: titles, reportDate: longDate(today),
      updatedDateUTC: new Date(`${today}T04:00:00Z`), fields: [], rows,
    }],
  };
}

// ── Sums over the ledger ────────────────────────────────────────────────────
// Lines are sorted by date; the first on or after `from` is found by
// bisection, then everything to `to` is added. Map of code -> cents.
function firstIndexFrom(lines, from) {
  let lo = 0, hi = lines.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (lines[mid].date < from) lo = mid + 1; else hi = mid; }
  return lo;
}
function sumLines(lines, from, to, into = new Map()) {
  for (let i = from ? firstIndexFrom(lines, from) : 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.date > to) break;
    into.set(l.code, (into.get(l.code) || 0) + l.cents);
  }
  return into;
}
const fyStart = day => `${day.slice(0, 4)}-01-01`;

// Balances as the Balance Sheet prints them at `day`: assets debit-positive,
// liabilities and equity credit-positive, plus Current Year Earnings and
// Retained Earnings carrying every closed year's profit. Map of code (or
// 'CYE') -> cents.
function balancesAt(company, lines, day) {
  const all = sumLines(lines, null, day);
  const out = new Map();
  let cye = 0, prior = 0;
  const start = fyStart(day);
  for (const a of company.accounts) {
    const bal = all.get(a.code) || 0;
    if (a.isPnl) continue;
    out.set(a.code, a._class === 'ASSET' ? bal : -bal);
  }
  for (const [code, cents] of sumLines(lines, start, day)) if (company.byCode.get(code)?.isPnl) cye -= cents;
  for (const [code, cents] of sumLines(lines, null, addDays(start, -1))) if (company.byCode.get(code)?.isPnl) prior -= cents;
  out.set('CYE', cye);
  out.set('960', (out.get('960') || 0) + prior);
  return out;
}

// ── Profit and Loss ─────────────────────────────────────────────────────────
// Sections of Xero's standard layout, with the account types each holds.
const PNL_SECTIONS = [
  { title: 'Income',                  types: ['REVENUE'],               total: 'Total Income',             sign: -1 },
  { title: 'Less Cost of Sales',      types: ['DIRECTCOSTS'],           total: 'Total Cost of Sales',      sign: 1 },
  { summary: 'Gross Profit' },
  { title: 'Other Income',            types: ['OTHERINCOME'],           total: 'Total Other Income',       sign: -1 },
  { title: 'Less Operating Expenses', types: ['EXPENSE', 'DEPRECIATN'], total: 'Total Operating Expenses', sign: 1 },
  { summary: 'Net Profit' },
];

// The section rows for a set of columns, given each column's Map of
// code -> cents (ledger sign). `firstHeader` is the Header's first cell.
function pnlRows(company, columns, firstHeader, labels, { fmt = money } = {}) {
  const n = columns.length;
  const rows = [header([firstHeader, ...labels])];
  let gross = Array(n).fill(0), net = Array(n).fill(0);
  let any = false;
  for (const s of PNL_SECTIONS) {
    if (s.summary) {
      const vals = s.summary === 'Gross Profit' ? gross : net;
      rows.push(section('', [row([cell(s.summary), ...vals.map(v => cell(fmt(v)))], 'SummaryRow')]));
      continue;
    }
    const lines = [];
    const total = Array(n).fill(0);
    for (const a of company.accounts) {
      if (!s.types.includes(a.type)) continue;
      const vals = columns.map(col => s.sign * (col.get(a.code) || 0));
      if (vals.every(v => v === 0)) continue;
      any = true;
      vals.forEach((v, i) => { total[i] += v; });
      lines.push(row([cell(a.name, a.accountID), ...vals.map(v => cell(fmt(v), a.accountID))]));
    }
    if (!lines.length) continue;
    lines.push(row([cell(s.total), ...total.map(v => cell(fmt(v)))], 'SummaryRow'));
    rows.push(section(s.title, lines));
    const signed = total.map(v => v * -s.sign);   // income adds, costs take away
    if (s.title === 'Income' || s.title === 'Less Cost of Sales') gross = gross.map((v, i) => v + signed[i]);
    net = net.map((v, i) => v + signed[i]);
  }
  // Gross Profit was pushed before Other Income and the expenses were known;
  // it is Income less Cost of Sales, which is already final then. Net Profit
  // is pushed last, after everything.
  return { rows, any };
}

function profitAndLoss(company, lines, { fromDate, toDate, periods, timeframe }) {
  const today = company.todayISO;
  const to = toDate || today;
  const from = fromDate || `${to.slice(0, 4)}-01-01`;
  const anchorDays = Math.round((Date.UTC(...dateParts(to)) - Date.UTC(...dateParts(from))) / 86400000) + 1;
  const step = { MONTH: 1, QUARTER: 3, YEAR: 12 }[String(timeframe || 'MONTH').toUpperCase()] || 1;
  const n = periods ? Number(periods) + 1 : 1;
  const spans = [];
  for (let i = 0; i < n; i++) {
    const f = parts(from), t = parts(to);
    const [fy, fm] = shiftMonth(f.y, f.m, -i * step);
    const [ty, tm] = shiftMonth(t.y, t.m, -i * step);
    const start = iso(fy, fm, f.d);
    const endByDays = addDays(start, anchorDays - 1);
    const endOfMonth = monthEnd(ty, tm);
    spans.push({ from: start, to: endByDays < endOfMonth ? endByDays : endOfMonth });
  }
  const columns = spans.map(s => sumLines(lines, s.from, s.to));
  const { rows } = pnlRows(company, columns, '', spans.map(s => pnlLabel(s.to)));
  const title = n > 1 ? `For the ${n} periods ended ${longDate(spans[0].to)}` : `For the period ${longDate(from)} to ${longDate(to)}`;
  return envelope('ProfitAndLoss', 'Profit and Loss', ['Profit and Loss', company.organisation.name, title], rows, today);
}
const dateParts = day => { const p = parts(day); return [p.y, p.m - 1, p.d]; };

// ── Budget Summary ──────────────────────────────────────────────────────────
// Oldest first, from the month of `date`, `periods` columns of `timeframe`
// months (1, 3 or 12). A span the Overall Budget holds nothing for is
// answered as Xero answers it: the three floating summary lines at nought.
function budgetSummary(company, { date, periods, timeframe }) {
  const today = company.todayISO;
  const start = parts(date || today);
  const span = { 1: 1, 3: 3, 12: 12 }[Number(timeframe || 1)] || 1;
  const n = Math.max(1, Number(periods || 1));
  const columns = [], labels = [];
  for (let k = 0; k < n; k++) {
    const col = new Map();
    const [y0, m0] = shiftMonth(start.y, start.m, k * span);
    for (let j = 0; j < span; j++) {
      const [y, m] = shiftMonth(y0, m0, j);
      const month = company.budget.months.get(`${y}-${String(m).padStart(2, '0')}`);
      if (!month) continue;
      for (const [code, cents] of month) col.set(code, (col.get(code) || 0) + cents);
    }
    columns.push(col);
    const [yl, ml] = shiftMonth(y0, m0, span - 1);
    labels.push(span === 1 ? `${MONTHS_SHORT[m0 - 1]}-${String(y0).slice(2)}`
      : span === 3 ? `${MONTHS_SHORT[m0 - 1]}-${MONTHS_SHORT[ml - 1]} ${String(yl).slice(2)}` : `${MONTHS_SHORT[m0 - 1]} ${y0}-${MONTHS_SHORT[ml - 1]} ${yl}`);
  }
  const built = pnlRows(company, columns, 'Account', labels);
  const rows = built.any ? built.rows : [
    header(['Account', ...labels]),
    section('', [row([cell('Gross Profit'), ...labels.map(() => cell('0.00'))], 'SummaryRow')]),
    section('', [row([cell('Total Expenses'), ...labels.map(() => cell('0.00'))], 'SummaryRow')]),
    section('', [row([cell('Net Profit'), ...labels.map(() => cell('0.00'))], 'SummaryRow')]),
  ];
  return envelope('BudgetSummary', 'Budget Summary', ['Budget Summary', company.organisation.name, `${labels[0]} to ${labels[labels.length - 1]}`], rows, today);
}

// ── Balance Sheet ───────────────────────────────────────────────────────────
const BS_PLACE = {
  BANK: 'Bank', CURRENT: 'Current Assets', PREPAYMENT: 'Current Assets', INVENTORY: 'Current Assets', FIXED: 'Fixed Assets',
  CURRLIAB: 'Current Liabilities', TERMLIAB: 'Non-current Liabilities', EQUITY: 'Equity',
};
const BS_LAYOUT = [
  ['Assets', ['Bank', 'Current Assets', 'Fixed Assets'], 'Total Assets'],
  ['Liabilities', ['Current Liabilities', 'Non-current Liabilities'], 'Total Liabilities'],
];

function balanceSheet(company, lines, { date, periods, timeframe }) {
  const today = company.todayISO;
  const at = parts(date || today);
  const step = { MONTH: 1, QUARTER: 3, YEAR: 12 }[String(timeframe || '').toUpperCase()] || 0;
  // No comparison asked for: the month end and the same month end a year earlier.
  const n = step ? Number(periods || 0) + 1 : 2;
  const back = step || 12;
  const dates = Array.from({ length: n }, (_, i) => { const [y, m] = shiftMonth(at.y, at.m, -i * back); return monthEnd(y, m); });
  const columns = dates.map(d => balancesAt(company, lines, d));
  const vals = code => columns.map(c => c.get(code) || 0);
  const nonzero = v => v.some(x => x !== 0);
  const rowOf = (label, v, accountID = null, type = 'Row') => row([cell(label, accountID), ...v.map(x => cell(money(x), accountID))], type);
  const add = (a, b) => a.map((x, i) => x + b[i]);
  const zero = () => Array(n).fill(0);

  const rows = [header(['', ...dates.map(shortDate)])];
  const groupTotals = {};
  for (const [group, subgroups, totalLabel] of BS_LAYOUT) {
    rows.push(section(group, []));
    let total = zero();
    for (const sub of subgroups) {
      const lines2 = [];
      let subTotal = zero();
      for (const a of company.accounts) {
        if (BS_PLACE[a.type] !== sub) continue;
        const v = vals(a.code);
        if (!nonzero(v)) continue;
        lines2.push(rowOf(a.name, v, a.accountID));
        subTotal = add(subTotal, v);
      }
      if (!lines2.length) continue;
      lines2.push(rowOf(`Total ${sub}`, subTotal, null, 'SummaryRow'));
      rows.push(section(sub, lines2));
      total = add(total, subTotal);
    }
    rows.push(section('', [rowOf(totalLabel, total, null, 'SummaryRow')]));
    groupTotals[group] = total;
  }
  rows.push(section('', [rowOf('Net Assets', add(groupTotals.Assets, groupTotals.Liabilities.map(x => -x)))]));

  const equity = [rowOf('Current Year Earnings', vals('CYE'))];
  let equityTotal = vals('CYE');
  for (const a of company.accounts) {
    if (a.type !== 'EQUITY') continue;
    const v = vals(a.code);
    if (!nonzero(v)) continue;
    equity.push(rowOf(a.name, v, a.accountID));
    equityTotal = add(equityTotal, v);
  }
  equity.push(rowOf('Total Equity', equityTotal, null, 'SummaryRow'));
  rows.push(section('Equity', equity));
  return envelope('BalanceSheet', 'Balance Sheet', ['Balance Sheet', company.organisation.name, `As at ${longDate(dates[0])}`], rows, today);
}

// ── Trial Balance ───────────────────────────────────────────────────────────
const TB_SECTIONS = [
  ['Revenue',     a => a.type === 'REVENUE' || a.type === 'OTHERINCOME'],
  ['Expenses',    a => a.type === 'DIRECTCOSTS' || a.type === 'EXPENSE' || a.type === 'DEPRECIATN'],
  ['Assets',      a => a._class === 'ASSET'],
  ['Liabilities', a => a._class === 'LIABILITY'],
  ['Equity',      a => a._class === 'EQUITY'],
];

function trialBalance(company, lines, { date }) {
  const today = company.todayISO;
  const at = date || today;
  const p = parts(at);
  const ytdPnl = sumLines(lines, fyStart(at), at);
  const all    = sumLines(lines, null, at);
  const month  = sumLines(lines, iso(p.y, p.m, 1), at);
  let priorProfit = 0;
  for (const [code, cents] of sumLines(lines, null, addDays(fyStart(at), -1))) if (company.byCode.get(code)?.isPnl) priorProfit += cents;

  const rows = [header(['Account', 'Debit', 'Credit', 'YTD Debit', 'YTD Credit'])];
  let totalDebit = 0, totalCredit = 0;
  for (const [title, match] of TB_SECTIONS) {
    const lines2 = [];
    for (const a of company.accounts) {
      if (!match(a)) continue;
      let ytd = a.isPnl ? (ytdPnl.get(a.code) || 0) : (all.get(a.code) || 0);
      if (a.code === '960') ytd += priorProfit;
      const move = month.get(a.code) || 0;
      if (ytd === 0 && move === 0) continue;
      totalDebit += Math.max(ytd, 0); totalCredit += Math.max(-ytd, 0);
      lines2.push(row([
        cell(`${a.name} (${a.code})`, a.accountID),
        cell(move > 0 ? plain(move) : '', a.accountID), cell(move < 0 ? plain(move) : '', a.accountID),
        cell(ytd > 0 ? plain(ytd) : '', a.accountID), cell(ytd < 0 ? plain(ytd) : '', a.accountID),
      ]));
    }
    rows.push(section(title, lines2));
  }
  rows.push(section('', [row([cell('Total'), cell(''), cell(''), cell(plain(totalDebit)), cell(plain(totalCredit))], 'SummaryRow')]));
  return envelope('TrialBalance', 'Trial Balance', ['Trial Balance', company.organisation.name, `As at ${longDate(at)}`], rows, today);
}

// ── Bank Summary ────────────────────────────────────────────────────────────
// Columnar: a Header naming the columns, then one Row per bank account —
// every account, moved or not — and a Total. Cash Spent is printed negative.
function bankSummary(company, lines, { fromDate, toDate }) {
  const today = company.todayISO;
  const to = toDate || today;
  const from = fromDate || `${to.slice(0, 7)}-01`;
  const opening = sumLines(lines, null, addDays(from, -1));
  const rows = [header(['Bank Accounts', 'Opening Balance', 'Cash Received', 'Cash Spent', 'Closing Balance'])];
  const body = [];
  const totals = { opening: 0, received: 0, spent: 0, closing: 0 };
  for (const a of company.accounts) {
    if (a.type !== 'BANK') continue;
    let received = 0, spent = 0;
    for (let i = firstIndexFrom(lines, from); i < lines.length; i++) {
      const l = lines[i];
      if (l.date > to) break;
      if (l.code !== a.code) continue;
      if (l.cents > 0) received += l.cents; else spent -= l.cents;
    }
    const open = opening.get(a.code) || 0;
    const closing = open + received - spent;
    totals.opening += open; totals.received += received; totals.spent += spent; totals.closing += closing;
    body.push(row([cell(a.name, a.accountID), cell(money(open), a.accountID), cell(money(received), a.accountID), cell(money(-spent), a.accountID), cell(money(closing), a.accountID)]));
  }
  body.push(row([cell('Total'), cell(money(totals.opening)), cell(money(totals.received)), cell(money(-totals.spent)), cell(money(totals.closing))], 'SummaryRow'));
  rows.push(section('', body));
  return envelope('BankSummary', 'Bank Summary', ['Bank Summary', company.organisation.name, `From ${longDate(from)} to ${longDate(to)}`], rows, today);
}

module.exports = {
  profitAndLoss, budgetSummary, balanceSheet, trialBalance, bankSummary,
  money, plain, sumLines, balancesAt, firstIndexFrom, shiftMonth, monthEnd, lastDayOfMonth, PNL_TYPES,
};
