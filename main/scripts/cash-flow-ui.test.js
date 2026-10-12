const fs   = require('fs');
const path = require('path');

// The Cash Flow and Banking tabs on the screen side, after an audit found
// figures that could not be read drawn as nil: "0.00 from customers" over
// payments that were never read, a runway of "0.00/mo, Self-funding" over
// months in which nothing moved, "Owed to you (2 sales invoices) 0.00", and
// a bank table that dashed a missing balance and a nil one alike. There is
// no React test setup in this project, so as in dashboard-figures-ui.test.js
// the decisions are plain functions in the components, lifted out of the
// source and run here, and the wiring is checked in the source.
const UI = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

// The source of `export function NAME(...) { ... }`, by matching braces from
// its first one. Good for the plain functions it is used on, whose parameter
// lists hold no braces.
function functionSource(src, name) {
  const start = src.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1).replace(/^export /, '');
}
function lift(rel, name, deps = {}) {
  const body = `${functionSource(read(rel), name)}\nreturn ${name};`;
  return new Function(...Object.keys(deps), body)(...Object.values(deps));
}

const fmtMoney = (v, cur) => `${cur ? `${cur} ` : ''}${Number(v || 0).toFixed(2)}`;
const PANEL = 'components/performance/CashFlowPanel.jsx';
const movementMetrics = lift(PANEL, 'movementMetrics', { fmtMoney });
const runwayMetric    = lift(PANEL, 'runwayMetric', { fmtMoney });
const balanceRows     = lift(PANEL, 'balanceRows');
const owedRows        = lift(PANEL, 'owedRows');
const emptyNotes      = lift(PANEL, 'emptyNotes');
const BANKING = 'pages/xero-insights/BankingTab.jsx';
const bankFigure = lift(BANKING, 'bankFigure', { fmtMoney });
const cashCard   = lift(BANKING, 'cashCard', { fmtMoney });

const UNREAD = 'Couldn’t read payments/bank transactions from Xero';
const movement = { customerReceipts: 2200, otherReceipts: 200, supplierPayments: 660, otherPayments: 0, cashIn: 2400, cashOut: 660 };
const cash = { available: true, cashIn: 2400, cashOut: 660, opening: 10000, closing: 11740, net: 1740 };

describe('Cash Flow: payments or bank transactions that could not be read', () => {
  test('cash in and out say they could not be read, never "0.00 from customers"', () => {
    const m = movementMetrics({ recordsAvailable: false, movement: { customerReceipts: 0, otherReceipts: 0 }, cash }, 'SGD');
    expect(m.cashIn).toEqual({ value: '—', footLeft: UNREAD, footRight: '' });
    expect(m.cashOut).toEqual({ value: '—', footLeft: UNREAD, footRight: '' });
    // Read, they are the figures, as before; a payload without the flag was read.
    expect(movementMetrics({ recordsAvailable: true, movement, cash }, 'SGD').cashIn)
      .toEqual({ value: 'SGD 2400.00', footLeft: 'SGD 2200.00 from customers', footRight: 'SGD 200.00 other' });
    expect(movementMetrics({ movement, cash }, 'SGD').cashOut.footLeft).toBe('SGD 660.00 to suppliers');
  });

  test('the panel suppresses what is built on the records: the waterfall, the monthly bars and the invoiced-received note', () => {
    const src = read(PANEL);
    expect(src).toMatch(/const records = data\.recordsAvailable !== false;/);
    expect(src).toMatch(/\{wf \? <Waterfall steps=\{wf\.steps\} currency=\{cur\} \/> : !records \? <Empty>\{unread\}<\/Empty> : \(/);
    expect(src).toMatch(/\{records \? \(\s*<>\s*<GroupedMonthlyBars months=\{months\}/);
    expect(src).toMatch(/\{records && rec\.notCollected !== 0 && \(/);
    // The "does not tie" note reads the server's unreconciled, which is never
    // material without the records (cash-flow-report.test.js).
    expect(src).toMatch(/\{data\.unreconciled\?\.material && \(/);
  });
});

describe('Cash Flow: the balance rows without a bank figure', () => {
  test('a dash each, and "Bank balance unavailable", never 0 to 0', () => {
    expect(balanceRows({ available: false, opening: 0, closing: 0, net: 0 })).toEqual({
      items: [
        { label: 'Opening balance', value: 0 },
        { label: 'Net movement', value: 0 },
        { label: 'Closing balance', value: 0, strong: true },
      ],
      note: 'Bank balance unavailable',
    });
    expect(balanceRows(cash)).toMatchObject({ items: [{ value: 10000 }, { value: 1740 }, { value: 11740 }], note: null });
    // Rows draws a nil value as a dash, which is what makes the first a dash.
    expect(read('components/performance/primitives.jsx')).toMatch(/r\.value === 0 \?[^\n]{0,80}—/);
  });
});

describe('Cash Flow: the runway and net cash flow card', () => {
  test('no figure says why, in the server\'s words, never "Taking in more than it spends"', () => {
    expect(runwayMetric({ available: false, reason: 'No cash moved in the closed months' }, 'SGD')).toEqual({
      label: 'Cash runway', value: '—', meter: null, tone: undefined, footLeft: 'No cash moved in the closed months', footRight: '',
    });
    expect(runwayMetric({ available: false }, 'SGD').footLeft).toBe('No closed month yet');
    expect(runwayMetric(undefined, 'SGD').value).toBe('—');
  });

  test('a figure reads as before: cash-positive, or months of runway coloured by how few', () => {
    expect(runwayMetric({ available: true, burning: false, avgNet: 1500, months: 4, partial: false }, 'SGD'))
      .toMatchObject({ label: 'Net cash flow', value: 'SGD 1500.00/mo', tone: 'var(--success)', footLeft: 'Taking in more than it spends', footRight: '4-mo avg' });
    expect(runwayMetric({ available: true, burning: true, runwayMonths: 2.5, netBurn: 800, months: 3, partial: false }, 'SGD'))
      .toMatchObject({ label: 'Cash runway', value: '2.5 months', tone: 'var(--danger)', footLeft: 'Burning SGD 800.00/mo net' });
    expect(runwayMetric({ available: true, burning: true, runwayMonths: 30, netBurn: 1, months: 1, partial: true }, 'SGD'))
      .toMatchObject({ value: '24+ months', meter: 100, footRight: '1-mo avg, partial' });
  });
});

describe('Cash Flow: what is owed', () => {
  test('counts only invoices with something due, and says plainly when there is none', () => {
    expect(owedRows({ counts: { receivable: 0, payable: 0 }, receivable: 0, payable: 0, net: 0 }).map(r => r.label))
      .toEqual(['Nothing owed to you', 'No bills to pay', 'Net position']);
    expect(owedRows({ counts: { receivable: 1, payable: 3 }, receivable: 120, payable: 900, net: 780 }).map(r => [r.label, r.value]))
      .toEqual([['Owed to you (1 sales invoice)', 120], ['You owe (3 bills)', 900], ['Net position', 780]]);
  });
});

describe('Cash Flow and the ageing: nothing to draw is said in words that fit', () => {
  const none = { arAgeing: { current: 0, d1_30: 0, d31_60: 0, d60plus: 0.001 } };
  const quiet = { weeks: Array.from({ length: 13 }, (_, i) => ({ week: i + 1, receipts: 0, payments: 0 })) };

  test('an empty receivables ageing is "Nothing outstanding", an empty 13 weeks "Nothing falls due"', () => {
    expect(emptyNotes(none, quiet)).toEqual({ ageing: 'Nothing outstanding', forecast: 'Nothing falls due in the next 13 weeks' });
    const some = emptyNotes({ arAgeing: { current: 50 } }, { weeks: [{ receipts: 0, payments: 20 }] });
    expect(some).toEqual({ ageing: null, forecast: null });
  });

  test('the panel shows them in place of the chart helpers\' "No activity in this range", and the ageing view agrees', () => {
    const src = read(PANEL);
    expect(src).toMatch(/\{empty\.ageing \? <Empty>\{empty\.ageing\}<\/Empty> : \(/);
    expect(src).toMatch(/\{empty\.forecast \? <Empty>\{empty\.forecast\}<\/Empty> : \(/);
    expect(read('pages/xero-insights/AgeingSection.jsx')).toMatch(/>Nothing outstanding</);
  });
});

describe('Banking: a figure that cannot be read says so', () => {
  test('an account the Bank Summary did not give is "Unavailable"; a nil one is a muted 0.00', () => {
    expect(bankFigure(null, 'balance', 'SGD')).toEqual({ text: 'Unavailable', muted: true });
    expect(bankFigure({ balance: 120 }, 'cashIn', 'SGD')).toEqual({ text: 'Unavailable', muted: true });
    expect(bankFigure({ balance: 120, cashIn: 0 }, 'cashIn', 'SGD')).toEqual({ text: 'SGD 0.00', muted: true });
    expect(bankFigure({ balance: -45.5 }, 'balance', 'USD')).toEqual({ text: 'USD -45.50', muted: false });
  });

  test('the cash card stays, saying the Bank Summary could not be read, rather than disappearing', () => {
    expect(cashCard({ available: false, total: 0 }, 'SGD')).toEqual({
      total: 'Unavailable', cashIn: 'Unavailable', cashOut: 'Unavailable', net: 'Unavailable', netTone: undefined,
      note: 'Couldn’t read the Bank Summary from Xero',
    });
    expect(cashCard({ available: true, total: 11740, cashIn: 2400, cashOut: 660, net: 1740 }, 'SGD'))
      .toEqual({ total: 'SGD 11740.00', cashIn: 'SGD 2400.00', cashOut: 'SGD 660.00', net: 'SGD 1740.00', netTone: 'var(--success)', note: null });
    const src = read(BANKING);
    expect(src).toMatch(/\{perf\.data\?\.cash && \(/);
    expect(src).not.toMatch(/\{perf\.data\?\.cash\?\.available && \(/);
    for (const field of ['balance', 'cashIn', 'cashOut']) expect(src).toMatch(new RegExp(`bankFigure\\(bal, '${field}', balCur\\)`));
  });

  test('a statement with no lines says how far back it looked', () => {
    const src = read(BANKING);
    expect(src).toMatch(/export const NO_STATEMENT_LINES = 'No transactions in the last 365 days';/);
    expect(src).toMatch(/<div>\{NO_STATEMENT_LINES\}<\/div>/);
    expect(src).not.toMatch(/No transactions found for this account/);
    // The statement read is the last 365 days, so that is the claim.
    expect(fs.readFileSync(path.join(__dirname, '../xero/bank.js'), 'utf8')).toMatch(/_addDays\(_partsFromDate\(new Date\(\)\), -365\)/);
  });
});
