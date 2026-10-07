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
  } catch {
    return { error: 'Invalid or expired token' };
  }
  // The token says who; the database says whether they still exist and what
  // they may do. Tokens live seven days, and role/existence used to be read
  // from the token alone, so a deleted or demoted user kept their access for
  // up to a week. One indexed primary-key read per request is cheap.
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
  if (live.sessions_valid_from && claims.iat !== undefined
      && claims.iat < Math.floor(Date.parse(live.sessions_valid_from) / 1000)) {
    return { error: 'You have been signed out. Sign in again.' };
  }
  return { user: live, claims };
}

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '').trim();
  const { user: live, claims, error } = sessionUser(token);
  if (error) return res.status(401).json({ error });
  req.user = { ...claims, id: live.id, email: live.email, role: live.role };
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

module.exports = { requireAuth, requireAdmin, sessionUser, jwtSecret, jwtSecretProblem, MIN_JWT_SECRET_LENGTH };
