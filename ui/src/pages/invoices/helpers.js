import { fmtMoney } from '../../utils/format';

// The three kinds of document this page holds, in the order they are shown.
//
// One array drives the tab strip, the count on each tab, which rows the list
// shows, and the empty state — so a count can never disagree with what is under
// it. Adding a fourth kind means adding one entry here and nothing else.
//
// invoiceType already stores exactly these three values, so this is a view over
// data that was always shaped this way; nothing was migrated to make it work.
// Xero's own vocabulary, which is also what this page used before the tabs were
// added: an invoice goes to a customer (ACCREC creates isCustomer), a bill comes
// from a supplier (ACCPAY creates isSupplier). Matching Xero's menu — Invoices
// and Bills to pay — means the label here and the label in the system it posts
// to are the same word.
//
// Expense claims post as ACCPAY bills too; the tab is separate because of how
// the document arrives, photographed by an employee rather than emailed by a
// supplier, not because Xero files it differently.
//
// `label` is the phone version. Invoices and Bills are short enough to keep
// their real names there; only Expense Claims needs shortening.
export const TABS = [
  { key: 'ar',     label: 'Invoices', long: 'Invoices',       match: i => i.invoiceType === 'ACCREC'  },
  { key: 'ap',     label: 'Bills',    long: 'Bills',          match: i => i.invoiceType === 'ACCPAY'  },
  { key: 'claims', label: 'Claims',   long: 'Expense Claims', match: i => i.invoiceType === 'EXPENSE' },
];
// Bills are the volume in an email-ingesting system; AR is usually near empty,
// and opening on an empty tab reads as a broken page.
export const DEFAULT_TAB = 'ap';
export const tabByKey = key => TABS.find(t => t.key === key) || TABS.find(t => t.key === DEFAULT_TAB);

// "Received" is when the document entered THIS system — the moment an email was
// parsed or a receipt was photographed. Distinct from the date printed on the
// document, which is what the Invoice date column shows. They answer different
// questions, and a bookkeeping cutoff needs this one.
//
// Recent times read as an interval because "2 min ago" is easier to place than a
// timestamp; anything older reads as a date, because "19 days ago" is not.
export function receivedLabel(iso) {
  if (!iso) return '—';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '—';
  const mins = Math.floor((Date.now() - then.getTime()) / 60000);
  if (mins < 1)    return 'just now';
  if (mins < 60)   return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)    return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7)    return `${days} day${days === 1 ? '' : 's'} ago`;
  return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: then.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

// One figure per currency present, because adding SGD to USD is not a total.
// Rows with no amount are skipped; a blank currency sorts last.
export function currencyTotals(rows) {
  const by = new Map();
  for (const r of rows) {
    if (r.totalAmount == null) continue;
    const c = r.currency || '';
    by.set(c, (by.get(c) || 0) + (Number(r.totalAmount) || 0));
  }
  return [...by.entries()]
    .filter(([, amount]) => amount)
    .sort(([a], [b]) => (a === '') - (b === '') || a.localeCompare(b))
    .map(([currency, amount]) => ({ currency, amount }));
}
export const totalsLabel = totals => totals.map(t => fmtMoney(t.amount, t.currency)).join(' · ');

// Inclusive lower bound for a preset, or null for "all time".
export function receivedCutoff(preset) {
  const now = new Date();
  switch (preset) {
    case 'today': { const d = new Date(now); d.setHours(0, 0, 0, 0); return d; }
    case '7d':    return new Date(now.getTime() - 7  * 86400000);
    case '30d':   return new Date(now.getTime() - 30 * 86400000);
    case 'month': return new Date(now.getFullYear(), now.getMonth(), 1);
    default:      return null;
  }
}


// Buckets for the grouped list. Named days for recent arrivals, calendar months
// for history — that is how you would describe them out loud. Deliberately NOT
// "last 7 / 30 days": those already exist as filters directly above, and
// repeating them as group headings would be two controls answering one question.
export function receivedBucket(iso, now = new Date()) {
  if (!iso) return { key: 'undated', label: 'Undated', rank: 9e9 };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { key: 'undated', label: 'Undated', rank: 9e9 };

  const startOfDay = x => { const c = new Date(x); c.setHours(0, 0, 0, 0); return c; };
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);

  if (days <= 0) return { key: 'today',     label: 'Today',              rank: 0 };
  if (days === 1) return { key: 'yesterday', label: 'Yesterday',          rank: 1 };
  if (days < 7)  return { key: 'thisweek',  label: 'Earlier this week',  rank: 2 };

  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return {
    key,
    label: d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
    // Newest month first, always after the named-day buckets.
    rank: 10 + (9999 - d.getFullYear()) * 12 + (11 - d.getMonth()),
  };
}

// A batch scanned long after it arrived is the case this whole column exists for
// — turning on the watcher backfills months of mail in one sweep. Saying so on
// the group header explains an otherwise confusing "August · scanned today".
export function scannedNote(rows) {
  const late = rows.filter(r => {
    if (!r.receivedAt || !r.processedAt) return false;
    return (new Date(r.processedAt) - new Date(r.receivedAt)) > 36 * 3600000; // more than a day and a half
  });
  if (!late.length) return null;
  const when = new Date(Math.max(...late.map(r => new Date(r.processedAt))));
  const days = Math.round((Date.now() - when) / 86400000);
  const word = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  return `${late.length} scanned ${word}`;
}
