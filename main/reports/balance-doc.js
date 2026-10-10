// The Balance Sheet export: a pdfmake document definition and an ExcelJS
// workbook, built the way the budget exports are (budget-doc.js,
// budget-render.js) and from the same page furniture, so the three reports
// come out of the printer looking like one set.
//
// Both files walk one flattened list of lines (balanceLines), in the order Xero
// prints them, so the PDF and the workbook cannot lay the report out
// differently — the same reason the variance exports share variancePeriods.
// And both read the payload the screen renders, straight from the balance
// sheet route: a second query shaped slightly differently is how a report and
// its export start telling different stories.

const doc    = require('./budget-doc');
const render = require('./budget-render');

const { pageHeader, pageFooter, STYLES, FOLDED_NOTE, fetchedNote, dayLabel } = doc;
const { _cell: cell, _latin1: latin1, _pdfLabel: pdfLabel, _currencyNote: currencyNote, _hasFolded: hasFolded } = doc;
const { RULE, BAND, AMBER } = doc._colours;
const { MONEY_FMT, ARGB, _workbook, _sheetHeader, _num: num } = render;

const RIGHT = { horizontal: 'right' };

const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// What the figures are: Xero's own wording for the two bases its reports can
// be run on. An unknown basis says nothing rather than guessing.
const BASIS = { accrual: 'Accrual basis', cash: 'Cash basis' };

function baseCurrency(organisation) {
  const c = organisation?.currency;
  return c && c !== '—' ? c : '';
}

// A balance as at a day inside the month still in progress is a figure still
// moving. It is the balance as Xero held it on the day it was read — an
// invoice dated the 25th is in it on the 8th — so "as at 8 Oct" read as the
// 1st to the 8th, which it never was. Said the way the budget exports say it
// of their month in progress.
function inProgressNote(asAt) {
  if (!asAt?.inProgress) return '';
  const day = dayLabel(asAt.iso) || String(asAt.label || '');
  const m   = /^\d{4}-(\d{2})/.exec(String(asAt.iso || ''));
  const month = m ? MONTH_FULL[Number(m[1]) - 1] : '';
  return `${day} — month in progress: includes everything dated in ${month || 'the month'} as Xero holds it`;
}

// The comparison the payload carries, when it carries one: how many earlier
// periods sit beside the as-at column, and what kind they are.
function compareSpan(compare) {
  const n = Number(compare?.periods || 0);
  if (!(n > 0) || !compare?.type) return null;
  const type = String(compare.type).toLowerCase();
  return { n, type, text: `${n} previous ${type}${n === 1 ? '' : 's'}` };
}

// What the report covers, in words, under the title and over the sheet: the
// day, the comparison, the basis and the currency. The day is the label the
// server wrote ('30 September 2026') so the file and the screen agree on it.
function balanceSubtitle(payload) {
  const asAt = payload?.asAt || {};
  const day  = asAt.label || dayLabel(asAt.iso);
  const cmp  = compareSpan(payload?.compare);
  return [
    day ? `As at ${day}` : '',
    cmp ? `Compared with ${cmp.text}` : '',
    BASIS[String(payload?.basis || '').toLowerCase()] || '',
    baseCurrency(payload?.organisation),
  ].filter(Boolean).join(' · ');
}

// The report as a list of lines in print order, which both files walk: each
// group's title in caps, each subgroup's title, its accounts, its total, the
// group's total, and Net Assets between liabilities and equity — before the
// equity group wherever it sits, or last when there is none — as Xero lays it
// out. A subgroup with no title (equity, in Xero's standard layout) prints
// its accounts straight under the group, and one with no total prints none.
function balanceLines(payload) {
  const lines  = [];
  const groups = payload?.groups || [];
  const net    = payload?.netAssets;
  const equity = groups.findIndex(g => g?.key === 'equity');
  const push = (kind, label, src) => lines.push({
    kind, label: String(label ?? ''), code: src?.code ?? null, values: Array.isArray(src?.values) ? src.values : null,
  });
  groups.forEach((g, i) => {
    if (net && i === equity) push('net', String(net.label || 'Net Assets').toUpperCase(), net);
    push('group', String(g?.title || '').toUpperCase());
    for (const sg of g?.subgroups || []) {
      // Equity arrives as a group with a lone subgroup of the same name (Xero
      // prints its total inside the section); one heading, not two.
      const sameAsGroup = String(sg?.title || '').trim().toLowerCase() === String(g?.title || '').trim().toLowerCase();
      if (sg?.title && !sameAsGroup) push('subgroup', sg.title);
      for (const r of sg?.rows || []) push('account', r?.label, r);
      if (sg?.total) push('subtotal', sg.total.label, sg.total);
    }
    if (g?.total) push('total', g.total.label, g.total);
  });
  if (net && equity === -1) push('net', String(net.label || 'Net Assets').toUpperCase(), net);
  return lines;
}

// A line's name as it is printed. The account code follows the name, as it
// does on screen (BankingTab), when the reader asked for codes; a line without
// one — Current Year Earnings has none — is just its name.
function lineLabel(line, codes) {
  return codes && line.code ? `${line.label} · ${line.code}` : line.label;
}

const isTitle = l => l.kind === 'group' || l.kind === 'subgroup';
const blanks  = n => Array.from({ length: n }, () => ({ text: '' }));

// ── PDF ─────────────────────────────────────────────────────────────────────
// Portrait, as Xero prints it: a column per period beside the account, and up
// to four of those sit comfortably. A longer comparison takes the landscape
// page rather than being cut off at the right-hand edge, which is what pdfmake
// does to a table wider than its page.
function balanceSheetDefinition(payload, opts = {}) {
  const { organisation = {}, columns = [] } = payload || {};
  const currency  = baseCurrency(organisation);
  const generated = opts.generatedAt ?? Date.now();
  const lines     = balanceLines(payload);
  const width     = 1 + columns.length;
  const labels    = lines.map(l => ({ label: lineLabel(l, opts.codes) }));

  const head = [
    { text: 'Account', style: 'colHead' },
    ...columns.map(c => ({ text: latin1(c?.label), style: 'colHead', alignment: 'right' })),
  ];
  const body = [head];
  // Rules and banding need to know what each row is, and the only place that
  // is known is here, while it is being built. Collected rather than
  // re-derived in the layout callbacks, which only receive an index.
  const ruleAbove  = new Set();
  const ruleBelow  = new Set();
  const bandedRows = new Set();
  let banded = false;

  lines.forEach((l, i) => {
    const label = pdfLabel(labels[i], i + 1);
    if (isTitle(l)) {
      banded = false;          // each heading restarts the stripe
      // Real cells rather than a colSpan, as in the budget exports, so a rule
      // can run through a heading if one is ever added.
      body.push([
        { text: label, style: 'section', ...(l.kind === 'group' ? { fontSize: 8.5, margin: [0, 8, 0, 2] } : { margin: [0, 4, 0, 1] }) },
        ...blanks(width - 1),
      ]);
      return;
    }
    const strong = l.kind !== 'account';
    // A rule above every total, as Xero draws one, and one below Net Assets,
    // which is the figure the report exists to deliver.
    if (strong) ruleAbove.add(body.length);
    if (l.kind === 'net') ruleBelow.add(body.length + 1);
    banded = !banded;
    if (banded) bandedRows.add(body.length);
    const style = strong ? 'strong' : 'account';
    const cells = [{ text: label, style, margin: [strong ? 0 : 8, 0, 0, 0] }];
    columns.forEach((_, c) => cells.push({ text: cell(l.values?.[c]), style, alignment: 'right' }));
    body.push(cells);
  });

  const progress = inProgressNote(payload?.asAt);
  const notes = (payload?.notes || []).map((n, i) => ({ text: latin1(n), style: 'note', margin: [0, i === 0 ? 8 : 3, 0, 0] }));
  if (hasFolded(labels)) notes.push({ text: FOLDED_NOTE, style: 'aside', margin: [0, 6, 0, 0] });

  return {
    pageSize: 'A4',
    pageOrientation: columns.length > 4 ? 'landscape' : 'portrait',
    pageMargins: [32, 60, 32, 30],
    defaultStyle: { font: 'Helvetica', fontSize: 8 },
    header: pageHeader(
      organisation.name,
      'Balance Sheet',
      balanceSubtitle(payload),
      { generatedAt: generated, timezone: opts.timezone, fetched: fetchedNote(payload, opts.timezone) },
    ),
    footer: pageFooter(currencyNote(currency)),
    styles: STYLES,
    content: [
      // Said before the figures, in the amber the screen gives a figure still
      // moving, so a reader does not take a mid-month balance for a closed one.
      ...(progress ? [{ text: latin1(progress), style: 'note', color: AMBER, margin: [0, 0, 0, 6] }] : []),
      {
        table: {
          headerRows: 1,
          dontBreakRows: true,
          widths: ['*', ...new Array(width - 1).fill('auto')],
          body,
        },
        layout: {
          vLineWidth: () => 0,
          hLineWidth: i => (i === 1 || ruleAbove.has(i) || ruleBelow.has(i) ? 0.7 : 0),
          hLineColor: () => RULE,
          fillColor: i => (bandedRows.has(i) ? BAND : null),
          paddingLeft:   () => 5,
          paddingRight:  () => 5,
          paddingTop:    () => 3,
          paddingBottom: () => 3,
        },
      },
      ...notes,
    ],
  };
}

// ── Workbook ────────────────────────────────────────────────────────────────
// Numbers as numbers with the budget exports' display format, never as
// preformatted strings: an export that arrives as text is one an accountant
// cannot sum, which defeats the point of offering a spreadsheet beside the PDF.
function balanceSheetWorkbook(payload, opts = {}) {
  const { organisation = {}, columns = [] } = payload || {};
  const currency  = baseCurrency(organisation);
  const generated = opts.generatedAt ?? Date.now();
  const lines     = balanceLines(payload);
  const width     = 1 + columns.length;

  const wb    = _workbook(generated);
  const sheet = wb.addWorksheet('Balance Sheet');

  let headRow = _sheetHeader(sheet, payload, 'Balance Sheet', balanceSubtitle(payload), { ...opts, generatedAt: generated }, width);
  // The month in progress, said above the table as it is in the PDF.
  const progress = inProgressNote(payload?.asAt);
  if (progress) {
    sheet.mergeCells(headRow, 1, headRow, width);
    const c = sheet.getCell(headRow, 1);
    c.value = progress;
    c.font  = { size: 9, italic: true, color: { argb: ARGB.amber } };
    headRow++;
  }

  const header = sheet.getRow(headRow);
  header.values = ['Account', ...columns.map(c => c?.label ?? '')];
  header.font   = { bold: true, size: 10 };
  for (let c = 2; c <= width; c++) header.getCell(c).alignment = RIGHT;

  for (const l of lines) {
    const label = lineLabel(l, opts.codes);
    if (isTitle(l)) {
      sheet.addRow([label]).font = { bold: true };
      continue;
    }
    const row = sheet.addRow([label, ...columns.map((_, c) => num(l.values?.[c]))]);
    if (l.kind === 'account') row.getCell(1).alignment = { indent: 1 };
    else row.font = { bold: true };
    for (let c = 2; c <= width; c++) row.getCell(c).numFmt = MONEY_FMT;
  }

  sheet.getColumn(1).width = 38;
  for (let c = 2; c <= width; c++) sheet.getColumn(c).width = 14;
  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: headRow }];

  sheet.addRow([]);
  for (const n of payload?.notes || []) sheet.addRow([String(n)]).font = { size: 9, italic: true };
  sheet.addRow([currencyNote(currency)]).font = { size: 8, italic: true, color: { argb: ARGB.muted } };
  return wb;
}

// ── Filename ────────────────────────────────────────────────────────────────
// Carries the organisation, the day and the comparison, so a download is
// identifiable on a desktop and last month's cannot overwrite this month's.
// Sanitised by the same rule as the budget exports' exportFilename. The
// extension is appended when a format is given, and left off otherwise for a
// caller that adds its own.
function balanceFilename(payload, format) {
  const slug = s => String(s).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  const org  = slug(payload?.organisation?.name || 'organisation').slice(0, 40) || 'organisation';
  const day  = slug(payload?.asAt?.iso || payload?.asAt?.label || 'undated');
  const cmp  = compareSpan(payload?.compare);
  const parts = ['Balance-Sheet', org, `as-at-${day}`];
  if (cmp) parts.push(`vs-${cmp.n}-prev-${slug(cmp.type)}${cmp.n === 1 ? '' : 's'}`);
  const base = parts.join('_');
  const ext  = format ? slug(String(format).toLowerCase()) : '';
  return ext ? `${base}.${ext}` : base;
}

module.exports = {
  balanceSheetDefinition,
  balanceSheetWorkbook,
  balanceFilename,
  balanceLines,
  balanceSubtitle,
  inProgressNote,
};
