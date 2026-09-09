const ExcelJS = require('exceljs');
const logger  = require('../utils/logger');

// Reads a company expense-claim spreadsheet into rows.
//
// Shaped around the real form this was built against — BLACKSTAR's "EXPENSES
// CLAIM FORM" — but deliberately by HEADER NAME rather than column letter, so a
// form with columns in a different order, or an extra one inserted, still reads.
// Hard-coding B for date would break the first time somebody adds a column.
//
// The claimant fills date, description, currency, amount and exchange rate. In
// the real file every CATEGORY column was left empty, which is the gap the AI
// exists to fill — so the categories are read if present and not required.

// Excel stores dates as days since 1899-12-30 (the epoch is shifted by the
// 1900 leap-year bug Excel deliberately preserves).
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

// Everything below one of these is the form's footer, not a claim line.
const FOOTER_MARKERS = /\b(total|claimant|signed|i declared|all supporting receipts|for finance purpose|accounts? code)\b/i;

function excelSerialToISO(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(EXCEL_EPOCH_MS + Math.round(n) * 86400000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// A cell may arrive as a number, a string, a Date, or exceljs's rich-text or
// formula shapes. Everything funnels through here.
function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (value.richText) return value.richText.map(t => t.text).join('').trim();
  if (value.text) return String(value.text).trim();
  if (value.result !== undefined) return cellText(value.result);
  return String(value).trim();
}

function cellDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') return excelSerialToISO(value);
  const text = cellText(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  if (/^\d+(\.\d+)?$/.test(text)) return excelSerialToISO(text);
  return null;
}

function cellNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = cellText(value).replace(/[^0-9.-]/g, '');
  // Number('') is 0, so an empty or unreadable cell was reading as a real zero
  // rather than as missing — which would let a claim line with no amount match
  // a receipt. No digits means no number.
  if (!/[0-9]/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

// Header matching is loose on purpose: real forms wrap headings onto two lines
// ("LOCAL TRAVEL COST\n(SGD)") and vary in case and punctuation.
function normaliseHeader(text) {
  return String(text || '').replace(/\s+/g, ' ').replace(/[()]/g, '').trim().toUpperCase();
}

const FIELD_HEADERS = {
  no:           ['NO', 'NO.', 'S/N', 'ITEM'],
  date:         ['DATE'],
  description:  ['DESCRIPTION OF EXPENSES', 'DESCRIPTION', 'PARTICULARS', 'DETAILS'],
  currency:     ['CURRENCY', 'CCY'],
  amount:       ['AMOUNT'],
  exchangeRate: ['EXCHANGE RATE', 'FX RATE', 'RATE'],
  baseAmount:   ['SGD AMOUNT', 'BASE AMOUNT', 'AMOUNT SGD'],
};

// Anything that is not one of the fields above and sits between them is a
// category column — the buckets the claimant is meant to tick.
function isFieldHeader(norm) {
  return Object.values(FIELD_HEADERS).some(list => list.includes(norm));
}

// Finds the header row: the first row carrying at least three known field
// headings. Forms carry a title, a company name and a claim period above it, so
// the header is never row 1.
function locateHeader(sheet) {
  let best = null;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (best || rowNumber > 30) return;
    const cols = {};
    const categories = [];
    let hits = 0;
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const norm = normaliseHeader(cellText(cell.value));
      if (!norm) return;
      for (const [field, names] of Object.entries(FIELD_HEADERS)) {
        if (names.includes(norm) && cols[field] === undefined) { cols[field] = colNumber; hits++; return; }
      }
      if (!isFieldHeader(norm)) categories.push({ col: colNumber, label: cellText(cell.value).replace(/\s+/g, ' ').trim() });
    });
    if (hits >= 3) best = { rowNumber, cols, categories };
  });
  return best;
}

// Returns { rows, categories, title }. Never throws: a form that cannot be read
// must degrade to "no rows" so the receipts alone can still be imported.
async function parseClaimForm(buffer) {
  const empty = { rows: [], categories: [], title: null, error: null };
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { ...empty, error: 'empty file' };

  let workbook;
  try {
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
  } catch (err) {
    logger.warn('Claim form could not be opened', { error: err.message });
    return { ...empty, error: 'not a readable spreadsheet' };
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) return { ...empty, error: 'no sheets' };

  const header = locateHeader(sheet);
  if (!header) return { ...empty, error: 'no header row found' };

  const title = cellText(sheet.getRow(1).getCell(1).value) || null;
  const rows = [];
  let reachedFooter = false;

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= header.rowNumber || reachedFooter) return;
    const get = field => (header.cols[field] ? row.getCell(header.cols[field]).value : null);

    // Real forms end with a totals line, a declaration and a signature block,
    // then a finance-only section. Reading past that turns "I declared the
    // expense claimed above..." into a claim line. Stop at the first marker.
    const wholeRow = [];
    row.eachCell({ includeEmpty: false }, cell => wholeRow.push(cellText(cell.value)));
    if (FOOTER_MARKERS.test(wholeRow.join(' '))) { reachedFooter = true; return; }

    const amount = cellNumber(get('amount'));
    const description = cellText(get('description'));
    // Blank template lines: the real form carried nine filled rows and dozens of
    // pre-formatted empties, which arrive as amount 0 rather than null because
    // the cell is formatted. Neither an amount nor a description means empty.
    if (!description && (amount === null || amount === 0)) return;

    const ticked = header.categories
      .map(c => ({ label: c.label, value: cellNumber(row.getCell(c.col).value) }))
      .filter(c => c.value !== null && c.value !== 0);

    rows.push({
      rowNumber,
      no:           cellText(get('no')).replace(/\.0$/, '') || String(rows.length + 1),
      date:         cellDate(get('date')),
      description,
      currency:     cellText(get('currency')).toUpperCase() || null,
      amount,
      exchangeRate: cellNumber(get('exchangeRate')),
      baseAmount:   cellNumber(get('baseAmount')),
      // Empty in the real form — the gap the AI is meant to fill.
      category:     ticked.length === 1 ? ticked[0].label : null,
      categoryAmbiguous: ticked.length > 1,
    });
  });

  return { rows, categories: header.categories.map(c => c.label), title, error: null };
}

module.exports = { parseClaimForm, excelSerialToISO, cellText, cellDate, cellNumber, normaliseHeader };
