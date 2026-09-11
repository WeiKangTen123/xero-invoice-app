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
// The catch is coverage: the standard fonts are Latin-1, so a label written in
// a non-Latin script cannot be drawn. Rather than let that throw mid-stream,
// text is folded to Latin-1 on the way in (see _latin1 in budget-doc), and the
// .xlsx export — which is UTF-8 throughout — is the one to reach for when the
// chart of accounts is not in a Latin script.
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
const MONEY_FMT = '#,##0.00;(#,##0.00);"–"';

function _sheetHeader(sheet, organisation, title, subtitle, generatedAt, width) {
  sheet.mergeCells(1, 1, 1, width);
  sheet.getCell(1, 1).value = `${organisation?.name || 'Organisation'} — ${title}`;
  sheet.getCell(1, 1).font  = { bold: true, size: 13 };
  sheet.mergeCells(2, 1, 2, width);
  sheet.getCell(2, 1).value = `${subtitle} · Generated ${new Date(generatedAt).toLocaleString('en-GB')}`;
  sheet.getCell(2, 1).font  = { size: 9, color: { argb: 'FF6B7280' } };
}

function budgetVsActualWorkbook(payload, opts = {}) {
  const { months = [], rows = [], organisation = {}, fiscalYear = {} } = payload || {};
  const currency  = organisation.currency && organisation.currency !== '—' ? organisation.currency : '';
  const generated = opts.generatedAt || Date.now();

  const wb    = new ExcelJS.Workbook();
  wb.creator  = 'Xero Invoice Automation';
  wb.created  = new Date(generated);
  const sheet = wb.addWorksheet('Budget vs Actual', { views: [{ state: 'frozen', xSplit: 1, ySplit: 4 }] });

  const width = months.length + 2;
  _sheetHeader(sheet, organisation, 'Budget vs Actual',
    [fiscalYear.label || 'Current financial year', currency].filter(Boolean).join(' · '), generated, width);

  const firstBudgetIdx = months.findIndex(m => m.source === 'budget');
  sheet.getRow(3).values = ['', ...months.map(m => (m.source === 'budget' ? 'Budget' : 'Actual')), ''];
  sheet.getRow(3).font   = { size: 8, color: { argb: 'FF6B7280' } };

  const header = sheet.getRow(4);
  header.values = ['Account', ...months.map(m => m.label), 'Total'];
  header.font   = { bold: true, size: 10 };

  for (const r of rows) {
    if (r.kind === 'section') {
      const row = sheet.addRow([r.label]);
      row.font = { bold: true };
      continue;
    }
    const strong = r.kind === 'subtotal' || r.kind === 'summary';
    const row = sheet.addRow([r.label, ...(r.cells || []).map(Number), Number(r.total || 0)]);
    if (strong) row.font = { bold: true };
    for (let c = 2; c <= width; c++) row.getCell(c).numFmt = MONEY_FMT;
  }

  sheet.getColumn(1).width = 34;
  for (let c = 2; c <= width; c++) sheet.getColumn(c).width = 13;
  if (firstBudgetIdx >= 0) {
    // Mark where actuals stop, the same seam the PDF rules and the screen draws.
    sheet.getColumn(firstBudgetIdx + 2).border = { left: { style: 'medium', color: { argb: 'FF6366F1' } } };
  }
  sheet.addRow([]);
  sheet.addRow([doc._currencyNote(currency, payload.currency)]).font = { size: 8, italic: true, color: { argb: 'FF6B7280' } };
  return wb;
}

function budgetVarianceWorkbook(payload, opts = {}) {
  const { rows = [], organisation = {}, months = [] } = payload || {};
  const currency  = organisation.currency && organisation.currency !== '—' ? organisation.currency : '';
  const generated = opts.generatedAt || Date.now();
  const month     = opts.month || 'ytd';
  const idx       = month === 'ytd' ? -1 : Math.max(0, months.findIndex(m => m.key === month));
  const label     = month === 'ytd' ? 'Year to date' : (months[idx]?.label || 'Year to date');
  const figuresFor = r => (month === 'ytd'
    ? { actual: r.actualToDate, budget: r.budgetToDate, variance: r.variance, variancePct: r.variancePct }
    : (r.monthly || [])[idx] || { actual: 0, budget: 0, variance: 0, variancePct: null });

  const wb    = new ExcelJS.Workbook();
  wb.creator  = 'Xero Invoice Automation';
  wb.created  = new Date(generated);
  const sheet = wb.addWorksheet('Budget Variance', { views: [{ state: 'frozen', xSplit: 1, ySplit: 3 }] });

  _sheetHeader(sheet, organisation, 'Budget Variance',
    [label, currency].filter(Boolean).join(' · '), generated, 5);

  const header = sheet.getRow(3);
  header.values = ['Account', 'Actual', 'Budget', 'Variance', 'Variance %'];
  header.font   = { bold: true, size: 10 };

  for (const r of rows) {
    if (r.kind === 'section') {
      sheet.addRow([r.label]).font = { bold: true };
      continue;
    }
    const strong = r.kind === 'subtotal' || r.kind === 'summary';
    const v = figuresFor(r);
    const row = sheet.addRow([
      r.label, Number(v.actual || 0), Number(v.budget || 0), Number(v.variance || 0),
      v.variancePct === null || v.variancePct === undefined ? null : Number(v.variancePct),
    ]);
    if (strong) row.font = { bold: true };
    for (let c = 2; c <= 4; c++) row.getCell(c).numFmt = MONEY_FMT;
    row.getCell(5).numFmt = '+0.0%;-0.0%;"–"';
  }

  sheet.getColumn(1).width = 38;
  for (let c = 2; c <= 5; c++) sheet.getColumn(c).width = 14;
  sheet.addRow([]);
  sheet.addRow([doc._currencyNote(currency, payload.currency)]).font = { size: 8, italic: true, color: { argb: 'FF6B7280' } };
  return wb;
}

module.exports = { streamPdf, budgetVsActualWorkbook, budgetVarianceWorkbook, FONTS };
