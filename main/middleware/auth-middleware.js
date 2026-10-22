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
// A sign-in lasts while it is in use, ends after two hours away, and ends
// twelve hours after the sign-in whatever happens. Each token is good for two
// hours, and once the one a request carries is a quarter of an hour old,
// requireAuth hands a fresh one back with the response (renewSession below),
// which the browser stores in its place (ui/src/api/client.js). The quarter
// hour means one new token per session every fifteen minutes rather than one
// per request; the cost is that "two hours away" can end up to fifteen
// minutes sooner.
//
// Tokens used to live 24 hours and renew for ever, so a laptop left signed in
// at the office was still signed in the next morning, and a session in daily
// use never had to show its password again. The twelve hours are counted from
// the session's own start (sessions.created_at, utils/sessions.js), which no
// token can move: a renewal never runs past it, and a token that would is
// refused at it. A working day fits; the next day is a new sign-in.
const SESSION_TTL_SECONDS         = 2 * 60 * 60;
const SESSION_MAX_AGE_SECONDS     = 12 * 60 * 60;
const SESSION_RENEW_AFTER_SECONDS = 15 * 60;
const SESSION_TOKEN_HEADER        = 'X-Session-Token';

// What a 401 says when the only thing wrong with a token is its age, which is
// what someone coming back from a long meeting or the next day meets.
const SESSION_EXPIRED_MESSAGE = 'Your session ended after 2 hours without use. Sign in again.';

// What a 401 says when the session has reached its twelve hours.
const SESSION_MAX_AGE_MESSAGE = 'Your session ended 12 hours after you signed in. Sign in again.';

// What a 401 says when the session was ended on purpose: Sign out, an admin
// ending it, a password change or "sign out everywhere".
const SIGNED_OUT_MESSAGE = 'You have been signed out. Sign in again.';

// What a 401 says to a token that names no session: one minted before
// sessions were kept, renewed ever since without one.
const SESSION_ENDED_MESSAGE = 'Your session has ended. Sign in again.';

// The test suite's hand-made tokens name no session (hundreds of them, across
// the route tests), and are accepted while it runs: under NODE_ENV=test, whose
// database is an empty one in memory (db/index.js), so there is no account
// anywhere such a token could reach. On any server a token with no session is
// refused; the tests that pin that run as one (NODE_ENV=production).
function acceptsTokensWithoutSession() {
  return process.env.NODE_ENV === 'test';
}

// Every session token is signed here: sign-in, registration, a password
// change, a renewal. Only the id is relied on; email and role ride along for
// the client, and sessionUser reads both from the database on every request.
// A renewal is marked as one, for the cutoff check in sessionUser.
//
// `sid` names the session the token belongs to (utils/sessions.js): a new one
// at each sign-in, the same one for a renewal or the token a password change
// hands back, since those are the same session on the same device. Its token
// runs out two hours from now or at the session's twelfth hour, whichever is
// sooner; `startedAt` (ms) is when the session began, read from its row when
// the caller does not have it to hand.
function signSession(user, { renewed = false, sid = null, startedAt = null } = {}) {
  const claims = { id: user.id, email: user.email, role: user.role };
  if (sid) claims.sid = String(sid);
  if (renewed) claims.renewed = true;
  let expiresIn = SESSION_TTL_SECONDS;
  if (sid) {
    const started = startedAt ?? require('../utils/sessions').liveSession(sid)?.startedAt;
    if (Number.isFinite(started)) {
      const left = Math.floor((started + SESSION_MAX_AGE_SECONDS * 1000 - Date.now()) / 1000);
      // At least a second: a token is never minted already dead, and one
      // signed at the very end is refused at the next request anyway.
      expiresIn = Math.max(1, Math.min(SESSION_TTL_SECONDS, left));
    }
  }
  return jwt.sign(claims, jwtSecret(), { expiresIn });
}

// Every check a session token must pass, in one place: signature and expiry,
// the account still existing, not disabled, and not issued before the
// account's sign-out cutoff. requireAuth uses it, and so must any route that
// reads a session token itself — the invoice PDF route called jwt.verify on
// its own and so still served a disabled account, and a token a password
// reset had signed out.
//
// Returns { user, claims, session } with the live database row and the
// session's { userId, startedAt } (null only for a test suite token, above),
// or { error } with what the 401 should say.
function sessionUser(token) {
  if (!token) return { error: 'Authentication required' };
  let claims;
  try {
    // HS256 named outright, the one algorithm signSession uses: the library
    // would otherwise take the algorithm a token says it was signed with.
    claims = jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] });
  } catch (err) {
    // A token that has simply run out is the everyday case (back after a
    // lunch away) and is said plainly; anything else (a bad signature, a
    // mangled token) keeps the generic wording.
    if (err instanceof jwt.TokenExpiredError) return { error: expiredMessage(token) };
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
  // Except a renewed one. A renewal is only made from a token at least a
  // quarter hour old that passed this same check, so none can be made after a cutoff within
  // the cutoff's own second: one stamped with that second was made just BEFORE
  // the cutoff, for a session the cutoff was meant to end. Accepted, it would
  // carry that session past a password reset or "sign out everywhere", and,
  // since renewal slides, keep it going indefinitely.
  if (live.sessions_valid_from && claims.iat !== undefined) {
    const cutoff = Math.floor(Date.parse(live.sessions_valid_from) / 1000);
    if (claims.iat < cutoff || (claims.renewed && claims.iat === cutoff)) {
      return { error: SIGNED_OUT_MESSAGE };
    }
  }
  // A token minted at a sign-in names its session, and is good only while
  // that session is: Sign out or an admin ending it ends the token with it,
  // where before a copy of a signed-out token worked for the rest of its day.
  // And only for twelve hours from the sign-in, however often it was renewed.
  // One primary-key read, like the one above. Lazily required, as users.js is.
  //
  // A token with no sid was issued before sessions were kept, and renewal
  // kept it going without one: nothing could end it but a password change,
  // and nothing bounded it. It is refused (but see acceptsTokensWithoutSession).
  if (!claims.sid) {
    if (!acceptsTokensWithoutSession()) return { error: SESSION_ENDED_MESSAGE };
    return { user: live, claims, session: null };
  }
  const session = require('../utils/sessions').liveSession(claims.sid);
  if (!session || String(session.userId) !== String(live.id)) return { error: SIGNED_OUT_MESSAGE };
  if (Date.now() >= session.startedAt + SESSION_MAX_AGE_SECONDS * 1000) return { error: SESSION_MAX_AGE_MESSAGE };
  return { user: live, claims, session };
}

// The words for a token that has run out: its two hours away, or, for a
// token whose life was cut short to end with its session (signSession), the
// session's twelve hours. Read from the token's own times, verified as above
// but for the expiry; anything unreadable is the everyday case.
function expiredMessage(token) {
  try {
    const { iat, exp } = jwt.verify(token, jwtSecret(), { algorithms: ['HS256'], ignoreExpiration: true });
    if (Number.isFinite(iat) && Number.isFinite(exp) && exp - iat < SESSION_TTL_SECONDS) return SESSION_MAX_AGE_MESSAGE;
  } catch {}
  return SESSION_EXPIRED_MESSAGE;
}

// Hands a fresh token back in the X-Session-Token header once the one this
// request carried is a quarter of an hour old. Only called once sessionUser
// has accepted the token, so an expired one, a disabled account, a token from
// before the cutoff or a session past its twelve hours is never renewed: those
// got their 401 first. The cutoff is not touched, and the old token stays good
// until it runs out, so requests already in flight with it still succeed.
// Revocation still reaches renewed tokens: a password change or "sign out
// everywhere" moves the cutoff past them too, and the renewal keeps the
// session's sid, so ending the session ends it.
//
// The new token runs out two hours from now or at the session's twelfth hour,
// whichever is sooner (signSession), and is skipped when that is no later than
// the token presented: in a session's last two hours nothing later can be
// offered, and a 24-hour token from before this change keeps its own end (it
// is refused at the twelfth hour all the same) rather than be offered a
// shorter one the browser would discard anyway (client.js keeps whichever runs
// out last). A token with no session (the test suite's) is not renewed.
//
// Never fails the request: the token presented is good, renewal is a courtesy.
function renewSession(res, live, claims, session) {
  if (!session || claims.iat === undefined || claims.exp === undefined) return;
  const now = Math.floor(Date.now() / 1000);
  if (now - claims.iat < SESSION_RENEW_AFTER_SECONDS) return;
  const sessionEnds = Math.floor((session.startedAt + SESSION_MAX_AGE_SECONDS * 1000) / 1000);
  if (Math.min(now + SESSION_TTL_SECONDS, sessionEnds) <= claims.exp) return;
  try {
    res.set(SESSION_TOKEN_HEADER, signSession(live, { renewed: true, sid: claims.sid, startedAt: session.startedAt }));
  } catch {}
}

// ── A temporary password must be replaced first ──────────────────────────────
// An account signed in with a password an admin set (users.js: must_change_
// password) may do one thing: choose its own. Every other route answers 403
// with a code the client turns into the change-password screen, and that
// screen needs only these: the change itself, who am I, sign out, and the
// account's own sign-in history (the Account page shows it beside the form).
// Keyed by method and the full path as mounted in index.js, so a router
// mounted elsewhere, or a GET added to a POST-only path, is gated until it is
// named here.
const PASSWORD_CHANGE_ALLOWED = new Set([
  'POST /api/auth/change-password',
  'GET /api/auth/me',
  'POST /api/auth/logout',
  'GET /api/auth/sign-ins',
]);
const PASSWORD_CHANGE_REQUIRED = { error: 'Set a new password to continue.', code: 'password_change_required' };

// Whether this request may run while the account's password is temporary.
// The query string and a trailing slash are not part of the route.
function allowedBeforePasswordChange(method, url) {
  const path = String(url || '').split('?')[0].replace(/\/+$/, '') || '/';
  return PASSWORD_CHANGE_ALLOWED.has(`${String(method || '').toUpperCase()} ${path}`);
}

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '').trim();
  const { user: live, claims, session, error } = sessionUser(token);
  if (error) return res.status(401).json({ error });
  // The 403 comes after every 401: a dead session is a dead session, whatever
  // the password. A 403 rather than a 401 because the client treats every 401
  // as a session that has ended and goes back to the login page, which is
  // exactly where this must not send someone who has just signed in.
  if (live.must_change_password && !allowedBeforePasswordChange(req.method, req.originalUrl || req.url)) {
    return res.status(403).json(PASSWORD_CHANGE_REQUIRED);
  }
  // `demo` rides along for GET /api/auth/me: the client hides the Xero
  // connection behind it (users.js isDemoUser). `sid` is the session this
  // request belongs to (null only for the test suite's tokens, above), for
  // Sign out and for the routes that keep this session while ending others.
  req.user = {
    ...claims, id: live.id, email: live.email, role: live.role, mustChangePassword: !!live.must_change_password,
    passwordChangeReason: require('../utils/users').passwordChangeReason(live),
    demo: !!live.is_demo, sid: claims.sid || null,
  };
  renewSession(res, live, claims, session);
  // Throttled to at most one DB write per user per minute — see
  // users.js#touchLastSeen. Failure here must never turn into a 401 — it's
  // presence tracking, not auth.
  try { require('../utils/users').touchLastSeen(req.user.id); } catch {}
  // The session's own last use and address, throttled the same way
  // (sessions.js#touchSession), and as harmless to skip.
  if (req.user.sid) {
    try { require('../utils/sessions').touchSession(req.user.sid, { ip: req.ip || null }); } catch {}
  }
  // Everything this request goes on to do runs as this person, so a record
  // it changes says who changed it (utils/audit-context.js).
  require('../utils/audit-context').runForRequest(req, next);
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
  SESSION_TTL_SECONDS, SESSION_MAX_AGE_SECONDS, SESSION_RENEW_AFTER_SECONDS, SESSION_TOKEN_HEADER,
  SESSION_EXPIRED_MESSAGE, SESSION_MAX_AGE_MESSAGE, SIGNED_OUT_MESSAGE, SESSION_ENDED_MESSAGE,
  allowedBeforePasswordChange, PASSWORD_CHANGE_ALLOWED, PASSWORD_CHANGE_REQUIRED,
};
