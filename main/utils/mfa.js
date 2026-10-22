// 2-step sign-in: after the password, a six-digit code from an authenticator
// app on the person's phone (Google Authenticator, Microsoft Authenticator,
// 1Password and the like), or one of ten single-use recovery codes for the day
// the phone is lost.
//
// Why: this is a finance tool, and an admin can read every account, make
// admins and reset passwords, all behind a password alone. A password can be
// guessed, phished or reused from another site's leak; a code from a phone in
// the person's pocket cannot be. Singapore's PDPC treats a second factor for
// administrator accounts as a baseline, and NIST SP 800-63B prefers one for
// anyone. So admins must have it (requiredFor), and anyone else may turn it on.
//
// The codes are TOTP (RFC 6238), made here with Node's own crypto: HMAC-SHA1
// of the number of 30-second steps since 1970, cut to six digits, which is
// what every authenticator app makes from the same secret. A code from the
// step before or after now is accepted too, for a phone whose clock is a few
// seconds out. No code is accepted twice: the step of the last one accepted is
// kept (users.mfa_last_step), and only a later step will do, so a code read
// over someone's shoulder is no use once it has been typed.
//
// The secret is 20 random bytes, given to the app as base32 (in a QR code, or
// typed), and stored encrypted (utils/crypto.js) like every other secret.
// Recovery codes are kept only as SHA-256 hashes: each is 12 characters from a
// 31-letter alphabet, about 59 random bits, which no one can work back from a
// hash, so the slow password hash is not needed for them.
//
// The half-made sign-in between the two steps is an `mfaToken` (issueChallenge
// below): a JWT good for five minutes, for one account, used once. What it
// may still do is kept in memory, like the rate limits: a restart makes every
// one of them start again from the password, which costs a person one retype.
const crypto = require('crypto');
const db     = require('../db');
const { encrypt, decrypt } = require('./crypto');

// What the authenticator app shows above the codes.
const ISSUER = 'Financial Automation';

const DIGITS        = 6;
const STEP_SECONDS  = 30;
const WINDOW_STEPS  = 1;    // a code from one step either side of now is accepted
const SECRET_BYTES  = 20;   // RFC 4226's recommended length for HMAC-SHA1

const RECOVERY_CODE_COUNT  = 10;
const RECOVERY_CODE_LENGTH = 12;
// No 0/o, 1/l/i: a code copied from paper must not be misread.
const RECOVERY_ALPHABET    = 'abcdefghjkmnpqrstuvwxyz23456789';

// The half-made sign-in (issueChallenge): five minutes, and five wrong codes.
const CHALLENGE_TTL_SECONDS = 5 * 60;
const MAX_WRONG_CODES       = 5;
const CHALLENGE_AUDIENCE    = 'mfa';

// Statements are prepared on first use, as in sessions.js: in tests the
// database is created after this module is required.
const _stmts = new Map();
function _stmt(sql) {
  let s = _stmts.get(sql);
  if (!s) { s = db.prepare(sql); _stmts.set(sql, s); }
  return s;
}

// ── Base32 (RFC 4648), the form an authenticator app takes a secret in ───────
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let out = '', bits = 0, value = 0;
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

// Spaces, padding and case are forgiven, as an app forgives them; any other
// character is not base32 and throws.
function base32Decode(text) {
  const clean = String(text).replace(/[\s=]/g, '').toUpperCase();
  const bytes = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    const i = BASE32.indexOf(ch);
    if (i === -1) throw new Error('Not a base32 secret');
    value = ((value << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ── Codes ────────────────────────────────────────────────────────────────────

// A new secret, as base32: what the app is given.
function generateSecret() {
  return base32Encode(crypto.randomBytes(SECRET_BYTES));
}

// The 30-second step `ms` falls in.
function stepAt(ms = Date.now()) {
  return Math.floor(ms / 1000 / STEP_SECONDS);
}

// RFC 4226: the code for one counter, from the secret's bytes.
function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(msg).digest();
  const at  = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[at] & 0x7f) << 24) | (mac[at + 1] << 16) | (mac[at + 2] << 8) | mac[at + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

// The code an authenticator app shows for this secret at `ms`. The tests make
// codes with it, as the phone would.
function codeAt(secret, ms = Date.now()) {
  return hotp(base32Decode(secret), stepAt(ms));
}

// A code as typed, with the spaces some apps show in the middle taken out, or
// null when it is not six digits.
function _digits(code) {
  if (typeof code !== 'string' && typeof code !== 'number') return null;
  const c = String(code).replace(/\s+/g, '');
  return new RegExp(`^\\d{${DIGITS}}$`).test(c) ? c : null;
}

// The step `code` is right for, within a step either side of now and after
// `lastStep` (the last one accepted, so none is accepted twice), or null.
function matchStep(secret, code, { now = Date.now(), lastStep = null } = {}) {
  const typed = _digits(code);
  if (!typed) return null;
  let key;
  try { key = base32Decode(secret); } catch { return null; }
  const current = stepAt(now);
  const given   = Buffer.from(typed);
  for (let s = current - WINDOW_STEPS; s <= current + WINDOW_STEPS; s++) {
    if (lastStep !== null && lastStep !== undefined && s <= Number(lastStep)) continue;
    if (crypto.timingSafeEqual(Buffer.from(hotp(key, s)), given)) return s;
  }
  return null;
}

// What the QR code holds: Google's Key URI format, which every authenticator
// app reads. The account's address names it in the app's list.
function otpauthUrl(email, secret) {
  const issuer = encodeURIComponent(ISSUER);
  return `otpauth://totp/${issuer}:${encodeURIComponent(String(email || ''))}`
    + `?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// The QR code of `text` as an SVG data URL, for an <img> on the set-up page.
// Made here rather than in the browser so the page needs no QR library and the
// secret is never handed to a third-party service to draw.
async function qrSvgDataUrl(text) {
  const svg = await require('qrcode').toString(String(text), { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

// ── Recovery codes ───────────────────────────────────────────────────────────

// Ten new codes, each `xxxx-xxxx-xxxx`, shown to the person once.
function generateRecoveryCodes(n = RECOVERY_CODE_COUNT) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    let raw = '';
    for (let j = 0; j < RECOVERY_CODE_LENGTH; j++) raw += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
    codes.push(raw.match(/.{4}/g).join('-'));
  }
  return codes;
}

// A recovery code as compared: lower case, without the dashes or spaces it
// was shown or typed with. Null when it cannot be one.
function normaliseRecoveryCode(code) {
  if (typeof code !== 'string') return null;
  const c = code.toLowerCase().replace(/[\s-]/g, '');
  return new RegExp(`^[a-z0-9]{${RECOVERY_CODE_LENGTH}}$`).test(c) ? c : null;
}

function hashRecoveryCode(code) {
  const c = normaliseRecoveryCode(code);
  return c ? crypto.createHash('sha256').update(c).digest('hex') : null;
}

// Whether what was typed has the shape of a recovery code rather than an app
// code, for a form that takes either in one box.
function looksLikeRecoveryCode(code) {
  return normaliseRecoveryCode(code) !== null;
}

function _recoveryHashes(row) {
  try {
    const list = JSON.parse(row && row.mfa_recovery ? row.mfa_recovery : '[]');
    return Array.isArray(list) ? list.filter(h => typeof h === 'string') : [];
  } catch {
    return [];
  }
}

// ── Who has it, and who must ─────────────────────────────────────────────────

// Whether 2-step is on for this account (a raw users row).
function isEnabled(row) {
  return !!(row && row.mfa_enabled_at && row.mfa_secret);
}

// Whether admins must have 2-step: MFA_REQUIRED_FOR_ADMINS=true or false says
// so outright; unset, it is on for every server and off while the test suite
// runs (NODE_ENV=test), whose hundreds of hand-made admin tokens would
// otherwise all be turned away. The tests of the requirement set it to true.
function requiredForAdmins(env = process.env) {
  const v = String(env.MFA_REQUIRED_FOR_ADMINS ?? '').trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return env.NODE_ENV !== 'test';
}

// Whether this account (a raw row) must have 2-step on.
function requiredFor(row) {
  return !!row && row.role === 'admin' && requiredForAdmins();
}

// Whether this account must turn 2-step on before it may do anything else
// (auth-middleware.js): it is required and not on yet.
function setupRequired(row) {
  return requiredFor(row) && !isEnabled(row);
}

function _row(userId) {
  return _stmt('SELECT id, email, role, mfa_secret, mfa_pending_secret, mfa_enabled_at, mfa_last_step, mfa_recovery FROM users WHERE id = ?')
    .get(String(userId)) || null;
}

// What GET /api/auth/mfa answers: { enabled, enabledAt, required,
// recoveryCodesLeft }. Takes an id or a raw row.
function status(rowOrId) {
  const row = rowOrId && typeof rowOrId === 'object' ? rowOrId : _row(rowOrId);
  const enabled = isEnabled(row);
  return {
    enabled,
    enabledAt:         enabled ? row.mfa_enabled_at : null,
    required:          requiredFor(row),
    recoveryCodesLeft: enabled ? _recoveryHashes(row).length : 0,
  };
}

// How many unused recovery codes the account has.
function recoveryCodesLeft(userId) {
  return status(userId).recoveryCodesLeft;
}

// ── Turning it on, using it, turning it off ─────────────────────────────────

// Set-up, first half: a new secret, kept as pending until a code from it
// proves the app has it (enable). A second call replaces the first, so the
// QR code to scan is always the newest. Null when 2-step is already on: a new
// secret then would be a way round it.
function beginSetup(userId) {
  const row = _row(userId);
  if (!row) throw new Error('User not found');
  if (isEnabled(row)) return null;
  const secret = generateSecret();
  _stmt('UPDATE users SET mfa_pending_secret = ? WHERE id = ?').run(encrypt(secret), row.id);
  return { secret, otpauthUrl: otpauthUrl(row.email, secret) };
}

// Set-up, second half: a code from the pending secret turns 2-step on, and
// ten recovery codes are made. The step of that code counts as used, so it
// cannot then sign anyone in. Returns { ok: true, recoveryCodes, enabledAt }
// or { ok: false, reason: 'already' | 'no_setup' | 'wrong_code' }. One
// IMMEDIATE transaction, so two tabs cannot both turn it on with different
// codes lists.
const _enable = db.transaction((userId, code, now) => {
  const row = _row(userId);
  if (!row) return { ok: false, reason: 'no_setup' };
  if (isEnabled(row)) return { ok: false, reason: 'already' };
  if (!row.mfa_pending_secret) return { ok: false, reason: 'no_setup' };
  const step = matchStep(decrypt(row.mfa_pending_secret), code, { now });
  if (step === null) return { ok: false, reason: 'wrong_code' };
  const recoveryCodes = generateRecoveryCodes();
  const enabledAt = new Date(now).toISOString();
  _stmt(`UPDATE users SET mfa_secret = mfa_pending_secret, mfa_pending_secret = NULL, mfa_enabled_at = ?,
         mfa_last_step = ?, mfa_recovery = ? WHERE id = ?`)
    .run(enabledAt, step, JSON.stringify(recoveryCodes.map(hashRecoveryCode)), row.id);
  return { ok: true, recoveryCodes, enabledAt };
});
function enable(userId, code, now = Date.now()) {
  return _enable.immediate(userId, code, now);
}

// Whether `code` is a right app code for the account, now. A right one is
// used up: the account's last step moves to it, in one conditional UPDATE, so
// of two requests with the same code only one gets through.
function verifyCode(userId, code, now = Date.now()) {
  const row = _row(userId);
  if (!isEnabled(row)) return false;
  const step = matchStep(decrypt(row.mfa_secret), code, { now, lastStep: row.mfa_last_step });
  if (step === null) return false;
  const { changes } = _stmt(`UPDATE users SET mfa_last_step = ? WHERE id = ? AND mfa_secret = ?
                             AND (mfa_last_step IS NULL OR mfa_last_step < ?)`)
    .run(step, row.id, row.mfa_secret, step);
  return changes > 0;
}

// Uses up one recovery code. Returns how many are left, or null when `code`
// is not one of the account's unused codes (or 2-step is off).
const _useRecoveryCode = db.transaction((userId, code) => {
  const row = _row(userId);
  if (!isEnabled(row)) return null;
  const hash = hashRecoveryCode(code);
  if (!hash) return null;
  const hashes = _recoveryHashes(row);
  const i = hashes.indexOf(hash);
  if (i === -1) return null;
  hashes.splice(i, 1);
  _stmt('UPDATE users SET mfa_recovery = ? WHERE id = ?').run(JSON.stringify(hashes), row.id);
  return hashes.length;
});
function useRecoveryCode(userId, code) {
  return _useRecoveryCode.immediate(userId, code);
}

// Ten new recovery codes in place of whatever is left of the old ones, which
// stop working. Null when 2-step is off.
function regenerateRecoveryCodes(userId) {
  const codes = generateRecoveryCodes();
  const { changes } = _stmt('UPDATE users SET mfa_recovery = ? WHERE id = ? AND mfa_enabled_at IS NOT NULL AND mfa_secret IS NOT NULL')
    .run(JSON.stringify(codes.map(hashRecoveryCode)), String(userId));
  return changes > 0 ? codes : null;
}

// Turns 2-step off: the secret, any set-up under way, the recovery codes and
// the last step all go. For a person's own "turn off" and an admin's reset.
// Returns whether it had been on.
function turnOff(userId) {
  const row = _row(userId);
  if (!row) return false;
  _stmt(`UPDATE users SET mfa_secret = NULL, mfa_pending_secret = NULL, mfa_enabled_at = NULL,
         mfa_last_step = NULL, mfa_recovery = NULL WHERE id = ?`).run(row.id);
  return isEnabled(row);
}

// ── The half-made sign-in (mfaToken) ─────────────────────────────────────────
// A right password for an account with 2-step on starts no session. It gets
// an mfaToken: a JWT signed with the session secret but for another audience
// ('mfa'), so it is no session token (auth-middleware.js refuses any token
// with an audience) and no session token is one of these. It names the
// account, carries a random jti, and runs out in five minutes. What it may
// still do is kept here by jti until then: five wrong codes and it is dead,
// one right code and it is spent.
//
// `pwc`: the password typed is one the rules now refuse, so the account must
// choose a new one once signed in (routes/auth.js). `kna`: the account is
// locked and this is its owner at an address it has signed in from before.
const _challenges = new Map(); // jti -> { expiresAt (ms), wrong, state: 'open' | 'used' | 'too_many' | 'ended' }

function _sweep(now = Date.now()) {
  for (const [jti, c] of _challenges) if (c.expiresAt <= now) _challenges.delete(jti);
}

function _jwt() { return require('jsonwebtoken'); }
function _secret() { return require('../middleware/auth-middleware').jwtSecret(); }

function issueChallenge(userId, { passwordChange = false, viaKnownAddress = false } = {}) {
  const jti    = crypto.randomBytes(16).toString('hex');
  const claims = { id: String(userId) };
  if (passwordChange)  claims.pwc = true;
  if (viaKnownAddress) claims.kna = true;
  const token = _jwt().sign(claims, _secret(), {
    algorithm: 'HS256', audience: CHALLENGE_AUDIENCE, expiresIn: CHALLENGE_TTL_SECONDS, jwtid: jti,
  });
  const now = Date.now();
  if (_challenges.size > 500) _sweep(now);
  _challenges.set(jti, { expiresAt: now + CHALLENGE_TTL_SECONDS * 1000, wrong: 0, state: 'open' });
  return token;
}

// The mfaToken's claims while it may still be used: { claims, jti }. Or
// { error } saying why not: 'expired' (run out, or from before a restart),
// 'invalid', 'used', 'too_many' or 'ended'.
function readChallenge(token) {
  if (typeof token !== 'string' || !token) return { error: 'invalid' };
  const jwt = _jwt();
  let claims;
  try {
    claims = jwt.verify(token, _secret(), { algorithms: ['HS256'], audience: CHALLENGE_AUDIENCE });
  } catch (err) {
    return { error: err instanceof jwt.TokenExpiredError ? 'expired' : 'invalid' };
  }
  const entry = claims.jti ? _challenges.get(claims.jti) : null;
  if (!entry || entry.expiresAt <= Date.now()) return { error: 'expired' };
  if (entry.state !== 'open') return { error: entry.state };
  return { claims, jti: claims.jti };
}

// One wrong code on this mfaToken: { wrong, dead }, dead once there have been
// MAX_WRONG_CODES.
function countWrongCode(jti) {
  const entry = _challenges.get(jti);
  if (!entry) return { wrong: MAX_WRONG_CODES, dead: true };
  entry.wrong += 1;
  if (entry.wrong >= MAX_WRONG_CODES) entry.state = 'too_many';
  return { wrong: entry.wrong, dead: entry.state === 'too_many' };
}

// The right code: the mfaToken is spent. False when it already was.
function spendChallenge(jti) {
  const entry = _challenges.get(jti);
  if (!entry || entry.state !== 'open') return false;
  entry.state = 'used';
  return true;
}

// Ends an mfaToken for any other reason: the account locked, disabled, or
// its 2-step turned off between the two steps.
function endChallenge(jti) {
  const entry = _challenges.get(jti);
  if (entry && entry.state === 'open') entry.state = 'ended';
}

module.exports = {
  // codes
  generateSecret, base32Encode, base32Decode, hotp, codeAt, stepAt, matchStep, otpauthUrl, qrSvgDataUrl,
  generateRecoveryCodes, normaliseRecoveryCode, hashRecoveryCode, looksLikeRecoveryCode,
  // accounts
  isEnabled, requiredForAdmins, requiredFor, setupRequired, status, recoveryCodesLeft,
  beginSetup, enable, verifyCode, useRecoveryCode, regenerateRecoveryCodes, turnOff,
  // the half-made sign-in
  issueChallenge, readChallenge, countWrongCode, spendChallenge, endChallenge,
  ISSUER, DIGITS, STEP_SECONDS, RECOVERY_CODE_COUNT, CHALLENGE_TTL_SECONDS, MAX_WRONG_CODES, CHALLENGE_AUDIENCE,
};
