const { AccountingApi }  = require('xero-node');
const { withRetry }      = require('./xero-utils');
const logger             = require('../utils/logger');

// Read-only financial summary for the "Xero Insights" tab — Organisation profile
// plus Receivables/Payables/status-breakdown, all derived from a single GET
// /Invoices call (no separate Reports/BankSummary scope needed for this).
//
// Cached in-memory per user+tenant, same short-TTL philosophy as token-cache.js —
// Xero's 60-calls/minute budget is shared with real invoice submission, so a
// dashboard nobody's actively watching shouldn't refetch on every page view.
const CACHE_TTL_MS = 90 * 1000;
const _cache = new Map(); // `${userId}:${tenantId}` -> { data, fetchedAt }

function _cacheKey(userId, tenantId) { return `${userId}:${tenantId}`; }

// PAID invoices, and AUTHORISED ones already fully paid down to zero, both read
// as "paid" here — amountDue is the source of truth for what's actually owed,
// not just the coarse Xero status.
function _statusLabel(inv) {
  const amountDue = Number(inv.amountDue || 0);
  if (inv.status === 'PAID' || amountDue <= 0) return 'paid';
  if (inv.dueDate && new Date(inv.dueDate) < new Date()) return 'overdue';
  return 'awaiting';
}

// Pure — takes already-fetched Xero data and shapes it. No network, no token
// cache, nothing to mock: this is where the actual KPI/status logic lives and
// is exactly what the tests exercise directly.
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
  const key    = _cacheKey(userId, tenantId);
  const cached = _cache.get(key);
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { ...cached.data, cached: true, fetchedAt: cached.fetchedAt };
  }

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);

  const accountingApi       = new AccountingApi();
  accountingApi.accessToken = token;

  const [orgRes, invRes] = await Promise.all([
    withRetry(() => accountingApi.getOrganisations(tenantId)),
    withRetry(() => accountingApi.getInvoices(
      tenantId, undefined, undefined, 'Date DESC', undefined, undefined, undefined,
      ['AUTHORISED', 'PAID'], 1, undefined, undefined, undefined, true // summaryOnly — no line items needed here
    )),
  ]);

  const data = _buildSummary(orgRes.body.organisations?.[0] || {}, invRes.body.invoices || []);
  _cache.set(key, { data, fetchedAt: Date.now() });
  logger.info('Xero Insights summary fetched', { userId, tenantId, invoiceCount: data.invoices.length });
  return { ...data, cached: false, fetchedAt: Date.now() };
}

// Called on disconnect so a stale summary can't outlive the connection it came from.
function clearCache(userId) {
  for (const key of _cache.keys()) {
    if (key.startsWith(`${userId}:`)) _cache.delete(key);
  }
}

module.exports = { getSummary, clearCache, _buildSummary };
