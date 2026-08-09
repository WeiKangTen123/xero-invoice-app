const jwt = require('jsonwebtoken');

function jwtSecret() {
  return process.env.JWT_SECRET || 'dev-secret-change-in-production';
}

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.user = jwt.verify(token, jwtSecret());
    // Lazily required to avoid a require-cycle at module load (users.js doesn't need
    // this module, but plenty of routes require both). Internally throttled to at
    // most one DB write per user per minute — see users.js#touchLastSeen. Failure
    // here must never turn into a 401 — it's presence tracking, not auth.
    try { require('../utils/users').touchLastSeen(req.user.id); } catch {}
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
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
