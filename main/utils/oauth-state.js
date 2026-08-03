const crypto = require('crypto');

// CSRF-safe `state` for the Xero OAuth2 Authorization Code flow. This app has no
// session/cookie auth (JWT-in-header only), and Xero's callback is a plain browser
// GET with no custom headers — so `state` IS the auth boundary that recovers which
// user this callback belongs to, not just a CSRF nonce layered on top of one.
//
// In-memory only, same philosophy as token-cache.js: short-lived (10 min covers even
// a slow login), single-process, nothing worth persisting — a lost state on restart
// just means the user clicks "Connect" again.
const TTL_MS = 10 * 60 * 1000;
const _states = new Map(); // state -> { userId, expiresAt }

function _sweepExpired() {
  const now = Date.now();
  for (const [state, entry] of _states) {
    if (entry.expiresAt <= now) _states.delete(state);
  }
}

function create(userId) {
  _sweepExpired();
  const state = crypto.randomBytes(24).toString('hex');
  _states.set(state, { userId, expiresAt: Date.now() + TTL_MS });
  return state;
}

// Single-use: deletes on read regardless of validity, so a leaked/replayed callback
// URL can't be reused even within the TTL window.
function consume(state) {
  const entry = _states.get(state);
  _states.delete(state);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.userId;
}

module.exports = { create, consume };
