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
const _states = new Map(); // state -> { userId, data, expiresAt }

function _sweepExpired() {
  const now = Date.now();
  for (const [state, entry] of _states) {
    if (entry.expiresAt <= now) _states.delete(state);
  }
}

// `data` rides along with the state and comes back from consumeEntry: what
// the consent link asked for (xero/oauth.js records which optional scope
// groups), so the callback can tell a scope the person left out from one
// Xero refused. Nothing in it is trusted for anything privileged.
function create(userId, data = {}) {
  _sweepExpired();
  const state = crypto.randomBytes(24).toString('hex');
  _states.set(state, { userId, data: { ...data }, expiresAt: Date.now() + TTL_MS });
  return state;
}

// Single-use: deletes on read regardless of validity, so a leaked/replayed callback
// URL can't be reused even within the TTL window. { userId, data } or null.
function consumeEntry(state) {
  const entry = _states.get(state);
  _states.delete(state);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return { userId: entry.userId, data: { ...entry.data } };
}

function consume(state) {
  const entry = consumeEntry(state);
  return entry ? entry.userId : null;
}

module.exports = { create, consume, consumeEntry };
