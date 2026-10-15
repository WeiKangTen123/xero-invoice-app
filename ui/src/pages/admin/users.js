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
