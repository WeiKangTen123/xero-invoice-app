// An invoice that did not arrive as the emailed template: composed in the
// form, or one row-group of a spreadsheet.
//
// There is no PDF to read and no model to ask — the data is already
// structured, so this is validation, one Document, the shared dedup and the
// shared row builder. What the two ways in share is everything after the
// first step; what differs is only how the input is shaped.
const ExcelJS = require('exceljs');
const invoiceStore = require('../utils/invoice-store');
const { normaliseDocument, parseDate, addDays, currencyCode, num } = require('./document');
const { findDuplicate } = require('./dedup');
const { buildRecord } = require('./record');
const { profileFor } = require('./profiles');
const { locateHeader, cellText, cellDate, cellNumber } = require('../claims/claim-form');
const jobs   = require('../jobs');
const logger = require('../utils/logger');

// ── One invoice, from structured input ──────────────────────────────────────

// Returns { errors } or { document }. Errors name the field so a form can
// point at it and a spreadsheet import can say which row.
function validate(input = {}) {
  const errors = [];
  const contactName = String(input.contactName ?? input.customer ?? input.contact?.name ?? '').trim();
  if (!contactName) errors.push({ field: 'contactName', error: 'Customer is required' });

  const currency = currencyCode(String(input.currency || ''));
  if (input.currency && !currency) errors.push({ field: 'currency', error: 'Currency must be a 3-letter code such as SGD' });

  const invoiceDate = input.invoiceDate ? parseDate(String(input.invoiceDate)) : null;
  if (input.invoiceDate && !invoiceDate) errors.push({ field: 'invoiceDate', error: 'Invoice date could not be read' });

  let dueDate = input.dueDate ? parseDate(String(input.dueDate)) : null;
  if (input.dueDate && !dueDate) errors.push({ field: 'dueDate', error: 'Due date could not be read' });
  const terms = num(input.termsDays);
  if (!dueDate && terms !== null && terms >= 0) dueDate = addDays(invoiceDate || new Date().toISOString().slice(0, 10), terms);

  const lineItems = (Array.isArray(input.lineItems) ? input.lineItems : [])
    .map(li => ({ description: li?.description, unitAmount: num(li?.unitAmount ?? li?.amount), discountRate: num(li?.discountRate), taxPercent: li?.taxPercent }))
    .filter(li => (li.description && String(li.description).trim()) || li.unitAmount !== null);
  if (!lineItems.length) errors.push({ field: 'lineItems', error: 'At least one line item is required' });
  for (const [i, li] of lineItems.entries()) {
    if (li.unitAmount === null) errors.push({ field: `lineItems[${i}].unitAmount`, error: `Line ${i + 1} has no amount` });
    else if (li.unitAmount < 0) errors.push({ field: `lineItems[${i}].unitAmount`, error: `Line ${i + 1} has a negative amount` });
  }
  if (errors.length) return { errors };

  const subTotal = lineItems.reduce((s, li) => s + (li.unitAmount || 0) * (1 - (li.discountRate || 0) / 100), 0);
  const taxAmount = lineItems.reduce((s, li) => {
    const pct = num(li.taxPercent);
    return s + (pct ? (li.unitAmount || 0) * (1 - (li.discountRate || 0) / 100) * (pct / 100) : 0);
  }, 0);

  const document = normaliseDocument({
    contactName,
    contactEmail:   input.contactEmail ?? input.email ?? null,
    contactAddress: input.contactAddress ?? input.address ?? null,
    invoiceNumber:  input.invoiceNumber ?? input.number ?? null,
    invoiceDate, dueDate, currency,
    lineItems,
    subTotal:  Math.round(subTotal * 100) / 100,
    taxAmount: Math.round(taxAmount * 100) / 100,
    totalAmount: Math.round((subTotal + taxAmount) * 100) / 100,
    description: input.description ?? null,
    brandingThemeName: input.brandingThemeName ?? null,
    lineAmountTypes: input.lineAmountTypes,
  });
  return { document };
}

// Validates, dedups and stores. Returns { id, status } | { duplicate: true, id }
// | { errors }. Never throws for bad input.
function intakeInvoice(userId, input, { source = 'form', defaults = {} } = {}) {
  const v = validate(input);
  if (v.errors) return { errors: v.errors };
  const doc = v.document;
  const store = invoiceStore.forUser(userId);

  const dup = findDuplicate({
    store, profile: profileFor('ACCREC'),
    contactName: doc.contact.name, number: doc.number, date: doc.date, amount: doc.total,
  });
  if (dup) return { duplicate: true, id: dup.match.id, reason: dup.reason, certain: dup.certain };

  const record = buildRecord({
    document: doc, invoiceType: 'ACCREC', source, defaults,
    extras: {
      invoiceNumber: doc.number || `INV-${Date.now()}`,
      invoiceDate:   doc.date || new Date().toISOString().slice(0, 10),
      dueDate:       doc.dueDate || addDays(doc.date || new Date().toISOString().slice(0, 10), 30),
      accountCode:   input.accountCode || defaults.accountCode || '',
    },
  });
  store.add(record);
  logger.info('Invoice composed', { userId, id: record.id, source, customer: record.contactName, total: record.totalAmount });
  return { id: record.id, status: record.status };
}

// ── A spreadsheet of invoices ───────────────────────────────────────────────
// One row per line item; rows sharing an invoice number are one invoice, and a
// row with no number belongs to the invoice above it. That is how Xero's own
// import sheet is laid out, and how a person naturally fills one in.
const SHEET_HEADERS = {
  invoiceNumber: ['INVOICE NUMBER', 'INVOICE NO', 'INVOICE NO.', 'INVOICE #', 'INVOICENUMBER', 'NUMBER', 'REF'],
  customer:      ['CUSTOMER', 'CUSTOMER NAME', 'CLIENT', 'CLIENT / CUSTOMER', 'CONTACT', 'CONTACT NAME', 'CONTACTNAME'],
  email:         ['EMAIL', 'CUSTOMER EMAIL', 'EMAIL ADDRESS', 'EMAILADDRESS'],
  address:       ['ADDRESS', 'CUSTOMER ADDRESS'],
  invoiceDate:   ['INVOICE DATE', 'INVOICEDATE', 'DATE'],
  dueDate:       ['DUE DATE', 'DUEDATE', 'DUE'],
  currency:      ['CURRENCY', 'CCY'],
  description:   ['DESCRIPTION', 'DETAILS', 'DESCRIPTION / DETAILS', 'ITEM', 'LINE ITEM'],
  amount:        ['AMOUNT', 'UNIT AMOUNT', 'UNITAMOUNT', 'LINE AMOUNT', 'PRICE'],
  discount:      ['DISCOUNT', 'DISCOUNT %', 'DISCOUNT RATE'],
  tax:           ['TAX', 'TAX %', 'TAX RATE', 'GST', 'GST %'],
  accountCode:   ['ACCOUNT CODE', 'ACCOUNTCODE', 'ACCOUNT'],
};

// A small CSV reader: quoted fields, doubled quotes, embedded commas and
// newlines. Enough for what a spreadsheet exports.
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

// Presents a CSV as the same minimal surface locateHeader reads from an
// ExcelJS sheet, so one header finder serves both.
function csvAsSheet(text) {
  const rows = parseCsv(text);
  const cell = v => ({ value: v === '' ? null : v });
  return {
    eachRow(_opts, fn) { rows.forEach((r, i) => fn({ eachCell(_o, cb) { r.forEach((v, j) => { if (String(v).trim() !== '') cb(cell(v), j + 1); }); }, getCell: n => cell(r[n - 1] ?? '') }, i + 1)); },
    getRow: n => ({ getCell: m => cell(rows[n - 1]?.[m - 1] ?? '') }),
  };
}

async function parseInvoiceSheet(buffer, name = '') {
  const empty = { rows: [], error: null };
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { ...empty, error: 'empty file' };
  let sheet;
  if (/\.csv$/i.test(name) || !buffer.subarray(0, 2).equals(Buffer.from('PK'))) {
    sheet = csvAsSheet(buffer.toString('utf8'));
  } else {
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer);
      sheet = wb.worksheets[0];
    } catch (err) {
      return { ...empty, error: 'not a readable spreadsheet' };
    }
    if (!sheet) return { ...empty, error: 'no sheets' };
  }
  const header = locateHeader(sheet, SHEET_HEADERS, 2);
  if (!header) return { ...empty, error: 'no header row found — expected columns such as Customer, Description, Amount' };

  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= header.rowNumber) return;
    const get = f => (header.cols[f] ? row.getCell(header.cols[f]).value : null);
    const amount = cellNumber(get('amount'));
    const description = cellText(get('description'));
    const customer = cellText(get('customer'));
    if (!description && !customer && (amount === null || amount === 0)) return;
    rows.push({
      rowNumber,
      invoiceNumber: cellText(get('invoiceNumber')).replace(/\.0$/, '') || null,
      customer: customer || null,
      email:    cellText(get('email')) || null,
      address:  cellText(get('address')) || null,
      invoiceDate: cellDate(get('invoiceDate')) || (get('invoiceDate') ? parseDate(cellText(get('invoiceDate'))) : null),
      dueDate:     cellDate(get('dueDate'))     || (get('dueDate')     ? parseDate(cellText(get('dueDate')))     : null),
      currency: cellText(get('currency')).toUpperCase() || null,
      description, amount,
      discount: cellNumber(get('discount')),
      tax:      cellNumber(get('tax')),
      accountCode: cellText(get('accountCode')) || null,
    });
  });
  return { rows, error: null };
}

// Rows → invoices. Consecutive rows with the same number, or with no number
// after a numbered one, are one invoice; header fields come from its first row.
function groupRows(rows) {
  const groups = [];
  let current = null;
  for (const r of rows) {
    const startsNew = !current || (r.invoiceNumber && r.invoiceNumber !== current.invoiceNumber) || (!r.invoiceNumber && r.customer && r.customer !== current.contactName);
    if (startsNew) {
      current = {
        rowNumber: r.rowNumber, invoiceNumber: r.invoiceNumber, contactName: r.customer, contactEmail: r.email, contactAddress: r.address,
        invoiceDate: r.invoiceDate, dueDate: r.dueDate, currency: r.currency, accountCode: r.accountCode, lineItems: [],
      };
      groups.push(current);
    }
    current.lineItems.push({ description: r.description, unitAmount: r.amount, discountRate: r.discount, taxPercent: r.tax });
  }
  return groups;
}

async function runInvoiceImport({ userId, job, payload, deps }) {
  const result = { created: [], duplicates: [], rejected: [] };
  const groups = [];
  for (const f of payload.sheets || []) {
    const { rows, error } = await parseInvoiceSheet(f.buffer, f.name);
    if (error) { result.rejected.push({ file: f.name, row: null, error }); continue; }
    for (const g of groupRows(rows)) groups.push({ ...g, file: f.name });
  }
  let done = 0;
  deps.onUpdate?.({ id: job.id, stage: 'reading receipts', receiptsTotal: groups.length, receiptsRead: 0, rowsTotal: 0 });
  try {
    for (const g of groups) {
      const r = intakeInvoice(userId, g, { source: 'spreadsheet', defaults: deps.defaults || {} });
      if (r.errors) result.rejected.push({ file: g.file, row: g.rowNumber, error: r.errors.map(e => e.error).join('; ') });
      else if (r.duplicate) result.duplicates.push({ file: g.file, row: g.rowNumber, id: r.id, reason: r.reason });
      else result.created.push({ file: g.file, row: g.rowNumber, id: r.id, customer: g.contactName, invoiceNumber: g.invoiceNumber });
      done += 1;
      deps.onUpdate?.({ id: job.id, receiptsRead: done, rowsTotal: result.created.length });
    }
    deps.onSettle({ id: job.id, stage: 'done', error: null, result, receiptsTotal: groups.length, receiptsRead: done, rowsTotal: result.created.length });
  } catch (err) {
    logger.error('Invoice import failed', { userId, jobId: job.id, error: err.message });
    deps.onSettle({ id: job.id, stage: 'failed', error: err.message, result, receiptsTotal: groups.length, receiptsRead: done, rowsTotal: result.created.length });
  }
}

jobs.registerJobType('invoice-import', { run: runInvoiceImport, defaultDeps: () => ({}) });

module.exports = { validate, intakeInvoice, parseInvoiceSheet, groupRows, parseCsv, runInvoiceImport, SHEET_HEADERS };
