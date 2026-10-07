const jwt = require('jsonwebtoken');
const { jwtSecret } = require('./auth-middleware');
const pairing = require('../utils/pairing');

// Which requests share one rate-limit bucket.
//
// One bucket per signed-in user, so a shared office IP does not throttle
// everyone at once. Two kinds of request carry no login and are still
// somebody's:
//   * a phone-capture link, whose token is the only identity it has, so each
//     link gets its own bucket rather than joining the office IP's — one
//     phone polling for its receipts must not drain the desktop users beside it
//   * a receipt image, fetched by an <img> that cannot send a header, so it
//     carries a short-lived token in its query string instead; those go to a
//     bucket of the account the image belongs to, apart from its API calls,
//     because a dialog of thumbnails is many requests that cost almost nothing
// Everything else falls back to the IP.
//
// A token earns its own bucket only when it is real. Keying on whatever was
// in the URL gave every made-up /capture/<x> a fresh 500 requests, so the
// limit stopped anyone who simply varied the path; an unknown or dead token
// now counts against its IP like any other anonymous request.
function _imageBucket(req, invoiceId) {
  const token = req.query && req.query.token;
  if (typeof token !== 'string' || !token) return null;
  try {
    // The same scope routes/receipts.js checks: a receipt token, for THIS receipt.
    const p = jwt.verify(token, jwtSecret());
    return p.purpose === 'receipt' && p.invoiceId === invoiceId && p.userId ? `image:${p.userId}` : null;
  } catch { return null; }
}

function rateLimitKey(req) {
  const path = req.path || '';

  const capture = /^\/api\/receipts\/capture\/([^/]+)/.exec(path);
  if (capture && pairing.isLive(capture[1])) return `capture:${capture[1]}`;

  const image = /^\/api\/receipts\/([^/]+)\/image$/.exec(path);
  const imageKey = image && _imageBucket(req, image[1]);
  if (imageKey) return imageKey;

  const auth = (req.headers && req.headers.authorization) || '';
  if (auth.startsWith('Bearer ')) {
    try { return `user:${jwt.verify(auth.slice(7), jwtSecret()).id}`; } catch { /* not ours; use the IP */ }
  }
  return `ip:${req.ip}`;
}

module.exports = { rateLimitKey };
