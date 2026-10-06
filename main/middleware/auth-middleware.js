const jwt = require('jsonwebtoken');

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('FATAL SECURITY ERROR: JWT_SECRET must be explicitly set in production environment.');
  }
  return secret || 'dev-secret-change-in-production';
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

module.exports = { requireAuth, requireAdmin, sessionUser, jwtSecret };
