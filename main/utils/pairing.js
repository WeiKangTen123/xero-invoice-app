const crypto = require('crypto');

// Short-lived pairing tokens that let a phone upload receipts without logging in.
//
// The problem is the same one oauth-state.js solves: a plain browser navigation
// carries no Authorization header, so the token in the URL IS the auth boundary.
// This mirrors that module deliberately — in-memory, swept, single-process.
// A pairing lost to a restart just means the user shows a fresh QR code.
//
// The token grants UPLOAD ONLY for one user. It cannot read an existing receipt,
// list anything, or reach any other route. That is what makes a credential in a
// URL, displayed on screen as a QR code, an acceptable trade.
const TTL_MS = 10 * 60 * 1000;

// Deliberately NOT single-use. A user photographing a stack of receipts should
// scan once and keep shooting; forcing a rescan per receipt would make the
// feature annoying enough to go unused. The exposure is bounded three ways
// instead: a 10-minute life, a cap on uploads, and explicit revocation when the
// desktop closes the dialog.
const MAX_USES = 20;

const _pairings = new Map(); // token -> { userId, expiresAt, uses, lastUploadAt, receiptIds }

function _sweepExpired() {
  const now = Date.now();
  for (const [token, entry] of _pairings) {
    if (entry.expiresAt <= now) _pairings.delete(token);
  }
}

function create(userId) {
  _sweepExpired();
  // 32 bytes: this is a bearer credential, not a nonce, so it is sized to resist
  // guessing rather than just collision.
  const token = crypto.randomBytes(32).toString('base64url');
  _pairings.set(token, { userId: String(userId), expiresAt: Date.now() + TTL_MS, uses: 0, lastUploadAt: null, receiptIds: [] });
  return token;
}

// Returns { userId, usesLeft, expiresInMs } for a live token, else null.
// Does NOT consume — the phone validates before showing a camera, and that
// check must not spend an upload.
function verify(token) {
  _sweepExpired();
  if (!token || typeof token !== 'string') return null;
  const entry = _pairings.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) { _pairings.delete(token); return null; }
  if (entry.uses >= MAX_USES) return null;
  return {
    userId: entry.userId,
    usesLeft: MAX_USES - entry.uses,
    expiresInMs: entry.expiresAt - Date.now(),
    // What arrived through THIS pairing, so the desktop can show the photos
    // rather than only a count.
    receiptIds: entry.receiptIds.slice(),
  };
}

// Call after a successful upload. Returns the updated state, or null if the
// token died between verify and here.
function consume(token, receiptId = null) {
  const entry = _pairings.get(token);
  if (!entry) return null;
  entry.uses += 1;
  entry.lastUploadAt = Date.now();
  if (receiptId) entry.receiptIds.push(receiptId);
  const result = { uses: entry.uses, usesLeft: Math.max(0, MAX_USES - entry.uses), receiptIds: entry.receiptIds.slice() };
  // Hitting the cap ends the pairing, but the desktop still needs one last poll
  // to show what came through, so the entry is kept until it expires naturally.
  return result;
}

// Read-only view for the pairing's OWNER, used to render what arrived. Kept
// separate from verify() on purpose: verify AUTHORISES an upload and must refuse
// a spent token, while this only describes one and can still report a token that
// has used its whole budget. Merging them once let uploads continue past the cap.
function status(token) {
  _sweepExpired();
  const entry = _pairings.get(token);
  if (!entry) return null;
  const alive = entry.expiresAt > Date.now() && entry.uses < MAX_USES;
  return {
    alive,
    spent: entry.uses >= MAX_USES,
    uses: entry.uses,
    usesLeft: Math.max(0, MAX_USES - entry.uses),
    expiresInMs: Math.max(0, entry.expiresAt - Date.now()),
    receiptIds: entry.receiptIds.slice(),
  };
}

// The desktop revokes when the dialog closes, so a QR code that was on screen
// stops working the moment the user is done with it.
function revoke(token) { return _pairings.delete(token); }

// Only the owner may revoke or inspect — a token is not a capability to manage
// other people's pairings.
function ownedBy(token, userId) {
  const entry = _pairings.get(token);
  return !!entry && entry.userId === String(userId);
}

function activeCount() { _sweepExpired(); return _pairings.size; }
function _reset() { _pairings.clear(); }

module.exports = { create, verify, status, consume, revoke, ownedBy, activeCount, TTL_MS, MAX_USES, _reset };
