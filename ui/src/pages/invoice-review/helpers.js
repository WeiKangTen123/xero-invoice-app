// Statuses that allow the user to trigger a Xero submission.
// 'posted' is included so a correction can be re-posted — this updates the existing
// Xero bill in place rather than creating a duplicate (see backend submitDraftInvoice).
export const SUBMITTABLE = new Set(['pending', 'review-needed', 'error', 'reviewed', 'posted']);
// Statuses that allow the user to mark as reviewed (i.e. not yet finalised)
export const MARKABLE    = new Set(['pending', 'review-needed', 'error', 'reported']);

// ── Main page ─────────────────────────────────────────────────────────────────
// Back to the list, on the tab this document belongs to. Returning to a bare
// /invoices dropped you on the default tab, so reviewing an expense claim and
// pressing Back showed you payables instead of where you had been.
export function listPathFor(inv) {
  const tab = inv?.invoiceType === 'ACCREC' ? 'ar'
            : inv?.invoiceType === 'EXPENSE' ? 'claims'
            : 'ap';
  return tab === 'ap' ? '/invoices' : `/invoices?tab=${tab}`;
}

// Send problems this page answers with something other than "fix the fields
// and try again", recognised by the server's own wording (main/queue/
// processor.js, and the boot-time release of sends a restart cut off). Matched
// on the phrase that carries the meaning, so a reworded tail still lands here.
//
// 'choose' and 'gone' are fixed in Setup, not in this record, so their banner
// links there. An interrupted send may already be in Xero, so its banner says
// to look there before sending again.
export function sendProblem(msg) {
  if (!msg) return null;
  if (/choose a default xero company/i.test(msg)) return 'choose';
  if (/xero company this was sent to is no longer connected/i.test(msg)) return 'gone';
  if (/interrupted/i.test(msg)) return 'interrupted';
  return null;
}

// ── Supplier memory ───────────────────────────────────────────────────────────
// A field filled from the contact's last settled bill or invoice carries where
// it came from (record.prefilledFrom, written by main/utils/supplier-memory.js)
// and the page says so beside it, so a person checks a remembered value rather
// than taking it for something read off this document.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "3 Sep", or "3 Sep 2025" outside this year. An invoice date is a calendar
// date as printed, so it is read as written rather than through a timezone,
// which could move it a day.
export function shortDate(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const [, y, mo, d] = m;
  const month = MONTHS[Number(mo) - 1];
  if (!month) return '';
  return `${Number(d)} ${month}${Number(y) === new Date().getFullYear() ? '' : ` ${y}`}`;
}

// "from last bill (INV-123, 3 Sep)"; a sales invoice's says "last invoice".
export function prefillText(from, invoiceType) {
  const what = invoiceType === 'ACCREC' ? 'last invoice' : 'last bill';
  const detail = [from?.fromNumber, shortDate(from?.fromDate)].filter(Boolean).join(', ');
  return `from ${what}${detail ? ` (${detail})` : ''}`;
}
