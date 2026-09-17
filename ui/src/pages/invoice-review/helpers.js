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
