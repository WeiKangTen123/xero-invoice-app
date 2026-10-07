const { encrypt, decrypt, isEncrypted } = require('./crypto');

describe('crypto (at-rest encryption)', () => {
  test('round-trips a value through encrypt/decrypt', () => {
    const plain = 'ESAHajLrDr-0PLwdoWzv-JRMqeTRK_doGtG6G-Hj8yidEGPd';
    const enc   = encrypt(plain);
    expect(enc).not.toBe(plain);
    expect(isEncrypted(enc)).toBe(true);
    expect(decrypt(enc)).toBe(plain);
  });

  test('encrypting the same value twice produces different ciphertext (random IV)', () => {
    const a = encrypt('same-secret');
    const b = encrypt('same-secret');
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe('same-secret');
    expect(decrypt(b)).toBe('same-secret');
  });

  test('legacy plaintext values pass through decrypt() unchanged', () => {
    // Simulates a value written before encryption existed — must not throw or mangle it.
    expect(decrypt('sk-or-v1-plainlegacykey')).toBe('sk-or-v1-plainlegacykey');
    expect(isEncrypted('sk-or-v1-plainlegacykey')).toBe(false);
  });

  test('null/empty values pass through untouched', () => {
    expect(encrypt(null)).toBeNull();
    expect(encrypt('')).toBe('');
    expect(decrypt(null)).toBeNull();
    expect(decrypt('')).toBe('');
  });

  test('tampered ciphertext fails to decrypt (auth tag mismatch)', () => {
    const enc = encrypt('secret-value');
    const tampered = enc.slice(0, -4) + 'abcd';
    expect(() => decrypt(tampered)).toThrow();
  });
});

// The startup check refuses a key keyProblem() rejects, so keyProblem() must
// accept every key this module has ever worked with — or a server whose
// stored credentials decrypt fine would refuse to start after a deploy.
describe('crypto keyProblem (the rule the startup check uses)', () => {
  const saved = process.env.ENCRYPTION_KEY;
  afterEach(() => { if (saved === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = saved; });
  const { keyProblem } = require('./crypto');
  const hex = 'ab'.repeat(32);

  test('missing, or not 32 bytes of hex, is a problem', () => {
    expect(keyProblem(undefined)).toMatch(/^ENCRYPTION_KEY not set/);
    expect(keyProblem('')).toMatch(/^ENCRYPTION_KEY not set/);
    expect(keyProblem('ab'.repeat(16))).toMatch(/64 hex characters/);
    expect(keyProblem('ab'.repeat(33))).toMatch(/64 hex characters/);
    expect(keyProblem('change_this_to_a_64_char_hex_string')).toMatch(/64 hex characters/);
  });

  test.each([
    ['lower-case hex', hex],
    ['upper-case hex', hex.toUpperCase()],
    ['hex with a stray trailing character', hex + 'z'],
    ['an odd 65th hex digit', hex + 'a'],
  ])('%s passes, and a value encrypted under it decrypts under it', (_label, key) => {
    expect(keyProblem(key)).toBeNull();
    process.env.ENCRYPTION_KEY = key;
    const enc = encrypt('stored-before-the-deploy');
    // The same 32 bytes as the plain lower-case key: these spellings were
    // always one key to crypto.js, and data written under one reads under all.
    process.env.ENCRYPTION_KEY = hex;
    expect(decrypt(enc)).toBe('stored-before-the-deploy');
  });

  test('every key keyProblem() rejects is one encrypt() could never have used', () => {
    for (const key of ['ab'.repeat(16), 'change_this_to_a_64_char_hex_string', 'zz' + hex]) {
      expect(keyProblem(key)).not.toBeNull();
      process.env.ENCRYPTION_KEY = key;
      expect(() => encrypt('x')).toThrow(/ENCRYPTION_KEY/);
    }
  });
});
