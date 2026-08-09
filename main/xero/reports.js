const { AccountingApi }  = require('xero-node');
const { withRetry }      = require('./xero-utils');
const logger             = require('../utils/logger');

// Read-only financial data for the "Insights" tab. Every function here either
// takes already-fetched Xero data (pure, fully unit-tested, nothing to mock) or
// is the thin cached-fetch wrapper around it — same split as the rest of this
// file's original summary logic.
//
// Cached in-memory per user+tenant(+range), same short-TTL philosophy as
// token-cache.js — Xero's 60-calls/minute budget is shared with real invoice
// submission, so a dashboard nobody's actively watching shouldn't refetch on
// every page view.
const CACHE_TTL_MS = 90 * 1000;
const _cache = new Map(); // arbitrary string key -> { data, fetchedAt }

function _cacheGet(key, force) {
  const cached = _cache.get(key);
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { ...cached.data, cached: true, fetchedAt: cached.fetchedAt };
  }
  return null;
}
function _cacheSet(key, data) {
  _cache.set(key, { data, fetchedAt: Date.now() });
  return { ...data, cached: false, fetchedAt: Date.now() };
}

function _apiFor(token) {
  const api = new AccountingApi();
  api.accessToken = token;
  return api;
}

// ── Snapshot summary (Receivables/Payables/status — always "right now") ─────

// PAID invoices, and AUTHORISED ones already fully paid down to zero, both read
// as "paid" here — amountDue is the source of truth for what's actually owed,
// not just the coarse Xero status.
function _statusLabel(inv) {
  const amountDue = Number(inv.amountDue || 0);
  if (inv.status === 'PAID' || amountDue <= 0) return 'paid';
  if (inv.dueDate && new Date(inv.dueDate) < new Date()) return 'overdue';
  return 'awaiting';
}

function _buildSummary(org, invoices) {
  let totalReceivables = 0, totalPayables = 0, overdueAmount = 0;
  let receivablesCount = 0, payablesCount = 0;
  const statusBreakdown = { paid: 0, awaiting: 0, overdue: 0 };

  const list = invoices.map(inv => {
    const isReceivable = inv.type === 'ACCREC';
    const amountDue     = Number(inv.amountDue || 0);
    const status         = _statusLabel(inv);
    statusBreakdown[status]++;
    if (status === 'overdue') overdueAmount += amountDue;

    if (inv.status === 'AUTHORISED' && amountDue > 0) {
      if (isReceivable) { totalReceivables += amountDue; receivablesCount++; }
      else               { totalPayables    += amountDue; payablesCount++; }
    }

    return {
      invoiceId:     inv.invoiceID,
      type:          isReceivable ? 'Sale' : 'Bill',
      contact:       inv.contact?.name || 'Unknown',
      invoiceNumber: inv.invoiceNumber || '',
      date:          inv.date || null,
      dueDate:       inv.dueDate || null,
      status,
      total:         Number(inv.total || 0),
      amountDue,
      currency:      inv.currencyCode || org.baseCurrency || '',
    };
  }).slice(0, 50); // recent-invoices table doesn't need the full org history

  return {
    connected: true,
    organisation: {
      name:     org.name || org.legalName || 'Organisation',
      country:  org.countryCode || '—',
      currency: org.baseCurrency || '—',
      yearEnd:  (org.financialYearEndDay && org.financialYearEndMonth)
        ? `${String(org.financialYearEndDay).padStart(2, '0')}/${String(org.financialYearEndMonth).padStart(2, '0')}`
        : '—',
    },
    kpis: { totalReceivables, totalPayables, receivablesCount, payablesCount, overdueAmount, statusBreakdown },
    invoices: list,
  };
}

async function getSummary(userId, tenantId, { force = false } = {}) {
  const key    = `summary:${userId}:${tenantId}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  const [orgRes, invRes] = await Promise.all([
    withRetry(() => api.getOrganisations(tenantId)),
    withRetry(() => api.getInvoices(
      tenantId, undefined, undefined, 'Date DESC', undefined, undefined, undefined,
      ['AUTHORISED', 'PAID'], 1, undefined, undefined, undefined, true // summaryOnly — no line items needed here
    )),
  ]);

  const data = _buildSummary(orgRes.body.organisations?.[0] || {}, invRes.body.invoices || []);
  logger.info('Insights summary fetched', { userId, tenantId, invoiceCount: data.invoices.length });
  return _cacheSet(key, data);
}

// ── Date-range engine (daily/weekly/monthly/yearly/custom) ──────────────────
// Everything here works in calendar dates (Y/M/D), never real instants — Xero's
// filter syntax (`DateTime(y,m,d)`) takes a plain calendar date with no
// timezone component, so day-boundary math never needs to resolve a UTC
// offset. "Today" itself is the one place a timezone actually matters (what
// counts as today depends on where the user is), resolved once via
// Intl.DateTimeFormat against the user's stored timezone preference.

function _todayPartsInTz(timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}
function _dateFromParts({ year, month, day }) { return new Date(Date.UTC(year, month - 1, day)); }
function _partsFromDate(d) { return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }; }
function _addDays(parts, n) { const d = _dateFromParts(parts); d.setUTCDate(d.getUTCDate() + n); return _partsFromDate(d); }
function _weekdayMon0(parts) { return (_dateFromParts(parts).getUTCDay() + 6) % 7; } // 0=Mon..6=Sun
function _fmtXeroDate(p) { return `DateTime(${p.year},${p.month},${p.day})`; }
function _fmtISODate(p) { return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; }
function _parseISODate(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [year, month, day] = s.split('-').map(Number);
  return { year, month, day };
}

const RANGE_PRESETS = new Set(['day', 'week', 'month', 'year', 'custom']);

// Pure. Returns { preset, fromISO, toISO, where, days } — `where` is a ready-to-use
// Xero filter clause; `toExclusive` never leaks out since every caller only needs
// an inclusive display range or the filter string.
function computeRange(preset, timezone, customFrom, customTo) {
  const today = _todayPartsInTz(timezone || 'UTC');
  const usePreset = RANGE_PRESETS.has(preset) ? preset : 'month';

  let from, toExclusive;
  if (usePreset === 'day') {
    from = today; toExclusive = _addDays(today, 1);
  } else if (usePreset === 'week') {
    from = _addDays(today, -_weekdayMon0(today)); toExclusive = _addDays(today, 1);
  } else if (usePreset === 'year') {
    from = { year: today.year, month: 1, day: 1 }; toExclusive = _addDays(today, 1);
  } else if (usePreset === 'custom') {
    const f = _parseISODate(customFrom), t = _parseISODate(customTo);
    if (!f || !t) throw new Error('Custom range requires valid "from" and "to" dates (YYYY-MM-DD)');
    if (_dateFromParts(f) > _dateFromParts(t)) throw new Error('"from" must not be after "to"');
    from = f; toExclusive = _addDays(t, 1);
  } else { // month
    from = { year: today.year, month: today.month, day: 1 }; toExclusive = _addDays(today, 1);
  }

  const toInclusive = _addDays(toExclusive, -1);
  const days = Math.round((_dateFromParts(toExclusive) - _dateFromParts(from)) / 86400000);

  return {
    preset:  usePreset,
    fromISO: _fmtISODate(from),
    toISO:   _fmtISODate(toInclusive),
    where:   `Date >= ${_fmtXeroDate(from)} && Date < ${_fmtXeroDate(toExclusive)}`,
    days,
  };
}

// Pure. Buckets invoices dated within the range into a trend series — daily
// buckets for anything a month or shorter (a week or a month both read fine as
// individual days), monthly buckets for anything longer (a year of daily points
// would be an unreadable chart).
function _buildPeriod(invoices, range) {
  const granularity = range.days <= 31 ? 'day' : 'month';
  const bucketOf = dateStr => {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    return granularity === 'day'
      ? dateStr.slice(0, 10)
      : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  const buckets = new Map(); // key -> { sales, bills }
  let salesTotal = 0, billsTotal = 0, salesCount = 0, billsCount = 0;

  for (const inv of invoices) {
    const isReceivable = inv.type === 'ACCREC';
    const total = Number(inv.total || 0);
    if (isReceivable) { salesTotal += total; salesCount++; } else { billsTotal += total; billsCount++; }

    const key = bucketOf(inv.date);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, { bucket: key, sales: 0, bills: 0 });
    const b = buckets.get(key);
    if (isReceivable) b.sales += total; else b.bills += total;
  }

  const trend = [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));

  return {
    range: { preset: range.preset, fromISO: range.fromISO, toISO: range.toISO },
    totals: { salesTotal, billsTotal, salesCount, billsCount, net: salesTotal - billsTotal },
    granularity,
    trend,
  };
}

async function getPeriod(userId, tenantId, { preset = 'month', from, to, timezone = 'UTC', force = false } = {}) {
  const range = computeRange(preset, timezone, from, to);
  const key   = `period:${userId}:${tenantId}:${range.preset}:${range.fromISO}:${range.toISO}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  const invRes = await withRetry(() => api.getInvoices(
    tenantId, undefined, range.where, 'Date ASC', undefined, undefined, undefined,
    ['AUTHORISED', 'PAID'], 1, undefined, undefined, undefined, true
  ));

  const data = _buildPeriod(invRes.body.invoices || [], range);
  logger.info('Insights period fetched', { userId, tenantId, range: range.preset, invoiceCount: (invRes.body.invoices || []).length });
  return _cacheSet(key, data);
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

async function getAccounts(userId, tenantId, { force = false } = {}) {
  const key    = `accounts:${userId}:${tenantId}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  const res = await withRetry(() => api.getAccounts(tenantId, undefined, undefined, 'Code ASC'));
  const data = { accounts: _buildAccounts(res.body.accounts || []) };
  return _cacheSet(key, data);
}

function _buildBankAccounts(accounts) {
  return accounts
    .filter(a => a.type === 'BANK')
    .map(a => ({
      accountId: a.accountID, code: a.code || '', name: a.name || '',
      accountNumber: a.bankAccountNumber || '', currency: a.currencyCode || '', status: a.status || '',
    }));
}

async function getBankAccounts(userId, tenantId, { force = false } = {}) {
  const key    = `bank:${userId}:${tenantId}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  const res = await withRetry(() => api.getAccounts(tenantId, undefined, 'Type=="BANK"', 'Name ASC'));
  const data = { bankAccounts: _buildBankAccounts(res.body.accounts || []) };
  return _cacheSet(key, data);
}

function _buildContacts(contacts) {
  return contacts.map(c => ({
    contactId: c.contactID, name: c.name || 'Unknown', email: c.emailAddress || '',
    isCustomer: !!c.isCustomer, isSupplier: !!c.isSupplier, status: c.contactStatus || '',
  }));
}

async function getContacts(userId, tenantId, { force = false } = {}) {
  const key    = `contacts:${userId}:${tenantId}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  const res = await withRetry(() => api.getContacts(
    tenantId, undefined, undefined, 'Name ASC', undefined, undefined, undefined, true
  ));
  const data = { contacts: _buildContacts(res.body.contacts || []) };
  return _cacheSet(key, data);
}

// Called on disconnect so nothing here can outlive the connection it came from.
function clearCache(userId) {
  for (const key of _cache.keys()) {
    if (key.includes(`:${userId}:`)) _cache.delete(key);
  }
}

module.exports = {
  getSummary, getPeriod, getAccounts, getBankAccounts, getContacts, clearCache,
  _buildSummary, _buildPeriod, computeRange, _buildAccounts, _buildBankAccounts, _buildContacts,
};
