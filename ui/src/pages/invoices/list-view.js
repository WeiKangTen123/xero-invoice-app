// Due dates, what is overdue, and the order the list is shown in.
//
// Imports nothing, so main/scripts/invoice-list-view.test.js can run it as it
// is (there is no React test setup in this project).

// ── Calendar days ────────────────────────────────────────────────────────────
// A due date is a day on the calendar, not an instant, so it is compared as
// one: YYYY-MM-DD turned into a whole day number. Going through Date with a
// time of day would let the device's timezone move it across midnight.

const pad2 = n => String(n).padStart(2, '0');

// Today's date, YYYY-MM-DD, where the person is. The account's timezone (as
// formatDateTime uses) decides when a bill turns overdue, not the server's
// clock and not UTC: in Singapore a bill due on the 8th is overdue from
// midnight on the 9th, Singapore time. An unknown zone falls back to the
// device's own day.
export function todayIn(timeZone, now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
    const part = type => (parts.find(p => p.type === type) || {}).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  } catch {
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  }
}

// Whole days since 1970 for a YYYY-MM-DD date (anything after the day, such
// as a time, is ignored), or null for something that is not a real date.
export function dayNumber(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  // 2026-02-30 would quietly become 2 March; it is a misread, not a date.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.round(ms / 86400000);
}

// ── Overdue ─────────────────────────────────────────────────────────────────

// Nothing is owed once Xero says it was paid, voided or deleted. Any other
// Xero status (draft, awaiting approval, approved, part-paid) still is, and so
// is a record not in Xero yet: the money has not moved because it was not sent.
const SETTLED = new Set(['PAID', 'VOIDED', 'DELETED']);

// Expense claims have no due date: they are paid back to the employee, not by
// a supplier's terms.
export const hasDueDate = inv => !!inv && inv.invoiceType !== 'EXPENSE';

export function isUnpaid(inv) {
  return !!inv && !SETTLED.has(inv.xeroStatus);
}

// How many days past due an unpaid bill or invoice is, or 0 when it is not
// overdue (due today or later, paid, no due date, or an expense claim). A
// record marked a duplicate is not counted: the bill it copies is the one
// that is owed, and counting both would show the same debt twice.
export function overdueDays(inv, today) {
  if (!hasDueDate(inv) || !isUnpaid(inv) || inv.status === 'duplicate') return 0;
  const due = dayNumber(inv.dueDate);
  const now = dayNumber(today);
  if (due === null || now === null) return 0;
  return Math.max(0, now - due);
}

// What the Due column shows, or null for an expense claim, which shows
// nothing. { date, label, overdue }: label is the date itself, "Due today",
// or "Overdue 12 days" (shown in red).
export function dueInfo(inv, today) {
  if (!hasDueDate(inv)) return null;
  const date = dayNumber(inv.dueDate) === null ? null : String(inv.dueDate).slice(0, 10);
  if (!date) return { date: null, label: '—', overdue: false };
  const days = overdueDays(inv, today);
  if (days > 0) return { date, label: `Overdue ${days} day${days === 1 ? '' : 's'}`, overdue: true };
  if (date === today && isUnpaid(inv) && inv.status !== 'duplicate') return { date, label: 'Due today', overdue: false };
  return { date, label: date, overdue: false };
}

// ── Sorting ─────────────────────────────────────────────────────────────────
// The list is grouped by when things arrived unless a sort is chosen; then it
// is one list in that order. Each sort has the direction it starts in (the
// one that answers the usual question: what is due first, what is largest)
// and words for both directions.

// What needs a person comes first, what is done comes last.
const STATUS_ORDER = ['review-needed', 'error', 'duplicate', 'reported', 'pending', 'reviewed', 'submitting', 'posted'];

const _text = v => {
  const s = String(v == null ? '' : v).trim();
  return s ? s : null;
};
const _num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export const SORT_FIELDS = {
  date:    { label: 'Date',              start: 'desc', asc: 'oldest first',        desc: 'newest first',  value: inv => dayNumber(inv.invoiceDate) },
  due:     { label: 'Due',               start: 'asc',  asc: 'earliest first',      desc: 'latest first',  value: inv => (hasDueDate(inv) ? dayNumber(inv.dueDate) : null) },
  contact: { label: 'Supplier/Customer', start: 'asc',  asc: 'A to Z',              desc: 'Z to A',        value: inv => _text(inv.vendorName) },
  // Raw figures across currencies: a sort, not a total, so 100 USD sits next
  // to 100 SGD rather than being converted.
  amount:  { label: 'Amount',            start: 'desc', asc: 'smallest first',      desc: 'largest first', value: inv => _num(inv.totalAmount) },
  status:  { label: 'Status',            start: 'asc',  asc: 'needs action first',  desc: 'posted first',
             value: inv => { const i = STATUS_ORDER.indexOf(inv.status); return i === -1 ? null : i; } },
};

// The URL form is "due-asc"; anything else reads as no sort, so a stale or
// hand-edited link shows the plain list rather than failing.
export function parseSort(param) {
  const m = /^([a-z]+)-(asc|desc)$/.exec(String(param || ''));
  return m && SORT_FIELDS[m[1]] ? { key: m[1], dir: m[2] } : null;
}
export const formatSort = sort => (sort ? `${sort.key}-${sort.dir}` : '');

// Clicking a column: first its usual direction, then the other way, then back
// to the list grouped by arrival.
export function nextSort(current, key) {
  if (!SORT_FIELDS[key]) return current || null;
  const start = SORT_FIELDS[key].start;
  if (!current || current.key !== key) return { key, dir: start };
  if (current.dir === start) return { key, dir: start === 'asc' ? 'desc' : 'asc' };
  return null;
}

// "Due, earliest first".
export function sortLabel(sort) {
  const f = sort && SORT_FIELDS[sort.key];
  return f ? `${f.label}, ${f[sort.dir]}` : '';
}

const _collator = typeof Intl !== 'undefined' ? new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }) : null;
function _compare(a, b) {
  if (typeof a === 'string' || typeof b === 'string') {
    return _collator ? _collator.compare(String(a), String(b)) : String(a).localeCompare(String(b));
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

// A new array in the chosen order. Rows with nothing to sort by (no due date,
// no amount) go last whichever way round, since "unknown" is neither the
// earliest nor the latest. Rows that tie keep the order they came in, which
// is newest first from the server, so the result never shuffles between two
// renders.
export function sortRows(rows, sort) {
  const f = sort && SORT_FIELDS[sort.key];
  if (!f) return rows.slice();
  const flip = sort.dir === 'desc' ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index, value: f.value(row) }))
    .sort((a, b) => {
      const an = a.value === null || a.value === undefined;
      const bn = b.value === null || b.value === undefined;
      if (an !== bn) return an ? 1 : -1;
      const c = an ? 0 : _compare(a.value, b.value) * flip;
      return c || a.index - b.index;
    })
    .map(x => x.row);
}
