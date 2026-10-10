const logger             = require('../utils/logger');
const { _cacheGet, _cacheSet, _dedupe } = require('./report-cache');
const { _apiFor, _allInvoices, _getOrganisation, LIST_PAGE_SIZE, LIST_MAX_PAGES } = require('./report-fetch');
const { _toBase, _foreignCurrency } = require('./currency');
const { _raisedByMonth } = require('./cash-flow');

// What is owed each way right now: receivables, payables, what is overdue, how
// it ages, and the most recent invoices. It takes no period, and getPerformance
// reads its totals for debtor and creditor days rather than fetching every
// invoice a second time. The ageing view (./ageing) reads the invoices still
// owed from this same fetch, for the same reason.

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

// Pure. The invoices and bills still owed, cut down to what the ageing view
// reads, so they can be cached beside the summary. The summary itself keeps
// only fifty rows and its totals, and every invoice the fetch returned, paid
// ones included, is far too much to hold in memory per organisation.
//
// Approved and not yet paid down to nothing: Xero's AUTHORISED takes in a
// part-paid invoice, and AmountDue is what remains of it, where Total would
// count the part already paid. Drafts, invoices awaiting approval and voided
// ones are left out, as in Xero's own Aged Receivables and Payables reports.
// The two dates are kept as Xero sent them; ./ageing reads them as calendar
// days.
function _outstandingOf(invoices = []) {
  const out = [];
  for (const inv of invoices) {
    if (!inv || inv.status !== 'AUTHORISED') continue;
    if (inv.type !== 'ACCREC' && inv.type !== 'ACCPAY') continue;
    const amountDue = Number(inv.amountDue || 0);
    if (!(amountDue > 0)) continue;
    out.push({
      invoiceId:    inv.invoiceID || null,
      type:         inv.type,
      contactId:    inv.contact?.contactID || null,
      contactName:  inv.contact?.name || '',
      number:       inv.invoiceNumber || '',
      reference:    inv.reference || '',
      date:         inv.date || null,
      dueDate:      inv.dueDate || null,
      amountDue,
      // Named as on the invoice, so _toBase and _foreignCurrency read these
      // records exactly as they read the invoices themselves.
      currencyCode: inv.currencyCode ? String(inv.currencyCode) : '',
      currencyRate: inv.currencyRate ?? null,
    });
  }
  return out;
}

async function _getSummaryRaw(userId, tenantId, { force = false } = {}) {
  const key    = `summary:${userId}:${tenantId}`;
  const cached = _cacheGet(key, force);
  // The two entries come from one fetch, so they count as a hit only together.
  // Should the cache ever drop one without the other, the summary is fetched
  // again rather than the ageing view finding nothing to read and showing an
  // empty ledger as "nothing outstanding".
  if (cached && _cacheGet(_outstandingKey(userId, tenantId), force)) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  // The organisation record comes through the one cached, shared read of it
  // (see _getOrganisation in ./report-fetch). The summary read it directly,
  // and so did Budget vs Actual, so a cold Dashboard load asked Xero for the
  // same record twice within the second. `force` is passed on: a refresh past
  // the grace window re-reads the organisation with everything else.
  const [org, invoices] = await Promise.all([
    _getOrganisation(userId, tenantId, force),
    _allInvoices(api, tenantId, { order: 'Date DESC', statuses: ['AUTHORISED', 'PAID'] }),
  ]);

  const data = _buildSummary(org, invoices);
  _cacheSet(_outstandingKey(userId, tenantId), {
    baseCurrency: org.baseCurrency || '',
    invoices: _outstandingOf(invoices),
    // The fetch is newest first and stops at the page cap, so an organisation
    // past it loses its OLDEST invoices — exactly the ones ageing is about. Said
    // rather than shown as a clean ledger.
    capped: invoices.length >= LIST_PAGE_SIZE * LIST_MAX_PAGES,
  });
  logger.info('Insights summary fetched', { userId, tenantId, invoiceCount: data.invoices.length });
  return _cacheSet(key, data);
}

function _outstandingKey(userId, tenantId) { return `outstanding:${userId}:${tenantId}`; }

// Bound after the declaration, through the one in-flight map in
// ./report-cache, so getPerformance's read of it shares the /summary route's
// request rather than starting its own.
const getSummary             = _dedupe('getSummary', _getSummaryRaw);

// The invoices still owed, from the summary's own fetch: one read of Xero
// serves the headline totals and the ageing view alike, and the two cannot
// disagree about what is outstanding. A dashboard has always loaded its summary
// by the time anyone opens the ageing, so this normally costs no Xero call at
// all. `cached` says whether this call went to Xero.
async function _getOutstanding(userId, tenantId, { force = false } = {}) {
  const key = _outstandingKey(userId, tenantId);
  const hit = _cacheGet(key, force);
  if (hit) return hit;
  // Asked for exactly as the /summary route asks, so it shares that request
  // when both arrive together, and the summary's cache entry is refreshed with
  // it.
  const summary = await getSummary(userId, tenantId, { force });
  const filled  = _cacheGet(key, false);
  if (!filled) throw new Error('The outstanding invoices could not be read from the summary');
  return { ...filled, cached: summary.cached !== false };
}

module.exports = { getSummary, _buildSummary, _outstandingOf, _getOutstanding };
