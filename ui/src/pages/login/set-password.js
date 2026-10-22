// The set-password page (pages/SetPassword.jsx): where an invite or a
// password-reset link lands, /set-password#t=<token>. The page cannot be
// rendered on every machine this is worked on, so what it decides (the token
// in the address, which screen to show for the server's answer, the words on
// each) lives here, imports nothing, and main/scripts/set-password-ui.test.js
// runs it as it is.
//
// The token rides in the fragment, which a browser never sends to a server:
// it stays out of access logs and out of the Referer header. The page reads
// it once and takes it out of the address bar straight away, so it is not
// left in the history or on a shared screen.

// The token from `location.hash`: "#t=<token>", alone or among other
// parameters. Read by hand rather than by URLSearchParams, which turns a "+"
// into a space. '' when there is none, or nothing a token could be.
export function tokenFromHash(hash) {
  const text = String(hash || '').replace(/^#/, '');
  for (const part of text.split('&')) {
    if (!part.startsWith('t=')) continue;
    let value = part.slice(2);
    try { value = decodeURIComponent(value); } catch (_) { return ''; }
    value = value.trim();
    return value && value.length <= 512 && !/\s/.test(value) ? value : '';
  }
  return '';
}

// ── What the page shows ──────────────────────────────────────────────────────
// checking → form, or dead (the link cannot be used: invalid, expired, used),
// or failed (the server could not be asked; Retry asks again) → done.
export const LINK_CHECKING = 'checking';
export const LINK_FORM     = 'form';
export const LINK_DEAD     = 'dead';
export const LINK_FAILED   = 'failed';
export const LINK_DONE     = 'done';

const REASONS = ['invalid', 'expired', 'used'];

// A link the server knows (POST /auth/link-info → 200): who it is for and
// what for. An invite unless the server says reset.
export function linkFromAnswer(body) {
  const b = body || {};
  return {
    state:     LINK_FORM,
    purpose:   b.purpose === 'reset' ? 'reset' : 'invite',
    email:     typeof b.email === 'string' ? b.email : '',
    invitedBy: typeof b.invitedBy === 'string' && b.invitedBy.trim() ? b.invitedBy.trim() : null,
    expiresAt: b.expiresAt || null,
  };
}

// A refusal, from link-info or from set-password. 410 is the link itself:
// invalid, expired or used, with the server's own words. A 400 or 404 about
// the link reads the same. Anything else (the server down, too many tries)
// is not the link's fault, and the page offers to ask again.
export function linkFromError(err) {
  const status = err && err.status;
  const body   = (err && err.body) || {};
  const said   = typeof body.error === 'string' && body.error.trim() ? body.error.trim() : '';
  if (status === 410 || status === 404 || (status === 400 && REASONS.includes(body.reason))) {
    return {
      state:   LINK_DEAD,
      reason:  REASONS.includes(body.reason) ? body.reason : 'invalid',
      // A server that says which kind of link it was helps the page offer
      // the right way on; without it, both are offered.
      purpose: body.purpose === 'reset' || body.purpose === 'invite' ? body.purpose : null,
      message: said || 'This link cannot be used.',
    };
  }
  return { state: LINK_FAILED, message: (err && err.message) || 'Could not reach the server.' };
}

// The page opened with no token at all: reloaded after the address was
// cleared, or a link cut short when it was copied.
export const NO_TOKEN = {
  state:   LINK_DEAD,
  reason:  'invalid',
  purpose: null,
  message: 'This page needs the whole link from your email. Open the link again; if you reloaded this page, the link was taken out of the address for safety.',
};

// The heading and the ways on for a link that cannot be used. `forgot`
// offers /forgot-password (a reset link that ran out: the person can get a
// new one themselves); `signIn` offers the sign-in page (a used link has
// most likely already set the password); `hint` says what else to do.
export function deadLinkView(reason, purpose) {
  if (reason === 'used') {
    return { title: 'This link has already been used', forgot: false, signIn: true, hint: 'If you set your password with it, sign in with that password.' };
  }
  if (reason === 'expired') {
    if (purpose === 'invite') return { title: 'This invite has expired', forgot: false, signIn: false, hint: 'Ask whoever invited you to send a new one.' };
    if (purpose === 'reset')  return { title: 'This link has expired', forgot: true, signIn: false, hint: '' };
    return { title: 'This link has expired', forgot: true, signIn: false, hint: 'For an invite, ask whoever invited you to send a new one.' };
  }
  return { title: 'This link doesn\'t work', forgot: false, signIn: true, hint: 'Check you opened the whole link, or ask your administrator for a new one.' };
}

// The form's heading and button, by what the link is for.
export function formText(link) {
  const l = link || {};
  if (l.purpose === 'reset') {
    return { title: 'Choose a new password', subtitle: 'For the account below. The link works once.', button: 'Set new password' };
  }
  return {
    title:    'Welcome — set your password',
    subtitle: l.invitedBy ? `Invited by ${l.invitedBy}` : 'You have been invited to Financial Automation.',
    button:   'Set password',
  };
}

// The password's problem is said once the field has been left, or the form
// sent; never on the first keystroke, when every password is still too short.
// Once said, it follows the typing, and goes as soon as the password passes.
export function shownProblem(problem, { touched = false, submitted = false } = {}) {
  return problem && (touched || submitted) ? problem : '';
}

// The sign-in page, with the address filled in for them.
export function signInPath(email) {
  const e = typeof email === 'string' ? email.trim() : '';
  return e ? `/login?email=${encodeURIComponent(e)}` : '/login';
}

// What the page says once the password is set. The server does not sign
// anyone in: they sign in with the new password, which is also what has a
// password manager save it. Someone still signed in on this browser as
// another account is signed out of it on the way.
export function doneText(email, signedInAs) {
  const other = typeof signedInAs === 'string' && signedInAs && email
    && signedInAs.trim().toLowerCase() !== String(email).trim().toLowerCase();
  return {
    title:  'Password set',
    text:   'Password set. Sign in with your new password.',
    button: 'Sign in',
    note:   other ? `You are signed in here as ${signedInAs}. Signing in as ${email} signs that session out.` : '',
  };
}
