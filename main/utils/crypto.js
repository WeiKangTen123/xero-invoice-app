const crypto = require('crypto');

// AES-256-GCM for at-rest encryption of per-user secrets (Xero client secret,
// IMAP password, Gemini API key) stored in user_credentials. Encrypted values are
// prefixed so decrypt() can tell an encrypted value apart from a legacy plaintext
// one still sitting in the DB from before this was added — those are returned
// as-is on read and get encrypted automatically the next time they're saved.
const ALGO       = 'aes-256-gcm';
const ENC_PREFIX = 'enc:v1:';
const IV_LEN     = 12;
const TAG_LEN    = 16;

function _key() {
  let raw = process.env.ENCRYPTION_KEY;
  if (!raw && process.env.NODE_ENV === 'test') raw = '0'.repeat(64); // fixed key, tests only
  if (!raw) {
    throw new Error(
      'ENCRYPTION_KEY not set — required to store/read credentials securely. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  const key = Buffer.from(raw, 'hex');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  return key;
}

function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return plaintext;
  const iv     = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, _key(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decrypt(value) {
  if (value == null || value === '') return value;
  if (!value.startsWith(ENC_PREFIX)) return value; // legacy plaintext — pass through

  const raw        = Buffer.from(value.slice(ENC_PREFIX.length), 'base64');
  const iv          = raw.subarray(0, IV_LEN);
  const authTag      = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext   = raw.subarray(IV_LEN + TAG_LEN);
  const decipher    = crypto.createDecipheriv(ALGO, _key(), iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

module.exports = { encrypt, decrypt, isEncrypted };
