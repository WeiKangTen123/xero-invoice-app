const crypto = require('crypto');

// AES-256-GCM for at-rest encryption of per-user secrets (Xero client secret,
// IMAP password, Gemini API key) stored in user_credentials. Encrypted values are
// prefixed so decrypt() can tell an encrypted value apart from a legacy plaintext
// one still sitting in the DB from before this was added — those are returned
// as-is on read and get encrypted automatically the next time they're saved.
//
// Two formats, so the key can be rotated:
//
//   enc:v1:<base64>        names no key. Everything written before rotation
//                          existed is in this form, and it is always read with
//                          ENCRYPTION_KEY.
//   enc:v2:<id>:<base64>   names the key in ENCRYPTION_KEYS it was written
//                          with, so an old and a new key can both be live while
//                          scripts/rotate-encryption-key.js moves every value
//                          from one to the other (docs/RUNBOOK.md).
//
// New values are written as v2, under the key ENCRYPTION_KEY_ID names, only
// once ENCRYPTION_KEYS is configured. With ENCRYPTION_KEY alone — every server
// deployed before rotation existed — writes stay v1, byte for byte what they
// always were. Nothing changes for a server until someone opts in, and older
// code rolled back onto the same database can still read all it finds there.
const ALGO      = 'aes-256-gcm';
const V1_PREFIX = 'enc:v1:';
const V2_PREFIX = 'enc:v2:';
const IV_LEN    = 12;
const TAG_LEN   = 16;

// A key id is written into every value encrypted with it, between colons, and
// listed in a comma-separated variable, so it can contain neither. A short,
// plain alphabet also keeps ids safe to print in errors and in the rotation
// report, which is why a malformed id is never echoed: it may be a pasted key.
const KEY_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;

// Keys in ENCRYPTION_KEYS are held to exactly 64 hex characters. Nothing was
// ever written under one before this rule existed, so unlike ENCRYPTION_KEY
// (below) there is no history to stay compatible with, and a key cut short
// or with a stray character when it was pasted is caught at boot rather than
// becoming the key every new secret is written under.
const RING_KEY_RE = /^[0-9a-fA-F]{64}$/;

const NOT_SET = 'ENCRYPTION_KEY not set — required to store/read credentials securely. ' +
  'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"';

// Reads the three variables into the keys this module uses, with every
// problem found. Problems never quote key material, only the ids of
// well-formed entries, because they are printed at boot and sent to Slack.
//
// ENCRYPTION_KEY keeps the rule it has always had, looser than "exactly 64
// hex characters": Buffer.from(…, 'hex') reads upper case and stops at the
// first non-hex character, so a key with a stray trailing character has
// always worked and may have credentials encrypted under it. A stricter check
// would lock out a server whose stored data decrypts fine.
function _keyring(env) {
  const legacyRaw = env.ENCRYPTION_KEY;
  const ringRaw   = String(env.ENCRYPTION_KEYS || '').trim();
  const primaryId = String(env.ENCRYPTION_KEY_ID || '').trim();
  const problems  = [];

  if (!legacyRaw && !ringRaw) problems.push(NOT_SET);
  let legacy = null;
  if (legacyRaw) {
    legacy = Buffer.from(legacyRaw, 'hex');
    if (legacy.length !== 32) {
      problems.push('ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
      legacy = null;
    }
  }

  const keys = new Map();
  const named = new Set(); // ids seen, usable or not, so a bad key is not also reported as "missing"
  // Empty entries are skipped so a trailing comma is harmless.
  const entries = ringRaw ? ringRaw.split(',').map(e => e.trim()).filter(Boolean) : [];
  entries.forEach((entry, i) => {
    const where = `ENCRYPTION_KEYS entry ${i + 1}`;
    const colon = entry.indexOf(':');
    if (colon === -1) return problems.push(`${where} is not in the form id:key`);
    const id  = entry.slice(0, colon).trim();
    const hex = entry.slice(colon + 1).trim();
    if (!KEY_ID_RE.test(id)) return problems.push(`${where}: the id must be 1-32 letters, digits, '.', '_' or '-'`);
    if (named.has(id)) return problems.push(`ENCRYPTION_KEYS names key "${id}" more than once`);
    named.add(id);
    if (!RING_KEY_RE.test(hex)) return problems.push(`ENCRYPTION_KEYS key "${id}" must be exactly 64 hex characters (32 bytes)`);
    keys.set(id, Buffer.from(hex, 'hex'));
  });

  // A keyring with no primary, or a primary with no keyring, is refused
  // rather than guessed at: either way the operator meant to rotate, and
  // quietly carrying on with the old key would look like a rotation that
  // happened.
  if (ringRaw && !primaryId) {
    problems.push('ENCRYPTION_KEY_ID not set — it names the key in ENCRYPTION_KEYS that new values are encrypted with');
  } else if (primaryId && !ringRaw) {
    problems.push('ENCRYPTION_KEY_ID is set but ENCRYPTION_KEYS is empty — set both, or neither to keep using ENCRYPTION_KEY alone');
  } else if (primaryId && !KEY_ID_RE.test(primaryId)) {
    problems.push("ENCRYPTION_KEY_ID must be 1-32 letters, digits, '.', '_' or '-'");
  } else if (primaryId && !named.has(primaryId)) {
    problems.push(`ENCRYPTION_KEY_ID "${primaryId}" is not one of the keys in ENCRYPTION_KEYS (${[...named].join(', ') || 'none usable'})`);
  }

  return { problems, legacy, keys, primary: keys.has(primaryId) ? primaryId : null };
}

// What is wrong with the configured keys, or null when they are usable. This
// is the one rule, shared by encrypt()/decrypt() and the startup check in
// index.js, so the server can never refuse at boot keys this module would
// have used, nor start with keys it would refuse on the first credential.
//
// Given the environment (an object) it checks ENCRYPTION_KEY, ENCRYPTION_KEYS
// and ENCRYPTION_KEY_ID together. Given a string it answers for that string
// as ENCRYPTION_KEY alone, which is how it was called before keys could be
// rotated, so a caller written then still gets the answer it expects.
function keyProblem(env) {
  const vars = env && typeof env === 'object' ? env : { ENCRYPTION_KEY: env };
  const { problems } = _keyring(vars);
  return problems.length ? problems.join('; ') : null;
}

function _config() {
  const env = process.env;
  // The test suite runs without a .env, so a fixed all-zero key stands in for
  // ENCRYPTION_KEY there — but only when no key of any kind is configured, so
  // a test that sets keys gets exactly what it set.
  const anyConfigured = env.ENCRYPTION_KEY || String(env.ENCRYPTION_KEYS || '').trim() || String(env.ENCRYPTION_KEY_ID || '').trim();
  const ring = _keyring(!anyConfigured && env.NODE_ENV === 'test' ? { ENCRYPTION_KEY: '0'.repeat(64) } : env);
  if (ring.problems.length) throw new Error(ring.problems.join('; '));
  return ring;
}

function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return plaintext;
  const { legacy, keys, primary } = _config();
  const key    = primary ? keys.get(primary) : legacy;
  const prefix = primary ? `${V2_PREFIX}${primary}:` : V1_PREFIX;
  const iv     = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return prefix + Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

// The key a stored value needs and the part to decrypt with it. A value whose
// key is not configured fails here, naming the key, instead of further down as
// an anonymous "unable to authenticate data" — after a rotation that is the
// difference between "put key 2026-01 back" and a mystery.
function _keyFor(value) {
  if (value.startsWith(V1_PREFIX)) {
    const { legacy } = _config();
    if (!legacy) {
      throw new Error('Cannot decrypt a stored value: it is enc:v1, written under ENCRYPTION_KEY, ' +
        'which is not set. Put the old ENCRYPTION_KEY back in .env to read it.');
    }
    return { key: legacy, body: value.slice(V1_PREFIX.length) };
  }
  const rest  = value.slice(V2_PREFIX.length);
  const colon = rest.indexOf(':');
  const id    = colon === -1 ? '' : rest.slice(0, colon);
  if (!KEY_ID_RE.test(id)) throw new Error('Cannot decrypt a stored value: enc:v2 without a valid key id');
  const { keys } = _config();
  if (!keys.has(id)) {
    throw new Error(`Cannot decrypt a stored value: it was encrypted with key "${id}", which is not in ENCRYPTION_KEYS ` +
      `(${keys.size ? `configured: ${[...keys.keys()].join(', ')}` : 'not set'}). Put key "${id}" back in ENCRYPTION_KEYS to read it.`);
  }
  return { key: keys.get(id), body: rest.slice(colon + 1) };
}

function decrypt(value) {
  if (value == null || value === '') return value;
  if (!isEncrypted(value)) return value; // legacy plaintext — pass through

  const { key, body } = _keyFor(value);
  const raw        = Buffer.from(body, 'base64');
  const iv         = raw.subarray(0, IV_LEN);
  const authTag    = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = raw.subarray(IV_LEN + TAG_LEN);
  const decipher   = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

function isEncrypted(value) {
  return typeof value === 'string' && (value.startsWith(V1_PREFIX) || value.startsWith(V2_PREFIX));
}

// The id an enc:v2 value names, or null for enc:v1 and for plaintext. The
// rotation script uses it to leave alone what is already on the primary key.
function keyIdOf(value) {
  if (typeof value !== 'string' || !value.startsWith(V2_PREFIX)) return null;
  const rest = value.slice(V2_PREFIX.length);
  const colon = rest.indexOf(':');
  return colon === -1 ? null : rest.slice(0, colon);
}

// The id new values are written under, or null while ENCRYPTION_KEY alone is
// in use (writes are enc:v1). Throws, like encrypt(), when the keys are unusable.
function primaryKeyId() {
  return _config().primary;
}

module.exports = { encrypt, decrypt, isEncrypted, keyProblem, keyIdOf, primaryKeyId };
