// "Export CSV": the rows on screen as a spreadsheet, built in the browser.
//
// Imports nothing, so main/scripts/invoice-list-view.test.js can run it as it
// is. The page passes in the words it shows for a Xero status, so the file and
// the screen say the same thing.

export const CSV_COLUMNS = [
  'Date', 'Due', 'Type', 'Supplier/Customer', 'Number', 'Currency',
  'Subtotal', 'Tax', 'Total', 'Status', 'Xero status', 'Amount due', 'Paid on', 'Account code',
];

// Plain words: the badges' symbols (✓, ⚠) are for the screen, and in a
// spreadsheet they only get in the way of filtering.
const STATUS_WORDS = {
  pending: 'Pending', submitting: 'Submitting', reviewed: 'Ready to post', posted: 'Posted',
  reported: 'Reported', error: 'Error', duplicate: 'Duplicate', 'review-needed': 'Needs review',
};
const TYPE_WORDS = { ACCPAY: 'Bill', ACCREC: 'Invoice', EXPENSE: 'Expense claim' };

// Excel, LibreOffice and Google Sheets run a cell that starts with = + - or @
// as a formula, and a supplier name or an emailed invoice number is text from
// outside: "=HYPERLINK(...)" would become a live link in the bookkeeper's
// sheet. Such a cell is written with an apostrophe in front, which makes it
// text. Tab and carriage return count too, since some programs strip them
// and read what follows. A plain number such as -12.50 (a credit) is left
// alone: it cannot be a formula, and the apostrophe would turn it into text.
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER  = /^-?\d+(\.\d+)?$/;

export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  // RFC 4180: a cell holding a comma, a quote or a line break is quoted, and
  // a quote inside it is doubled.
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// The whole file. It starts with a byte order mark, without which Excel reads
// the file as the PC's local code page and "Café Ltd" or "¥" turn to mojibake;
// lines end in CRLF, as the format says.
export function toCsv(rows) {
  return `﻿${rows.map(r => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

// Two decimals and no thousands separator, so a spreadsheet reads a number.
const money = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? '' : Number(v).toFixed(2));

export function invoiceCsvRow(inv, { xeroStatusLabel } = {}) {
  return [
    inv.invoiceDate || '',
    // Expense claims have no due date, as on screen.
    inv.invoiceType === 'EXPENSE' ? '' : (inv.dueDate || ''),
    TYPE_WORDS[inv.invoiceType] || inv.invoiceType || '',
    inv.vendorName || '',
    inv.invoiceNumber || '',
    inv.currency || '',
    money(inv.subTotal),
    money(inv.taxAmount),
    money(inv.totalAmount),
    STATUS_WORDS[inv.status] || inv.status || '',
    (xeroStatusLabel ? xeroStatusLabel(inv) : inv.xeroStatus) || '',
    money(inv.xeroAmountDue),
    inv.xeroPaidOn || '',
    inv.accountCode || '',
  ];
}

export function invoiceCsv(rows, opts) {
  return toCsv([CSV_COLUMNS, ...rows.map(inv => invoiceCsvRow(inv, opts))]);
}

// "invoices-bills-2026-10-08.csv": which tab, and the day it was taken.
export function csvFilename(kind, today) {
  const slug = String(kind || 'records').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `invoices-${slug}-${today}.csv`;
}
