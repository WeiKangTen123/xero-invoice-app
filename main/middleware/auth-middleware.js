const jwt = require('jsonwebtoken');

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('FATAL SECURITY ERROR: JWT_SECRET must be explicitly set in production environment.');
  }
  return secret || 'dev-secret-change-in-production';
}

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  let claims;
  try {
    claims = jwt.verify(token, jwtSecret());
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  // The token says who; the database says whether they still exist and what
  // they may do. Tokens live seven days, and role/existence used to be read
  // from the token alone, so a deleted or demoted user kept their access for
  // up to a week. One indexed primary-key read per request is cheap.
  //
  // users.js is required lazily to avoid a require-cycle at module load
  // (users.js doesn't need this module, but plenty of routes require both).
  const users = require('../utils/users');
  const live  = users.findById(claims.id);
  if (!live) return res.status(401).json({ error: 'Account no longer exists' });
  req.user = { ...claims, id: live.id, email: live.email, role: live.role };
  // Throttled to at most one DB write per user per minute — see
  // users.js#touchLastSeen. Failure here must never turn into a 401 — it's
  // presence tracking, not auth.
  try { users.touchLastSeen(req.user.id); } catch {}
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

module.exports = { requireAuth, requireAdmin, jwtSecret };
