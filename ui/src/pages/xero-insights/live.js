// Live updates on the Dashboard, on the screen side: whether the server's
// "something changed in Xero" stamp has moved, whether a report on screen was
// read before it moved, and the wording of the status line and the banner.
//
// Plain functions with no imports, so main/scripts/live-updates-ui.test.js can
// load and run them; the page (XeroInsights.jsx), its status line (bits.jsx)
// and the banner (XeroConnectionBanner.jsx) only lay them out.

// A stamp as milliseconds, from an ISO string (the version route) or a number
// (every report carries the Date.now() its cache entry was made at, see
// xero/report-cache.js). null for nothing, or for anything unreadable.
function ms(stamp) {
  if (stamp === null || stamp === undefined || stamp === '') return null;
  const t = new Date(stamp).getTime();
  return Number.isNaN(t) ? null : t;
}

// Whether the change stamp moved forward since the previous read. `prev` is
// the stamp that read brought — null when the server had seen no change yet —
// or undefined when there has been no read at all. The first read never
// counts: the stamp it brings is history, not news, and acting on it would
// refetch every report the page had just loaded. A null followed by a stamp
// is the first change the server saw, and counts.
export function hasChanged(prev, next) {
  if (prev === undefined) return false;
  const b = ms(next);
  if (b === null) return false;
  const a = ms(prev);
  return a === null || b > a;
}

// Whether a report read at `fetchedAt` predates the change at `changedAt`, so
// the tab showing it must ask again when it is next opened: the server dropped
// its cached copy at the change, and a plain fetch brings the new figures.
// Nothing to compare — never loaded, or no change seen — is not stale.
export function shouldRefetchTab(fetchedAt, changedAt) {
  const a = ms(fetchedAt), b = ms(changedAt);
  return a !== null && b !== null && a < b;
}

// The oldest of the reads on screen, as milliseconds, or null when none is
// known. The status line says when Xero was read for what is showing, and
// with the summary read at 10:02 over a P&L read at 09:50 that is 09:50.
export function oldestRead(stamps) {
  const known = (stamps || []).map(ms).filter(t => t !== null);
  return known.length ? Math.min(...known) : null;
}

// The status line beside Refresh, in pieces: when Xero was last read for the
// figures on screen, when the server last asked Xero whether anything changed,
// and when it cannot ask, that live updates are off and why. `formatTime`
// turns a stamp into a clock time in the reader's timezone. `reconnect` says
// the reason is cured by reconnecting, so the line can offer the way there.
export function liveLabel({ fetchedAt, checkedAt, live, liveReason } = {}, formatTime) {
  // A company the detector has not reached yet (its first poll is due within
  // two minutes of the first view) is not "off": saying so on every first
  // visit would send readers to Setup for nothing. It is pending.
  const pending = live === false && !checkedAt && /not checked/i.test(liveReason || '');
  const off     = live === false && !pending;
  const reason  = off ? (liveReason || null) : null;
  return {
    asOf:      fetchedAt ? `Xero data as of ${formatTime(fetchedAt)}` : 'Xero data',
    checked:   checkedAt ? `· checked ${formatTime(checkedAt)}` : (pending ? '· first check pending' : null),
    off:       off ? '· live updates off' : null,
    reason,
    reconnect: !!reason && /reconnect/i.test(reason),
  };
}

// The scopes a connection made before they were asked for is missing, and
// what each costs: bills post without their PDF, the Dashboard cannot be told
// when Xero changes, and the Balance Sheet tab cannot read its report (nor
// its check against Xero the Trial Balance, so the two report scopes count
// as one thing). All are cured by one reconnect, which is what the banner's
// title has to say — "once", so it does not read as a fault.
const ATTACHMENTS_SCOPE = 'accounting.attachments';
const JOURNALS_SCOPE    = 'accounting.journals.read';
const BALANCE_SCOPES    = ['accounting.reports.balancesheet.read', 'accounting.reports.trialbalance.read'];

function scopesMissing(missingScopes) {
  const missing = Array.isArray(missingScopes) ? missingScopes : [];
  return {
    attachments: missing.includes(ATTACHMENTS_SCOPE),
    journals:    missing.includes(JOURNALS_SCOPE),
    balance:     BALANCE_SCOPES.some(s => missing.includes(s)),
  };
}

// The banner's title for the scopes a connection is missing, or null when
// none of the three it speaks for is among them. One missing scope is named
// with its own verb; two or more are listed after "allow", so the title reads
// as one reconnect for all of them rather than three faults.
export function bannerTitle(missingScopes) {
  const { attachments, journals, balance } = scopesMissing(missingScopes);
  const parts = [attachments && 'attachments', journals && 'live updates', balance && 'the Balance Sheet'].filter(Boolean);
  if (parts.length > 1) return `Reconnect Xero once to allow ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  if (journals)    return 'Reconnect Xero once to turn on live updates';
  if (attachments) return 'Reconnect Xero to allow attachments';
  if (balance)     return 'Reconnect Xero once to add the Balance Sheet';
  return null;
}

// What is lost meanwhile, for the same scopes.
export function bannerDetail(missingScopes) {
  const { attachments, journals, balance } = scopesMissing(missingScopes);
  const lost = [];
  if (attachments) lost.push('Bills and claims are reaching Xero without their PDF or receipt photo.');
  if (journals)    lost.push('The Dashboard cannot see when Xero changes, so its figures wait for a Refresh.');
  if (balance)     lost.push('The Balance Sheet tab cannot be read until then.');
  if (!lost.length) return null;
  return `${lost.join(' ')} Reconnecting asks Xero for ${lost.length > 1 ? 'those permissions' : 'that permission'}.`;
}
