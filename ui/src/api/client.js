const BASE = '/api';

// Where the server hands back a fresh session token, once the one a request
// carried is a quarter of an hour old (main/middleware/auth-middleware.js
// #renewSession). Tokens last two hours, so storing these is what keeps
// someone who is using the app signed in, up to twelve hours from signing in.
// The API is on this page's own origin, so the header is readable here
// without any CORS exposure.
const SESSION_TOKEN_HEADER = 'X-Session-Token';

// Where someone who must set a new password is sent: the Account page, in
// its set-password mode. The login page goes there on a sign-in that says
// so, the route guard (App.jsx#PrivateRoute) for any other page, and this
// client for a request the server refused for it (below).
export const SET_PASSWORD_PATH = '/account?set-password=1';

// Where an admin without 2-step sign-in is sent: the Account page, in its
// set-up-2-step mode. Sent there the same three ways as above; the server
// answers 403 { code: 'mfa_setup_required' } until it is on.
export const MFA_SETUP_PATH = '/account?setup-2-step=1';

// The page an account must go to before any other, or '' when there is none.
// A password to set comes first, as on the server, which answers
// password_change_required ahead of mfa_setup_required.
export function requiredPath(user) {
  if (user && user.mustChangePassword) return SET_PASSWORD_PATH;
  if (user && user.mfaSetupRequired) return MFA_SETUP_PATH;
  return '';
}

function getToken() {
  return localStorage.getItem('token');
}

// A JWT's claims, read without checking the signature. Only ever used to put
// two tokens in order before storing one; the server verifies every token it
// is sent, so a forged one here gains nothing. null for anything unreadable.
export function tokenClaims(token) {
  try {
    const payload = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload));
  } catch {
    return null;
  }
}

// Which session token to keep: the one stored, or one a response just handed
// back. Two requests sent together can both come back renewed, in either
// order, so the token that runs out last wins and an older one never replaces
// it. Nothing is taken when nothing is stored (signed out while the request was
// out) or when the stored token is another account's (signed in as someone
// else in another tab): the renewal belongs to a session this browser has left.
export function newerSessionToken(stored, offered) {
  if (!stored || !offered) return stored;
  const kept = tokenClaims(stored);
  const fresh = tokenClaims(offered);
  if (!kept || !fresh || kept.id !== fresh.id) return stored;
  return fresh.exp > kept.exp ? offered : stored;
}

// Stores a renewal the response carried, if it is the newer token. Only called
// for a response that worked, after the 401 handling has had its say, so a
// renewal never decides whether a session has ended.
function storeRenewal(res) {
  const offered = res.headers?.get(SESSION_TOKEN_HEADER);
  if (!offered) return;
  const stored = getToken();
  const keep   = newerSessionToken(stored, offered);
  if (keep !== stored) localStorage.setItem('token', keep);
}

// The pages open without a session (App.jsx): nothing on them needs one, so
// a session that has ended is no reason to leave them. The set-password page
// in particular: its address can still carry an invite or reset token in the
// fragment while the session is checked, and sending it on as ?next= would
// put the token in a URL the server logs.
const PUBLIC_PATHS = ['/login', '/capture', '/set-password', '/forgot-password'];

export function isPublicPath(path) {
  const p = String(path || '');
  return PUBLIC_PATHS.some(base => p === base || p.startsWith(`${base}/`) || p.startsWith(`${base}?`));
}

function clearSession() {
  localStorage.removeItem('token');
  // Hard-navigate to login so all React state is wiped — avoids stale UI
  // showing for a split second after an expired-token 401.
  // Phone capture pages (/capture/:token) are deliberately unauthenticated and must never redirect to login.
  // The page being left rides along as ?next=, so signing in again lands back
  // on it — tab, filters and all — instead of on the dashboard. Login checks it
  // is a path on this site before following it (utils/returnTo.js).
  const path = window.location.pathname;
  if (!isPublicPath(path)) {
    const here = `${path}${window.location.search}${window.location.hash}`;
    window.location.href = here === '/' ? '/login' : `/login?next=${encodeURIComponent(here)}`;
  }
}

// The server answers 403 { code: 'password_change_required' } to nearly
// everything while an account is on a temporary password. The session is
// good — the token stays — the person just has to set a password first, so
// they are taken to the form. Hard-navigated like clearSession, so whatever
// page sent the request is dropped rather than left half-loaded; the Account
// page itself is left alone (its own refused requests would otherwise reload
// it in a loop), as are the pages with no session to gate.
function requirePasswordChange() {
  const path = window.location.pathname;
  if (path.startsWith('/account') || isPublicPath(path)) return;
  window.location.href = SET_PASSWORD_PATH;
}

// The same for 403 { code: 'mfa_setup_required' }: an admin who has not set
// up 2-step sign-in is taken to the Account page to do it, token kept, and
// the Account page is left alone for the same reason.
function requireMfaSetup() {
  const path = window.location.pathname;
  if (path.startsWith('/account') || isPublicPath(path)) return;
  window.location.href = MFA_SETUP_PATH;
}

// Sign-in, registration, sign-out and the rest of the session's own routes
// (main/routes/auth.js), the query string aside.
export function isAuthPath(path) {
  return /^\/auth(\/|$|\?)/.test(String(path || ''));
}

async function request(path, options = {}, retried = false) {
  const token   = getToken();
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res  = await fetch(`${BASE}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (res.status === 401) {
      // A 401 is about the token this request carried, which may no longer be
      // the one stored. Changing the password moves a cutoff on the server that
      // rejects the old token; a status poll sent with it (from this tab or any
      // other, they share localStorage) can get its 401 back after the new token
      // was stored, and clearing then would throw away a good session. So when
      // the token has changed under us, ask again once with the current one: the
      // auth middleware answers 401 before any handler runs, so nothing happened
      // the first time. Only a rejection of the token still stored ends the
      // session; if it moved yet again during the retry, the newer one is left
      // for its own requests to judge.
      //
      // Never for /auth/*: there a 401 is the answer, not the token's fault.
      // A wrong password sent while another tab stored a token was sent
      // again, and counted twice towards the lock.
      const current = getToken();
      if (current && current !== token) {
        if (!retried && !isAuthPath(path)) return request(path, options, true);
      } else {
        clearSession();
      }
    } else if (res.status === 403 && data.code === 'password_change_required') {
      requirePasswordChange();
    } else if (res.status === 403 && data.code === 'mfa_setup_required') {
      requireMfaSetup();
    }
    // A 401 throws too. On most pages the navigation above wins the race and
    // the caller never runs; on /login (no navigation) a wrong password used to
    // come back as `undefined` and blow up as "cannot read 'token'" instead of
    // the server's own message.
    // The reason is in `error` on most routes and in `message` on Setup's
    // Test buttons (routes/setup.js answers { success: false, message }).
    // Read either: reading only `error` showed every failed test as a bare
    // "HTTP 400" and hid why it failed.
    const reason = data.error || data.message;
    const err    = new Error(reason || (res.status === 401 ? 'Your session has expired. Sign in again.' : `HTTP ${res.status}`));
    err.status   = res.status;
    // The body as well as its message: a 423 from sign-in carries when the
    // lock ends (lockedUntil, lockMinutes), which the login page counts down.
    err.code     = data.code;
    err.body     = data;
    throw err;
  }
  storeRenewal(res);
  return data;
}

// ── Confirm it's you ─────────────────────────────────────────────────────────
// The sensitive admin actions (inviting or promoting an admin; a reset link,
// password reset or deletion of an admin; resetting someone's 2-step
// sign-in) answer 403 { code: 'reauth_required' } when this session has not
// proved lately who is at the keyboard. Every call gets the same answer to
// it, so no page handles it: a provider (context/ReauthContext.jsx) registers
// what asks, which resolves true once POST /auth/reauth has gone through and
// false when the person cancels. The request is then sent once more; on a
// cancel the caller gets the original error. Without a provider the error
// goes to the caller as it came.
const REAUTH_PATH = '/auth/reauth';
let reauthHandler = null;
let reauthAsking  = null;

// Registers the asker; returns what unregisters it (an effect's cleanup).
export function setReauthHandler(fn) {
  reauthHandler = typeof fn === 'function' ? fn : null;
  return () => { if (reauthHandler === fn) reauthHandler = null; };
}

// A refusal the asker answers. Never the reauth request itself: a wrong
// password there is the dialog's to say.
export function needsReauth(err, path) {
  return !!err && err.status === 403 && err.code === 'reauth_required'
    && !String(path || '').startsWith(REAUTH_PATH);
}

// One question at a time: requests refused together wait on the same one,
// and each is sent again once it is answered. A handler that throws counts
// as a cancel.
function confirmIdentity(err) {
  if (!reauthAsking) {
    reauthAsking = Promise.resolve()
      .then(() => reauthHandler(err))
      .then(ok => ok === true, () => false)
      .finally(() => { reauthAsking = null; });
  }
  return reauthAsking;
}

async function send(path, options) {
  try {
    return await request(path, options);
  } catch (err) {
    if (!reauthHandler || !needsReauth(err, path)) throw err;
    if (!(await confirmIdentity(err))) throw err;
    // Once: a second refusal goes to the caller.
    return request(path, options);
  }
}

export const api = {
  get:    (path)       => send(path),
  post:   (path, body) => send(path, { method: 'POST',   body: JSON.stringify(body) }),
  patch:  (path, body) => send(path, { method: 'PATCH',  body: JSON.stringify(body) }),
  // A whole record replaced: the Cash Flow Manager's bank options and the
  // change made to one forecast item.
  put:    (path, body) => send(path, { method: 'PUT',    body: JSON.stringify(body) }),
  delete: (path)       => send(path, { method: 'DELETE' }),
};
