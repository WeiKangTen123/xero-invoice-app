const jwt = require('jsonwebtoken');

// Tokens are signed with JWT_SECRET and nothing else. There used to be a
// hardcoded fallback for any environment that was not 'production', and this
// repository is public: a server started without NODE_ENV (a manual `node
// main/index.js`, a pm2 start outside ecosystem.config.js) signed and accepted
// tokens anyone could forge as any user, admin included. Only the test suite
// keeps a fallback, so the suite runs on a checkout with no .env.
const TEST_ONLY_SECRET = 'test-only-jwt-secret';

// Shorter than this is guessable offline from one captured token (HS256 with
// a 32-byte secret is the strength the algorithm is built for).
const MIN_JWT_SECRET_LENGTH = 32;

// Values published in this repository: the old fallback and the .env.example
// placeholder. Long enough to pass the length test, and no secret at all.
const PUBLIC_SECRETS = new Set(['dev-secret-change-in-production', 'change_this_to_a_long_random_string']);

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'test') return TEST_ONLY_SECRET;
  // index.js refuses to start without it, so this is the backstop for any
  // other way in (a script, a REPL), not a path a running server takes.
  throw new Error('JWT_SECRET is not set — sessions cannot be signed or verified.');
}

// For the startup check in index.js: { fatal } when there is no secret at all
// (nothing can be signed, so the server must not start), { warning } when
// there is one but it is weak (the server starts — a weak secret still works,
// and refusing to boot over it would turn a hardening gap into an outage).
function jwtSecretProblem(secret) {
  if (!secret) {
    return { fatal: 'JWT_SECRET is not set. Add a long random value to main/.env, e.g. the output of: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"' };
  }
  if (PUBLIC_SECRETS.has(secret)) {
    return { warning: 'JWT_SECRET is a value published in this repository — anyone can forge sessions. Replace it with a long random value.' };
  }
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    return { warning: `JWT_SECRET is only ${secret.length} characters; use at least ${MIN_JWT_SECRET_LENGTH} random characters.` };
  }
  return {};
}

// ── Session tokens ───────────────────────────────────────────────────────────
// A sign-in lasts as long as it is in use, and ends after 24 hours away. Each
// token is good for 24 hours, and once the one a request carries is an hour
// old, requireAuth hands a fresh one back with the response (renewSession
// below), which the browser stores in its place (ui/src/api/client.js). They
// used to be fixed seven-day tokens: someone working all week was thrown out
// mid-task on day seven, and a laptop left signed in stayed signed in for a
// week. The hour means one new token per session per hour rather than one per
// request; the cost is that "24 hours away" can end up to an hour sooner.
const SESSION_TTL_SECONDS         = 24 * 60 * 60;
const SESSION_RENEW_AFTER_SECONDS = 60 * 60;
const SESSION_TOKEN_HEADER        = 'X-Session-Token';

// What a 401 says when the only thing wrong with a token is its age, which is
// what someone coming back the next day meets.
const SESSION_EXPIRED_MESSAGE = 'Your session ended after 24 hours away. Sign in again.';

// Every session token is signed here: sign-in, registration, a password
// change, a renewal. Only the id is relied on; email and role ride along for
// the client, and sessionUser reads both from the database on every request.
// A renewal is marked as one, for the cutoff check in sessionUser.
function signSession(user, { renewed = false } = {}) {
  const claims = { id: user.id, email: user.email, role: user.role };
  if (renewed) claims.renewed = true;
  return jwt.sign(claims, jwtSecret(), { expiresIn: SESSION_TTL_SECONDS });
}

// Every check a session token must pass, in one place: signature and expiry,
// the account still existing, not disabled, and not issued before the
// account's sign-out cutoff. requireAuth uses it, and so must any route that
// reads a session token itself — the invoice PDF route called jwt.verify on
// its own and so still served a disabled account, and a token a password
// reset had signed out.
//
// Returns { user, claims } with the live database row, or { error } with what
// the 401 should say.
function sessionUser(token) {
  if (!token) return { error: 'Authentication required' };
  let claims;
  try {
    claims = jwt.verify(token, jwtSecret());
  } catch (err) {
    // A token that has simply run out is the everyday case (back after a day
    // away) and is said plainly; anything else (a bad signature, a mangled
    // token) keeps the generic wording.
    if (err instanceof jwt.TokenExpiredError) return { error: SESSION_EXPIRED_MESSAGE };
    return { error: 'Invalid or expired token' };
  }
  // The token says who; the database says whether they still exist and what
  // they may do. Role and existence used to be read from the token alone, so a
  // deleted or demoted user kept their access until it ran out, which was up to
  // a week when tokens lived seven days, and with renewal would be for as long
  // as they kept using it. One indexed primary-key read per request is cheap.
  //
  // users.js is required lazily to avoid a require-cycle at module load
  // (users.js doesn't need this module, but plenty of routes require both).
  const live = require('../utils/users').findById(claims.id);
  if (!live) return { error: 'Account no longer exists' };
  if (live.disabled_at) return { error: 'This account has been disabled' };
  // A password change or reset, or an admin's "sign out everywhere", moves
  // sessions_valid_from forward and every token minted before it is refused.
  // Compared at whole seconds, the precision of a JWT's iat: a token issued in
  // the same second as the cutoff (signing straight back in after a reset)
  // must still be accepted.
  //
  // Except a renewed one. A renewal is only made from a token at least an hour
  // old that passed this same check, so none can be made after a cutoff within
  // the cutoff's own second: one stamped with that second was made just BEFORE
  // the cutoff, for a session the cutoff was meant to end. Accepted, it would
  // carry that session past a password reset or "sign out everywhere", and,
  // since renewal slides, keep it going indefinitely.
  if (live.sessions_valid_from && claims.iat !== undefined) {
    const cutoff = Math.floor(Date.parse(live.sessions_valid_from) / 1000);
    if (claims.iat < cutoff || (claims.renewed && claims.iat === cutoff)) {
      return { error: 'You have been signed out. Sign in again.' };
    }
  }
  return { user: live, claims };
}

// Hands a fresh token back in the X-Session-Token header once the one this
// request carried is an hour old. Only called once sessionUser has accepted
// the token, so an expired one, a disabled account or a token from before the
// cutoff is never renewed: those got their 401 first. The cutoff is not
// touched, and the old token stays good until it runs out, so requests already
// in flight with it still succeed. Revocation still reaches renewed tokens: a
// password change or "sign out everywhere" moves the cutoff past them too.
//
// Skipped when the new token would run out no later than the one presented.
// That is only true of the seven-day tokens issued before this change; they
// keep their own end rather than be offered a shorter token the browser would
// discard anyway (client.js keeps whichever runs out last), and are renewed in
// their final day like any other.
//
// Never fails the request: the token presented is good, renewal is a courtesy.
function renewSession(res, live, claims) {
  if (claims.iat === undefined || claims.exp === undefined) return;
  const now = Math.floor(Date.now() / 1000);
  if (now - claims.iat < SESSION_RENEW_AFTER_SECONDS) return;
  if (now + SESSION_TTL_SECONDS <= claims.exp) return;
  try { res.set(SESSION_TOKEN_HEADER, signSession(live, { renewed: true })); } catch {}
}

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '').trim();
  const { user: live, claims, error } = sessionUser(token);
  if (error) return res.status(401).json({ error });
  req.user = { ...claims, id: live.id, email: live.email, role: live.role };
  renewSession(res, live, claims);
  // Throttled to at most one DB write per user per minute — see
  // users.js#touchLastSeen. Failure here must never turn into a 401 — it's
  // presence tracking, not auth.
  try { require('../utils/users').touchLastSeen(req.user.id); } catch {}
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

module.exports = {
  requireAuth, requireAdmin, sessionUser, signSession, jwtSecret, jwtSecretProblem, MIN_JWT_SECRET_LENGTH,
  SESSION_TTL_SECONDS, SESSION_RENEW_AFTER_SECONDS, SESSION_TOKEN_HEADER, SESSION_EXPIRED_MESSAGE,
};
