// Admin › Users: what a row says about an account's sign-in state, from the
// fields GET /api/admin/users sends (failedLogins, lockedUntil,
// mustChangePassword). The page cannot be rendered on every machine this is
// worked on, so the wording lives here, imports nothing, and
// main/scripts/login-ui.test.js runs it as it is.

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Date.parse(value);
  return NaN;
}

// HH:MM, 24-hour. The Admin page shows every time in the admin's own account
// timezone, so the badge takes the same one; without it, the browser's.
function clockTime(ms, timeZone) {
  try {
    const opts = { hour: '2-digit', minute: '2-digit', hour12: false };
    if (timeZone) opts.timeZone = timeZone;
    return new Intl.DateTimeFormat('en-GB', opts).format(new Date(ms));
  } catch (_) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

// Locked right now: a lockedUntil still ahead of `now`.
export function isLocked(row, now = Date.now()) {
  const until = toMs(row?.lockedUntil);
  return Number.isFinite(until) && until > toMs(now);
}

// The badge on a locked row — "🔒 Locked until 10:45 · 5 failed" — with a
// title saying what to do, or null when the row is not locked (the server
// leaves lockedUntil behind after it has passed, and that is no lock).
export function lockBadge(row, now = Date.now(), opts = {}) {
  if (!isLocked(row, now)) return null;
  const until  = toMs(row.lockedUntil);
  const failed = Number(row.failedLogins) || 0;
  const text   = `🔒 Locked until ${clockTime(until, opts.timeZone)}` + (failed > 0 ? ` · ${failed} failed` : '');
  return {
    text,
    until,
    failed,
    title: 'Too many wrong passwords. Unlock lets them sign in again now; otherwise the lock ends on its own.',
  };
}

// Wrong passwords since the last sign-in, on a row that is not locked: a
// warning worth a glance, said quietly. Nothing on a locked row (the badge
// counts them) or a clean one.
export function failedNote(row, now = Date.now()) {
  const failed = Number(row?.failedLogins) || 0;
  if (failed <= 0 || isLocked(row, now)) return '';
  return `${failed} failed attempt${failed === 1 ? '' : 's'}`;
}

// An account still on the temporary password its administrator set.
export function mustSetNote(row) {
  return row?.mustChangePassword === true ? 'must set a password at next sign-in' : '';
}

// ── Demo accounts ────────────────────────────────────────────────────────────
// A demo account (GET /api/admin/users rows carry `demo`) shows sample data
// this app generates in place of a Xero connection. The Add User form offers
// to copy this admin's keys, defaults and mailbox to it, so it works at once;
// main/scripts/demo-ui.test.js runs what is below.

// The muted badge on a demo row, or null. An admin switches their own account
// between Xero and sample data (PUT /api/setup/data-source), so an admin on
// sample data is there by choice and keeps their Xero connection; anyone
// else's demo account is locked to sample data and has none.
export function demoBadge(row) {
  if (row?.demo !== true) return null;
  if (row.role === 'admin') {
    return { text: 'sample data', title: 'On sample data by their own choice; their Xero connection is kept' };
  }
  return { text: 'demo', title: 'Demo account: sample data, no Xero connection' };
}

// The settings the form offers to copy, in the order the boxes show, keyed as
// POST /api/admin/users takes them under `copyFrom`.
const COPY_BOXES = [
  { key: 'llm',      label: 'LLM keys' },
  { key: 'defaults', label: 'Invoice defaults' },
  { key: 'mailbox',  label: 'Mailbox (IMAP)' },
];

export function copyBoxes() {
  return COPY_BOXES.map(b => ({ key: b.key, label: b.label }));
}

// The boxes' starting ticks once Demo account is ticked: all of them, since a
// demo account needs keys to parse with and defaults to fill in, and the
// mailbox is what makes it show something arriving.
export function copyDefaults() {
  const out = {};
  for (const b of COPY_BOXES) out[b.key] = true;
  return out;
}

// What the form sends, from its fields: { email, password, role, demo,
// copyFrom: { llm, defaults, mailbox }, mailboxFilterFrom }. The copy boxes
// are only shown for a demo account, so their ticks only travel with one;
// the sender address only travels with the mailbox, trimmed.
export function addUserPayload(form) {
  const f = form || {};
  const demo = f.demo === true;
  const ticks = (demo && f.copyFrom) || {};
  const copyFrom = {};
  for (const b of COPY_BOXES) copyFrom[b.key] = ticks[b.key] === true;
  const payload = { email: f.email, password: f.password, role: f.role, demo, copyFrom };
  if (copyFrom.mailbox) payload.mailboxFilterFrom = String(f.mailboxFilterFrom || '').trim();
  return payload;
}

// One whole address and nothing else, as the server asks of the sender
// (routes/admin.js FULL_ADDRESS, kept the same): the mail server matches the
// sender filter anywhere in a sender, so 'gmail.com' would match almost
// every email in the mailbox.
const FULL_ADDRESS = /^[^\s@,;<>()"]+@[^\s@,;<>()".]+(?:\.[^\s@,;<>()".]+)+$/;

// Why the form cannot be sent yet, or null. Two accounts watching one mailbox
// must watch different senders, so the mailbox copy needs the address the
// demo account processes emails from; the server refuses it without one, or
// with anything but one whole address. (Whether it clashes with a sender
// another account already watches for, the admin's own included, only the
// server knows; it says so in its answer.)
export function addUserProblem(form) {
  const p = addUserPayload(form);
  if (p.copyFrom.mailbox && !p.mailboxFilterFrom) {
    return 'Mailbox needs a sender address: the demo account only processes emails from that sender';
  }
  if (p.copyFrom.mailbox && !FULL_ADDRESS.test(p.mailboxFilterFrom)) {
    return 'Mailbox needs one whole sender address, such as bills@vendor.com: a domain or part of an address would match almost every email';
  }
  return null;
}

// The copy groups as the banner names them, in the order the boxes show.
const COPY_NAMES = { llm: 'LLM keys', defaults: 'invoice defaults', mailbox: 'mailbox' };

// What the banner says once an account is made, from what was sent
// (addUserPayload) and what the server answered (POST /api/admin/users:
// { user, copied }): "Demo account x created. Copied: LLM keys, invoice
// defaults, mailbox." A group that was ticked but had nothing to copy (no
// keys, no defaults, no mailbox password) is named too, so the admin is not
// left thinking it went across.
export function createdMessage(payload, answer) {
  const user   = (answer && answer.user) || null;
  const demo   = user ? user.demo === true : !!(payload && payload.demo === true);
  const email  = (user && user.email) || (payload && payload.email) || '';
  const sent   = (answer && Array.isArray(answer.copied)) ? answer.copied : [];
  const keys   = COPY_BOXES.map(b => b.key);
  const copied = keys.filter(k => sent.includes(k));
  const missed = keys.filter(k => payload && payload.copyFrom && payload.copyFrom[k] === true && !sent.includes(k));
  const names  = list => list.map(k => COPY_NAMES[k]).join(', ');
  let text = `${demo ? 'Demo account' : 'User'} ${email} created.`;
  if (copied.length) text += ` Copied: ${names(copied)}.`;
  if (missed.length) text += ` Not copied, as you have none set up: ${names(missed)}.`;
  return text;
}
