// Admin › Users › the detail panel: what each line of it says, from GET
// /api/admin/users/:id/detail. The page cannot be rendered on every machine
// this is worked on, so the wording and the decisions (which sign-in reads
// how, which counts are worth a word, which actions the panel offers) live
// here, import nothing, and main/scripts/user-detail-ui.test.js runs them as
// they are. Every function that says "ago" takes `now`, so a test can fix it.

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value) return Date.parse(value);
  return NaN;
}

function plural(n, one, many) {
  return n === 1 ? one : (many || `${one}s`);
}

// Intl parts in the admin's own timezone (the one every time on the Admin
// page is shown in), or the browser's without one. The month is named here
// rather than by Intl, which says "Sept" or "Sep" depending on the browser.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayParts(ms, timeZone) {
  // h23 rather than hour12: false, which some engines turn into "24:05".
  const opts = { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  if (timeZone) opts.timeZone = timeZone;
  try {
    const out = {};
    for (const p of new Intl.DateTimeFormat('en-GB', opts).formatToParts(new Date(ms))) out[p.type] = p.value;
    return { day: String(Number(out.day)), month: MONTHS[Number(out.month) - 1], year: out.year, hour: out.hour, minute: out.minute };
  } catch (_) {
    const d = new Date(ms);
    return {
      day: String(d.getDate()), month: MONTHS[d.getMonth()], year: String(d.getFullYear()),
      hour: String(d.getHours()).padStart(2, '0'), minute: String(d.getMinutes()).padStart(2, '0'),
    };
  }
}

// "3 min ago", "1 h ago", "2 d ago"; "just now" under a minute (and for a
// time a little ahead of this clock); '' for no time at all.
export function relativeTime(iso, now = Date.now()) {
  const at = toMs(iso);
  if (!Number.isFinite(at)) return '';
  const sec = Math.floor((toMs(now) - at) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} d ago`;
  if (day < 365) return `${Math.min(11, Math.floor(day / 30))} mo ago`;
  return `${Math.floor(day / 365)} y ago`;
}

// "3 Sep 2026".
export function fullDate(iso, opts = {}) {
  const ms = toMs(iso);
  if (!Number.isFinite(ms)) return '';
  const p = dayParts(ms, opts.timeZone);
  return `${p.day} ${p.month} ${p.year}`;
}

// "16 Oct", with the year only when it is not this one.
export function shortDate(iso, opts = {}) {
  const ms = toMs(iso);
  if (!Number.isFinite(ms)) return '';
  const p = dayParts(ms, opts.timeZone);
  const thisYear = dayParts(toMs(opts.now ?? Date.now()), opts.timeZone).year;
  return p.year === thisYear ? `${p.day} ${p.month}` : `${p.day} ${p.month} ${p.year}`;
}

// "20 Oct 09:12", with the year only when it is not this one.
export function shortDateTime(iso, opts = {}) {
  const ms = toMs(iso);
  if (!Number.isFinite(ms)) return '';
  const p = dayParts(ms, opts.timeZone);
  return `${shortDate(ms, opts)} ${p.hour}:${p.minute}`;
}

// "09:12" today, "19 Oct 23:53" on any other day.
export function whenLabel(iso, opts = {}) {
  const ms = toMs(iso);
  if (!Number.isFinite(ms)) return '';
  const p = dayParts(ms, opts.timeZone);
  const t = dayParts(toMs(opts.now ?? Date.now()), opts.timeZone);
  const today = p.day === t.day && p.month === t.month && p.year === t.year;
  return today ? `${p.hour}:${p.minute}` : shortDateTime(ms, opts);
}

function isLocked(user, now) {
  const until = toMs(user?.lockedUntil);
  return Number.isFinite(until) && until > toMs(now);
}

// ── The head of the panel ────────────────────────────────────────────────────
// Three lines under the email:
//   ● Active · user · joined 3 Sep 2026                  [demo] [★ admin]
//   Last sign-in 20 Oct 09:12 · active 2 min ago
//   Password changed 16 Oct · 🔒 Locked until 10:45 (5 failed)
// `state.tone` colours the dot; each note carries its own tone (null is muted).
export function statusLine(user, now = Date.now(), opts = {}) {
  const u = user || {};
  const o = { timeZone: opts.timeZone, now };
  const locked = isLocked(u, now);

  const invited = u.invited === true;
  const state = u.disabledAt ? { label: 'Disabled', tone: 'red' }
    : locked                 ? { label: 'Locked',   tone: 'red' }
    : invited                ? { label: 'Invited',  tone: 'yellow' }
    : u.online               ? { label: 'Online',   tone: 'green' }
    :                          { label: 'Active',   tone: 'gray' };

  const summary = [state.label, u.role === 'admin' ? 'admin' : 'user'];
  if (u.createdAt && fullDate(u.createdAt, o)) summary.push(`joined ${fullDate(u.createdAt, o)}`);

  // An admin on sample data chose it and can switch back to Xero; anyone
  // else's demo account is locked to it (as admin/users.js demoBadge says).
  const badges = [];
  if (u.demo === true) {
    badges.push(u.role === 'admin'
      ? { key: 'demo', text: 'sample data', title: 'On sample data by their own choice; their Xero connection is kept' }
      : { key: 'demo', text: 'demo', title: 'Demo account: sample data, no Xero connection' });
  }
  if (u.role === 'admin') badges.push({ key: 'admin', text: '★ admin', title: 'Sees every account and this page' });

  const seen = [];
  seen.push(u.lastLoginAt && shortDateTime(u.lastLoginAt, o) ? `Last sign-in ${shortDateTime(u.lastLoginAt, o)}` : 'Never signed in');
  if (u.online) seen.push('online now');
  else if (relativeTime(u.lastSeenAt, now)) seen.push(`active ${relativeTime(u.lastSeenAt, now)}`);

  const notes = [];
  if (u.disabledAt && shortDate(u.disabledAt, o)) notes.push({ text: `Disabled since ${shortDate(u.disabledAt, o)}`, tone: 'red' });
  // Invited and no password yet (the list's invited, inviteExpiresAt,
  // inviteExpired): when the link runs out, or that it has.
  if (invited) {
    const until = toMs(u.inviteExpiresAt);
    const gone  = u.inviteExpired === true || (Number.isFinite(until) && until <= toMs(now));
    const at    = Number.isFinite(until) ? shortDateTime(until, o) : '';
    if (gone) notes.push({ text: at ? `Invite expired ${at}: send a new link to let them in` : 'Invite expired: send a new link to let them in', tone: 'red' });
    else notes.push({ text: at ? `Invite link expires ${at}` : 'Invite sent, no password set yet', tone: 'yellow' });
  }
  if (u.passwordChangedAt && shortDate(u.passwordChangedAt, o)) {
    notes.push({ text: `Password changed ${shortDate(u.passwordChangedAt, o)}`, tone: null });
  }
  if (u.mustChangePassword === true) {
    const expires = toMs(u.tempPasswordExpiresAt);
    // No expiry: not an admin's temporary password but their own, which the
    // rules now refuse (or a demo account made an admin); it still signs in.
    if (!Number.isFinite(expires)) notes.push({ text: 'Must choose a new password: theirs no longer meets the rules', tone: 'yellow' });
    else if (expires > toMs(now)) notes.push({ text: `Temporary password, expires ${shortDateTime(expires, o)}`, tone: 'yellow' });
    else notes.push({ text: `Temporary password expired ${shortDateTime(expires, o)}: send a reset link to let them in`, tone: 'red' });
  }
  const failed = Number(u.failedLogins) || 0;
  if (locked) {
    const p = dayParts(toMs(u.lockedUntil), opts.timeZone);
    notes.push({ text: `🔒 Locked until ${p.hour}:${p.minute}` + (failed > 0 ? ` (${failed} failed)` : ''), tone: 'red' });
  } else if (failed > 0) {
    notes.push({ text: `${failed} failed ${plural(failed, 'attempt')} since the last sign-in`, tone: 'yellow' });
  }
  const lockCount = Number(u.lockCount) || 0;
  if (lockCount > 0) {
    const last = u.lastLockedAt && shortDate(u.lastLockedAt, o);
    notes.push({ text: `Locked ${lockCount} ${plural(lockCount, 'time')}` + (last ? `, last ${last}` : ''), tone: null });
  }

  return { state, summary: summary.join(' · '), badges, seen: seen.join(' · '), notes };
}

// ── Sign-ins ─────────────────────────────────────────────────────────────────
// One row per recorded sign-in event: an icon, plain words and a tone (green,
// yellow, red, blue or gray). The server says `result`; an older record may
// carry only its `action`, which is read the same way.
const RESULT_OF_ACTION = {
  'login.success': 'success', 'login.failed': 'failure', 'login.locked': 'locked',
  'login.unlocked': 'unlocked', 'login.refused': 'refused', 'auth.logout': 'logout', logout: 'logout',
  'session.revoke': 'revoked',
};

const REFUSED = {
  locked:            'Refused: account locked',
  disabled:          'Refused: account disabled',
  expired_temporary: 'Refused: temporary password expired',
};

function lockMinutes(event) {
  const candidates = [event.lockMinutes, event.minutes, event.details?.lockMinutes, event.details?.minutes, event.reason];
  for (const c of candidates) {
    const n = typeof c === 'number' ? c : (typeof c === 'string' && /^\d+$/.test(c.trim()) ? Number(c) : NaN);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export function signInRow(event) {
  const e = event || {};
  const result = e.result || RESULT_OF_ACTION[e.action];
  switch (result) {
    case 'success':  return { icon: '✓', label: 'Signed in', tone: 'green' };
    case 'failure':  return { icon: '✕', label: 'Wrong password', tone: 'yellow' };
    case 'locked': {
      const m = lockMinutes(e);
      return { icon: '🔒', label: m ? `Locked ${m} min` : 'Locked', tone: 'red' };
    }
    case 'refused':  return { icon: '⛔', label: REFUSED[e.reason] || 'Refused', tone: 'red' };
    case 'unlocked': return { icon: '🔓', label: 'Unlocked', tone: 'blue' };
    case 'logout':   return { icon: '⇥', label: 'Signed out', tone: 'gray' };
    case 'revoked':  return { icon: '⇥', label: 'Session ended by admin', tone: 'gray' };
    default:         return { icon: '•', label: typeof e.action === 'string' && e.action ? e.action : 'Unknown', tone: 'gray' };
  }
}

// Where a sign-in or a session came from: the device and the place, each a
// ready label from the server, joined; '' when neither is known.
export function whereLabel(item) {
  return [item?.device, item?.location].filter(s => typeof s === 'string' && s.trim()).join(' · ');
}

// ── Sessions ─────────────────────────────────────────────────────────────────
// Two lines per session:
//   Chrome · Windows   203.0.113.5                         This device
//     Singapore · Singtel   started 09:12 · seen 2 min ago
// The admin's own current session is "This device" and cannot be revoked
// here (the server refuses it: that is Sign out).
export function sessionRow(session, now = Date.now(), opts = {}) {
  const s = session || {};
  const o = { timeZone: opts.timeZone, now };
  const when = [];
  if (whenLabel(s.createdAt, o)) when.push(`started ${whenLabel(s.createdAt, o)}`);
  if (relativeTime(s.lastSeenAt, now)) when.push(`seen ${relativeTime(s.lastSeenAt, now)}`);
  return {
    device:    s.device || 'Unknown device',
    ip:        s.ip || '',
    location:  s.location || '',
    when:      when.join(' · '),
    current:   s.current === true,
    isNew:     s.isNew === true,
    canRevoke: s.current !== true && !!s.sid,
  };
}

export function sessionsHeading(sessions) {
  const n = Array.isArray(sessions) ? sessions.length : 0;
  return n > 0 ? `Sessions (${n} active)` : 'Sessions';
}

// Every token now belongs to a listed session (a token from before sessions
// were kept is refused, auth-middleware.js), so an empty list means signed in
// nowhere and needs no note. Kept as a function so the panel's call stands.
export const UNLISTED_SESSIONS_NOTE = '';

export function sessionsNote() {
  return '';
}

// ── Work ─────────────────────────────────────────────────────────────────────
// The mailbox watcher and auto-submit on one line: "Running · auto-submit off".
// The watcher's state and stop reason are the registry's
// (email/watcher-registry.js getStatus, STOP_REASONS); `enabled` is whether
// its owner has it switched on. A stop the mail server caused is red: it
// will not start again by itself.
const WATCHER_STATES = { watching: 'Running', connecting: 'Connecting', reconnecting: 'Reconnecting', stopped: 'Stopped' };
const WATCHER_REASONS = {
  manual:        'stopped by hand',
  idle:          'owner away',
  'auth-failed': 'the mail server refused the password',
  'max-retries': 'the mail server could not be reached',
  shutdown:      'the server restarted',
};

export function watcherLine(work) {
  const w = work?.watcher || {};
  const auto = work?.autoSubmit === true ? 'auto-submit on' : 'auto-submit off';
  if (w.running === true) return { text: `Running · ${auto}`, tone: 'green' };
  if (w.state === 'connecting' || w.state === 'reconnecting') {
    return { text: `${WATCHER_STATES[w.state]} · ${auto}`, tone: 'yellow' };
  }
  if (w.enabled === false && (!w.state || w.state === 'stopped')) return { text: `Off · ${auto}`, tone: 'gray' };
  const state = WATCHER_STATES[w.state] && w.state !== 'watching' ? WATCHER_STATES[w.state]
    : typeof w.state === 'string' && w.state && w.state !== 'watching'
      ? w.state.charAt(0).toUpperCase() + w.state.slice(1).replace(/[-_]/g, ' ')
      : 'Stopped';
  const why = typeof w.reason === 'string' && w.reason ? (WATCHER_REASONS[w.reason] || w.reason) : '';
  const failed = w.reason === 'auth-failed' || w.reason === 'max-retries';
  return { text: `${state}${why ? ` (${why})` : ''} · ${auto}`, tone: failed ? 'red' : 'gray' };
}

export function mailboxLine(mailbox) {
  if (mailbox?.configured !== true) return 'Not set up';
  return mailbox.address || 'Set up';
}

const METHODS = { oauth: 'OAuth', custom: 'Custom Connection', demo: 'Demo' };

// Xero: the companies, how it connects and when the token was last
// refreshed; or why it is not connected. A demo account names its Demo
// Company and says nothing goes to Xero. An admin on sample data chose it
// and keeps their Xero connection to switch back to, so theirs says so
// (`opts.role` is the account's).
export function xeroLine(xero, opts = {}) {
  const x = xero || {};
  const now = opts.now ?? Date.now();
  const orgs = Array.isArray(x.organisations) ? x.organisations.filter(Boolean) : [];
  const names = orgs.length > 2 ? `${orgs.slice(0, 2).join(', ')} +${orgs.length - 2} more` : orgs.join(', ');
  if (opts.demo === true || x.method === 'demo') {
    const company = orgs[0] || 'Demo Company Pte Ltd';
    if (opts.role === 'admin') return { text: `${company} · sample data (their choice)`, tone: 'gray' };
    return { text: `${company} · sample data, no Xero connection`, tone: 'gray' };
  }
  if (x.connected !== true) {
    return { text: x.reason ? `Not connected · ${x.reason}` : 'Not connected', tone: 'gray' };
  }
  if (x.needsReconnect === true) {
    const head = names ? `${names} · ` : '';
    return { text: `${head}needs reconnecting` + (x.reason ? `: ${x.reason}` : ''), tone: 'yellow' };
  }
  const out = [names || 'Connected'];
  if (METHODS[x.method]) out.push(METHODS[x.method]);
  if (relativeTime(x.lastRefreshedAt, now)) out.push(`refreshed ${relativeTime(x.lastRefreshedAt, now)}`);
  return { text: out.join(' · '), tone: 'green' };
}

// The document counts worth a word, in the order a document moves through
// them; a zero says nothing. "None yet" when every count is zero.
const DOCUMENT_COUNTS = [
  ['pending',      () => 'pending'],
  ['reviewNeeded', () => 'to review'],
  ['reviewed',     () => 'reviewed'],
  ['submitting',   () => 'submitting'],
  ['posted',       () => 'posted'],
  ['error',        n => plural(n, 'error')],
  ['duplicate',    n => plural(n, 'duplicate')],
  ['reported',     () => 'reported'],
];

export function documentsLine(documents) {
  const d = documents || {};
  const out = [];
  for (const [key, word] of DOCUMENT_COUNTS) {
    const n = Number(d[key]) || 0;
    if (n > 0) out.push(`${n} ${word(n)}`);
  }
  return out.length ? out.join(' · ') : 'None yet';
}

// The processing queue: what waits, what is running, and what failed for
// good with the last error it gave (cut short; the full text is the title).
export function queueLine(queue) {
  const q = queue || {};
  const pending = Number(q.pending) || 0;
  const processing = Number(q.processing) || 0;
  const dead = Number(q.dead) || 0;
  const out = [`${pending} waiting`];
  if (processing > 0) out.push(`${processing} processing`);
  if (dead > 0) {
    const err = typeof q.lastError === 'string' ? q.lastError.trim() : '';
    const short = err.length > 120 ? `${err.slice(0, 119)}…` : err;
    out.push(`${dead} failed` + (short ? `: "${short}"` : ''));
  }
  return { text: out.join(' · '), tone: dead > 0 ? 'red' : null, title: typeof q.lastError === 'string' ? q.lastError : '' };
}

// 1024-based, one decimal at most: "512 KB", "48.2 MB", "1.5 GB". Anything
// above zero is at least 0.1 KB, so a few bytes do not read as nothing.
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (bytes === null || bytes === undefined || bytes === '' || !Number.isFinite(n) || n < 0) return '—';
  const KB = 1024, MB = KB * 1024, GB = MB * 1024;
  const one = v => String(Math.round(v * 10) / 10);
  if (n >= GB) return `${one(n / GB)} GB`;
  if (n >= MB) return `${one(n / MB)} MB`;
  if (n === 0) return '0 KB';
  return `${one(Math.max(n / KB, 0.1))} KB`;
}

// "48.2 MB · Gemini keys 2", with what makes up the total for the title.
export function storageLine(storage, geminiKeys) {
  const s = storage || {};
  const text = [formatBytes(s.bytes)];
  const keys = Number(geminiKeys);
  if (Number.isFinite(keys)) text.push(`Gemini keys ${keys}`);
  const title = [['Receipts', s.receipts], ['PDFs', s.pdfs], ['Queue', s.queue]]
    .filter(([, v]) => Number.isFinite(Number(v)) && v !== null && v !== undefined)
    .map(([k, v]) => `${k} ${formatBytes(v)}`)
    .join(' · ');
  return { text: text.join(' · '), title };
}

// ── Activity ─────────────────────────────────────────────────────────────────
// What happened to the account's documents, and what was done to the account
// itself (muted, with who did it).
export function activityRow(item) {
  const a = item || {};
  const account = a.kind === 'account';
  return {
    text:  a.summary || '',
    by:    account && a.by ? `by ${a.by}` : '',
    muted: account,
  };
}

// ── Actions ──────────────────────────────────────────────────────────────────
// What the panel offers, grouped, with the label each button shows, what it
// says on hover, and why it is held (the server refuses these too; the
// button says why first). Your own account offers only what the server
// allows on yourself: Unlock and the automation switches. `busyKey` is the
// key the page's control() marks the request in flight with. An account
// still on its invite has no password to reset: it is offered a new invite
// link, or the invite revoked, as its row in the list is.
export function panelActions({ user, isMe = false, lastAdmin = false, now = Date.now(), work = null } = {}) {
  const u = user || {};
  const groups = [];

  const account = [];
  if (isLocked(u, now)) {
    account.push({ key: 'unlock', busyKey: 'unlock', label: '🔓 Unlock', title: 'End the lock now, so they can sign in again' });
  }
  if (!isMe) {
    account.push({
      key: 'role', busyKey: 'role',
      label: u.role === 'admin' ? '◦ Make user' : '★ Make admin',
      title: u.role === 'admin' ? 'Back to an ordinary user' : 'Give them this page',
      blocked: lastAdmin ? 'Cannot demote the last admin' : null,
    });
    if (u.invited === true) {
      account.push({ key: 'invite', busyKey: 'invite', label: '✉ New invite link', title: 'Make a new invite link, emailed or to copy' });
      account.push({ key: 'revokeInvite', busyKey: 'revokeInvite', label: '⊘ Revoke invite', title: 'Stop the link they were sent from working' });
    } else {
      account.push({
        key: 'reset', busyKey: 'reset', label: '🔑 Send reset link',
        title: 'A link to choose a new password: emailed to them, or for you to copy and send',
      });
    }
  }
  if (account.length) groups.push({ key: 'account', label: 'Account', actions: account });

  const automation = [];
  // A watcher in a backoff is not running, but is still one to stop.
  const w = work?.watcher;
  if (w && (w.running === true || w.state === 'connecting' || w.state === 'reconnecting')) {
    automation.push({ key: 'stopWatcher', busyKey: 'watcher', label: '■ Stop watcher', title: 'Stop polling this mailbox' });
  }
  if (work?.autoSubmit === true) {
    automation.push({ key: 'autoSubmitOff', busyKey: 'auto', label: '⏻ Turn off auto-submit', title: 'Stop this account posting to Xero automatically' });
  }
  if (automation.length) groups.push({ key: 'automation', label: 'Automation', actions: automation });

  if (!isMe) {
    groups.push({
      key: 'danger', label: 'Danger', actions: [
        {
          key: 'disabled', busyKey: 'disabled',
          label: u.disabledAt ? '✓ Enable' : '⏸ Disable',
          title: u.disabledAt ? 'Let them sign in again' : 'Block sign-in and stop their watcher, keeping their data',
          blocked: lastAdmin ? 'Cannot disable the last admin' : null,
        },
        {
          key: 'delete', busyKey: 'delete', label: '✕ Delete', danger: true,
          title: 'Remove the account and everything in it',
          blocked: lastAdmin ? 'Cannot delete the last admin' : null,
        },
      ],
    });
  }
  return groups;
}

// Said on your own account in place of the controls the server refuses there.
export const SELF_NOTE = 'This is your account: change your password, or sign out everywhere, from the Account page. '
  + 'Another admin changes its role, disables or deletes it.';

// ── Attribution ──────────────────────────────────────────────────────────────
// The places come from DB-IP's free database, whose CC BY licence asks for a
// link wherever they are shown. The server sends it; this is the same, for an
// answer without it.
export const ATTRIBUTION = { text: 'IP Geolocation by DB-IP', url: 'https://db-ip.com' };

export function attributionOf(detail) {
  const a = detail?.attribution;
  return a && typeof a.text === 'string' && a.text && typeof a.url === 'string' && /^https:\/\//.test(a.url)
    ? { text: a.text, url: a.url }
    : { ...ATTRIBUTION };
}
