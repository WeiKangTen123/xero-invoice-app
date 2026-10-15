const logger             = require('../utils/logger');
const { xeroErrMsg }     = require('./xero-utils');
const { _cacheGet, _cacheSet, _dedupe } = require('./report-cache');
const { _apiFor, _allInvoices, _getOrganisation, LIST_PAGE_SIZE, LIST_MAX_PAGES } = require('./report-fetch');
const { _toBase, _foreignCurrency } = require('./currency');
const { _raisedByMonth } = require('./cash-flow');
const { _addDays, _dateFromParts, _fmtISODate, _parseISODate, _partsFromDate, _todayPartsInTz } = require('./periods');

// The calendar day of a Xero date (see performance.js#_xeroDay). Required when
// first used rather than at load: performance.js reads the summary, so the two
// would otherwise require each other and one would see the other half-built.
const _day = v => require('./performance')._xeroDay(v);
// The unallocated credit notes the ageing view reads and caches. Required when
// first used for the same reason: ./ageing reads this module at load.
const _creditNotes = (...args) => require('./ageing')._getCreditNotes(...args);

// What is owed each way right now: receivables, payables, what is overdue, how
// it ages, and the most recent invoices. It takes no period, and getPerformance
// reads its totals for debtor and creditor days rather than fetching every
// invoice a second time. The ageing view (./ageing) reads the invoices still
// owed from this same fetch, for the same reason.

// ── Snapshot summary (Receivables/Payables/status — always "right now") ─────

// Today's date where the user is, as the ageing view dates it (./ageing#_asOf).
function _todayIn(timezone) {
  return _fmtISODate(_todayPartsInTz(timezone || 'UTC'));
}

// PAID invoices, and AUTHORISED ones already fully paid down to zero, both read
// as "paid" here — amountDue is the source of truth for what's actually owed,
// not just the coarse Xero status.
function _isPaid(inv) {
  return inv.status === 'PAID' || Number(inv.amountDue || 0) <= 0;
}

// Overdue from the day after the due date, where the user is, as the ageing
// view counts it: the due date is a calendar day and is set against today's
// date in the user's timezone. It was compared as an instant with the clock, so
// in Singapore an invoice due today turned overdue at 08:00 (midnight UTC)
// while the ageing still called it current.
function _isOverdue(dueDate, todayISO) {
  const due = _day(dueDate);
  return !!due && due < todayISO;
}

// Buckets an outstanding invoice by how soon it's due — same shape as Xero's
// own "Invoices owed to you" / "Bills to pay" dashboard widgets (grouped into
// overdue, due this week, due soon, due later), just with fixed day windows
// instead of Xero's dynamic weekly columns, since those shift with "today".
// Counted in calendar days from today where the user is, for the reason given
// at _isOverdue, so the two never disagree about an invoice due today.
function _agingBucketOf(dueDate, todayISO) {
  const due = _parseISODate(_day(dueDate)), today = _parseISODate(todayISO);
  if (!due || !today) return 'later';
  const days = Math.round((_dateFromParts(due) - _dateFromParts(today)) / 86400000);
  if (days < 0) return 'overdue';
  if (days <= 7) return 'within7';
  if (days <= 30) return 'within30';
  return 'later';
}
function _emptyAging() {
  return { overdue: { count: 0, amount: 0 }, within7: { count: 0, amount: 0 }, within30: { count: 0, amount: 0 }, later: { count: 0, amount: 0 } };
}

// Money is added in whole cents, each document converted and rounded to the
// cent first, exactly as the ageing view adds it, so the headline totals and
// the ageing's agree to the last cent rather than nearly.
const _cents     = v => Math.round(Number(v || 0) * 100);
const _fromCents = c => (c === 0 ? 0 : c / 100);

// Pure. Everything in the summary that does not depend on which day it is,
// from every invoice fetched: the organisation, the fifty newest rows (each
// "paid" or "awaiting"; _summaryAsOf turns the late ones overdue), how many
// are paid, and what was raised each month. This is what is cached, so one
// read of Xero serves a reader in any timezone, and getPerformance's read
// (which names none) still shares the /summary route's.
function _summaryBase(org, invoices) {
  const base = org.baseCurrency || '';
  let paidCount = 0;
  // Each row keeps its own currency and face amount; the KPIs, worked out in
  // _summaryAsOf, are in the base currency.
  const list = invoices.map(inv => {
    const paid = _isPaid(inv);
    if (paid) paidCount++;
    return {
      invoiceId:     inv.invoiceID,
      type:          inv.type === 'ACCREC' ? 'Sale' : 'Bill',
      contact:       inv.contact?.name || 'Unknown',
      invoiceNumber: inv.invoiceNumber || '',
      date:          inv.date || null,
      dueDate:       inv.dueDate || null,
      status:        paid ? 'paid' : 'awaiting',
      total:         Number(inv.total || 0),
      amountDue:     Number(inv.amountDue || 0),
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
    paidCount,
    invoices: list,
    // What was invoiced and billed in each month, from every invoice fetched
    // rather than the fifty listed. getPerformance measures debtor and creditor
    // days from this and the totals, so those need no invoice fetch of their
    // own.
    raisedByMonth: _raisedByMonth(invoices, base),
    currency: _foreignCurrency(invoices, base),
  };
}

// Pure. The summary as of `todayISO`, from _summaryBase's figures and the
// invoices still owed (_outstandingOf's records, cached beside them).
//
// `credits` is ./ageing#_creditsOf's unallocated credit notes, or null when
// they could not be read. They are taken off each side's total exactly as the
// ageing view takes them off, so Total Receivables is the ageing's total and
// the receivables on Xero's Balance Sheet, where the gross figure overstated
// both by every credit a customer had not yet used. The counts stay counts of
// invoices, and creditsNetted says how much was taken off. When the notes
// could not be read the gross figure is still worth showing, so it is, and
// creditsUnavailable says nothing was taken off.
//
// What is overdue, and the forward aging, are the invoices alone: a credit
// note is never late. Overdue is kept per direction. It used to be one sum of
// every overdue document, so a bill you were late paying was added to an
// invoice a customer was late paying: two opposite positions netted into a
// figure that described neither.
function _summaryAsOf(base, outstanding = [], { baseCurrency = '', todayISO = _todayIn('UTC'), credits = [] } = {}) {
  const sideOf = type => (type === 'ACCREC' ? 'receivables' : 'payables');
  const owed = { receivables: 0, payables: 0 }, count = { receivables: 0, payables: 0 };
  const late = { receivables: 0, payables: 0 }, lateCount = { receivables: 0, payables: 0 };
  const aging = { receivables: _emptyAging(), payables: _emptyAging() };
  for (const inv of outstanding || []) {
    const side  = sideOf(inv.type);
    const cents = _cents(_toBase(inv, Number(inv.amountDue || 0), baseCurrency));
    owed[side] += cents; count[side]++;
    if (_isOverdue(inv.dueDate, todayISO)) { late[side] += cents; lateCount[side]++; }
    const bucket = aging[side][_agingBucketOf(inv.dueDate, todayISO)];
    bucket.count++; bucket.amount += cents;
  }

  const netted = { receivables: 0, payables: 0 };
  for (const cn of credits || []) {
    const side = cn?.type === 'ACCRECCREDIT' ? 'receivables' : cn?.type === 'ACCPAYCREDIT' ? 'payables' : null;
    const remaining = Number(cn?.remainingCredit || 0);
    if (!side || !(remaining > 0)) continue;
    netted[side] += _cents(_toBase(cn, remaining, baseCurrency));
  }

  const overdue = lateCount.receivables + lateCount.payables;
  const invoices = (base.invoices || []).map(r => (
    r.status === 'awaiting' && _isOverdue(r.dueDate, todayISO) ? { ...r, status: 'overdue' } : r));
  const agingOut = side => Object.fromEntries(Object.entries(aging[side])
    .map(([k, b]) => [k, { count: b.count, amount: _fromCents(b.amount) }]));

  return {
    connected: true,
    organisation: base.organisation,
    kpis: {
      totalReceivables: _fromCents(owed.receivables - netted.receivables),
      totalPayables:    _fromCents(owed.payables - netted.payables),
      receivablesCount: count.receivables,
      payablesCount:    count.payables,
      overdueReceivables: _fromCents(late.receivables),
      overduePayables:    _fromCents(late.payables),
      overdueReceivablesCount: lateCount.receivables,
      overduePayablesCount:    lateCount.payables,
      statusBreakdown: {
        paid: base.paidCount || 0,
        awaiting: count.receivables + count.payables - overdue,
        overdue,
      },
      creditsNetted: { receivables: _fromCents(netted.receivables), payables: _fromCents(netted.payables) },
      creditsUnavailable: credits === null,
    },
    aging: { receivables: agingOut('receivables'), payables: agingOut('payables') },
    invoices,
    raisedByMonth: base.raisedByMonth,
    currency: base.currency,
  };
}

// Pure. The whole summary from one fetch of every invoice, as of `todayISO`
// (today in UTC unless given), with `credits` netted as _summaryAsOf says.
function _buildSummary(org, invoices, { todayISO, credits } = {}) {
  return _summaryAsOf(_summaryBase(org, invoices), _outstandingOf(invoices), {
    baseCurrency: org.baseCurrency || '', todayISO, credits,
  });
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
// days. The expected (sales) and planned (bills) payment dates a person can set
// in Xero are kept as calendar days, for the cash manager (./cash-manager),
// which dates an item by them first. Xero may leave both out of a list read,
// in which case they are null and the cash manager falls back.
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
      expectedPaymentDate: _day(inv.expectedPaymentDate),
      plannedPaymentDate:  _day(inv.plannedPaymentDate),
    });
  }
  return out;
}

// How late each contact pays, or is paid, read from the PAID invoices the
// summary's fetch already returns, so the cash manager can date an open
// invoice by when that customer actually tends to pay rather than by a due
// date they routinely miss. No call of its own.
//
// Per direction as well as per contact: a business that is both customer and
// supplier pays its bills on its own habits and is paid on ours, and the two
// say nothing about each other. Measured over invoices fully paid in the last
// year, so a customer who used to be slow and no longer is stops being
// predicted slow; at least two of them, because one late payment is an
// incident, not a habit. The average is rounded to whole days and held
// between 0 and 60: paying early does not bring cash in before the due date
// anyone plans around, and beyond two months the debt is a collection
// problem that a date shift would only hide.
const LATENESS_LOOKBACK_DAYS = 365;
const LATENESS_MIN_PAID      = 2;
const LATENESS_MAX_DAYS      = 60;

// One contact on one side, as both the map below and the cash manager key it.
// A record with no contact id, which Xero should never send, falls back to its
// name, as the ageing groups it.
function _contactKey(type, contactId, contactName) {
  return `${type}:${contactId || `name:${contactName || ''}`}`;
}

// Pure. { "<type>:<contact>": { days, count, average } } for every contact
// with enough paid history; `todayISO` is the end of the year looked back over.
function _latenessOf(invoices = [], todayISO = new Date().toISOString().slice(0, 10)) {
  const today = _parseISODate(todayISO);
  const since = today ? _fmtISODate(_addDays(today, -LATENESS_LOOKBACK_DAYS)) : null;
  const sums  = new Map();
  for (const inv of invoices || []) {
    if (!inv || inv.status !== 'PAID') continue;
    if (inv.type !== 'ACCREC' && inv.type !== 'ACCPAY') continue;
    const due = _day(inv.dueDate), paid = _day(inv.fullyPaidOnDate);
    if (!due || !paid) continue;
    if (since && (paid < since || paid > todayISO)) continue;
    const late = Math.round((_dateFromParts(_parseISODate(paid)) - _dateFromParts(_parseISODate(due))) / 86400000);
    const key = _contactKey(inv.type, inv.contact?.contactID, inv.contact?.name);
    const s = sums.get(key) || { total: 0, count: 0 };
    s.total += late; s.count++;
    sums.set(key, s);
  }
  const out = {};
  for (const [key, s] of sums) {
    if (s.count < LATENESS_MIN_PAID) continue;
    const average = s.total / s.count;
    out[key] = {
      days: Math.min(LATENESS_MAX_DAYS, Math.max(0, Math.round(average))),
      count: s.count,
      average: Math.round(average * 10) / 10,
    };
  }
  return out;
}

// Pure. The paid invoices _latenessOf measures from, cut down to what it
// reads, so they can be cached beside the open invoices. The year it looks
// back over ends on today where the reader is, which a read shared by every
// timezone cannot know, so the measure is taken per request
// (_getOutstanding) and only these are kept: every paid invoice of the last
// year and two days, `todayISO` being the UTC day of the fetch. No reader's
// day is more than a day either side of it, so none loses an invoice its own
// year takes in.
function _paidHistoryOf(invoices = [], todayISO) {
  const today = _parseISODate(todayISO);
  const since = today ? _fmtISODate(_addDays(today, -(LATENESS_LOOKBACK_DAYS + 2))) : null;
  const out = [];
  for (const inv of invoices || []) {
    if (!inv || inv.status !== 'PAID') continue;
    if (inv.type !== 'ACCREC' && inv.type !== 'ACCPAY') continue;
    const dueDate = _day(inv.dueDate), fullyPaidOnDate = _day(inv.fullyPaidOnDate);
    if (!dueDate || !fullyPaidOnDate || (since && fullyPaidOnDate < since)) continue;
    out.push({
      status: 'PAID', type: inv.type, dueDate, fullyPaidOnDate,
      contact: { contactID: inv.contact?.contactID || null, name: inv.contact?.name || '' },
    });
  }
  return out;
}

// One read of Xero for the summary and the open invoices behind it, cached as
// two entries: the figures that do not depend on the day (_summaryBase) and
// the invoices still owed (_outstandingOf). Neither depends on the day or the
// timezone, so the /summary route in Singapore and getPerformance's read,
// which names no timezone, share one fetch and one cache entry; the day is
// applied per request in getSummary, and the lateness in _getOutstanding.
async function _fetchSummaryRaw(userId, tenantId, { force = false } = {}) {
  const key    = `summary:${userId}:${tenantId}`;
  const cached = _cacheGet(key, force);
  // The two entries come from one fetch, so they count as a hit only together.
  // Should the cache ever drop one without the other, the summary is fetched
  // again rather than the ageing view finding nothing to read and showing an
  // empty ledger as "nothing outstanding".
  const held = cached && _cacheGet(_outstandingKey(userId, tenantId), force);
  if (held) return { base: cached, outstanding: held };

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

  const outstanding = _cacheSet(_outstandingKey(userId, tenantId), {
    baseCurrency: org.baseCurrency || '',
    invoices: _outstandingOf(invoices),
    // The fetch is newest first and stops at the page cap, so an organisation
    // past it loses its OLDEST invoices — exactly the ones ageing is about. Said
    // rather than shown as a clean ledger.
    capped: invoices.length >= LIST_PAGE_SIZE * LIST_MAX_PAGES,
    // In the same entry as the open invoices it dates, so the two are always
    // from one fetch: the cash manager never predicts from a stale history.
    // The lateness itself was measured here, over the year to today in UTC,
    // so in Singapore before 08:00 an invoice paid that morning was not yet
    // counted; it is measured per request from these instead.
    paidHistory: _paidHistoryOf(invoices, _fmtISODate(_partsFromDate(new Date()))),
  });
  const base = _cacheSet(key, _summaryBase(org, invoices));
  logger.info('Insights summary fetched', { userId, tenantId, invoiceCount: base.invoices.length });
  return { base, outstanding };
}

function _outstandingKey(userId, tenantId) { return `outstanding:${userId}:${tenantId}`; }

// Bound after the declaration, through the one in-flight map in
// ./report-cache, so the /summary route, getPerformance and the ageing view
// asking at once share one fetch.
const _fetchSummary = _dedupe('_fetchSummary', _fetchSummaryRaw, { force: false });

// The summary as of today where the user is. As with the ageing view, only
// what it is built from is cached, not the result: an invoice turns overdue at
// midnight in the reader's timezone, which a cached result would not notice,
// and building it is one pass over the open invoices. A caller that names no
// timezone gets UTC's day; the totals getPerformance reads do not depend on
// the day at all. `cached` is true when nothing in this request went to Xero.
async function _getSummaryRaw(userId, tenantId, { timezone = 'UTC', force = false } = {}) {
  const [{ base, outstanding }, creditRes] = await Promise.all([
    _fetchSummary(userId, tenantId, { force }),
    // Asked for exactly as the ageing view asks, so the two share one read.
    // A failure costs the netting, not the summary: the gross figures are
    // shown and creditsUnavailable says nothing was taken off.
    _creditNotes(userId, tenantId, { force }).catch(err => {
      logger.warn('Summary: credit notes unavailable, nothing netted', { userId, tenantId, error: xeroErrMsg(err) });
      return null;
    }),
  ]);
  const data = _summaryAsOf(base, outstanding.invoices, {
    baseCurrency: outstanding.baseCurrency,
    todayISO: _todayIn(timezone),
    credits: creditRes ? creditRes.creditNotes : null,
  });
  const stamps = [base.fetchedAt, creditRes?.fetchedAt].filter(Number.isFinite);
  return {
    ...data,
    cached: base.cached !== false && (!creditRes || creditRes.cached !== false),
    // The older of the two reads, so "synced" never claims fresher than the
    // oldest figure on screen.
    fetchedAt: stamps.length ? Math.min(...stamps) : Date.now(),
  };
}

// The timezone is part of the request, so readers whose days differ never
// share one in flight; left out it is UTC, the same request as UTC named.
const getSummary             = _dedupe('getSummary', _getSummaryRaw, { timezone: 'UTC', force: false });

// The invoices still owed, from the summary's own fetch: one read of Xero
// serves the headline totals and the ageing view alike, and the two cannot
// disagree about what is outstanding. A dashboard has always loaded its summary
// by the time anyone opens the ageing, so this normally costs no Xero call at
// all. `cached` says whether this call went to Xero.
//
// `lateness` (_latenessOf) is measured over the year to today in `timezone`,
// UTC when none is named. Only the measure depends on the day, and it is one
// pass over a year of paid invoices, so it is taken here per request and the
// cached read stays one per company, whatever the reader's timezone.
async function _getOutstanding(userId, tenantId, { force = false, timezone = 'UTC' } = {}) {
  const key = _outstandingKey(userId, tenantId);
  // Through the same fetch the /summary route's request makes, so it shares
  // that request when both arrive together, and the summary's cache entry is
  // refreshed with it.
  const read = _cacheGet(key, force) || (await _fetchSummary(userId, tenantId, { force })).outstanding;
  const { paidHistory, ...rest } = read;
  return { ...rest, lateness: _latenessOf(paidHistory || [], _todayIn(timezone)) };
}

module.exports = {
  getSummary, _buildSummary, _summaryBase, _summaryAsOf, _outstandingOf, _getOutstanding, _latenessOf, _paidHistoryOf, _contactKey,
  LATENESS_LOOKBACK_DAYS, LATENESS_MIN_PAID, LATENESS_MAX_DAYS,
};
