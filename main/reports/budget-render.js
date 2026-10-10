// Turns the document definitions in budget-doc.js into actual files.
//
// Split from the definitions on purpose: the structure worth testing is the
// shape of the document, and asserting that by inspecting an object beats
// parsing a rendered PDF back out. This module is the thin part that only calls
// a library.

const ExcelJS = require('exceljs');
const doc     = require('./budget-doc');

// Helvetica is one of the 14 standard PDF fonts, which every reader resolves
// itself — no font file is embedded, nothing binary is vendored into the repo,
// and the output is a good deal smaller. pdfmake 0.2.x ships only a browser vfs
// bundle and no .ttf, so embedding Roboto here would have meant committing font
// binaries for no visible gain on a financial table.
//
// The catch is coverage: the standard fonts are drawn through WinAnsiEncoding,
// so a label written in a non-Latin script cannot be drawn. Rather than let that
// throw mid-stream, text is folded on the way in (see _latin1 in budget-doc),
// and the .xlsx export — which is UTF-8 throughout — is the one to reach for
// when the chart of accounts is not in a Latin script.
const FONTS = {
  Helvetica: {
    normal:      'Helvetica',
    bold:        'Helvetica-Bold',
    italics:     'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
};

let _printer = null;
// Built once and reused rather than per request.
function printer() {
  if (!_printer) {
    const PdfPrinter = require('pdfmake');
    _printer = new PdfPrinter(FONTS);
  }
  return _printer;
}

// Streams into `res` rather than buffering: these are small documents, but a
// stream means a slow client cannot pin a whole PDF in memory on a 2-core box.
function streamPdf(definition, res) {
  const pdf = printer().createPdfKitDocument(definition);
  pdf.pipe(res);
  pdf.end();
  return pdf;
}

// ── Workbook ────────────────────────────────────────────────────────────────
// Numbers land as numbers with a display format, never as preformatted strings.
// An export that arrives as text is one an accountant cannot sum, which defeats
// the point of offering a spreadsheet alongside the PDF.
//
// The formats print what the PDF and the screen print: brackets for negatives,
// a plain "-" for nil (it was an en dash here and a hyphen everywhere else), and
// percentages to two decimals with no plus sign, as Xero shows them. A
// percentage that prints as a dash is written as the text "-" (see below), so
// its format needs no zero section of its own.
const MONEY_FMT = '#,##0.00;(#,##0.00);"-"';
const PCT_FMT   = '0.00%';

const ARGB = {
  muted:    'FF6B7280',
  accent:   'FF6366F1',
  positive: 'FF0F9D76',
  negative: 'FFB42318',
  amber:    'FFB45309',
};
// The month in progress, tinted as on screen and in the PDF.
const AMBER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDF3DC' } };
const RIGHT      = { horizontal: 'right' };

// Rounded to cents, as the figures are printed. Sums of cent amounts can carry
// float noise (9857.100000000002) that shows the moment someone widens the
// number format, and that neither the PDF nor the screen ever shows.
const num = v => (Math.round(Number(v || 0) * 100) / 100) || 0;

// The title block above a sheet, one merged line each: what the report is, what
// it covers and when it was generated, when its figures were read from Xero,
// and — said before anything else — a missing budget. Returns the first free
// row, since how many lines there are depends on the payload.
function _sheetHeader(sheet, payload, title, subtitle, opts, width) {
  const muted = { size: 9, color: { argb: ARGB.muted } };
  const lines = [
    { text: `${payload?.organisation?.name || 'Organisation'} — ${title}`, font: { bold: true, size: 13 } },
    { text: `${subtitle} · Generated ${doc.stamp(opts.generatedAt, opts.timezone)}`, font: muted },
  ];
  const fetched = doc.fetchedNote(payload, opts.timezone);
  if (fetched) lines.push({ text: fetched, font: muted });
  if (payload?.budgetMissing) lines.push({ text: doc.BUDGET_MISSING, font: { bold: true, size: 10, color: { argb: ARGB.amber } } });
  lines.forEach((l, i) => {
    sheet.mergeCells(i + 1, 1, i + 1, width);
    sheet.getCell(i + 1, 1).value = l.text;
    sheet.getCell(i + 1, 1).font  = l.font;
  });
  return lines.length + 1;
}

// A heading spanning a block of columns, as the screen's band does.
function _band(sheet, row, from, to, text, argb, fill) {
  if (to > from) sheet.mergeCells(row, from, row, to);
  const c = sheet.getCell(row, from);
  c.value     = text;
  c.font      = { bold: true, size: 9, color: { argb } };
  c.alignment = { horizontal: 'center' };
  if (fill) c.fill = fill;
}

// The account name stays exactly as Xero has it, so a workbook can be matched
// against the chart of accounts or another export by name. "Not budgeted" goes
// in the cell's note instead of being appended to the name, where it broke
// every lookup on that account.
const labelOf = r => r.label ?? '';
const NOT_BUDGETED_NOTE = 'Not budgeted: this line has actuals in Xero but no Overall Budget.';
function markUnbudgeted(row, r) {
  if (r.unbudgeted) row.getCell(1).note = NOT_BUDGETED_NOTE;
}

function _workbook(generated) {
  const wb   = new ExcelJS.Workbook();
  wb.creator = 'Financial Automation';
  wb.created = new Date(generated);
  return wb;
}

function budgetVsActualWorkbook(payload, opts = {}) {
  const { months = [], rows = [], organisation = {}, fiscalYear = {} } = payload || {};
  const currency  = organisation.currency && organisation.currency !== '—' ? organisation.currency : '';
  const generated = opts.generatedAt ?? Date.now();

  const wb    = _workbook(generated);
  const sheet = wb.addWorksheet('Budget vs Actual');

  const firstBudgetIdx = months.findIndex(m => m.source === 'budget');
  const actualCount    = firstBudgetIdx === -1 ? months.length : firstBudgetIdx;
  // The month in progress gets a "so far" column before its budget one, as on
  // screen and in the PDF, and it stays out of Total.
  const curIdx   = doc.currentColumn(months);
  const hasCur   = curIdx >= 0;
  const soFarCol = hasCur ? 2 + curIdx : -1;
  const colOf    = i => 2 + i + (hasCur && i >= curIdx ? 1 : 0);
  const width    = months.length + 2 + (hasCur ? 1 : 0);

  const bandRow = _sheetHeader(sheet, payload, 'Budget vs Actual',
    [fiscalYear.label || 'Current financial year', currency].filter(Boolean).join(' · '),
    { ...opts, generatedAt: generated }, width);
  const headRow = bandRow + 1;

  // The same band as the screen: Actual, So far, Overall Budget. It used to
  // label every budget month just "Budget", which is not what Xero calls it.
  sheet.getCell(bandRow, 1).value = currency ? `Figures in ${currency}` : '';
  sheet.getCell(bandRow, 1).font  = { size: 8, color: { argb: ARGB.muted } };
  if (actualCount > 0) _band(sheet, bandRow, 2, 1 + actualCount, 'Actual', ARGB.positive);
  if (hasCur) _band(sheet, bandRow, soFarCol, soFarCol, 'So far', ARGB.amber, AMBER_FILL);
  if (actualCount < months.length) _band(sheet, bandRow, colOf(actualCount), width - 1, 'Overall Budget', ARGB.accent);

  const header = sheet.getRow(headRow);
  header.getCell(1).value = 'Account';
  months.forEach((m, i) => { header.getCell(colOf(i)).value = m.label; });
  header.getCell(width).value = 'Total';
  header.font = { bold: true, size: 10 };
  for (let c = 2; c <= width; c++) header.getCell(c).alignment = RIGHT;
  if (hasCur) {
    const c = header.getCell(soFarCol);
    c.value = `${String(months[curIdx].label).split(' ')[0]} so far`;
    c.font  = { bold: true, size: 10, color: { argb: ARGB.amber } };
    c.fill  = AMBER_FILL;
  }

  for (const r of rows) {
    if (r.kind === 'section') {
      sheet.addRow([r.label]).font = { bold: true };
      continue;
    }
    const strong = r.kind === 'subtotal' || r.kind === 'summary';
    const values = new Array(width).fill(null);
    values[0] = labelOf(r);
    months.forEach((_, i) => { values[colOf(i) - 1] = num(r.cells?.[i]); });
    if (hasCur) values[soFarCol - 1] = num(r.monthly?.[curIdx]?.actual);
    values[width - 1] = num(r.total);
    const row = sheet.addRow(values);
    markUnbudgeted(row, r);
    if (strong) row.font = { bold: true };
    for (let c = 2; c <= width; c++) row.getCell(c).numFmt = MONEY_FMT;
    if (hasCur) row.getCell(soFarCol).fill = AMBER_FILL;
  }
  const lastRow = sheet.rowCount;

  sheet.getColumn(1).width = 34;
  for (let c = 2; c <= width; c++) sheet.getColumn(c).width = 13;
  if (firstBudgetIdx >= 0) {
    // Mark where the closed actuals stop, the same seam the PDF rules and the
    // screen draws: before the "so far" column when there is one. Cell by cell
    // over the table only, so the merged title lines above are left alone.
    for (let r = bandRow; r <= lastRow; r++) {
      sheet.getCell(r, firstBudgetIdx + 2).border = { left: { style: 'medium', color: { argb: ARGB.accent } } };
    }
  }
  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: headRow }];

  sheet.addRow([]);
  // What has been booked so far in the month still in progress, which the grid
  // shows as budget. Same sentence as the PDF; text, because it is a note about
  // the figures rather than one of them.
  const soFar = doc.soFarNote(payload);
  if (soFar) sheet.addRow([soFar]).font = { size: 9, italic: true };
  sheet.addRow([doc._currencyNote(currency, payload?.currency)]).font = { size: 8, italic: true, color: { argb: ARGB.muted } };
  return wb;
}

function budgetVarianceWorkbook(payload, opts = {}) {
  const { rows = [], organisation = {} } = payload || {};
  const currency  = organisation.currency && organisation.currency !== '—' ? organisation.currency : '';
  const generated = opts.generatedAt ?? Date.now();
  // Resolved by the same rule as the PDF and the filename, and laid out from
  // the same column groups, so all three agree on which figures these are.
  const month   = doc.resolveMonth(payload, opts.month);
  const periods = doc.variancePeriods(payload, month);
  const width   = 1 + periods.length * 4;

  const wb    = _workbook(generated);
  const sheet = wb.addWorksheet('Budget Variance');

  const bandRow = _sheetHeader(sheet, payload, 'Budget Variance',
    [doc.varianceSubtitle(payload, month), currency].filter(Boolean).join(' · '),
    { ...opts, generatedAt: generated }, width);
  const headRow = bandRow + 1;

  sheet.getCell(bandRow, 1).value = currency ? `Figures in ${currency}` : '';
  sheet.getCell(bandRow, 1).font  = { size: 8, color: { argb: ARGB.muted } };
  periods.forEach((p, g) => _band(sheet, bandRow, 2 + g * 4, 5 + g * 4, p.label, ARGB.accent));

  const header = sheet.getRow(headRow);
  header.values = ['Account', ...periods.flatMap(() => ['Actual', 'Budget', 'Variance', 'Variance %'])];
  header.font   = { bold: true, size: 10 };
  for (let c = 2; c <= width; c++) header.getCell(c).alignment = RIGHT;

  for (const r of rows) {
    if (r.kind === 'section') {
      sheet.addRow([r.label]).font = { bold: true };
      continue;
    }
    const strong = r.kind === 'subtotal' || r.kind === 'summary';
    const values = [labelOf(r)];
    const groups = periods.map(p => doc.figures(p, r));
    for (const v of groups) {
      // A percentage the PDF prints as "-" — no budget to divide by, or a line
      // on budget — is written as that same dash rather than left blank in one
      // place and dashed in another. One the PDF prints as 0.00% is written as
      // 0, since a hair below zero would otherwise show in Excel as "-0.00%".
      const text = doc._pctCell(v);
      const pct  = text === '-' ? '-' : text === '0.00%' ? 0 : Number(v.variancePct);
      values.push(num(v.actual), num(v.budget), num(v.variance), pct);
    }
    const row = sheet.addRow(values);
    markUnbudgeted(row, r);
    if (strong) row.font = { bold: true };
    groups.forEach((v, g) => {
      const base = 2 + g * 4;
      for (let c = base; c < base + 3; c++) row.getCell(c).numFmt = MONEY_FMT;
      const pctCell = row.getCell(base + 3);
      pctCell.numFmt    = PCT_FMT;
      pctCell.alignment = RIGHT;
      // Favourable green, unfavourable red, as the PDF and the screen colour it.
      const good = doc.favourable(r, v.variance);
      if (good !== null) {
        const font = { bold: strong, color: { argb: good ? ARGB.positive : ARGB.negative } };
        row.getCell(base + 2).font = font;
        pctCell.font = font;
      }
    });
  }
  const lastRow = sheet.rowCount;

  sheet.getColumn(1).width = 38;
  for (let c = 2; c <= width; c++) sheet.getColumn(c).width = 14;
  // A rule where one group ends and the next begins, as in the PDF.
  for (let g = 1; g < periods.length; g++) {
    for (let r = bandRow; r <= lastRow; r++) {
      sheet.getCell(r, 2 + g * 4).border = { left: { style: 'thin', color: { argb: 'FFD8D8E4' } } };
    }
  }
  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: headRow }];

  sheet.addRow([]);
  sheet.addRow([doc._currencyNote(currency, payload?.currency)]).font = { size: 8, italic: true, color: { argb: ARGB.muted } };
  return wb;
}

module.exports = {
  streamPdf, budgetVsActualWorkbook, budgetVarianceWorkbook, FONTS, MONEY_FMT, PCT_FMT,
  // The workbook furniture, shared with the other report exports
  // (balance-doc.js) so every sheet opens with the same title block.
  ARGB, _workbook, _sheetHeader, _num: num,
};
