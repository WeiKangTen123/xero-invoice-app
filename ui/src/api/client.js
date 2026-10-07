const BASE = '/api';

// Where the server hands back a fresh session token, once the one a request
// carried is an hour old (main/middleware/auth-middleware.js#renewSession).
// Tokens last 24 hours, so storing these is what keeps someone who is using
// the app signed in. The API is on this page's own origin, so the header is
// readable here without any CORS exposure.
const SESSION_TOKEN_HEADER = 'X-Session-Token';

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

function clearSession() {
  localStorage.removeItem('token');
  // Hard-navigate to login so all React state is wiped — avoids stale UI
  // showing for a split second after an expired-token 401.
  // Phone capture pages (/capture/:token) are deliberately unauthenticated and must never redirect to login.
  // The page being left rides along as ?next=, so signing in again lands back
  // on it — tab, filters and all — instead of on the dashboard. Login checks it
  // is a path on this site before following it (utils/returnTo.js).
  const path = window.location.pathname;
  if (!path.startsWith('/login') && !path.startsWith('/capture')) {
    const here = `${path}${window.location.search}${window.location.hash}`;
    window.location.href = here === '/' ? '/login' : `/login?next=${encodeURIComponent(here)}`;
  }
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
      const current = getToken();
      if (current && current !== token) {
        if (!retried) return request(path, options, true);
      } else {
        clearSession();
      }
    }
    // A 401 throws too. On most pages the navigation above wins the race and
    // the caller never runs; on /login (no navigation) a wrong password used to
    // come back as `undefined` and blow up as "cannot read 'token'" instead of
    // the server's own message.
    const err    = new Error(data.error || (res.status === 401 ? 'Your session has expired. Sign in again.' : `HTTP ${res.status}`));
    err.status   = res.status;
    throw err;
  }
  storeRenewal(res);
  return data;
}

export const api = {
  get:    (path)       => request(path),
  post:   (path, body) => request(path, { method: 'POST',   body: JSON.stringify(body) }),
  patch:  (path, body) => request(path, { method: 'PATCH',  body: JSON.stringify(body) }),
  delete: (path)       => request(path, { method: 'DELETE' }),
};
