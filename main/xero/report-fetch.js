const { AccountingApi }  = require('xero-node');
const { withRetry }      = require('./xero-utils');
const logger             = require('../utils/logger');
const { DIRECTORY_TTL_MS, _cacheGet, _cacheSet, _dedupe } = require('./report-cache');

// Reaching Xero for the reports: an API client per token, every list fetch
// paged and capped the same way, report cells read as numbers, and the
// directory records (the organisation, chart of accounts, bank accounts and
// contacts) that change rarely and are cached for hours.
//
// Shared by every report module, so a list is paged, capped and logged the
// same way wherever it is read.

function _apiFor(token) {
  const api = new AccountingApi();
  api.accessToken = token;
  return api;
}

// Xero returns at most 100 invoices per page and `page=1` was never followed
// up, so every KPI built on invoices — receivables, overdue, DSO, the
// forecast, supplier spend — was computed on the 100 most recent. Pages until
// a short page; the cap is a safety net that logs when hit. Always summaryOnly:
// no caller here needs line items, and it keeps each page small.
async function _allInvoices(api, tenantId, { where, order, statuses }) {
  return _allPages(page => api.getInvoices(
    tenantId, undefined, where, order, undefined, undefined, undefined,
    statuses, page, undefined, undefined, undefined, true,
  ), 'invoices', { what: 'Invoice', tenantId });
}

// Payments, bank transactions, contacts and quotes have the same problem the
// other way round: called without `page` they are not capped at 100, they
// return every matching record in one response — up to 100,000 of them — and
// Xero bills GET requests by the volume they return. So every one is paged
// with the `page` parameter alone, at Xero's fixed 100 records a page, and a
// page shorter than that is the last one. xero-node 20 has a pageSize
// argument on these methods; it was deliberately not adopted in the upgrade to
// it, so that no SDK call changed along with the version. Every list fetch in
// the reports goes through here, invoices included, so they all stop the same
// way: at a short page, or at the cap, which is a cost ceiling and is logged
// when hit because the figures built on that list are then incomplete.
const LIST_PAGE_SIZE = 100;
// 10,000 records. These lists used to come back whole in one unpaged request,
// so a cap low enough to bite in an ordinary busy year (20 pages = 2,000
// payments) would quietly undercount cash figures that were complete before.
// The cap is only there to stop a runaway fetch.
const LIST_MAX_PAGES = 100;
async function _allPages(fetchPage, field, { what, tenantId, maxPages = LIST_MAX_PAGES }) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await withRetry(() => fetchPage(page));
    const batch = res?.body?.[field] || [];
    out.push(...batch);
    if (batch.length < LIST_PAGE_SIZE) return out;
  }
  logger.warn(`${what} fetch hit the page cap; figures may be incomplete`, { tenantId, pages: maxPages });
  return out;
}

// Xero formats report cell values like "1,234.56" or "(123.45)" for negatives —
// never a plain parseable number. A cell that is already a number, or anything
// else that is not a string, is read for what it is worth rather than thrown
// on: this runs on every cell of every report, and one odd cell must not take
// the whole report down.
function _parseReportNumber(s) {
  if (!s) return 0;
  if (typeof s !== 'string') {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }
  const negative = /^\(.*\)$/.test(s.trim());
  const n = Number(s.replace(/[(),]/g, ''));
  if (Number.isNaN(n)) return 0;
  return negative ? -n : n;
}

// Cached separately from getSummary's own org fetch (same underlying Xero
// call, but this one's only reached for the 'year' preset, and keeping it
// standalone avoids reshaping getSummary's existing parallel fetch).
async function _getOrganisationRaw(userId, tenantId, force) {
  const key    = `org:${userId}:${tenantId}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached.org;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);
  const res = await withRetry(() => api.getOrganisations(tenantId));
  return _cacheSet(key, { org: res.body.organisations?.[0] || {} }, DIRECTORY_TTL_MS).org;
}

// ── Chart of Accounts, Contacts, Bank Accounts ───────────────────────────────
// All three ride on scopes already granted for existing features — Accounts and
// TaxRates are both in the "settings" scope bucket (already used by
// xero/invoices.js#getOrgTaxRates), and Contacts already has full read/write
// access for invoice creation. Nothing here needed a wider OAuth consent.

function _buildAccounts(accounts) {
  return accounts.map(a => ({
    accountId: a.accountID, code: a.code || '', name: a.name || '',
    type: a.type || '', taxType: a.taxType || '', status: a.status || '',
  }));
}

async function _getAccountsRaw(userId, tenantId, { force = false } = {}) {
  const key    = `accounts:${userId}:${tenantId}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  const res = await withRetry(() => api.getAccounts(tenantId, undefined, undefined, 'Code ASC'));
  const data = { accounts: _buildAccounts(res.body.accounts || []) };
  return _cacheSet(key, data, DIRECTORY_TTL_MS);
}

function _buildBankAccounts(accounts) {
  return accounts
    .filter(a => a.type === 'BANK')
    .map(a => ({
      accountId: a.accountID, code: a.code || '', name: a.name || '',
      accountNumber: a.bankAccountNumber || '', currency: a.currencyCode || '', status: a.status || '',
    }));
}

async function _getBankAccountsRaw(userId, tenantId, { force = false } = {}) {
  const key    = `bank:${userId}:${tenantId}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  const res = await withRetry(() => api.getAccounts(tenantId, undefined, 'Type=="BANK"', 'Name ASC'));
  const data = { bankAccounts: _buildBankAccounts(res.body.accounts || []) };
  return _cacheSet(key, data, DIRECTORY_TTL_MS);
}

function _buildContacts(contacts) {
  return contacts.map(c => ({
    contactId: c.contactID, name: c.name || 'Unknown', email: c.emailAddress || '',
    isCustomer: !!c.isCustomer, isSupplier: !!c.isSupplier, status: c.contactStatus || '',
  }));
}

async function _getContactsRaw(userId, tenantId, { force = false } = {}) {
  const key    = `contacts:${userId}:${tenantId}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  // Paged (see _allPages): unpaged, an org with years of customers and
  // suppliers came back as one response of every contact it ever had.
  const contacts = await _allPages(page => api.getContacts(
    tenantId, undefined, undefined, 'Name ASC', undefined, page, undefined, true
  ), 'contacts', { what: 'Contact', tenantId });
  const data = { contacts: _buildContacts(contacts) };
  return _cacheSet(key, data, DIRECTORY_TTL_MS);
}

// Bound after the declarations, through the one in-flight map in
// ./report-cache, so callers in the other report modules (getBudgetVariance →
// _getOrganisation, the bank account list → getBankAccounts) go through the
// same in-flight map as routes.
const _getOrganisation       = _dedupe('_getOrganisation', _getOrganisationRaw);
const getAccounts            = _dedupe('getAccounts', _getAccountsRaw);
const getBankAccounts        = _dedupe('getBankAccounts', _getBankAccountsRaw);
const getContacts            = _dedupe('getContacts', _getContactsRaw);

module.exports = {
  _apiFor, _allInvoices, _allPages, LIST_PAGE_SIZE, LIST_MAX_PAGES, _parseReportNumber,
  _getOrganisation, getAccounts, getBankAccounts, getContacts,
  _buildAccounts, _buildBankAccounts, _buildContacts,
};
