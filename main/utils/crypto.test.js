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
