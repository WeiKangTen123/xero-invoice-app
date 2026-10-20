// Sign-in sessions: one row per sign-in (the sessions table, db/schema.sql),
// so a person or an admin can see where an account is signed in and end one
// session without ending them all.
//
// Tokens are still stateless JWTs (middleware/auth-middleware.js). What
// changes is that a token minted at a sign-in names its session in a `sid`
// claim, a renewal keeps it, and sessionUser refuses a token whose session has
// been ended. Before this, the only way to end a session was to end all of
// them (users.sessions_valid_from), and Sign out ended nothing at all: the
// browser forgot its token, and a copy of it stayed good for the rest of the
// day.
//
// A row is written at the sign-in, touched at most once a minute while the
// session is in use (like users.js#touchLastSeen), ended by Sign out, a
// revoke, a password change, "sign out everywhere" or disabling the account,
// and deleted 30 days after it was last used.
const crypto = require('crypto');
const db     = require('../db');
const { SESSION_TTL_SECONDS } = require('../middleware/auth-middleware');

// A session is in use while its token can be: a token lives 24 hours and is
// renewed while used (auth-middleware.js), so one last seen more than 24
// hours ago has no token left that works.
const SESSION_LIFETIME_MS = SESSION_TTL_SECONDS * 1000;

// Kept this long after the last use, then deleted (pruneSessions). Long
// enough to answer "was that me last week?"; no longer, because each row
// holds the IP addresses it was used from, which are personal data under
// Singapore's PDPA and are kept only as long as they serve security.
const SESSION_RETENTION_DAYS = 30;

// The browser's description of itself, as kept: enough to tell "Chrome on
// Windows" from "Safari on iPhone", and no more, since the header is whatever
// the client chooses to send.
const USER_AGENT_MAX = 300;

const TOUCH_THROTTLE_MS = 60 * 1000;

// Why a session ended, as stored in ended_reason. 'expired' is never written:
// listSessions reports it for a session that simply ran out.
const END_REASONS = ['logout', 'revoked', 'signed_out_everywhere', 'password_changed', 'disabled', 'expired'];

// Statements are prepared on first use rather than at load, as in
// audit-log.js: in tests the database is created after this module is
// required. isSessionLive runs on every authenticated request.
const _stmts = new Map();
function _stmt(sql) {
  let s = _stmts.get(sql);
  if (!s) { s = db.prepare(sql); _stmts.set(sql, s); }
  return s;
}

// A User-Agent as kept: trimmed and cut to USER_AGENT_MAX, or null when
// there is none.
function _ua(userAgent) {
  const s = String(userAgent ?? '').trim();
  return s ? s.slice(0, USER_AGENT_MAX) : null;
}

// The User-Agent header of a request, as kept. The sign-in records
// (routes/auth.js) use it too, so a session and its sign-in event name the
// browser the same way.
function userAgentOf(req) {
  return _ua(req && typeof req.get === 'function' ? req.get('User-Agent') : req?.headers?.['user-agent']);
}

// In-memory throttle, as users.js#touchLastSeen: a chatty client (the
// dashboard polls every few seconds) must not turn every request into a
// write. At most one UPDATE per session per minute; the address seen in
// between is picked up by the next one.
const _lastTouchWrite = new Map(); // sid -> ms timestamp of last DB write

// A new session for this account, from this address and browser. Returns its
// id, the `sid` the session's tokens carry: 16 random bytes, so one session
// cannot be guessed from another.
function startSession(userId, { ip = null, userAgent = null } = {}) {
  const sid = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const at  = new Date(now).toISOString();
  _stmt(`
    INSERT INTO sessions (id, user_id, created_at, last_seen_at, first_ip, last_ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(sid, String(userId), at, at, ip || null, ip || null, _ua(userAgent));
  // The sign-in itself counts as the first touch.
  _lastTouchWrite.set(sid, now);
  return sid;
}

// Records that the session was used now, from `ip`: at most once a minute
// (the throttle above). Never for an ended session.
function touchSession(sid, { ip = null, now = Date.now() } = {}) {
  if (!sid) return;
  const last = _lastTouchWrite.get(sid) || 0;
  if (now - last < TOUCH_THROTTLE_MS) return;
  _lastTouchWrite.set(sid, now);
  // Every session ever touched would otherwise stay in the map for the life
  // of the process; one not touched for a minute has nothing to throttle.
  if (_lastTouchWrite.size > 1000) {
    for (const [old, at] of _lastTouchWrite) if (now - at >= TOUCH_THROTTLE_MS) _lastTouchWrite.delete(old);
  }
  // An ended session stays as it ended: a request already in flight when it
  // was ended must not make it look used afterwards.
  _stmt('UPDATE sessions SET last_seen_at = ?, last_ip = COALESCE(?, last_ip) WHERE id = ? AND ended_at IS NULL')
    .run(new Date(now).toISOString(), ip || null, String(sid));
}

// Ends one session. `endedBy` is the admin's id when an admin ended it.
// Returns whether a live session was ended: one already ended keeps its
// first reason, which is what happened to it.
function endSession(sid, reason, endedBy = null) {
  if (!sid) return false;
  _lastTouchWrite.delete(sid);
  const { changes } = _stmt('UPDATE sessions SET ended_at = ?, ended_reason = ?, ended_by = ? WHERE id = ? AND ended_at IS NULL')
    .run(new Date().toISOString(), String(reason), endedBy != null ? String(endedBy) : null, String(sid));
  return changes > 0;
}

// Ends every live session of an account, except `except` (the session making
// the request, for a password change or "sign out everywhere", which keep the
// device they were made from signed in). Returns how many were ended.
function endAllSessions(userId, reason, { except = null, endedBy = null } = {}) {
  const { changes } = _stmt('UPDATE sessions SET ended_at = ?, ended_reason = ?, ended_by = ? WHERE user_id = ? AND ended_at IS NULL AND id IS NOT ?')
    .run(new Date().toISOString(), String(reason), endedBy != null ? String(endedBy) : null, String(userId), except != null ? String(except) : null);
  return changes;
}

// Whether a token naming this session may still be used: the session exists
// and has not been ended. Its age is the token's own business (its exp); a
// row pruned away is gone, and so is its session.
function isSessionLive(sid) {
  if (!sid) return false;
  return _stmt('SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL').get(String(sid)) !== undefined;
}

function _session(r, now) {
  const s = {
    sid: r.id, createdAt: r.created_at, lastSeenAt: r.last_seen_at, firstIp: r.first_ip, lastIp: r.last_ip,
    userAgent: r.user_agent, endedAt: r.ended_at, endedReason: r.ended_reason,
  };
  // Nothing ends a session that is simply left: its last token runs out a
  // day after it was last used. Said here rather than written, so the answer
  // does not wait on a sweep.
  if (!s.endedAt) {
    const lastSeen = Date.parse(r.last_seen_at);
    if (Number.isFinite(lastSeen) && lastSeen + SESSION_LIFETIME_MS <= now) {
      s.endedAt = new Date(lastSeen + SESSION_LIFETIME_MS).toISOString();
      s.endedReason = 'expired';
    }
  }
  return s;
}

// One session by its id, with the account it belongs to, or null. For a
// route that acts on one session of a named account (routes/admin.js).
function getSession(sid, now = Date.now()) {
  if (!sid) return null;
  const r = _stmt('SELECT * FROM sessions WHERE id = ?').get(String(sid));
  return r ? { ...(_session(r, now)), userId: r.user_id } : null;
}

// An account's sessions, most recently used first. `active` (the default):
// only those still in use, not ended and used within a token's lifetime.
// `active: false`: every session kept (the last 30 days), ended ones with
// when and why.
function listSessions(userId, { active = true, now = Date.now() } = {}) {
  const rows = active
    ? _stmt('SELECT * FROM sessions WHERE user_id = ? AND ended_at IS NULL AND last_seen_at > ? ORDER BY last_seen_at DESC, created_at DESC')
      .all(String(userId), new Date(now - SESSION_LIFETIME_MS).toISOString())
    : _stmt('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC, created_at DESC').all(String(userId));
  return rows.map(r => _session(r, now));
}

// Deletes sessions last used, or ended, more than 30 days before `now`.
// Returns how many went. Called with the audit prune at boot
// (audit-log.js#pruneOldEvents).
function pruneSessions(now = Date.now()) {
  const cutoff = new Date(now - SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return _stmt('DELETE FROM sessions WHERE last_seen_at < ? OR ended_at < ?').run(cutoff, cutoff).changes;
}

module.exports = {
  startSession, touchSession, endSession, endAllSessions, isSessionLive, getSession, listSessions, pruneSessions,
  userAgentOf, SESSION_LIFETIME_MS, SESSION_RETENTION_DAYS, USER_AGENT_MAX, TOUCH_THROTTLE_MS, END_REASONS,
};
