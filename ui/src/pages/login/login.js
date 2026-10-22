// The sign-in screen's decisions that need no React: which form it shows,
// whether a forgotten password can be reset by email, the address passed in
// the query, what it says when a first-run registration is refused, what the alert says
// when the server answers 423 (the account is locked after too many wrong
// passwords), and the countdown on the button while the lock lasts. The page
// cannot be rendered on every machine this is worked on, so they live here,
// import nothing, and main/scripts/login-ui.test.js,
// main/scripts/login-flow-ui.test.js, main/scripts/set-password-ui.test.js
// and main/scripts/forgot-password-ui.test.js run them as they are.

// ── Which form ───────────────────────────────────────────────────────────────
// The page asks GET /auth/status before it shows a form. Until the answer it
// is checking; then it creates the first (admin) account when there is none,
// and signs in ever after. It used to start as a sign-in form and switch, so
// first run flashed the wrong form; and a failed check left it signing in,
// on a site with no account to sign in to. A check that fails now says so,
// with a Retry.
export const FORM_CHECKING    = 'checking';
export const FORM_FIRST_RUN   = 'first-run';
export const FORM_SIGN_IN     = 'sign-in';
export const FORM_UNREACHABLE = 'unreachable';

// The form for a GET /auth/status answer. Only a plain "no accounts yet" opens
// the first-run form; anything else signs in, which is also what the server
// holds every later visitor to.
export function formFromStatus(body) {
  return body && body.hasUsers === false ? FORM_FIRST_RUN : FORM_SIGN_IN;
}

export const STATUS_FAILED_MESSAGE = 'Could not reach the server to load the sign-in form. Check your connection and try again.';

// Whether "Forgot your password?" can lead to a reset by email: the same
// answer says so (`mail`, true once this server can send email). Without
// it, the person asks an administrator for a reset link.
export function resetByEmail(body) {
  return !!body && body.mail === true;
}

export const ASK_ADMIN_TEXT = 'Ask your administrator for a reset link.';

// The address passed along in the query (?email=), to start a form with: the
// sign-in page's from a password just set, the forgot-password page's from
// the sign-in form. Only something that looks like one address, never a long
// one; '' for anything else.
export function emailFromSearch(search) {
  try {
    const value = new URLSearchParams(String(search || '')).get('email');
    const e = typeof value === 'string' ? value.trim() : '';
    return e && e.length <= 254 && /^[^\s@,;<>]+@[^\s@,;<>]+$/.test(e) ? e : '';
  } catch (_) {
    return '';
  }
}

// Where "Forgot your password?" leads when reset by email is on: with the
// address typed so far, when it is one, so it is not typed twice.
export function forgotPath(email) {
  const e = emailFromSearch(`?email=${encodeURIComponent(String(email || '').trim())}`);
  return e ? `/forgot-password?email=${encodeURIComponent(e)}` : '/forgot-password';
}

// A first-run registration the server turned away because an account exists
// after all: 403, someone else set this site up first (in another tab, or
// between this page loading and the form being sent); 409, this very address
// has an account. Either way the form becomes a sign-in form, and this is
// what it says. null for any other failure, which is shown as it came.
export function registerRefusal(err) {
  if (err?.status === 403) return 'This site already has an administrator, so the form now signs in. Need an account? Ask your administrator.';
  if (err?.status === 409) return 'An account with this email already exists. Sign in with its password.';
  return null;
}

// A time in ms from whatever the caller holds: a Date, a number, an ISO
// string. NaN for anything unreadable.
function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Date.parse(value);
  return NaN;
}

// HH:MM, 24-hour, in the browser's own time: the person reading it is the one
// waiting, wherever they are, so no account timezone applies. `timeZone` is
// for tests, which cannot rely on the machine's clock setting.
export function clockTime(ms, timeZone) {
  try {
    const opts = { hour: '2-digit', minute: '2-digit', hour12: false };
    if (timeZone) opts.timeZone = timeZone;
    return new Intl.DateTimeFormat('en-GB', opts).format(new Date(ms));
  } catch (_) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

// When the lock ends, from the 423 body: its lockedUntil, or now plus its
// lockMinutes for a server that sent only that. null when it sent neither.
function lockEnd(body, nowMs) {
  const until = toMs(body?.lockedUntil);
  if (Number.isFinite(until)) return until;
  const minutes = Number(body?.lockMinutes);
  if (Number.isFinite(minutes) && minutes > 0) return nowMs + minutes * 60000;
  return null;
}

// The 423 body read into the alert: when the lock ends (ms), how many whole
// minutes that is from now (never less than one while it lasts), the clock
// time, and the sentence. null when there is no lock left to wait out, so a
// stale body never locks the form.
export function lockMessage(body, now = Date.now(), opts = {}) {
  const nowMs = Number.isFinite(toMs(now)) ? toMs(now) : Date.now();
  const until = lockEnd(body, nowMs);
  if (until === null || until <= nowMs) return null;
  const minutes = Math.max(1, Math.ceil((until - nowMs) / 60000));
  const time = clockTime(until, opts.timeZone);
  return {
    until,
    minutes,
    time,
    text: `Too many failed attempts. This account is locked until ${time} (${minutes} minute${minutes === 1 ? '' : 's'}). `
        + 'If this wasn\'t you, or you can\'t wait, ask your administrator to unlock it.',
  };
}

// The button while the lock lasts: still locked, and m:ss to go. Once the
// moment has passed the button is a Sign in button again.
export function lockCountdown(until, now = Date.now()) {
  const left = toMs(until) - toMs(now);
  if (!Number.isFinite(left) || left <= 0) return { locked: false, text: '' };
  const total = Math.ceil(left / 1000);
  const m = Math.floor(total / 60), s = total % 60;
  return { locked: true, text: `${m}:${String(s).padStart(2, '0')}` };
}
