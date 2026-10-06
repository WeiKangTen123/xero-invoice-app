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
