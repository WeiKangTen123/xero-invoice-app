// The monthly cash forecast's export: a pdfmake document definition and an
// ExcelJS workbook, built as the Cash Flow Manager's export is and from the
// same page furniture (budget-doc.js, budget-render.js), so it prints as one
// of the set.
//
// Both read the payload the Monthly tab renders, straight from the route
// (xero/cash-monthly.js), and both print the same grid: a row for each line
// the screen shows, a column for each month, the past months shaded as on
// screen, this month marked as actual and forecast together, and a closing
// balance below the overdraft limit in red. The workbook adds a sheet saying
// what each figure was made of, which the screen shows on hover and a page
// cannot.

const doc    = require('./budget-doc');
const render = require('./budget-render');

const { pageHeader, pageFooter, STYLES, fetchedNote, dayLabel } = doc;
const { _cell: cell, _latin1: latin1, _currencyNote: currencyNote } = doc;
const { MUTED, RULE, BAND, NEGATIVE, AMBER, AMBER_TINT } = doc._colours;
const { MONEY_FMT, ARGB, _workbook, _sheetHeader, _num: num } = render;

const TITLE = 'Monthly Cash Flow';

// The bands over the month columns, in the screen's words.
const BAND_LABEL = { actual: 'ACTUAL', current: 'ACTUAL + FORECAST', forecast: 'FORECAST' };
// Where each group of lines starts, as the screen heads them.
const HEADINGS = { in_customer: 'Cash in', out_supplier: 'Cash out' };
// The lines printed bold: the totals and the balances they arrive at.
const STRONG = new Set(['opening', 'in_total', 'out_total', 'net', 'closing']);

const SHEET_ACTUAL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5FA' } };
const SHEET_CURRENT = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDF3DC' } };
const RIGHT = { horizontal: 'right' };

function baseCurrency(organisation) {
  const c = organisation?.currency;
  return c && c !== '—' ? c : '';
}

const monthsOf = payload => (Array.isArray(payload?.months) ? payload.months.filter(Boolean) : []);
const rowsOf   = payload => (Array.isArray(payload?.rows) ? payload.rows.filter(Boolean) : []);
const isNull   = v => v === null || v === undefined;

// How a closing balance reads against the bank options' overdraft limit: red
// past it (or below zero with no limit), amber below zero within it. Read in
// cents, so a hair under zero from adding floats is not called overdrawn.
function balanceTone(value, overdraft = 0) {
  if (isNull(value)) return null;
  const b = Math.round(Number(value) * 100);
  const limit = Math.max(0, Math.round(Number(overdraft || 0) * 100));
  if (b >= 0) return null;
  return b < -limit ? 'red' : 'amber';
}

// The month in progress, for the footnote: 'Oct 2026 = actual to 14 Oct 2026
// and forecast for the rest of the month'.
function currentNote(payload) {
  const cur = monthsOf(payload).find(m => m.kind === 'current');
  if (!cur) return '';
  const day = dayLabel(payload?.today);
  return `* ${cur.label} = actual to ${day || 'today'} and forecast for the rest of the month.`;
}

// Under the title: the months, where actual turns to forecast, and the
// currency.
function monthlySubtitle(payload) {
  const months = monthsOf(payload);
  const span = months.length ? `${months[0].label} – ${months[months.length - 1].label}` : '';
  const day = dayLabel(payload?.today);
  const fill = payload?.fill === 'none' ? 'months ahead as scheduled' : 'months ahead filled from the budget';
  return [span, day ? `actual to ${day}, forecast after` : '', months.length ? fill : '', baseCurrency(payload?.organisation)]
    .filter(Boolean).join(' · ');
}

// The bands over the months: runs of one kind, in order, as [kind, count].
function bandsOf(months) {
  const out = [];
  for (const m of months) {
    const last = out[out.length - 1];
    if (last && last[0] === m.kind) last[1]++;
    else out.push([m.kind, 1]);
  }
  return out;
}

// ── PDF ─────────────────────────────────────────────────────────────────────

// Helvetica's advance widths, in ems, for what a figure is made of, as the
// budget grid sizes its page.
const GLYPH_EM = { ',': 0.278, '.': 0.278, ' ': 0.278, '(': 0.333, ')': 0.333, '-': 0.333, '*': 0.389 };
const textWidth = (text, size) =>
  [...String(text)].reduce((w, ch) => w + (/\d/.test(ch) ? 0.556 : GLYPH_EM[ch] ?? 0.667), 0) * size;
const A4_LANDSCAPE = { width: 841.89, height: 595.28 };
const MARGINS = [28, 60, 28, 30];
const LABEL_WIDTH = 112;
const PADDING = 8;

// Twenty-five months do not fit across A4, and pdfmake cuts a wide table off
// at the edge rather than wrapping it, so the page widens to the table: A4's
// height, every figure the same size, and a viewer's fit-to-page to scale it.
function pageSizeFor(body, cols) {
  let needed = MARGINS[0] + MARGINS[2] + LABEL_WIDTH + PADDING;
  for (let c = 1; c <= cols; c++) {
    let widest = 0;
    for (const r of body) if (r[c] && typeof r[c].text === 'string' && !r[c].colSpan) widest = Math.max(widest, textWidth(r[c].text, 7));
    needed += widest + PADDING;
  }
  return needed <= A4_LANDSCAPE.width ? 'A4' : { width: Math.ceil(needed), height: A4_LANDSCAPE.height };
}

function gridBody(payload) {
  const months = monthsOf(payload);
  const n = months.length;
  const overdraft = Number(payload?.overdraft || 0);
  const band = [{ text: '' }];
  for (const [kind, count] of bandsOf(months)) {
    band.push({ text: BAND_LABEL[kind] || '', style: 'band', alignment: 'center', color: MUTED, ...(count > 1 ? { colSpan: count } : {}) });
    for (let k = 1; k < count; k++) band.push({});
  }
  const head = [{ text: '', style: 'colHead' },
    ...months.map(m => ({ text: `${m.label}${m.kind === 'current' ? '*' : ''}`, style: 'colHead', alignment: 'right' }))];
  const body = [band, head];
  for (const r of rowsOf(payload)) {
    if (HEADINGS[r.key]) body.push([{ text: HEADINGS[r.key], style: 'group', colSpan: n + 1 }, ...Array.from({ length: n }, () => ({}))]);
    const strong = STRONG.has(r.key);
    const info = r.group === 'info';
    const indent = r.group === 'in' || r.group === 'out' ? !/_total$/.test(r.key) : false;
    const label = { text: latin1(r.label), style: strong ? 'strong' : 'account', ...(indent ? { margin: [8, 0, 0, 0] } : {}), ...(info ? { italics: true, color: MUTED } : {}) };
    const cells = months.map((_, i) => {
      const v = r.values?.[i];
      const c = { text: isNull(v) ? '' : cell(v), style: strong ? 'strong' : 'account', alignment: 'right' };
      if (info) Object.assign(c, { italics: true, color: MUTED });
      if (r.key === 'closing') {
        const tone = balanceTone(v, overdraft);
        if (tone) c.color = tone === 'red' ? NEGATIVE : AMBER;
      }
      return c;
    });
    body.push([label, ...cells]);
  }
  return body;
}

function monthlyLayout(months) {
  const kinds = months.map(m => m.kind);
  return {
    vLineWidth: () => 0,
    // A rule under the column heads, and over the totals and the balances.
    hLineWidth: i => (i === 2 ? 0.7 : 0),
    hLineColor: () => RULE,
    // The past months shaded and this month tinted, as on screen; the label
    // column and the group headings stay plain.
    fillColor: (row, node, col) => {
      if (!col || row < 1) return null;
      const kind = kinds[col - 1];
      return kind === 'actual' ? BAND : kind === 'current' ? AMBER_TINT : null;
    },
    paddingLeft:   () => 4,
    paddingRight:  () => 4,
    paddingTop:    () => 2.5,
    paddingBottom: () => 2.5,
  };
}

// Landscape, and wider still when the months ask for it.
function cashMonthlyDefinition(payload, opts = {}) {
  const organisation = payload?.organisation || {};
  const currency  = baseCurrency(organisation);
  const generated = opts.generatedAt ?? Date.now();
  const months    = monthsOf(payload);
  const body      = gridBody(payload);
  const footnote  = currentNote(payload);
  const notes = [
    ...(footnote ? [footnote] : []),
    ...(payload?.overdraft > 0 ? [`Closing balances below the overdraft limit of ${cell(payload.overdraft)} are red; below zero within it, amber.`] : []),
    ...(payload?.notes || []).map(n => latin1(n)),
  ].map((text, i) => ({ text, style: 'note', margin: [0, i === 0 ? 8 : 3, 0, 0] }));

  return {
    pageSize: pageSizeFor(body, months.length),
    pageOrientation: 'landscape',
    pageMargins: MARGINS,
    defaultStyle: { font: 'Helvetica', fontSize: 8 },
    header: pageHeader(
      organisation.name,
      TITLE,
      monthlySubtitle(payload),
      { generatedAt: generated, timezone: opts.timezone, fetched: fetchedNote(payload, opts.timezone) },
    ),
    footer: pageFooter(currencyNote(currency)),
    styles: STYLES,
    content: [
      months.length
        ? {
          table: { headerRows: 2, dontBreakRows: true, widths: [LABEL_WIDTH, ...months.map(() => 'auto')], body },
          layout: monthlyLayout(months),
        }
        : { text: 'No months to show.', style: 'note' },
      ...notes,
    ],
  };
}

// ── Workbook ────────────────────────────────────────────────────────────────
// Numbers as numbers in the budget exports' money format, never preformatted
// text, and a blank cell where there is no figure, so an accountant can sum
// across the months and a missing month is not read as nil.

function gridSheet(wb, name, payload, subtitle, opts, write) {
  const months = monthsOf(payload);
  const width = months.length + 1;
  const sheet = wb.addWorksheet(name);
  const bandRow = _sheetHeader(sheet, payload, TITLE, subtitle, opts, width);
  // The bands over the months, merged across each run of one kind.
  let col = 2;
  for (const [kind, count] of bandsOf(months)) {
    if (count > 1) sheet.mergeCells(bandRow, col, bandRow, col + count - 1);
    const c = sheet.getCell(bandRow, col);
    c.value = BAND_LABEL[kind] || '';
    c.font = { bold: true, size: 9, color: { argb: ARGB.muted } };
    c.alignment = { horizontal: 'center' };
    col += count;
  }
  const head = sheet.getRow(bandRow + 1);
  head.values = ['', ...months.map(m => `${m.label}${m.kind === 'current' ? '*' : ''}`)];
  head.font = { bold: true, size: 10 };
  months.forEach((_, i) => { head.getCell(i + 2).alignment = RIGHT; });
  sheet.getColumn(1).width = 30;
  months.forEach((_, i) => { sheet.getColumn(i + 2).width = write === 'sources' ? 28 : 14; });
  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: bandRow + 1 }];
  const fill = (row, i) => {
    const kind = months[i].kind;
    if (kind === 'actual') row.getCell(i + 2).fill = SHEET_ACTUAL;
    if (kind === 'current') row.getCell(i + 2).fill = SHEET_CURRENT;
  };
  return { sheet, months, fill };
}

function figuresSheet(wb, payload, subtitle, opts, currency) {
  const { sheet, months, fill } = gridSheet(wb, 'Monthly cash flow', payload, subtitle, opts, 'figures');
  const overdraft = Number(payload?.overdraft || 0);
  for (const r of rowsOf(payload)) {
    if (HEADINGS[r.key]) sheet.addRow([HEADINGS[r.key]]).font = { bold: true, size: 10, color: { argb: ARGB.accent } };
    const values = months.map((_, i) => (isNull(r.values?.[i]) ? null : num(r.values[i])));
    const row = sheet.addRow([r.label, ...values]);
    months.forEach((_, i) => {
      row.getCell(i + 2).numFmt = MONEY_FMT;
      fill(row, i);
      if (r.key === 'closing') {
        const tone = balanceTone(values[i], overdraft);
        if (tone) row.getCell(i + 2).font = { bold: true, color: { argb: tone === 'red' ? ARGB.negative : ARGB.amber } };
      }
    });
    if (STRONG.has(r.key)) {
      row.getCell(1).font = { bold: true };
      months.forEach((_, i) => { if (r.key !== 'closing' || !balanceTone(values[i], overdraft)) row.getCell(i + 2).font = { bold: true }; });
    }
    if (r.group === 'info') row.font = { italic: true, color: { argb: ARGB.muted } };
  }
  sheet.addRow([]);
  const footnote = currentNote(payload);
  for (const n of [...(footnote ? [footnote] : []), ...(payload?.notes || [])]) sheet.addRow([String(n)]).font = { size: 9, italic: true };
  sheet.addRow([currencyNote(currency)]).font = { size: 8, italic: true, color: { argb: ARGB.muted } };
}

// What each figure was made of, cell for cell, as the screen shows on hover.
function sourcesSheet(wb, payload, subtitle, opts) {
  const { sheet, months, fill } = gridSheet(wb, 'Sources', payload, subtitle, opts, 'sources');
  for (const r of rowsOf(payload)) {
    const row = sheet.addRow([r.label, ...months.map((_, i) => String(r.sources?.[i] || ''))]);
    months.forEach((_, i) => fill(row, i));
  }
}

function cashMonthlyWorkbook(payload, opts = {}) {
  const currency  = baseCurrency(payload?.organisation);
  const generated = opts.generatedAt ?? Date.now();
  const subtitle  = monthlySubtitle(payload);
  const o         = { ...opts, generatedAt: generated };
  const wb = _workbook(generated);
  figuresSheet(wb, payload, subtitle, o, currency);
  sourcesSheet(wb, payload, subtitle, o);
  return wb;
}

// ── Filename ────────────────────────────────────────────────────────────────
// The organisation, the day it was built and the months it runs over, so a
// download is identifiable on a desktop and a six-month file does not
// overwrite a twelve-month one. Sanitised by the budget exports' rule; the
// extension is appended when a format is given.
function cashMonthlyFilename(payload, format) {
  const slug = s => String(s).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  const org  = slug(payload?.organisation?.name || 'organisation').slice(0, 40) || 'organisation';
  const day  = slug(payload?.today || 'undated') || 'undated';
  const months = monthsOf(payload);
  const parts = ['Monthly-Cash-Flow', org, day];
  if (months.length) parts.push(`${slug(months[0].key)}-to-${slug(months[months.length - 1].key)}`);
  const base = parts.join('_');
  const ext  = format ? slug(String(format).toLowerCase()) : '';
  return ext ? `${base}.${ext}` : base;
}

module.exports = {
  cashMonthlyDefinition,
  cashMonthlyWorkbook,
  cashMonthlyFilename,
  monthlySubtitle,
  currentNote,
  balanceTone,
};
