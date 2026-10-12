const logger             = require('../utils/logger');
const { withRetry, isScopeError, xeroErrMsg } = require('./xero-utils');
const { _cacheGet, _cacheSet, _dedupe } = require('./report-cache');
const { _apiFor, _allPages, _getOrganisation } = require('./report-fetch');
const { _getOutstanding, _contactKey } = require('./summary');
const { getBankSummary, _bankAccountList } = require('./bank');
const { _bankByCurrency, _isLive, _isReceiptPayment } = require('./cash-flow');
const { _getCreditNotes, _daysBetween } = require('./ageing');
const { _xeroDay } = require('./performance');
const { _toBase, _foreignCurrency } = require('./currency');
const { _addDays, _fmtISODate, _fmtXeroDate, _lastDayOfMonth, _parseISODate, _todayPartsInTz } = require('./periods');

// The Cash Flow Manager: the bank balance today, then every day of the next
// ninety with what is expected to come in and go out, the way Xero Analytics'
// Cash flow manager lays it out.
//
// Built from what Xero already says and what the person has added here:
//   * the closing balance of each bank account today (the Bank Summary);
//   * the sales invoices and bills still owed, from the Dashboard summary's own
//     fetch (see summary.js#_getOutstanding), each dated by when it is likely
//     to be paid, and with unallocated credit notes netted off;
//   * the invoices and bills approved repeating templates will raise;
//   * payments already recorded in Xero with a date after today;
//   * entries, changes to single items, and bank account options kept in this
//     app's database (utils/cash-manager-store.js), never written to Xero.
//
// The payload itself is not cached, only the Xero reads it is built from, so
// an edit made here shows on the very next load, and the day it is built for
// turns at midnight in the user's timezone. Every Xero call is a GET.

const HORIZON_DAYS = 90;
// Templates change rarely and are read whole, with no paging, in one call.
const REPEATING_TTL_MS = 60 * 60 * 1000;
// Payments dated after today are what someone has just scheduled, so they are
// read again sooner than the templates.
const PAYMENTS_TTL_MS = 10 * 60 * 1000;
// The balance is read over the same window the Dashboard's Overview reads it
// (performance.js: the last 31 days to today). The closing balance does not
// depend on where the window starts, and asking for exactly the window the
// Overview asked for makes this the Overview's cached read rather than a call.
const BALANCE_WINDOW_DAYS = 31;
// A ceiling on any one schedule's occurrences, against a template whose
// period Xero sent as nothing.
const MAX_OCCURRENCES = 400;

// Money is added in whole cents, as in the ageing, so the days, the tiles and
// the running balance agree to the last cent.
const toCents   = v => Math.round(Number(v || 0) * 100);
const fromCents = c => (c === 0 ? 0 : c / 100);
const addDaysISO = (iso, n) => _fmtISODate(_addDays(_parseISODate(iso), n));

// A day in a month that may run past December, held to the month's length:
// the 31st in a 30-day month is its last day, never the 1st of the next.
function _monthDay(year, month, day) {
  const y = year + Math.floor((month - 1) / 12);
  const m = (((month - 1) % 12) + 12) % 12 + 1;
  return _fmtISODate({ year: y, month: m, day: Math.min(Math.max(1, day), _lastDayOfMonth(y, m)) });
}

function _todayBalanceWindow(todayParts) {
  return { from: _fmtISODate(_addDays(todayParts, -BALANCE_WINDOW_DAYS)), to: _fmtISODate(todayParts) };
}

// ── Repeating templates ─────────────────────────────────────────────────────

// Pure. The approved templates, cut down to what the schedule needs, with
// every date as a calendar day.
function _templatesOf(list = []) {
  const out = [];
  for (const r of list || []) {
    if (!r || String(r.status || '').toUpperCase() !== 'AUTHORISED') continue;
    if (r.type !== 'ACCREC' && r.type !== 'ACCPAY') continue;
    const s = r.schedule || {};
    out.push({
      repeatingInvoiceId: r.repeatingInvoiceID || r.iD || null,
      type:         r.type,
      contactId:    r.contact?.contactID || null,
      contactName:  r.contact?.name || '',
      reference:    r.reference || '',
      total:        Number(r.total || 0),
      currencyCode: r.currencyCode ? String(r.currencyCode) : '',
      schedule: {
        period:            Number(s.period) || 1,
        unit:              s.unit ? String(s.unit).toUpperCase() : '',
        dueDate:           Number(s.dueDate) || 0,
        dueDateType:       s.dueDateType ? String(s.dueDateType).toUpperCase() : '',
        startDate:         _xeroDay(s.startDate),
        nextScheduledDate: _xeroDay(s.nextScheduledDate),
        endDate:           _xeroDay(s.endDate),
      },
    });
  }
  return out;
}

// Pure. The dates a template will raise an invoice on, from the next one Xero
// has scheduled up to `untilISO` or the template's own end date. A monthly
// schedule keeps the day of the month it started on: one started on the 31st
// raises on the 30th in a 30-day month and is back on the 31st after it, as
// Xero's own schedule does, rather than drifting to the 28th for good after
// February.
function _repeatingDates(schedule, untilISO, max = MAX_OCCURRENCES) {
  const next  = schedule?.nextScheduledDate;
  const first = _parseISODate(next);
  if (!first) return [];
  const period = Math.max(1, Math.floor(Number(schedule.period) || 1));
  const unit   = String(schedule.unit || '').toUpperCase();
  const end    = schedule.endDate && schedule.endDate < untilISO ? schedule.endDate : untilISO;
  const anchor = (_parseISODate(schedule.startDate) || first).day;
  const out = [];
  for (let k = 0; out.length < max; k++) {
    let d;
    if (unit === 'WEEKLY') d = addDaysISO(next, 7 * period * k);
    else if (unit === 'MONTHLY') d = k === 0 ? next : _monthDay(first.year, first.month + period * k, anchor);
    else break;
    if (d > end) break;
    out.push(d);
  }
  return out;
}

// Pure. When an invoice raised on `dateISO` falls due, by the template's own
// terms. "Days after the invoice month" counts from the month's last day, and
// "of the current / following month" is that day of the month, held to the
// month's length.
function _repeatingDue(dateISO, schedule) {
  const p = _parseISODate(dateISO);
  const n = Math.max(0, Math.floor(Number(schedule?.dueDate) || 0));
  switch (String(schedule?.dueDateType || '').toUpperCase()) {
    case 'DAYSAFTERBILLDATE':
    case 'DAYSAFTERINVOICEDATE':  return addDaysISO(dateISO, n);
    case 'DAYSAFTERBILLMONTH':
    case 'DAYSAFTERINVOICEMONTH': return addDaysISO(_monthDay(p.year, p.month, 31), n);
    case 'OFCURRENTMONTH':        return _monthDay(p.year, p.month, n);
    case 'OFFOLLOWINGMONTH':      return _monthDay(p.year, p.month + 1, n);
    default:                      return dateISO;
  }
}

// ── Payments dated after today ──────────────────────────────────────────────

// Pure. A payment recorded with a future date has already taken the invoice's
// AmountDue down, so the invoice no longer brings that money in; without the
// payment itself on its date, the cash would vanish from the projection.
// Which way it moves money is cash-flow.js#_isReceiptPayment's rule, the one
// every cash figure here uses.
function _futurePaymentsOf(list = []) {
  return (list || []).filter(p => p && _isLive(p)).map(p => ({
    paymentId:    p.paymentID || null,
    status:       p.status ? String(p.status) : '',
    paymentType:  p.paymentType ? String(p.paymentType) : '',
    receipt:      _isReceiptPayment(p),
    date:         _xeroDay(p.date),
    amount:       Number(p.amount || 0),
    // A payment carries a rate but no currency; the invoice it pays names it.
    currencyRate: p.currencyRate ?? null,
    currencyCode: p.invoice?.currencyCode ? String(p.invoice.currencyCode) : '',
    accountId:    p.account?.accountID || null,
    contactName:  p.invoice?.contact?.name || p.creditNote?.contact?.name || '',
    number:       p.invoice?.invoiceNumber || p.creditNote?.creditNoteNumber || '',
    reference:    p.reference || '',
  }));
}

// ── Entries kept here ───────────────────────────────────────────────────────

const STEP_DAYS   = { daily: 1, weekly: 7, fortnightly: 14 };
const STEP_MONTHS = { monthly: 1, yearly: 12 };

// Pure. The days an entry falls on between today and `untilISO`. A repeating
// entry that started before today has already happened on its earlier dates,
// so the bank balance holds them and they are not listed again. A once-off
// dated before today has not been removed, so it is still expected: it is
// kept, and shows as overdue like an invoice past its date.
function _manualDates(entry, todayISO, untilISO, max = MAX_OCCURRENCES) {
  const start = entry?.date;
  const s = _parseISODate(start);
  if (!s) return [];
  const f = entry.frequency || 'once';
  if (f === 'once') return start <= untilISO ? [start] : [];
  const end = entry.endDate && entry.endDate < untilISO ? entry.endDate : untilISO;
  const out = [];
  if (STEP_DAYS[f]) {
    const step = STEP_DAYS[f];
    let k = start < todayISO ? Math.ceil(_daysBetween(start, todayISO) / step) : 0;
    for (; out.length < max; k++) {
      const d = addDaysISO(start, step * k);
      if (d > end) break;
      out.push(d);
    }
  } else if (STEP_MONTHS[f]) {
    const step = STEP_MONTHS[f];
    const t = _parseISODate(todayISO);
    // Straight to the month before today's, rather than walking every month
    // since an entry started years ago.
    let k = Math.max(0, Math.floor(((t.year - s.year) * 12 + (t.month - s.month)) / step) - 1);
    for (; out.length < max; k++) {
      const d = _monthDay(s.year, s.month + step * k, s.day);
      if (d > end) break;
      if (d >= todayISO) out.push(d);
    }
  }
  return out;
}

// ── The projection ──────────────────────────────────────────────────────────

const zero = () => ({ in: 0, out: 0 });
const money = t => ({ in: fromCents(t.in), out: fromCents(t.out), net: fromCents(t.in - t.out) });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Pure. Everything the tab shows, as of `todayISO`.
//
// `outstanding` is summary.js#_outstandingOf's records and `lateness` its
// map of how late each contact pays. `credits` (ageing.js#_creditsOf),
// `bank` (a Bank Summary), `templates` and `payments` are null when they could
// not be read; `repeatingFailure` and `paymentsFailure` say why ('scope' or
// 'error'). `entries`, `overrides` and `bankOptions` are the store's.
//
// How an item is dated, first match wins: a date set here ('override'); the
// expected (sales) or planned (bills) payment date set in Xero ('expected',
// 'planned'); the due date moved by the contact's average days late
// ('predicted'); the due date ('due'). Repeating invoices are 'scheduled',
// future payments 'payment' and entries 'manual'. An item dated before today
// is overdue: it is listed and totalled, and placed on no day, since when it
// will be paid is exactly what is not known. An excluded item stays listed and
// counts nowhere.
function _buildCashManager({
  todayISO, timezone = null, horizonDays = HORIZON_DAYS,
  organisation = {}, baseCurrency = '',
  outstanding = [], lateness = {}, incomplete = false,
  credits = null, bank = null, bankAccounts = [], bankOptions = {},
  templates = null, repeatingFailure = null,
  payments = null, paymentsFailure = null,
  entries = [], overrides = {},
}) {
  const base = baseCurrency || '';
  const horizonEnd = addDaysISO(todayISO, horizonDays - 1);
  const isForeign = d => !!d.currencyCode && !!base && d.currencyCode !== base;
  const items = [];
  const notes = [];

  // ── The bank, today. Base-currency accounts only count (see
  // cash-flow.js#_bankByCurrency): a USD balance added to an SGD one is a
  // number that means nothing. Each account's options are applied by its Xero
  // id, or by its name when the account list could not name it.
  const byCur = bank ? _bankByCurrency(bank, bankAccounts, base) : null;
  const accounts = [];
  const leftOutAccounts = new Set();
  let balanceCents = 0, overdraftCents = 0, included = 0;
  if (byCur) {
    for (const a of [...byCur.accounts, ...byCur.foreignAccounts]) {
      const id  = a.accountId || `name:${a.name}`;
      const opt = bankOptions?.[id] || {};
      const adjustment = opt.openingAdjustmentCents || 0, overdraft = opt.overdraftCents || 0;
      const counts = !a.foreign && opt.included !== false;
      accounts.push({
        accountId: id, name: a.name, currency: a.currency || base, balance: a.closingBalance,
        included: counts, openingAdjustment: fromCents(adjustment), overdraft: fromCents(overdraft), foreign: a.foreign,
      });
      if (counts) {
        balanceCents += toCents(a.closingBalance) + adjustment;
        overdraftCents += overdraft;
        included++;
      } else if (a.accountId) {
        leftOutAccounts.add(a.accountId);
      }
    }
  }

  // ── Invoices and bills still owed.
  let stated = 0, predicted = 0;
  const open = { receivables: { cents: 0, count: 0 }, payables: { cents: 0, count: 0 } };
  for (const inv of outstanding || []) {
    if (!inv || (inv.type !== 'ACCREC' && inv.type !== 'ACCPAY')) continue;
    const amountDue = Number(inv.amountDue || 0);
    if (!(amountDue > 0)) continue;
    const sales   = inv.type === 'ACCREC';
    const dueDate = _xeroDay(inv.dueDate);
    const given   = sales ? inv.expectedPaymentDate : inv.plannedPaymentDate;
    const late    = lateness?.[_contactKey(inv.type, inv.contactId, inv.contactName)];
    let date, dateBasis, daysLate = null;
    if (given) {
      date = given; dateBasis = sales ? 'expected' : 'planned'; stated++;
    } else if (dueDate && late) {
      daysLate = late.days; date = addDaysISO(dueDate, late.days); dateBasis = 'predicted'; predicted++;
    } else {
      // Xero will not approve an invoice without a due date; one that came
      // back without it is placed on its own date, or today, not dropped.
      date = dueDate || _xeroDay(inv.date) || todayISO; dateBasis = 'due';
    }
    const cents = toCents(_toBase(inv, amountDue, base));
    const side  = open[sales ? 'receivables' : 'payables'];
    side.cents += cents; side.count++;
    items.push({
      key: `invoice:${inv.invoiceId}`, direction: sales ? 'in' : 'out', source: sales ? 'invoice' : 'bill',
      date, dueDate, dateBasis, cents, originalCents: cents,
      currency: inv.currencyCode || base, faceAmount: amountDue, foreign: isForeign(inv),
      contactId: inv.contactId || null, contactName: inv.contactName || '', number: inv.number || '', reference: inv.reference || '',
      entryId: null, daysLate,
    });
  }

  // ── What approved repeating templates will raise. A template in another
  // currency carries no exchange rate until Xero raises the invoice, so it is
  // named in the notes and left out rather than counted at face value.
  const foreignTemplates = [];
  let templateCount = 0, unscheduled = 0;
  for (const t of templates || []) {
    const total = Number(t.total || 0);
    if (!(total > 0) || (t.type !== 'ACCREC' && t.type !== 'ACCPAY')) continue;
    if (isForeign(t)) { foreignTemplates.push(t); continue; }
    if (!['WEEKLY', 'MONTHLY'].includes(t.schedule?.unit) || !t.schedule?.nextScheduledDate) { unscheduled++; continue; }
    templateCount++;
    for (const d of _repeatingDates(t.schedule, horizonEnd)) {
      const due = _repeatingDue(d, t.schedule);
      items.push({
        key: `repeating:${t.repeatingInvoiceId}:${d}`, direction: t.type === 'ACCREC' ? 'in' : 'out', source: 'repeating',
        date: due, dueDate: due, invoiceDate: d, dateBasis: 'scheduled', cents: toCents(total), originalCents: toCents(total),
        currency: base, faceAmount: total, foreign: false,
        contactId: t.contactId, contactName: t.contactName, number: '', reference: t.reference, entryId: null,
      });
    }
  }

  // ── Payments dated after today. One into an account the opening balance
  // leaves out (another currency, or switched off here) would move money the
  // projection does not hold, so it is left out with it.
  let paymentCount = 0, paymentsLeftOut = 0;
  for (const p of payments || []) {
    if (!p.date || !_isLive(p)) continue;
    if (p.accountId && leftOutAccounts.has(p.accountId)) { paymentsLeftOut++; continue; }
    const cents = Math.abs(toCents(_toBase(p, p.amount, base)));
    if (!cents) continue;
    paymentCount++;
    items.push({
      key: `payment:${p.paymentId}`, direction: p.receipt ? 'in' : 'out', source: 'payment',
      date: p.date, dueDate: null, dateBasis: 'payment', cents, originalCents: cents,
      currency: p.currencyCode || base, faceAmount: p.amount, foreign: isForeign(p),
      contactId: null, contactName: p.contactName, number: p.number, reference: p.reference, entryId: null,
    });
  }

  // ── Entries made here, always in base currency.
  for (const e of entries || []) {
    for (const d of _manualDates(e, todayISO, horizonEnd)) {
      items.push({
        key: `manual:${e.id}:${d}`, direction: e.direction === 'in' ? 'in' : 'out', source: 'manual',
        date: d, dueDate: null, dateBasis: 'manual', cents: e.amountCents, originalCents: e.amountCents,
        currency: base, faceAmount: fromCents(e.amountCents), foreign: false,
        contactId: null, contactName: '', number: '', reference: e.description, description: e.description, entryId: e.id,
      });
    }
  }

  // ── Changes made here to single items. The date is applied before the
  // credit notes are netted, since they go against the earliest items.
  for (const it of items) {
    it.originalDate = it.date;
    it.overridden = false; it.excluded = false; it.amountOverridden = false; it.creditCents = 0;
    const ov = overrides?.[it.key];
    if (!ov) continue;
    if (ov.date) { it.date = ov.date; it.dateBasis = 'override'; it.overridden = true; }
    if (ov.amountCents !== null && ov.amountCents !== undefined) { it.cents = ov.amountCents; it.amountOverridden = true; it.overridden = true; }
    if (ov.excluded) { it.excluded = true; it.overridden = true; }
  }

  // ── Unallocated credit notes, netted against the same contact's earliest
  // invoices (or bills) still owed, oldest note first. A credit is never put
  // on a day of its own: it is money that will not be paid, not money that
  // arrives. One left over once the contact's items are used up is said, and
  // counts nowhere. An excluded item, or one whose amount was set here, takes
  // none: the first counts nowhere, and the second already says what will be
  // paid.
  let creditCount = 0, creditApplied = 0, creditLeft = 0, creditLeftCount = 0;
  const contactOf = x => x.contactId || `name:${x.contactName}`;
  const sortedCredits = [...(credits || [])].sort((a, b) =>
    (_xeroDay(a.date) || '').localeCompare(_xeroDay(b.date) || '') || String(a.number).localeCompare(String(b.number)));
  for (const cn of sortedCredits) {
    const source = cn.type === 'ACCRECCREDIT' ? 'invoice' : cn.type === 'ACCPAYCREDIT' ? 'bill' : null;
    let left = source ? toCents(_toBase(cn, Number(cn.remainingCredit || 0), base)) : 0;
    if (!(left > 0)) continue;
    creditCount++;
    const who = contactOf(cn);
    const targets = items
      .filter(i => i.source === source && contactOf(i) === who && !i.excluded && !i.amountOverridden && i.cents > 0)
      .sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
    for (const t of targets) {
      const take = Math.min(left, t.cents);
      t.cents -= take; t.creditCents += take; creditApplied += take; left -= take;
      if (!left) break;
    }
    if (left > 0) { creditLeft += left; creditLeftCount++; }
  }

  // ── Days, tiles and the running balance.
  const days  = Array.from({ length: horizonDays }, (_, i) => ({ date: addDaysISO(todayISO, i), ...zero() }));
  const tiles = { today: zero(), next7: zero(), next8to30: zero(), overdue: zero() };
  const shown = [];
  let beyond = 0;
  for (const it of items) {
    it.overdue = it.date < todayISO;
    it.beyondHorizon = it.date > horizonEnd;
    if (it.beyondHorizon) {
      // Kept on the list only when a change made here sent it there, so the
      // change can be found and undone.
      if (it.overridden) shown.push(it); else beyond++;
      continue;
    }
    shown.push(it);
    if (it.excluded) continue;
    const dir = it.direction;
    if (it.overdue) { tiles.overdue[dir] += it.cents; continue; }
    const i = _daysBetween(todayISO, it.date);
    days[i][dir] += it.cents;
    if (i === 0) tiles.today[dir] += it.cents;
    else if (i <= 7) tiles.next7[dir] += it.cents;
    else if (i <= 30) tiles.next8to30[dir] += it.cents;
  }

  let running = balanceCents, runwayDays = null;
  const series = days.map((d, i) => {
    running += d.in - d.out;
    if (runwayDays === null && running < -overdraftCents) runwayDays = i;
    return { date: d.date, in: fromCents(d.in), out: fromCents(d.out), net: fromCents(d.in - d.out), balance: fromCents(running) };
  });
  // From a balance that could not be read, the first day "below the
  // overdraft" is an artefact of starting at nothing, not a warning.
  if (!byCur) runwayDays = null;

  const order = { in: 0, out: 1 };
  shown.sort((a, b) => a.date.localeCompare(b.date) || order[a.direction] - order[b.direction]
    || a.contactName.localeCompare(b.contactName) || a.key.localeCompare(b.key));

  // ── What the figures are, and what they leave out, plainly.
  const tzText = timezone ? ` (${timezone})` : '';
  notes.push(`Cash in is approved sales invoices with an amount still due, cash out approved bills; a part-paid one counts `
    + `only what is still due. Each is dated by, first match wins: a date set here, the expected (sales) or planned (bills) `
    + `payment date in Xero, the due date moved by how late that contact has paid on average over the last year (from at `
    + `least two paid invoices, 0 to 60 days), or the due date.`);
  if (open.receivables.count + open.payables.count > 0 && stated === 0) {
    notes.push('No open invoice or bill carried an expected or planned payment date from Xero (Xero may leave them out '
      + 'of a list read), so none is dated that way.');
  }
  if (predicted) notes.push(`${plural(predicted, 'invoice or bill is', 'invoices and bills are')} dated by the contact's payment history.`);
  notes.push(`Anything dated before today, ${todayISO}${tzText}, is overdue: it is totalled on its own and placed on no day, `
    + 'since when it will be paid is not known. Set a date on it to place it.');
  if (credits === null) {
    notes.push('Credit notes could not be read from Xero just now, so none are netted off; what is owed may be less.');
  } else if (creditCount) {
    notes.push(`${plural(creditCount, 'unallocated credit note is', 'unallocated credit notes are')} netted against the `
      + `same contact's earliest items, ${fromCents(creditApplied).toFixed(2)} in all.`
      + (creditLeft ? ` ${fromCents(creditLeft).toFixed(2)} of credit on ${plural(creditLeftCount, 'note', 'notes')} has no `
        + 'open item of its contact to go against and is left out.' : ''));
  }
  notes.push('Unallocated overpayments and prepayments are not used: that money is already in the bank, so it is in '
    + 'the opening balance.');
  if (templates === null) {
    notes.push(repeatingFailure === 'scope'
      ? 'Repeating invoices could not be read: the Xero connection does not allow it. Reconnect in Setup to include them.'
      : 'Repeating invoices could not be read from Xero just now, so none are included.');
  } else if (templateCount) {
    notes.push(`${plural(templateCount, 'approved repeating template adds', 'approved repeating templates add')} the `
      + 'invoices and bills it will raise, each on its due date by the template\'s terms.');
  }
  if (foreignTemplates.length) {
    notes.push(`Repeating ${foreignTemplates.map(t => `${t.contactName || 'template'} (${t.currencyCode})`).join(', ')} `
      + `${foreignTemplates.length === 1 ? 'is' : 'are'} left out: a template in another currency has no exchange rate `
      + `until Xero raises the invoice.`);
  }
  if (unscheduled) notes.push(`${plural(unscheduled, 'repeating template has', 'repeating templates have')} no schedule this can read and ${unscheduled === 1 ? 'is' : 'are'} left out.`);
  if (payments === null) {
    notes.push(paymentsFailure === 'scope'
      ? 'Payments dated after today could not be read: the Xero connection does not allow it. Reconnect in Setup to include them.'
      : 'Payments dated after today could not be read from Xero just now; an invoice paid with a future date may be missing.');
  } else if (paymentCount) {
    notes.push(`${plural(paymentCount, 'payment', 'payments')} recorded in Xero with a date after today ${paymentCount === 1 ? 'is' : 'are'} on that date.`);
  }
  if (paymentsLeftOut) notes.push(`${plural(paymentsLeftOut, 'future payment goes', 'future payments go')} through a bank account left out of the balance, so ${paymentsLeftOut === 1 ? 'it is' : 'they are'} left out too.`);
  if (!byCur) {
    notes.push('Bank balances could not be read from Xero just now, so the projection starts from zero and no runway is given.');
  } else {
    notes.push(`The opening balance is today's closing balance of ${plural(included, 'bank account', 'bank accounts')} `
      + `from Xero's Bank Summary, with any adjustment set here.`);
    if (byCur.foreignAccounts.length) {
      notes.push(`${byCur.foreignAccounts.map(a => `${a.name} (${a.currency})`).join(', ')} ${byCur.foreignAccounts.length === 1 ? 'is' : 'are'} `
        + `in another currency, listed in ${byCur.foreignAccounts.length === 1 ? 'its' : 'their'} own and left out of the balance.`);
    }
  }
  if (beyond) notes.push(`${plural(beyond, 'item falls', 'items fall')} after ${horizonEnd}, beyond the ${horizonDays} days shown.`);
  const currency = _foreignCurrency((outstanding || []).filter(i => Number(i?.amountDue) > 0), base);
  if (currency.mixed) {
    notes.push(`Amounts in ${currency.currencies.join(', ')} are converted to ${base || 'base currency'} at the rate Xero `
      + 'stamped on each document.' + (currency.unconvertible
      ? ` ${currency.unconvertible} had no rate and ${currency.unconvertible === 1 ? 'is' : 'are'} counted at face value.` : ''));
  }
  if (incomplete) {
    notes.push('Xero returned the most invoices this dashboard reads in one go, newest first, so the oldest unpaid ones '
      + 'may be missing.');
  }

  return {
    organisation: { name: organisation.name || organisation.legalName || 'Organisation', currency: base },
    today: todayISO,
    timezone,
    horizonDays,
    horizonEnd,
    bank: { available: !!byCur, accounts, balance: fromCents(balanceCents), overdraft: fromCents(overdraftCents) },
    tiles: {
      bankBalance: fromCents(balanceCents),
      today: money(tiles.today), next7: money(tiles.next7), next8to30: money(tiles.next8to30), overdue: money(tiles.overdue),
    },
    runwayDays,
    series,
    items: shown.map(it => ({
      key: it.key, direction: it.direction, source: it.source,
      date: it.date, dueDate: it.dueDate || null, dateBasis: it.dateBasis,
      amount: fromCents(it.cents), originalAmount: fromCents(it.originalCents),
      currency: it.currency, contactName: it.contactName, number: it.number, reference: it.reference,
      overdue: it.overdue, excluded: it.excluded, overridden: it.overridden, entryId: it.entryId || null,
      originalDate: it.originalDate, faceAmount: it.faceAmount, foreign: !!it.foreign,
      creditApplied: fromCents(it.creditCents), daysLate: it.daysLate ?? null,
      invoiceDate: it.invoiceDate || null, description: it.description || null, beyondHorizon: it.beyondHorizon,
    })),
    // Every open invoice and bill before credit notes and changes made here,
    // past the horizon too: what the check sets against the ageing.
    open: {
      receivables: { amount: fromCents(open.receivables.cents), count: open.receivables.count },
      payables:    { amount: fromCents(open.payables.cents),    count: open.payables.count },
    },
    notes,
  };
}

// ── Fetching ────────────────────────────────────────────────────────────────

// Every approved template in one call: the endpoint is not paged, and the
// list is short. Cached for an hour, keyed so a disconnect or a change in Xero
// (report-cache.js#clearTenant) drops it with everything else.
async function _getRepeatingRaw(userId, tenantId, { force = false } = {}) {
  const key    = `repeating:${userId}:${tenantId}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;
  const tokenCache = require('../utils/token-cache').forUser(userId);
  const api = _apiFor(await tokenCache.getValidToken(tenantId));
  const res = await withRetry(() => api.getRepeatingInvoices(tenantId, 'Status=="AUTHORISED"'));
  const templates = _templatesOf(res?.body?.repeatingInvoices || []);
  logger.info('Repeating invoices fetched', { userId, tenantId, templates: templates.length });
  return _cacheSet(key, { templates }, REPEATING_TTL_MS);
}
const _getRepeatingInvoices = _dedupe('_getRepeatingInvoices', _getRepeatingRaw, { force: false });

// Approved payments dated after today, paged like every list (normally one
// page). Keyed by the day, since "after today" is a different question
// tomorrow.
async function _getFuturePaymentsRaw(userId, tenantId, { todayISO, force = false } = {}) {
  const key    = `futurepay:${userId}:${tenantId}:${todayISO}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;
  const tokenCache = require('../utils/token-cache').forUser(userId);
  const api   = _apiFor(await tokenCache.getValidToken(tenantId));
  const where = `Date > ${_fmtXeroDate(_parseISODate(todayISO))} && Status=="AUTHORISED"`;
  const list  = await _allPages(page => api.getPayments(tenantId, undefined, where, 'Date ASC', page),
    'payments', { what: 'Payment', tenantId });
  return _cacheSet(key, { payments: _futurePaymentsOf(list) }, PAYMENTS_TTL_MS);
}
const _getFuturePayments = _dedupe('_getFuturePayments', _getFuturePaymentsRaw, { force: false });

// A part that could not be read costs what it adds, not the projection: the
// notes say what is missing. The open invoices and the organisation are the
// projection itself, so a failure there is the report's failure.
function _soft(what, promise, ctx) {
  return promise.then(value => ({ value }), error => {
    logger.warn(`Cash manager: ${what} unavailable`, { ...ctx, error: xeroErrMsg(error) });
    return { error, failure: isScopeError(error) ? 'scope' : 'error' };
  });
}

async function _getCashManagerRaw(userId, tenantId, { timezone = 'UTC', force = false } = {}) {
  const todayParts = _todayPartsInTz(timezone);
  const todayISO   = _fmtISODate(todayParts);
  const ctx = { userId, tenantId };
  const [outstanding, org, credits, bank, bankAccounts, repeating, payments] = await Promise.all([
    _getOutstanding(userId, tenantId, { force }),
    _getOrganisation(userId, tenantId, force),
    _soft('credit notes', _getCreditNotes(userId, tenantId, { force }), ctx),
    _soft('bank summary', getBankSummary(userId, tenantId, { ..._todayBalanceWindow(todayParts), force }), ctx),
    _bankAccountList(userId, tenantId, force),
    _soft('repeating invoices', _getRepeatingInvoices(userId, tenantId, { force }), ctx),
    _soft('future payments', _getFuturePayments(userId, tenantId, { todayISO, force }), ctx),
  ]);

  // Required here: the store opens the database, which no other report needs.
  const store = require('../utils/cash-manager-store').forTenant(userId, tenantId);
  const data = _buildCashManager({
    todayISO, timezone,
    organisation: org, baseCurrency: outstanding.baseCurrency || org?.baseCurrency || '',
    outstanding: outstanding.invoices, lateness: outstanding.lateness || {}, incomplete: outstanding.capped,
    credits: credits.value ? credits.value.creditNotes : null,
    bank: bank.value || null, bankAccounts, bankOptions: store.bankOptions(),
    templates: repeating.value ? repeating.value.templates : null, repeatingFailure: repeating.failure || null,
    payments: payments.value ? payments.value.payments : null, paymentsFailure: payments.failure || null,
    entries: store.listEntries(), overrides: store.overrides(),
  });

  const reads  = [outstanding, credits.value, bank.value, repeating.value, payments.value].filter(Boolean);
  const stamps = reads.map(r => r.fetchedAt).filter(Number.isFinite);
  return {
    ...data,
    // True when nothing in this request went to Xero.
    cached: reads.every(r => r.cached !== false),
    // The oldest read, so "synced" never claims fresher than the oldest
    // figure on screen.
    fetchedAt: stamps.length ? Math.min(...stamps) : Date.now(),
  };
}
const getCashManager = _dedupe('getCashManager', _getCashManagerRaw, { timezone: 'UTC', force: false });

module.exports = {
  getCashManager, _buildCashManager, _templatesOf, _repeatingDates, _repeatingDue, _futurePaymentsOf, _manualDates,
  _todayBalanceWindow, _monthDay,
  HORIZON_DAYS, REPEATING_TTL_MS, PAYMENTS_TTL_MS, BALANCE_WINDOW_DAYS,
};
