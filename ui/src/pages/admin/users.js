// Admin › Users: what a row says about an account's sign-in state, from the
// fields GET /api/admin/users sends (failedLogins, lockedUntil,
// mustChangePassword, invited, inviteExpiresAt, inviteExpired, mfaEnabled),
// and what the page says once an invite or a reset link is made. The page
// cannot be rendered on every machine this is worked on, so the wording lives
// here, imports nothing, and main/scripts/login-ui.test.js,
// main/scripts/demo-ui.test.js, main/scripts/invite-ui.test.js and
// main/scripts/mfa-ui.test.js run it as it is.

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
// this app generates in place of a Xero connection. The Invite a user form offers
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

// What the form sends, from its fields: { email, role, demo, copyFrom: { llm,
// defaults, mailbox }, mailboxFilterFrom }. No password: the person sets
// their own from the invite link, and an administrator never knows it. The
// copy boxes are only shown for a demo account, so their ticks only travel
// with one; the sender address only travels with the mailbox, trimmed.
export function addUserPayload(form) {
  const f = form || {};
  const demo = f.demo === true;
  const ticks = (demo && f.copyFrom) || {};
  const copyFrom = {};
  for (const b of COPY_BOXES) copyFrom[b.key] = ticks[b.key] === true;
  const payload = { email: f.email, role: f.role, demo, copyFrom };
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

// The copy groups as the result names them, in the order the boxes show.
const COPY_NAMES = { llm: 'LLM keys', defaults: 'invoice defaults', mailbox: 'mailbox' };

// What was copied to a new demo account, said under the invite's result,
// from what was sent (addUserPayload) and what the server answered (POST
// /api/admin/users: { user, copied }): "Demo account: copied LLM keys,
// invoice defaults, mailbox." A group that was ticked but had nothing to copy
// (no keys, no defaults, no mailbox password) is named too, so the admin is
// not left thinking it went across. '' for an ordinary account.
export function copiedNote(payload, answer) {
  const user   = (answer && answer.user) || null;
  const demo   = user ? user.demo === true : !!(payload && payload.demo === true);
  if (!demo) return '';
  const sent   = (answer && Array.isArray(answer.copied)) ? answer.copied : [];
  const keys   = COPY_BOXES.map(b => b.key);
  const copied = keys.filter(k => sent.includes(k));
  const missed = keys.filter(k => payload && payload.copyFrom && payload.copyFrom[k] === true && !sent.includes(k));
  const names  = list => list.map(k => COPY_NAMES[k]).join(', ');
  let text = 'Demo account';
  text += copied.length ? `: copied ${names(copied)}.` : '.';
  if (missed.length) text += ` Not copied, as you have none set up: ${names(missed)}.`;
  return text;
}

// ── Invites and reset links ──────────────────────────────────────────────────
// An account is made without a password: the person is sent a link to set
// their own (/set-password#t=…), and so is anyone an administrator sends a
// reset link. The server emails it when it can (Setup › Email sending);
// otherwise it hands the link back, once, for the admin to pass on.

// What the result says for the server's answer, { emailed, link, expiresAt,
// emailError? } (POST /api/admin/users → invite, POST …/invite → invite,
// POST …/reset-link → reset). `kind` is 'invite' or 'reset'; `when` is the
// expiry as the page formats it ("29 Oct, 14:05", utils/formatDate.js
// formatShortDateTime), '' when there is none. `link` is set only when the
// admin has to send it themselves; `note` goes under it. `ok` is false only
// when nothing reached anyone.
export function linkResult(kind, answer, email, when) {
  const a     = answer || {};
  const what  = kind === 'reset' ? 'Reset link' : 'Invite';
  const who   = typeof email === 'string' && email.trim() ? email.trim() : 'them';
  const until = typeof when === 'string' && when ? when : '';
  if (a.emailed === true) {
    return { ok: true, emailed: true, link: null, text: `${what} sent to ${who}.${until ? ` It expires on ${until}.` : ''}`, note: '' };
  }
  const link = typeof a.link === 'string' && a.link.trim() ? a.link.trim() : null;
  const err  = typeof a.emailError === 'string' && a.emailError.trim() ? a.emailError.trim() : '';
  const why  = err ? `The email couldn't be sent (${err})` : 'Email isn\'t set up on this server';
  if (!link) {
    // Neither emailed nor handed back: nothing reached anyone. Said plainly,
    // with the way to try again.
    return {
      ok: false, emailed: false, link: null,
      text: `${what} created, but it was not emailed${err ? ` (${err})` : ''} and no link came back. ${kind === 'reset' ? 'Send reset link' : 'New link'} makes another.`,
      note: '',
    };
  }
  return {
    ok: true, emailed: false, link,
    text: `${what} created. ${why}, so send this link to ${who} yourself. Treat it like a password.`,
    note: `Shown once. Single use${until ? `, expires ${until}` : ''}.`,
  };
}

// The note on a row that has been invited and has not set a password yet,
// in place of its sign-in details: "Invited · expires 29 Oct", or "Invite
// expired 20 Oct" once it has run out (the server says so, `inviteExpired`;
// its expiry against `now` says the same for a list loaded a while ago).
// `day` is the expiry as the page formats it ("29 Oct"). null for any other
// row.
export function inviteNote(row, { now = Date.now(), day = '' } = {}) {
  if (row?.invited !== true) return null;
  const at      = toMs(row.inviteExpiresAt);
  const expired = row.inviteExpired === true || (Number.isFinite(at) && at <= toMs(now));
  if (expired) {
    return { expired, text: day ? `Invite expired ${day}` : 'Invite expired', title: 'The invite link ran out before they used it. New link makes another.' };
  }
  return { expired, text: day ? `Invited · expires ${day}` : 'Invited', title: 'Has not set a password yet. New link makes another; Revoke stops the one sent.' };
}

// ── 2-step sign-in ───────────────────────────────────────────────────────────
// Rows carry `mfaEnabled`. The small badge on a row with it on, or null.
export function mfaBadge(row) {
  if (row?.mfaEnabled !== true) return null;
  return { text: '2-step', title: '2-step sign-in is on: a code from an authenticator app after the password' };
}

// Reset 2-step, asked first (POST /api/admin/users/:id/mfa-reset): for
// someone who has lost their phone and their recovery codes.
export function mfaResetAsk(row) {
  const email = (row && row.email) || 'this account';
  return {
    title:        `Reset 2-step sign-in for ${email}?`,
    message:      'They will have to set it up again at their next sign-in. Use this when they have lost their phone.',
    confirmLabel: 'Reset 2-step',
    danger:       true,
  };
}

// The toast once it is done.
export function mfaResetDone(row) {
  const email = (row && row.email) || 'The account';
  return `2-step sign-in for ${email} is reset. They set it up again at their next sign-in.`;
}

// Revoke, asked first: the link sent stops working.
export function revokeInviteAsk(row) {
  const email = (row && row.email) || 'this account';
  return {
    title:        `Revoke the invite for ${email}?`,
    message:      'The link they were sent stops working at once.',
    confirmLabel: 'Revoke',
    danger:       true,
  };
}
