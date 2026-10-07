const logger             = require('../utils/logger');
const { xeroErrMsg }     = require('./xero-utils');
const { _cacheGet, _cacheSet, _dedupe } = require('./report-cache');
const { _apiFor, _allPages } = require('./report-fetch');
const { _getOutstanding } = require('./summary');
const { _toBase, _foreignCurrency } = require('./currency');
const { _todayPartsInTz, _fmtISODate, _parseISODate, _dateFromParts } = require('./periods');
const { _xeroDay } = require('./performance');

// Receivables and payables by age, and by contact, with each contact's
// invoices behind the figures: the drill-down Xero's Aged Receivables and Aged
// Payables reports give, read from data the dashboard already holds.
//
// The invoices come from the summary's own fetch (see summary.js
// #_getOutstanding), so the headline "Total Receivables" and this view are one
// read of Xero and cannot disagree about which invoices are open. The one thing
// added is a paged read of unallocated credit notes, cached like any report.
//
// The summary's older "aging" (overdue / due within 7 / within 30 / later) looks
// FORWARD, at when money is coming; this looks BACK, at how late it is, in the
// columns accountants chase debts by. Both stay: they answer different
// questions.

const SIDES = {
  receivables: { type: 'ACCREC', creditType: 'ACCRECCREDIT', docs: 'sales invoices', report: 'Aged Receivables' },
  payables:    { type: 'ACCPAY', creditType: 'ACCPAYCREDIT', docs: 'bills',          report: 'Aged Payables' },
};

// Days past the DUE date, as Xero's Aged reports count them when set to age by
// due date. Due today is not yet late, so it is Current; the day after is 1.
const BUCKETS = [
  { key: 'current', label: 'Current',      short: 'Current' },
  { key: 'd1_30',   label: '1–30 days',    short: '1–30' },
  { key: 'd31_60',  label: '31–60 days',   short: '31–60' },
  { key: 'd61_90',  label: '61–90 days',   short: '61–90' },
  { key: 'd90plus', label: 'Over 90 days', short: '90+' },
];

function _bucketOf(daysOverdue) {
  if (!(daysOverdue > 0)) return 'current';
  if (daysOverdue <= 30) return 'd1_30';
  if (daysOverdue <= 60) return 'd31_60';
  if (daysOverdue <= 90) return 'd61_90';
  return 'd90plus';
}

// Whole calendar days from one YYYY-MM-DD to another. Both are calendar dates,
// never instants, so no UTC offset can move a due date a day either way; the
// one place a timezone counts is which day "today" is, settled before this.
function _daysBetween(fromISO, toISO) {
  const a = _parseISODate(fromISO), b = _parseISODate(toISO);
  if (!a || !b) return null;
  return Math.round((_dateFromParts(b) - _dateFromParts(a)) / 86400000);
}

// Today where the user is. An invoice due on the 7th is a day late from
// midnight on the 8th in Singapore, while it is still the 7th in London.
function _asOf(timezone) {
  return _fmtISODate(_todayPartsInTz(timezone || 'UTC'));
}

// A screen and a JSON payload have to stop somewhere. The largest contacts are
// listed and the rest totalled as one row, so every bucket still adds up to the
// headline; each contact lists its oldest documents first, which are the ones
// a reader chases. Both are said in the payload when they bite.
const CONTACT_LIMIT = 50;
const INVOICE_LIMIT = 25;

// Money is added in whole cents. A converted amount is rounded to the cent per
// document, as Xero does, and integer cents add up exactly, so the buckets,
// the contacts and the total always agree to the last cent.
const toCents = v => Math.round(Number(v || 0) * 100);
const fromCents = c => (c === 0 ? 0 : c / 100);
const emptyBuckets = () => Object.fromEntries(BUCKETS.map(b => [b.key, 0]));

// Pure. Unallocated credit notes, cut down to what the ageing reads. Xero marks
// a credit note PAID once it is fully allocated or refunded, so the AUTHORISED
// ones fetched are those with credit left; RemainingCredit is that credit, in
// the note's own currency.
function _creditsOf(notes = []) {
  const out = [];
  for (const cn of notes) {
    if (!cn || cn.status !== 'AUTHORISED') continue;
    if (cn.type !== 'ACCRECCREDIT' && cn.type !== 'ACCPAYCREDIT') continue;
    const remainingCredit = Number(cn.remainingCredit || 0);
    if (!(remainingCredit > 0)) continue;
    out.push({
      creditNoteId: cn.creditNoteID || null,
      type:         cn.type,
      contactId:    cn.contact?.contactID || null,
      contactName:  cn.contact?.name || '',
      number:       cn.creditNoteNumber || '',
      reference:    cn.reference || '',
      date:         cn.date || null,
      dueDate:      cn.dueDate || null,
      remainingCredit,
      currencyCode: cn.currencyCode ? String(cn.currencyCode) : '',
      currencyRate: cn.currencyRate ?? null,
    });
  }
  return out;
}

// Pure. The ageing for one side, as of `todayISO`.
//
// `outstanding` is summary.js#_outstandingOf's records: approved, with an
// amount still due. `credits` is _creditsOf's, or null when they could not be
// read, in which case nothing is netted and the notes say so.
//
// What is netted, plainly, because it is where this and Xero's own Aged report
// can differ:
//   * Unallocated credit notes ARE subtracted, as Xero's report subtracts them,
//     each as a negative amount in the column for its own date (a credit note
//     is never "late", so its date stands in for a due date). An allocated
//     one has already reduced the invoice's AmountDue, so it is not counted
//     twice.
//   * Unallocated overpayments and prepayments are NOT. Reading them is two
//     more Xero calls; Xero's report subtracts them, so a contact holding one
//     shows more owed here than there.
//
// Amounts are in the organisation's base currency: Xero gives AmountDue in the
// invoice's own currency, converted here with the rate Xero stamped on it, the
// same way as every other figure on the dashboard (see ./currency). Each row
// also carries its own currency and face amount, and is flagged when foreign.
function _buildAgeing({
  side, outstanding = [], credits = null, baseCurrency = '', todayISO, timezone = null,
  incomplete = false, contactLimit = CONTACT_LIMIT, invoiceLimit = INVOICE_LIMIT,
}) {
  const spec = SIDES[side];
  if (!spec) throw new Error(`Unknown ageing side "${side}"`);
  const base = baseCurrency || '';
  const isForeign = d => !!d.currencyCode && !!base && d.currencyCode !== base;

  const docs = [];
  for (const inv of outstanding || []) {
    if (!inv || inv.type !== spec.type) continue;
    const amountDue = Number(inv.amountDue || 0);
    if (!(amountDue > 0)) continue;
    const dueDate = _xeroDay(inv.dueDate);
    // Xero will not approve an invoice without a due date, so this is a
    // record that came back incomplete; it is counted as not yet due rather
    // than guessed late.
    const daysOverdue = dueDate ? _daysBetween(dueDate, todayISO) : null;
    docs.push({
      kind: 'invoice', source: inv,
      id: inv.invoiceId || null, contactId: inv.contactId || null, contactName: inv.contactName || '',
      number: inv.number || '', reference: inv.reference || '',
      date: _xeroDay(inv.date), dueDate, ageDate: dueDate,
      daysOverdue, bucket: _bucketOf(daysOverdue),
      amount: amountDue, cents: toCents(_toBase(inv, amountDue, base)),
      currency: inv.currencyCode || base, foreign: isForeign(inv),
    });
  }
  let creditCount = 0;
  for (const cn of credits || []) {
    if (!cn || cn.type !== spec.creditType) continue;
    const remaining = Number(cn.remainingCredit || 0);
    if (!(remaining > 0)) continue;
    const date = _xeroDay(cn.date);
    const ageDate = _xeroDay(cn.dueDate) || date;
    const age = ageDate ? _daysBetween(ageDate, todayISO) : null;
    creditCount++;
    docs.push({
      kind: 'credit-note', source: cn,
      id: cn.creditNoteId || null, contactId: cn.contactId || null, contactName: cn.contactName || '',
      number: cn.number || '', reference: cn.reference || '',
      date, dueDate: null, ageDate,
      daysOverdue: null, bucket: _bucketOf(age),
      amount: -remaining, cents: -toCents(_toBase(cn, remaining, base)),
      currency: cn.currencyCode || base, foreign: isForeign(cn),
    });
  }

  // Grouped by Xero's contact id, which is what Xero's report groups by: two
  // customers both called "Smith" are two lines. A record with no id, which
  // Xero should never send, falls back to its name.
  const byContact = new Map();
  const totals = emptyBuckets(), counts = emptyBuckets();
  let grossCents = 0, creditCents = 0, invoiceCount = 0;
  for (const d of docs) {
    const key = d.contactId || `name:${d.contactName}`;
    let c = byContact.get(key);
    if (!c) {
      c = { contactId: d.contactId, name: d.contactName || 'Unknown contact', buckets: emptyBuckets(),
            total: 0, oldestDue: null, count: 0, credits: 0, foreign: false, docs: [] };
      byContact.set(key, c);
    }
    c.buckets[d.bucket] += d.cents;
    c.total += d.cents;
    c.docs.push(d);
    if (d.foreign) c.foreign = true;
    totals[d.bucket] += d.cents;
    if (d.kind === 'invoice') {
      c.count++; invoiceCount++; counts[d.bucket]++; grossCents += d.cents;
      if (d.dueDate && (!c.oldestDue || d.dueDate < c.oldestDue)) c.oldestDue = d.dueDate;
    } else {
      c.credits++; creditCents -= d.cents;
    }
  }

  // Largest balance first; a tie goes by name so the order never shuffles
  // between two loads of the same figures.
  const all = [...byContact.values()].sort((a, b) => (b.total - a.total) || a.name.localeCompare(b.name));
  const shown = all.slice(0, contactLimit);
  const rest  = all.slice(contactLimit);

  const row = d => ({
    kind: d.kind, id: d.id, number: d.number, reference: d.reference,
    date: d.date, dueDate: d.dueDate, daysOverdue: d.daysOverdue, bucket: d.bucket,
    amountDue: d.amount, currency: d.currency, amountDueBase: fromCents(d.cents), foreign: d.foreign,
  });
  // Oldest first, credit notes in among the invoices by their own date, and
  // anything without a date last.
  const byAge = (a, b) => (a.ageDate || '9999-99-99').localeCompare(b.ageDate || '9999-99-99')
    || (a.kind === b.kind ? 0 : a.kind === 'invoice' ? -1 : 1)
    || a.number.localeCompare(b.number);

  const contacts = shown.map(c => {
    const docsByAge = [...c.docs].sort(byAge);
    return {
      contactId: c.contactId, name: c.name,
      buckets: Object.fromEntries(BUCKETS.map(b => [b.key, fromCents(c.buckets[b.key])])),
      total: fromCents(c.total),
      oldestDue: c.oldestDue,
      count: c.count,
      credits: c.credits,
      foreign: c.foreign,
      invoices: docsByAge.slice(0, invoiceLimit).map(row),
      invoicesOmitted: Math.max(0, docsByAge.length - invoiceLimit),
    };
  });

  let others = null;
  if (rest.length) {
    const ob = emptyBuckets();
    let ot = 0, oc = 0;
    for (const c of rest) {
      for (const b of BUCKETS) ob[b.key] += c.buckets[b.key];
      ot += c.total; oc += c.count;
    }
    others = {
      contactCount: rest.length,
      buckets: Object.fromEntries(BUCKETS.map(b => [b.key, fromCents(ob[b.key])])),
      total: fromCents(ot), count: oc,
    };
  }

  const totalCents = BUCKETS.reduce((s, b) => s + totals[b.key], 0);
  const foreignCurrency = _foreignCurrency(docs.map(d => d.source), base);
  const creditsRead = credits !== null && credits !== undefined;

  const notes = [];
  notes.push(`Approved ${spec.docs} with an amount still due, aged by days past their due date as of ${todayISO}`
    + `${timezone ? ` (${timezone})` : ''}. A part-paid one counts only what is still due. Drafts, ones awaiting `
    + `approval, voided and paid ones are left out, as in Xero's ${spec.report} report.`);
  if (!creditsRead) {
    notes.push(`Credit notes could not be read from Xero just now, so none are subtracted; Xero's ${spec.report} `
      + 'report subtracts unallocated ones, so it may show less.');
  } else if (creditCount) {
    notes.push(`${creditCount} unallocated credit note${creditCount === 1 ? ' is' : 's are'} subtracted, each in the `
      + `column for its own date, as Xero's ${spec.report} report does.`);
  }
  notes.push(`Unallocated overpayments and prepayments are not subtracted. Xero's ${spec.report} report does `
    + 'subtract them, so a contact holding one shows more owed here than there.');
  if (foreignCurrency.mixed) {
    notes.push(`Amounts in ${foreignCurrency.currencies.join(', ')} are converted to ${base || 'base currency'} at the `
      + 'rate Xero stamped on each document; Xero\'s figure after a currency revaluation can differ slightly.'
      + (foreignCurrency.unconvertible
        ? ` ${foreignCurrency.unconvertible} had no rate and ${foreignCurrency.unconvertible === 1 ? 'is' : 'are'} counted at face value.`
        : ''));
  }
  if (rest.length) {
    notes.push(`The ${contactLimit} largest balances of ${all.length} contacts are listed; the other ${rest.length} `
      + 'are totalled in one row.');
  }
  if (contacts.some(c => c.invoicesOmitted > 0)) {
    notes.push(`Each contact lists its ${invoiceLimit} oldest documents; the rest are in its totals.`);
  }
  if (incomplete) {
    notes.push('Xero returned the most invoices this dashboard reads in one go, newest first, so the oldest unpaid '
      + 'ones may be missing from these figures.');
  }

  return {
    side,
    asOf: todayISO,
    timezone,
    currency: base,
    buckets: BUCKETS.map(b => ({ key: b.key, label: b.label, short: b.short, amount: fromCents(totals[b.key]), count: counts[b.key] })),
    total: fromCents(totalCents),
    gross: fromCents(grossCents),
    count: invoiceCount,
    contactCount: all.length,
    credits: { netted: creditsRead, count: creditCount, amount: fromCents(creditCents) },
    overpaymentsNetted: false,
    contacts,
    others,
    limits: { contacts: contactLimit, invoicesPerContact: invoiceLimit },
    foreignCurrency,
    incomplete: !!incomplete,
    notes,
  };
}

// Every unallocated credit note, both kinds in one read, so receivables and
// payables share it. Status=="AUTHORISED" keeps it to the notes with credit
// left, usually a handful, so this is normally one page. Paged like every other
// list (see report-fetch.js#_allPages).
async function _getCreditNotesRaw(userId, tenantId, { force = false } = {}) {
  const key    = `creditnotes:${userId}:${tenantId}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const api = _apiFor(await tokenCache.getValidToken(tenantId));
  const notes = await _allPages(page => api.getCreditNotes(
    tenantId, undefined, 'Status=="AUTHORISED"', 'Date DESC', page,
  ), 'creditNotes', { what: 'Credit note', tenantId });
  return _cacheSet(key, { creditNotes: _creditsOf(notes) });
}
const _getCreditNotes = _dedupe('_getCreditNotes', _getCreditNotesRaw, { force: false });

// The result itself is not cached, only what it is built from. Building it is
// one pass over the open invoices, and the day they are aged against turns at
// midnight in each user's timezone, which a cached result would not notice.
// `cached` is true when nothing in this request went to Xero.
async function _getAgeingRaw(userId, tenantId, { side, timezone = 'UTC', force = false } = {}) {
  if (!SIDES[side]) throw new Error(`Unknown ageing side "${side}"`);
  const [outstanding, creditRes] = await Promise.all([
    _getOutstanding(userId, tenantId, { force }),
    // A credit-note failure costs the netting, not the view: the invoices are
    // what the reader came for, and the notes say nothing was subtracted.
    _getCreditNotes(userId, tenantId, { force }).catch(err => {
      logger.warn('Ageing: credit notes unavailable, nothing netted', { userId, tenantId, error: xeroErrMsg(err) });
      return null;
    }),
  ]);
  const data = _buildAgeing({
    side,
    outstanding: outstanding.invoices,
    credits: creditRes ? creditRes.creditNotes : null,
    baseCurrency: outstanding.baseCurrency,
    todayISO: _asOf(timezone),
    timezone,
    incomplete: outstanding.capped,
  });
  const stamps = [outstanding.fetchedAt, creditRes?.fetchedAt].filter(Number.isFinite);
  return {
    ...data,
    cached: outstanding.cached !== false && (!creditRes || creditRes.cached !== false),
    // The older of the two reads, so "synced" never claims fresher than the
    // oldest figure on screen.
    fetchedAt: stamps.length ? Math.min(...stamps) : Date.now(),
  };
}
const getAgeing = _dedupe('getAgeing', _getAgeingRaw, { timezone: 'UTC', force: false });

module.exports = {
  getAgeing, _buildAgeing, _creditsOf, _bucketOf, _daysBetween, _asOf,
  AGEING_SIDES: Object.keys(SIDES), AGEING_BUCKETS: BUCKETS, CONTACT_LIMIT, INVOICE_LIMIT,
};
