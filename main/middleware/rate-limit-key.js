const jwt = require('jsonwebtoken');
const { jwtSecret } = require('./auth-middleware');

// Which requests share one rate-limit bucket.
//
// One bucket per signed-in user, so a shared office IP does not throttle
// everyone at once. A phone-capture link carries no login; its token is the
// only identity it has, so each link gets its own bucket rather than joining
// the office IP's — one phone polling for its receipts must not drain the
// desktop users beside it. Everything else falls back to the IP.
function rateLimitKey(req) {
  const capture = /^\/api\/receipts\/capture\/([^/]+)/.exec(req.path || '');
  if (capture) return `capture:${capture[1]}`;

  const auth = (req.headers && req.headers.authorization) || '';
  if (auth.startsWith('Bearer ')) {
    try { return `user:${jwt.verify(auth.slice(7), jwtSecret()).id}`; } catch { /* not ours; use the IP */ }
  }
  return `ip:${req.ip}`;
}

module.exports = { rateLimitKey };
