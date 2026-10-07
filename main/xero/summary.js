const { withRetry }      = require('./xero-utils');
const logger             = require('../utils/logger');
const { _cacheGet, _cacheSet, _dedupe } = require('./report-cache');
const { _apiFor, _allInvoices } = require('./report-fetch');
const { _toBase, _foreignCurrency } = require('./currency');
const { _raisedByMonth } = require('./cash-flow');

// What is owed each way right now: receivables, payables, what is overdue, how
// it ages, and the most recent invoices. It takes no period, and getPerformance
// reads its totals for debtor and creditor days rather than fetching every
// invoice a second time.

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

// Buckets an outstanding invoice by how soon it's due — same shape as Xero's
// own "Invoices owed to you" / "Bills to pay" dashboard widgets (grouped into
// overdue, due this week, due soon, due later), just with fixed day windows
// instead of Xero's dynamic weekly columns, since those shift with "today".
function _agingBucketOf(dueDate) {
  if (!dueDate) return 'later';
  const days = Math.floor((new Date(dueDate) - new Date()) / 86400000);
  if (days < 0) return 'overdue';
  if (days <= 7) return 'within7';
  if (days <= 30) return 'within30';
  return 'later';
}
function _emptyAging() {
  return { overdue: { count: 0, amount: 0 }, within7: { count: 0, amount: 0 }, within30: { count: 0, amount: 0 }, later: { count: 0, amount: 0 } };
}

function _buildSummary(org, invoices) {
  let totalReceivables = 0, totalPayables = 0;
  let receivablesCount = 0, payablesCount = 0;
  // Overdue is kept per direction. It used to be one sum of every overdue
  // document, so a bill you were late paying was added to an invoice a customer
  // was late paying: two opposite positions netted into a figure that described
  // neither, and grew whenever you fell behind with a supplier.
  let overdueReceivables = 0, overduePayables = 0;
  let overdueReceivablesCount = 0, overduePayablesCount = 0;
  const statusBreakdown = { paid: 0, awaiting: 0, overdue: 0 };
  const aging = { receivables: _emptyAging(), payables: _emptyAging() };

  // Totals are in the org's base currency. Each row keeps its own currency
  // and face amount; the KPIs used to add USD to SGD and label the sum as base.
  const base = org.baseCurrency || '';
  const list = invoices.map(inv => {
    const isReceivable = inv.type === 'ACCREC';
    const amountDue     = Number(inv.amountDue || 0);
    const dueBase       = _toBase(inv, amountDue, base);
    const status         = _statusLabel(inv);
    statusBreakdown[status]++;
    if (status === 'overdue') {
      if (isReceivable) { overdueReceivables += dueBase; overdueReceivablesCount++; }
      else              { overduePayables    += dueBase; overduePayablesCount++; }
    }

    if (inv.status === 'AUTHORISED' && amountDue > 0) {
      if (isReceivable) { totalReceivables += dueBase; receivablesCount++; }
      else               { totalPayables    += dueBase; payablesCount++; }
      const bucket = aging[isReceivable ? 'receivables' : 'payables'][_agingBucketOf(inv.dueDate)];
      bucket.count++; bucket.amount += dueBase;
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
    kpis: {
      totalReceivables, totalPayables, receivablesCount, payablesCount,
      overdueReceivables, overduePayables, overdueReceivablesCount, overduePayablesCount,
      statusBreakdown,
    },
    aging,
    invoices: list,
    // What was invoiced and billed in each month, from every invoice fetched
    // rather than the fifty listed. getPerformance measures debtor and creditor
    // days from this and the totals above, so those need no invoice fetch of
    // their own.
    raisedByMonth: _raisedByMonth(invoices, base),
    currency: _foreignCurrency(invoices, base),
  };
}

async function _getSummaryRaw(userId, tenantId, { force = false } = {}) {
  const key    = `summary:${userId}:${tenantId}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  const [orgRes, invoices] = await Promise.all([
    withRetry(() => api.getOrganisations(tenantId)),
    _allInvoices(api, tenantId, { order: 'Date DESC', statuses: ['AUTHORISED', 'PAID'] }),
  ]);

  const data = _buildSummary(orgRes.body.organisations?.[0] || {}, invoices);
  logger.info('Insights summary fetched', { userId, tenantId, invoiceCount: data.invoices.length });
  return _cacheSet(key, data);
}

// Bound after the declaration, through the one in-flight map in
// ./report-cache, so getPerformance's read of it shares the /summary route's
// request rather than starting its own.
const getSummary             = _dedupe('getSummary', _getSummaryRaw);

module.exports = { getSummary, _buildSummary };
