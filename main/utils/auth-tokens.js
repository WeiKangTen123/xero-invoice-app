// Single-use links that let a person choose a password: an admin's invite to
// a new account, and a password reset (the auth_tokens table, db/schema.sql).
// Before these, an admin typed a temporary password and handed it over by
// chat, and someone who forgot theirs had to ask an admin for another. Built
// to OWASP's Forgot Password Cheat Sheet:
//
//   * the token is 32 random bytes (base64url), so it cannot be guessed, and
//     only its SHA-256 is stored: a backup or a read of the table holds no
//     link that works. A plain hash is enough for 256 random bits; a slow
//     password hash is for secrets a person chose.
//   * a link works once (consume), and a newer link of the same kind for the
//     same account replaces the older (issue deletes it)
//   * a link is dead once the account's address changes from the one it was
//     sent to, or the account is disabled (peek)
//   * it lives as long as it needs to and no longer: an invite a week, a
//     reset a person asked for half an hour, one an admin sent a day
//   * a password set by any other way kills every unused link of the
//     account (users.js#voidPendingLinks)
//
// The link itself puts the token in the URL fragment (utils/mailer.js
// linkFor), which a browser never sends to a server: neither this server's
// access log nor an email provider's link scanner sees it. The page posts it.
const crypto = require('crypto');
const db     = require('../db');

const PURPOSES = ['invite', 'reset'];

const MINUTE_MS = 60 * 1000;
const HOUR_MS   = 60 * MINUTE_MS;
const DAY_MS    = 24 * HOUR_MS;

// How long each kind of link works. An invite waits a week for someone to
// open their mail; a reset the person asked for is used at once or not at
// all; one an admin sent may be read the next morning.
const INVITE_TTL_MS      = 7 * DAY_MS;
const RESET_TTL_MS       = 30 * MINUTE_MS;
const ADMIN_RESET_TTL_MS = 24 * HOUR_MS;

// Used and expired rows are kept this long, so a link opened late still says
// "already used" or "expired" rather than "not valid", then go (prune).
const RETENTION_DAYS = 30;

// A token as issue makes it: 32 bytes in base64url, 43 characters. Anything
// else is not one of ours, and is refused before it is hashed.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Statements are prepared on first use, as in audit-log.js: in tests the
// database is created after this module is required.
const _stmts = new Map();
function _stmt(sql) {
  let s = _stmts.get(sql);
  if (!s) { s = db.prepare(sql); _stmts.set(sql, s); }
  return s;
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// A new link for this account: its raw token, which is never stored and
// cannot be had again. Every earlier unused link of the same kind for the
// account is deleted in the same transaction, so a re-sent invite or a second
// "forgot password" leaves one link that works, the newest. `ttlMs` is how
// long it works (INVITE_TTL_MS and so on); `createdBy` the admin's id, or
// null for a link the person asked for; `now` (ms) for the tests. It is sent
// for the account's current address, and dies if that changes (peek).
function issue(userId, purpose, { ttlMs, createdBy = null, now = Date.now() } = {}) {
  if (!PURPOSES.includes(purpose)) throw new Error(`Unknown link purpose: ${purpose}`);
  if (!(Number(ttlMs) > 0)) throw new Error('A link needs a lifetime');
  const raw = crypto.randomBytes(32).toString('base64url');
  db.transaction(() => {
    const user = _stmt('SELECT id, email FROM users WHERE id = ?').get(String(userId));
    if (!user) throw new Error('User not found');
    _stmt('DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL').run(String(userId), purpose);
    _stmt(`
      INSERT INTO auth_tokens (user_id, purpose, token_hash, email, created_by, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(String(userId), purpose, hashToken(raw), user.email, createdBy != null ? String(createdBy) : null,
      new Date(now).toISOString(), new Date(now + Number(ttlMs)).toISOString());
  }).immediate();
  return raw;
}

// What a link is, without using it: { ok: true, purpose, userId, email,
// expiresAt, createdBy }, or { ok: false, reason } where reason is
//   'invalid'  not one of ours, replaced by a newer one, revoked, for an
//              account that has gone, been disabled or changed its address,
//              or an invite for an account that already has a password
//   'used'     it worked once already
//   'expired'  it ran out
// A failure names the purpose too when the link was found, so the page can
// say "ask your administrator" for an invite and "request a new one" for a
// reset. Read-only.
function peek(raw, { now = Date.now() } = {}) {
  if (typeof raw !== 'string' || !TOKEN_PATTERN.test(raw)) return { ok: false, reason: 'invalid' };
  const row = _stmt('SELECT * FROM auth_tokens WHERE token_hash = ?').get(hashToken(raw));
  return _judge(row, now);
}

function _judge(row, now) {
  if (!row) return { ok: false, reason: 'invalid' };
  const purpose = row.purpose;
  if (row.used_at) return { ok: false, reason: 'used', purpose };
  const user = _stmt('SELECT id, email, password, disabled_at FROM users WHERE id = ?').get(row.user_id);
  if (!user || user.disabled_at || user.email !== row.email) return { ok: false, reason: 'invalid', purpose };
  // An invite is for an account with no password yet, and a reset for one
  // with a password: the other way round, something set it meanwhile.
  const invited = user.password === require('./users').INVITED_PASSWORD;
  if ((purpose === 'invite') !== invited) return { ok: false, reason: 'invalid', purpose };
  if (!(Date.parse(row.expires_at) > now)) return { ok: false, reason: 'expired', purpose };
  return {
    ok: true, purpose, userId: row.user_id, email: row.email, expiresAt: row.expires_at, createdBy: row.created_by,
  };
}

// Uses the link up and runs fn(row) with its row, in one transaction: the
// link is checked again inside it (as peek), marked used, and fn writes what
// the link was for. Two requests with the same link race to this point and
// only one gets through; the other reads 'used'. fn must be synchronous (a
// slow hash is made before); if it throws, nothing is written and the link
// still works. Returns peek's answer, with `result` (fn's return) on success.
function consume(raw, fn, { now = Date.now() } = {}) {
  if (typeof raw !== 'string' || !TOKEN_PATTERN.test(raw)) return { ok: false, reason: 'invalid' };
  const hash = hashToken(raw);
  return db.transaction(() => {
    const row  = _stmt('SELECT * FROM auth_tokens WHERE token_hash = ?').get(hash);
    const link = _judge(row, now);
    if (!link.ok) return link;
    const { changes } = _stmt('UPDATE auth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL')
      .run(new Date(now).toISOString(), row.id);
    if (!changes) return { ok: false, reason: 'used', purpose: row.purpose };
    return { ...link, result: typeof fn === 'function' ? fn(row) : undefined };
  }).immediate();
}

// Deletes every unused link of this kind for the account (an admin's revoke
// of an invite). Returns how many went. Used links stay, as used.
function revoke(userId, purpose) {
  return _stmt('DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL').run(String(userId), purpose).changes;
}

// Deletes links used, or run out, more than RETENTION_DAYS before `now`.
// Returns how many went. From the daily retention job
// (jobs/account-retention.js).
function prune({ now = Date.now(), days = RETENTION_DAYS } = {}) {
  const cutoff = new Date(now - days * DAY_MS).toISOString();
  return _stmt('DELETE FROM auth_tokens WHERE used_at < ? OR expires_at < ?').run(cutoff, cutoff).changes;
}

module.exports = {
  issue, peek, consume, revoke, prune, hashToken,
  PURPOSES, INVITE_TTL_MS, RESET_TTL_MS, ADMIN_RESET_TTL_MS, RETENTION_DAYS,
};
