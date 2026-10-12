// The Cash Flow Manager export: a pdfmake document definition and an ExcelJS
// workbook, built the way the Balance Sheet and budget exports are and from the
// same page furniture (budget-doc.js, budget-render.js), so every report comes
// out of the printer looking like one set.
//
// Both files read the payload the screen renders, straight from the cash
// manager route, and both cut it to the same span (cashSpan) and the same item
// lists (itemLists). A projection printed for 60 days whose lists ran to 90, or
// a spreadsheet that kept an item the PDF had dropped, is two documents telling
// different stories about one forecast. Both lead with the days before today
// as they happened (actualRows), as the screen's chart does.

const doc    = require('./budget-doc');
const render = require('./budget-render');

const { pageHeader, pageFooter, STYLES, fetchedNote, dayLabel } = doc;
const { _cell: cell, _latin1: latin1, _currencyNote: currencyNote } = doc;
const { MUTED, RULE, BAND, NEGATIVE } = doc._colours;
const { MONEY_FMT, ARGB, _workbook, _sheetHeader, _num: num } = render;

const TITLE = 'Cash Flow Manager';
const RIGHT = { horizontal: 'right' };

// Dates go into the workbook as dates, so a reader can sort and filter on them;
// the weekday leads in the daily sheet, where it is what explains a quiet row.
const DAY_FMT  = 'ddd d mmm yyyy';
const DATE_FMT = 'd mmm yyyy';
// The weekend tint, as light as the PDF's band so a printed sheet stays legible.
const WEEKEND_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5FA' } };

// Why an item sits on the day it does, in the screen's words. The date is the
// forecast's weakest link — a due date is a promise, a prediction is a guess —
// so a reader deciding whether to chase a payment needs to know which it is.
const BASIS = {
  expected:  'Expected date',
  planned:   'Planned date',
  predicted: 'Predicted from payment history',
  due:       'Due date',
  repeating: 'Repeating invoice',
  // The server's name for a repeating template's occurrence (its date comes
  // from the template's schedule); said the same way as `repeating`.
  scheduled: 'Repeating invoice',
  payment:   'Payment dated ahead',
  manual:    'Your entry',
  override:  'Changed here',
};
// What an item's source says about its date when the payload names no basis.
const SOURCE_BASIS = { repeating: 'repeating', payment: 'payment', manual: 'manual' };

// A Xero item whose date or amount was changed here is no longer on Xero's
// date, whatever basis it started from, so "Changed here" wins. An entry the
// user made is theirs from the start; editing it does not make it "changed".
// An unknown basis says nothing rather than guessing.
function basisText(item) {
  const manual = item?.source === 'manual' || item?.dateBasis === 'manual';
  if (item?.overridden && !manual) return BASIS.override;
  const key = String(item?.dateBasis || SOURCE_BASIS[item?.source] || '').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(BASIS, key)) return BASIS[key];
  return manual ? BASIS.manual : '';
}

function baseCurrency(organisation) {
  const c = organisation?.currency;
  return c && c !== '—' ? c : '';
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

// '2026-10-12' as a date at midnight UTC, read from the string so no timezone
// can move it a day. ExcelJS turns a Date into a serial from its UTC time, so
// this lands in the sheet as exactly that day.
function utcDay(iso) {
  const m = ISO_DAY.exec(String(iso || ''));
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function isWeekend(iso) {
  const d = utcDay(iso)?.getUTCDay();
  return d === 0 || d === 6;
}

// 'Mon 12 Oct 2026': the weekday is what tells a reader why a day has no
// receipts, which a bare date does not.
function dayText(iso) {
  const d = utcDay(iso);
  return d ? `${WEEKDAY[d.getUTCDay()]} ${dayLabel(iso)}` : latin1(iso);
}

// What goes into a workbook date cell: the day as a date, or whatever arrived
// as text rather than nothing, so a malformed date is visible, not lost.
const sheetDate = iso => utcDay(iso) || (iso ? String(iso) : null);

const positive = v => {
  const n = Math.floor(Number(v));
  return n > 0 ? n : 0;
};

// The span both files print: today and the days asked for after it, or the
// payload's own horizon, and never more days than the series has — a title
// saying "90 days" over a table of 60 would be claiming a projection nobody
// made. Xero's "60 days" runs from today to the day sixty days on (6 Oct to
// 5 Dec), so 60 days is 61 rows, and the payload's horizon counts today too.
// The last day is read from the series, so the title names the same day the
// table ends on.
function cashSpan(payload, days) {
  const series = Array.isArray(payload?.series) ? payload.series : [];
  const most = Math.max(0, series.length - 1);
  let n = positive(days) || Math.max(0, positive(payload?.horizonDays) - 1) || most;
  if (n > most) n = most;
  const rows = series.slice(0, series.length ? n + 1 : 0);
  return { days: n, rows, end: rows.length ? String(rows[rows.length - 1]?.date || '') : '' };
}

// The days before today as they happened, oldest first, as the payload has
// them. Unavailable when the server could not read them, so the file says so
// rather than printing thirty days of nothing; null for a payload that
// carries none, which prints no section at all.
function actualRows(payload) {
  if (payload?.actualsAvailable === false) {
    return { available: false, rows: [], days: positive(payload?.actualDays) || 30 };
  }
  const rows = Array.isArray(payload?.actuals) ? payload.actuals.filter(Boolean) : [];
  return rows.length ? { available: true, rows, days: rows.length } : null;
}

const actualHeading = actual => `Actual (last ${actual.days} day${actual.days === 1 ? '' : 's'})`;
const ACTUAL_UNAVAILABLE = 'Past cash could not be read from Xero, so the days before today are not shown.';

// Under the title and over every sheet: how far the projection runs and the
// currency, as the Balance Sheet export puts its day and currency there.
function cashSubtitle(payload, span) {
  const end  = dayLabel(span.end);
  const what = span.days > 0
    ? `Projected for ${span.days} day${span.days === 1 ? '' : 's'}${end ? ` ending on ${end}` : ''}`
    : '';
  return [what, baseCurrency(payload?.organisation)].filter(Boolean).join(' · ');
}

// The five figures across the top, in the screen's order. The bank balance
// stands alone; each of the others is a net movement, with the cash in and out
// it is made of printed beneath it.
function tiles(payload) {
  const t = payload?.tiles || {};
  const flow = (label, f) => ({ label, amount: f?.net, in: f?.in, out: f?.out });
  return [
    { label: "Today's bank balance", amount: t.bankBalance ?? payload?.bank?.balance, balance: true },
    flow("Today's movement", t.today),
    flow('Next 1–7 days', t.next7),
    flow('Next 8–30 days', t.next8to30),
    flow('Overdue', t.overdue),
  ];
}

// The accounts the bank balance is made of, and those left out of it, so a
// reader can check the opening figure against their own bank statements.
function bankAccounts(payload) {
  const accounts = Array.isArray(payload?.bank?.accounts) ? payload.bank.accounts : [];
  return {
    counted: accounts.filter(a => a?.included !== false),
    left:    accounts.filter(a => a?.included === false),
  };
}

// An item's number and its reference or description, which is all a manual
// entry has to go by. One of them alone when the other is blank or the same.
function describe(item) {
  const parts = [item?.number, item?.reference || item?.description]
    .map(s => String(s ?? '').trim())
    .filter(Boolean);
  return [...new Set(parts)].join(' · ');
}

const dueOf = item => item?.dueDate || item?.date || '';

// The item lists both files print. Overdue items go in a list of their own
// whichever way the money flows, since the question they raise — chase it, or
// pay it — is not one about a day in the projection. The rest are kept to the
// days being printed: an item dated past the last row is in no figure on the
// page, and listing it would make the lists add up to more than the table.
// Within a list, by date; excluded items go last, so the ones that move the
// figures are read first, and the ones that do not stay visible as excluded.
function itemLists(payload, span) {
  const items = Array.isArray(payload?.items) ? payload.items.filter(Boolean) : [];
  const inSpan = it => !span.end || String(it.date || '') <= span.end;
  const order = dateOf => (a, b) =>
    (a.excluded ? 1 : 0) - (b.excluded ? 1 : 0) || String(dateOf(a)).localeCompare(String(dateOf(b)));
  const current = items.filter(it => !it.overdue && inSpan(it));
  return {
    in:      current.filter(it => it.direction === 'in').sort(order(it => it.date || '')),
    out:     current.filter(it => it.direction === 'out').sort(order(it => it.date || '')),
    overdue: items.filter(it => it.overdue).sort(order(dueOf)),
  };
}

const EXCLUDED_NOTE = 'Items struck through and marked "excluded" are left out of every figure above.';
const FOLDED_NOTE   = 'A "?" stands for a character the PDF\'s built-in font cannot draw. '
  + 'The Excel export carries every name as written in Xero.';

// ── PDF ─────────────────────────────────────────────────────────────────────

// Plain table rules, as the Balance Sheet draws them: one under the column
// heads and none between rows.
function plainLayout(fill) {
  return {
    vLineWidth: () => 0,
    hLineWidth: i => (i === 1 ? 0.7 : 0),
    hLineColor: () => RULE,
    fillColor: fill || (() => null),
    paddingLeft:   () => 5,
    paddingRight:  () => 5,
    paddingTop:    () => 2.5,
    paddingBottom: () => 2.5,
  };
}

const heading = text => ({ text, style: 'section', fontSize: 9, margin: [0, 12, 0, 4] });

function tileTable(payload) {
  const { counted } = bankAccounts(payload);
  const overdraft   = Number(payload?.bank?.overdraft || 0);
  const bankLine = [
    counted.length ? `${counted.length} account${counted.length === 1 ? '' : 's'}` : '',
    overdraft > 0 ? `Overdraft limit ${cell(overdraft)}` : '',
  ].filter(Boolean).join(' · ');
  return {
    table: {
      widths: new Array(5).fill('*'),
      body: [tiles(payload).map(t => ({
        stack: [
          { text: t.label, style: 'colHead' },
          // Red only for a balance below zero, as in the daily table: red
          // means overdrawn, and a net outflow is not that.
          { text: cell(t.amount), fontSize: 12, bold: true, margin: [0, 2, 0, 1], ...(t.balance && num(t.amount) < 0 ? { color: NEGATIVE } : {}) },
          { text: t.balance ? bankLine : `In ${cell(t.in)} · Out ${cell(t.out)}`, style: 'aside' },
        ],
      }))],
    },
    layout: {
      hLineWidth: () => 0.7,
      vLineWidth: () => 0.7,
      hLineColor: () => RULE,
      vLineColor: () => RULE,
      paddingLeft:   () => 7,
      paddingRight:  () => 7,
      paddingTop:    () => 5,
      paddingBottom: () => 5,
    },
  };
}

function dailyTable(span) {
  const body = [['Date', 'Cash in', 'Cash out', 'Net movement', 'Bank balance'].map((t, i) => ({
    text: t, style: 'colHead', ...(i ? { alignment: 'right' } : {}),
  }))];
  // Which rows fall on a weekend is known only here, while the body is built;
  // the fill callback receives nothing but an index.
  const weekend = new Set();
  const money = v => ({ text: cell(v), style: 'account', alignment: 'right' });
  for (const r of span.rows) {
    if (isWeekend(r?.date)) weekend.add(body.length);
    // A past day's balance is blank when there was no balance today to work
    // it back from: a dash would read as nil.
    const balance = r?.balance === null ? { text: '', style: 'account' } : money(r?.balance);
    if (num(r?.balance) < 0) balance.color = NEGATIVE;
    body.push([{ text: dayText(r?.date), style: 'account' }, money(r?.in), money(r?.out), money(r?.net), balance]);
  }
  return {
    table: { headerRows: 1, dontBreakRows: true, widths: [90, '*', '*', '*', '*'], body },
    layout: plainLayout(i => (weekend.has(i) ? BAND : null)),
  };
}

// One item as a row. An excluded item keeps its place in the list, struck
// through and muted, with the word "excluded" left legible beside it — a
// struck-through line alone is easy to miss on a monochrome printout.
function itemRow(item, overdue) {
  const off  = item.excluded ? { decoration: 'lineThrough', color: MUTED } : {};
  const text = (t, extra = {}) => ({ text: t, style: 'account', ...off, ...extra });
  const desc = latin1(describe(item));
  const day  = overdue ? dueOf(item) : item.date;
  const row  = [
    text(dayLabel(day) || latin1(day)),
    text(latin1(item.contactName)),
    item.excluded
      ? { text: [{ text: desc, ...off }, { text: `${desc ? '  ' : ''}excluded`, italics: true, color: MUTED }], style: 'account' }
      : text(desc),
  ];
  if (overdue) {
    const amount = cell(item.amount);
    row.push(
      text(item.direction === 'in' ? amount : '', { alignment: 'right' }),
      text(item.direction === 'out' ? amount : '', { alignment: 'right' }),
    );
  } else {
    row.push(text(basisText(item)), text(cell(item.amount), { alignment: 'right' }));
  }
  return row;
}

function itemTable(items, overdue, empty) {
  if (!items.length) return { text: empty, style: 'note' };
  const heads = overdue
    ? ['Due date', 'Contact', 'Number / description', 'Cash in', 'Cash out']
    : ['Date', 'Contact', 'Number / description', 'Date basis', 'Amount'];
  const money = overdue ? [3, 4] : [4];
  return {
    table: {
      headerRows: 1,
      dontBreakRows: true,
      widths: overdue ? ['auto', '*', '*', 70, 70] : ['auto', '*', '*', 'auto', 70],
      body: [
        heads.map((t, i) => ({ text: t, style: 'colHead', ...(money.includes(i) ? { alignment: 'right' } : {}) })),
        ...items.map(it => itemRow(it, overdue)),
      ],
    },
    layout: plainLayout(),
  };
}

// Landscape, so the five figures sit in one row and the daily table's columns
// are wide enough to read across without a ruler.
function cashManagerDefinition(payload, opts = {}) {
  const organisation = payload?.organisation || {};
  const currency  = baseCurrency(organisation);
  const generated = opts.generatedAt ?? Date.now();
  const span      = cashSpan(payload, opts.days);
  const lists     = itemLists(payload, span);
  const actual    = actualRows(payload);
  const ahead     = `in the ${span.days} day${span.days === 1 ? '' : 's'} projected`;

  const { counted, left } = bankAccounts(payload);
  const names = list => list.map(a => latin1(a?.name)).filter(Boolean).join(', ');
  const bankNote = [
    counted.length ? `Bank balance from ${names(counted)}.` : '',
    left.length ? `Left out: ${names(left)}.` : '',
  ].filter(Boolean).join(' ');

  const shown  = [...lists.in, ...lists.out, ...lists.overdue];
  const folded = shown.some(it => latin1(it.contactName) !== String(it.contactName ?? '') || latin1(describe(it)) !== describe(it));
  const notes  = [
    ...(payload?.notes || []).map(n => latin1(n)),
    ...(shown.some(it => it.excluded) ? [EXCLUDED_NOTE] : []),
    ...(folded ? [FOLDED_NOTE] : []),
  ].map((n, i) => ({ text: n, style: 'note', margin: [0, i === 0 ? 10 : 3, 0, 0] }));

  return {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [32, 60, 32, 30],
    defaultStyle: { font: 'Helvetica', fontSize: 8 },
    header: pageHeader(
      organisation.name,
      TITLE,
      cashSubtitle(payload, span),
      { generatedAt: generated, timezone: opts.timezone, fetched: fetchedNote(payload, opts.timezone) },
    ),
    footer: pageFooter(currencyNote(currency)),
    styles: STYLES,
    content: [
      tileTable(payload),
      ...(bankNote ? [{ text: bankNote, style: 'aside', margin: [0, 4, 0, 0] }] : []),
      ...(actual ? [
        heading(actualHeading(actual)),
        actual.available ? dailyTable(actual) : { text: ACTUAL_UNAVAILABLE, style: 'note' },
      ] : []),
      heading('Day by day'),
      dailyTable(span),
      heading('Cash in'),
      itemTable(lists.in, false, `No cash expected in ${ahead}.`),
      heading('Cash out'),
      itemTable(lists.out, false, `No cash going out ${ahead}.`),
      heading('Overdue'),
      itemTable(lists.overdue, true, 'Nothing overdue.'),
      ...notes,
    ],
  };
}

// ── Workbook ────────────────────────────────────────────────────────────────
// Numbers as numbers with the budget exports' display format, never as
// preformatted strings, and dates as dates: an export that arrives as text is
// one an accountant cannot sum or sort, which defeats the point of offering a
// spreadsheet beside the PDF.

// A sheet with the shared title block and a header row. Columns are described
// once — label, width, and whether they hold money or a date — so the header,
// the widths and each row's formats cannot fall out of step.
function addSheet(wb, name, payload, subtitle, opts, columns) {
  const sheet   = wb.addWorksheet(name);
  const headRow = _sheetHeader(sheet, payload, TITLE, subtitle, opts, columns.length);
  const header  = sheet.getRow(headRow);
  header.values = columns.map(c => c.label);
  header.font   = { bold: true, size: 10 };
  columns.forEach((c, i) => {
    if (c.money) header.getCell(i + 1).alignment = RIGHT;
    sheet.getColumn(i + 1).width = c.width;
  });
  sheet.views = [{ state: 'frozen', ySplit: headRow }];
  return sheet;
}

function addRow(sheet, columns, values) {
  const row = sheet.addRow(values);
  columns.forEach((c, i) => {
    if (c.money) row.getCell(i + 1).numFmt = MONEY_FMT;
    if (c.date && values[i] instanceof Date) row.getCell(i + 1).numFmt = c.date;
  });
  return row;
}

function closeSheet(sheet, currency, notes = []) {
  sheet.addRow([]);
  for (const n of notes) sheet.addRow([String(n)]).font = { size: 9, italic: true };
  sheet.addRow([currencyNote(currency)]).font = { size: 8, italic: true, color: { argb: ARGB.muted } };
}

const MONEY = width => ({ money: true, width });

function summarySheet(wb, payload, subtitle, opts, currency) {
  const columns = [{ label: 'Figure', width: 30 }, { ...MONEY(16), label: 'Amount' }, { ...MONEY(16), label: 'Cash in' }, { ...MONEY(16), label: 'Cash out' }];
  const sheet = addSheet(wb, 'Summary', payload, subtitle, opts, columns);
  for (const t of tiles(payload)) {
    const row = addRow(sheet, columns, t.balance ? [t.label, num(t.amount), null, null] : [t.label, num(t.amount), num(t.in), num(t.out)]);
    if (t.balance && num(t.amount) < 0) row.getCell(2).font = { color: { argb: ARGB.negative } };
  }
  // The accounts behind the opening balance, as the PDF names them under the
  // figures, with whether each is counted in it.
  const { counted, left } = bankAccounts(payload);
  if (counted.length || left.length) {
    sheet.addRow([]);
    const head = sheet.addRow(['Bank account', 'Balance', 'Currency', 'Counted']);
    head.font = { bold: true, size: 10 };
    head.getCell(2).alignment = RIGHT;
    for (const a of [...counted, ...left]) {
      addRow(sheet, columns.slice(0, 2), [String(a?.name ?? ''), num(a?.balance), a?.currency || '', a?.included === false ? 'No' : 'Yes']);
    }
  }
  closeSheet(sheet, currency, payload?.notes || []);
}

const DAY_COLUMNS = [
  { label: 'Date', width: 18, date: DAY_FMT },
  { ...MONEY(15), label: 'Cash in' },
  { ...MONEY(15), label: 'Cash out' },
  { ...MONEY(15), label: 'Net movement' },
  { ...MONEY(15), label: 'Bank balance' },
];

// A row a day, as the PDF's table. A balance that could not be worked back is
// an empty cell, not a nil one.
function dayRows(sheet, rows) {
  for (const r of rows) {
    const balance = r?.balance === null ? null : num(r?.balance);
    const row = addRow(sheet, DAY_COLUMNS, [sheetDate(r?.date), num(r?.in), num(r?.out), num(r?.net), balance]);
    if (isWeekend(r?.date)) for (let c = 1; c <= DAY_COLUMNS.length; c++) row.getCell(c).fill = WEEKEND_FILL;
    if (num(r?.balance) < 0) row.getCell(5).font = { color: { argb: ARGB.negative } };
  }
}

function dailySheet(wb, payload, subtitle, opts, currency, span) {
  const sheet = addSheet(wb, 'Daily', payload, subtitle, opts, DAY_COLUMNS);
  dayRows(sheet, span.rows);
  closeSheet(sheet, currency);
}

// The days before today, on a sheet ahead of the projection's, as the PDF
// prints them ahead of it.
function actualSheet(wb, payload, subtitle, opts, currency, actual) {
  const sheet = addSheet(wb, actualHeading(actual), payload, subtitle, opts, DAY_COLUMNS);
  if (actual.available) dayRows(sheet, actual.rows);
  closeSheet(sheet, currency, actual.available ? [] : [ACTUAL_UNAVAILABLE]);
}

// An excluded item, struck through and muted as in the PDF, with its status
// in a column of its own so a reader can filter the excluded ones out.
function markExcluded(row, item, width) {
  if (!item.excluded) return;
  for (let c = 1; c <= width; c++) row.getCell(c).font = { strike: true, color: { argb: ARGB.muted } };
}

function itemSheet(wb, name, items, payload, subtitle, opts, currency) {
  const columns = [
    { label: 'Date', width: 13, date: DATE_FMT },
    { label: 'Due date', width: 13, date: DATE_FMT },
    { label: 'Contact', width: 28 },
    { label: 'Number', width: 14 },
    { label: 'Description', width: 30 },
    { label: 'Date basis', width: 28 },
    { ...MONEY(15), label: 'Amount' },
    { label: 'Status', width: 10 },
  ];
  const sheet = addSheet(wb, name, payload, subtitle, opts, columns);
  for (const it of items) {
    const row = addRow(sheet, columns, [
      sheetDate(it.date), sheetDate(it.dueDate), String(it.contactName ?? ''), String(it.number ?? ''),
      String(it.reference || it.description || ''), basisText(it), num(it.amount), it.excluded ? 'Excluded' : '',
    ]);
    markExcluded(row, it, columns.length);
  }
  closeSheet(sheet, currency);
}

function overdueSheet(wb, items, payload, subtitle, opts, currency) {
  const columns = [
    { label: 'Due date', width: 13, date: DATE_FMT },
    { label: 'Contact', width: 28 },
    { label: 'Number', width: 14 },
    { label: 'Description', width: 30 },
    { ...MONEY(15), label: 'Cash in' },
    { ...MONEY(15), label: 'Cash out' },
    { label: 'Status', width: 10 },
  ];
  const sheet = addSheet(wb, 'Overdue', payload, subtitle, opts, columns);
  for (const it of items) {
    const amount = num(it.amount);
    const row = addRow(sheet, columns, [
      sheetDate(dueOf(it)), String(it.contactName ?? ''), String(it.number ?? ''), String(it.reference || it.description || ''),
      it.direction === 'in' ? amount : null, it.direction === 'out' ? amount : null, it.excluded ? 'Excluded' : '',
    ]);
    markExcluded(row, it, columns.length);
  }
  closeSheet(sheet, currency);
}

function cashManagerWorkbook(payload, opts = {}) {
  const currency  = baseCurrency(payload?.organisation);
  const generated = opts.generatedAt ?? Date.now();
  const span      = cashSpan(payload, opts.days);
  const lists     = itemLists(payload, span);
  const actual    = actualRows(payload);
  const subtitle  = cashSubtitle(payload, span);
  const o         = { ...opts, generatedAt: generated };

  const wb = _workbook(generated);
  summarySheet(wb, payload, subtitle, o, currency);
  if (actual) actualSheet(wb, payload, subtitle, o, currency, actual);
  dailySheet(wb, payload, subtitle, o, currency, span);
  itemSheet(wb, 'Cash in', lists.in, payload, subtitle, o, currency);
  itemSheet(wb, 'Cash out', lists.out, payload, subtitle, o, currency);
  overdueSheet(wb, lists.overdue, payload, subtitle, o, currency);
  return wb;
}

// ── Filename ────────────────────────────────────────────────────────────────
// Carries the organisation, the day the projection starts and how far it runs,
// so a download is identifiable on a desktop and a 30-day file cannot
// overwrite a 90-day one. Sanitised by the same rule as the budget exports'
// exportFilename. The extension is appended when a format is given, and left
// off otherwise for a caller that adds its own.
function cashManagerFilename(payload, format, days) {
  const slug = s => String(s).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  const org  = slug(payload?.organisation?.name || 'organisation').slice(0, 40) || 'organisation';
  const day  = slug(payload?.today || 'undated') || 'undated';
  const span = cashSpan(payload, days);
  const parts = ['Cash-Flow-Manager', org, day];
  if (span.days > 0) parts.push(`${span.days}-days`);
  const base = parts.join('_');
  const ext  = format ? slug(String(format).toLowerCase()) : '';
  return ext ? `${base}.${ext}` : base;
}

module.exports = {
  cashManagerDefinition,
  cashManagerWorkbook,
  cashManagerFilename,
  cashSpan,
  cashSubtitle,
  actualRows,
  itemLists,
  basisText,
  BASIS,
};
