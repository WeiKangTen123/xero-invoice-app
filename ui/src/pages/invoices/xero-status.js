// What Xero says about a posted record, in this app's words, and whether a
// correction can still be sent from here.
//
// The server reads the status back from Xero every three hours and on
// "Refresh from Xero" (main/xero/status-sync.js), and every row carries it as
// xeroStatus, xeroAmountDue, xeroAmountPaid, xeroPaidOn and xeroSyncedAt. All
// null until the first check, and a record with no status shows nothing: an
// unknown status is not a draft.
//
// Imports nothing, so main/scripts/xero-status-ui.test.js can run it as it is.

// One entry per thing a person can see. PART_PAID is not a Xero status: Xero
// calls a part-paid bill AUTHORISED, and the difference between "approved,
// nothing paid" and "approved, half paid" is the one a bookkeeper asks about.
export const XERO_STATUS_META = {
  DRAFT:      { label: 'Draft in Xero',     cls: 'badge-gray',   tip: 'Still a draft in Xero.' },
  SUBMITTED:  { label: 'Awaiting approval', cls: 'badge-yellow', tip: 'Submitted for approval in Xero.' },
  AUTHORISED: { label: 'Approved',          cls: 'badge-blue',   tip: 'Approved in Xero and not yet paid.' },
  PART_PAID:  { label: 'Part-paid',         cls: 'badge-purple', tip: 'Approved in Xero and partly paid.' },
  PAID:       { label: 'Paid',              cls: 'badge-green',  tip: 'Paid in full in Xero.' },
  VOIDED:     { label: 'Voided',            cls: 'badge-red',    tip: 'Voided in Xero.' },
  DELETED:    { label: 'Deleted in Xero',   cls: 'badge-red',    tip: 'Deleted in Xero.' },
};

// Approved with money already against it. A bill paid in full is PAID, so
// anything paid on an AUTHORISED one is a part payment.
export function isPartPaid(inv) {
  return !!inv && inv.xeroStatus === 'AUTHORISED' && Number(inv.xeroAmountPaid) > 0;
}

// Which XERO_STATUS_META entry a record shows, or null for none: not in Xero,
// or not checked yet.
export function xeroStatusKey(inv) {
  if (!inv || !inv.xeroInvoiceId || !inv.xeroStatus || !XERO_STATUS_META[inv.xeroStatus]) return null;
  return isPartPaid(inv) ? 'PART_PAID' : inv.xeroStatus;
}

// Why a correction can no longer be sent from here, or null while it can.
// Re-posting updates the Xero bill in place, which Xero refuses once the bill
// has left DRAFT, and sending a submitted one back as a draft would pull it
// out of whoever is approving it. A status not read yet keeps the button as it
// always was. The server applies the same rule to the submit route
// (status-sync.js repostRefusal), so the two must say the same thing.
const LOCKED_BECAUSE = {
  SUBMITTED:  'Awaiting approval in Xero',
  AUTHORISED: 'Approved in Xero',
  PART_PAID:  'Part-paid in Xero',
  PAID:       'Paid in Xero',
  VOIDED:     'Voided in Xero',
  DELETED:    'Deleted in Xero',
};
export function repostBlockedReason(inv) {
  const key = xeroStatusKey(inv);
  if (!key || key === 'DRAFT') return null;
  return LOCKED_BECAUSE[key] ? `${LOCKED_BECAUSE[key]}, so it can no longer be changed from here` : null;
}

// "checked 2 hours ago": how old the status is. Recent checks read as an
// interval; anything over a week reads as a date, since by then the interval
// is not the useful part.
export function checkedAgo(iso, now = Date.now()) {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const mins = Math.floor((now - then.getTime()) / 60000);
  if (mins < 1)  return 'checked just now';
  if (mins < 60) return `checked ${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `checked ${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7)  return `checked ${days} day${days === 1 ? '' : 's'} ago`;
  return `checked ${then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

// What "Refresh from Xero" found, from the server's { checked, updated,
// failedTenants }. A company that could not be read is said plainly: its
// rows show their last known status, and that should not pass for current.
export function syncSummary(r) {
  const checked = Number(r && r.checked) || 0;
  const updated = Number(r && r.updated) || 0;
  const failed  = Number(r && r.failedTenants) || 0;
  const what = `Checked ${checked} record${checked === 1 ? '' : 's'} in Xero: ${updated ? `${updated} changed` : 'nothing changed'}.`;
  if (!failed) return what;
  return `${what} ${failed === 1 ? 'One Xero company' : `${failed} Xero companies`} could not be read this time, so some statuses may be out of date.`;
}
