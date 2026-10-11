// The Setup page's Xero connect controls, on the screen side: how each
// optional-permission box is set from the connection's answer, what Connect
// asks the server for, and which missing permissions the app-wide banner
// may still ask a reconnect over.
//
// Plain functions with no imports, so main/scripts/connect-ui.test.js can
// load and run them; the Setup page (Setup.jsx) and the banner
// (XeroConnectionBanner.jsx) only lay them out.
//
// Why there are boxes at all: Xero's sign-in page refuses some apps the
// granular report scopes with "invalid_scope" and never comes back, so a
// Connect that asked for everything looked broken. /api/xero/connection now
// says, per optional permission, what became of it — granted, declined by
// the person, refused by Xero (found by a server-side probe), never asked
// (missing), or not known — and Connect asks only for what is ticked.

// The two permissions a connection can do without, in the order the boxes
// show and the `extras` list names them. The scopes are what each is made
// of: the server names the same ones in its answer (optional[key].scopes),
// and those win when given, so a scope renamed there never leaves a box out
// of step; these stand in for a server that has not said.
const OPTIONAL_BOXES = [
  { key: 'live',    label: 'Live updates (journals permission)',
    scopes: ['accounting.journals.read'] },
  { key: 'balance', label: 'Balance Sheet (balance sheet and trial balance permissions)',
    scopes: ['accounting.reports.balancesheet.read', 'accounting.reports.trialbalance.read'] },
];

const STATUSES = ['granted', 'declined', 'refused', 'missing', 'unknown'];

// What a refused box says beside itself. "Does not allow" rather than
// "refused": the person did nothing, Xero's sign-in page will not take the
// scope from this app, and no reconnect changes that.
const REFUSED_NOTE = 'Xero does not allow this app this permission';

// The boxes, for the page to lay out.
export function optionalBoxes() {
  return OPTIONAL_BOXES.map(b => ({ key: b.key, label: b.label }));
}

// The status the server gave a group, or 'unknown' for anything it did not
// say: an older server with no `optional`, a group it does not know, or a
// status this code does not. Unknown is treated as "never asked" everywhere
// below, which is what Connect did before the boxes existed.
export function optionalStatus(optional, key) {
  const s = optional && optional[key] ? optional[key].status : undefined;
  return STATUSES.includes(s) ? s : 'unknown';
}

// What an unsettled box says: nothing has told the server whether Xero lets
// this app ask for it, so it is not asked for unless the person ticks it.
const UNKNOWN_NOTE = "Xero has not said whether this app may ask for it — tick to try";

// How one box is set. Granted starts ticked, so a reconnect keeps what it
// has; missing (Xero allows it, never asked) starts ticked, so a reconnect
// gains it. Declined starts unticked: the person chose that last time, and a
// page load must not quietly undo it. Refused is unticked and cannot be
// ticked — asking would only send the person back into Xero's error page —
// and says why; the page offers "Check again" beside it. Unknown starts
// unticked too: a Connect that asked for something Xero refuses is the very
// failure the boxes exist to prevent, so it is tried only on purpose.
export function boxState(optional, key) {
  const status = optionalStatus(optional, key);
  if (status === 'refused')  return { checked: false, disabled: true,  note: REFUSED_NOTE, status };
  if (status === 'declined') return { checked: false, disabled: false, note: null,         status };
  if (status === 'granted')  return { checked: true,  disabled: false, note: 'granted',    status };
  if (status === 'missing')  return { checked: true,  disabled: false, note: null,         status };
  return { checked: false, disabled: false, note: UNKNOWN_NOTE, status };
}

// Every box's starting tick, keyed by group: { live, balance }.
export function defaultBoxes(optional) {
  const out = {};
  for (const b of OPTIONAL_BOXES) out[b.key] = boxState(optional, b.key).checked;
  return out;
}

// The `extras` the Connect request carries, from the ticked boxes: 'live,balance',
// 'live', 'balance' or '' (ask for none). Always in the boxes' own order, so
// the value does not depend on which box was ticked last. The caller leaves
// the parameter out altogether when it has no answer from the server yet,
// which lets the server ask for whatever its probe allows.
export function extrasParam(boxes) {
  return OPTIONAL_BOXES.map(b => b.key).filter(k => !!(boxes && boxes[k])).join(',');
}

function groupScopes(optional, box) {
  const given = optional && optional[box.key] ? optional[box.key].scopes : null;
  return Array.isArray(given) && given.length ? given : box.scopes;
}

// The scopes among `missingScopes` the banner may still ask a reconnect
// over. Of the optional groups, only one Xero is known to allow and that was
// never asked for ('missing') is worth a reconnect: one the person declined
// is cured by its box in Setup, one Xero refuses by nothing, and one whose
// standing is unknown might send the person into Xero's "invalid_scope" page
// — the trap the banner itself led people into. A scope outside the groups,
// such as attachments, always stays. With no `optional` at all (an older
// server) every missing scope stays, as the banner worked before.
export function bannerGroups(optional, missingScopes) {
  const missing = Array.isArray(missingScopes) ? missingScopes : [];
  if (!optional || typeof optional !== 'object') return missing;
  const quiet = new Set();
  for (const b of OPTIONAL_BOXES) {
    if (optionalStatus(optional, b.key) !== 'missing') for (const s of groupScopes(optional, b)) quiet.add(s);
  }
  return missing.filter(s => !quiet.has(s));
}
