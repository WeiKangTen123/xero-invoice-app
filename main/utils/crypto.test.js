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

// ── Key rotation ─────────────────────────────────────────────────────────────
// The server in production has ENCRYPTION_KEY alone and every stored value is
// enc:v1. The first group is the promise that it keeps working untouched; the
// rest is what changes once someone opts in with ENCRYPTION_KEYS.
describe('crypto keyring (rotation)', () => {
  const VARS = ['ENCRYPTION_KEY', 'ENCRYPTION_KEYS', 'ENCRYPTION_KEY_ID'];
  const saved = Object.fromEntries(VARS.map(k => [k, process.env[k]]));
  const use = vars => {
    for (const k of VARS) { if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  };
  afterEach(() => use(saved));

  const { keyProblem, keyIdOf, primaryKeyId } = require('./crypto');
  const nodeCrypto = require('crypto');
  const OLD = 'a1'.repeat(32), K1 = 'b2'.repeat(32), K2 = 'c3'.repeat(32), K3 = 'd4'.repeat(32);

  // The enc:v1 format exactly as the code before rotation wrote and read it,
  // spelled out here independently, so a change to crypto.js cannot move both
  // sides of the comparison at once.
  const oldEncrypt = (key, text) => {
    const iv = nodeCrypto.randomBytes(12);
    const c  = nodeCrypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
    const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return 'enc:v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  };
  const oldDecrypt = (key, value) => {
    const raw = Buffer.from(value.slice('enc:v1:'.length), 'base64');
    const d = nodeCrypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  };

  describe("ENCRYPTION_KEY alone (today's production configuration)", () => {
    test('writes enc:v1 under ENCRYPTION_KEY that the code before rotation reads, and reads what it wrote', () => {
      use({ ENCRYPTION_KEY: OLD });
      expect(keyProblem(process.env)).toBeNull();
      expect(primaryKeyId()).toBeNull();
      const enc = encrypt('refresh-token-123');
      expect(enc).toMatch(/^enc:v1:[A-Za-z0-9+/=]+$/);
      expect(oldDecrypt(OLD, enc)).toBe('refresh-token-123');
      expect(decrypt(oldEncrypt(OLD, 'imap-password'))).toBe('imap-password');
      expect(keyIdOf(enc)).toBeNull();
    });

    test('the same key spelled the ways it always worked still reads old values', () => {
      const stored = oldEncrypt(OLD, 'xero-secret');
      use({ ENCRYPTION_KEY: OLD.toUpperCase() + 'z' });
      expect(keyProblem(process.env)).toBeNull();
      expect(decrypt(stored)).toBe('xero-secret');
    });
  });

  describe('with ENCRYPTION_KEYS configured', () => {
    test('new values are enc:v2 under the primary key, named by its id', () => {
      use({ ENCRYPTION_KEY: OLD, ENCRYPTION_KEYS: `2026-01:${K1},2026-10:${K2}`, ENCRYPTION_KEY_ID: '2026-10' });
      expect(primaryKeyId()).toBe('2026-10');
      const enc = encrypt('gemini-key');
      expect(enc.startsWith('enc:v2:2026-10:')).toBe(true);
      expect(isEncrypted(enc)).toBe(true);
      expect(keyIdOf(enc)).toBe('2026-10');
      expect(decrypt(enc)).toBe('gemini-key');
      // Written with K2, the primary, not K1 or ENCRYPTION_KEY: the same id
      // pointing at another key cannot read it.
      use({ ENCRYPTION_KEYS: `2026-10:${K1}`, ENCRYPTION_KEY_ID: '2026-10' });
      expect(() => decrypt(enc)).toThrow();
    });

    test('enc:v1 values written before the keyring are still read with ENCRYPTION_KEY', () => {
      const legacy = oldEncrypt(OLD, 'written-last-year');
      use({ ENCRYPTION_KEY: OLD, ENCRYPTION_KEYS: `k2:${K2}`, ENCRYPTION_KEY_ID: 'k2' });
      expect(decrypt(legacy)).toBe('written-last-year');
    });

    test('a value under a key still in the ring but no longer primary is read', () => {
      use({ ENCRYPTION_KEYS: `k1:${K1}`, ENCRYPTION_KEY_ID: 'k1' });
      const underK1 = encrypt('older');
      use({ ENCRYPTION_KEYS: `k1:${K1},k2:${K2}`, ENCRYPTION_KEY_ID: 'k2' });
      expect(decrypt(underK1)).toBe('older');
      expect(keyIdOf(encrypt('newer'))).toBe('k2');
    });

    test('a value under a key id that is not configured is an error naming that id', () => {
      use({ ENCRYPTION_KEYS: `k1:${K1}`, ENCRYPTION_KEY_ID: 'k1' });
      const underK1 = encrypt('secret');
      use({ ENCRYPTION_KEY: OLD, ENCRYPTION_KEYS: `k3:${K3}`, ENCRYPTION_KEY_ID: 'k3' });
      expect(() => decrypt(underK1)).toThrow(/encrypted with key "k1", which is not in ENCRYPTION_KEYS \(configured: k3\)/);
      use({ ENCRYPTION_KEY: OLD });
      expect(() => decrypt(underK1)).toThrow(/encrypted with key "k1", which is not in ENCRYPTION_KEYS \(not set\)/);
    });

    test('an enc:v1 value once ENCRYPTION_KEY has been removed is an error saying so', () => {
      const legacy = oldEncrypt(OLD, 'never-rotated');
      use({ ENCRYPTION_KEYS: `k2:${K2}`, ENCRYPTION_KEY_ID: 'k2' });
      expect(() => decrypt(legacy)).toThrow(/enc:v1, written under ENCRYPTION_KEY, which is not set/);
    });

    test('plaintext still passes through, and an enc:v2 value without a key id is refused', () => {
      use({ ENCRYPTION_KEYS: `k2:${K2}`, ENCRYPTION_KEY_ID: 'k2' });
      expect(decrypt('sk-plain-legacy')).toBe('sk-plain-legacy');
      expect(() => decrypt('enc:v2:abc')).toThrow(/without a valid key id/);
    });

    test('encrypt() refuses a keyring keyProblem() rejects, rather than writing under a guess', () => {
      use({ ENCRYPTION_KEY: OLD, ENCRYPTION_KEYS: `k2:${K2}`, ENCRYPTION_KEY_ID: 'k9' });
      expect(() => encrypt('x')).toThrow(/ENCRYPTION_KEY_ID "k9" is not one of the keys/);
    });
  });

  describe('keyProblem(env), the rule the startup check refuses by', () => {
    const problem = env => keyProblem({ NODE_ENV: 'production', ...env });

    test('good configurations pass: the legacy key alone, a keyring beside it, and a keyring alone', () => {
      expect(problem({ ENCRYPTION_KEY: OLD })).toBeNull();
      expect(problem({ ENCRYPTION_KEY: OLD, ENCRYPTION_KEYS: `k1:${K1},k2:${K2}`, ENCRYPTION_KEY_ID: 'k2' })).toBeNull();
      expect(problem({ ENCRYPTION_KEYS: ` k2:${K2.toUpperCase()} , `, ENCRYPTION_KEY_ID: 'k2' })).toBeNull();
    });

    test('nothing configured is the message it has always been', () => {
      expect(problem({})).toMatch(/^ENCRYPTION_KEY not set/);
      expect(problem({ ENCRYPTION_KEYS: '  ' })).toMatch(/^ENCRYPTION_KEY not set/);
    });

    test.each([
      ['a short key',          `k1:${K1.slice(0, 62)}`],
      ['a 65th hex digit',     `k1:${K1}a`],
      ['a stray character',    `k1:${K1}z`],
      ['a non-hex key',        `k1:${'zz'.repeat(32)}`],
    ])('%s in ENCRYPTION_KEYS is refused, naming the id and never the key', (_label, ring) => {
      const msg = problem({ ENCRYPTION_KEY: OLD, ENCRYPTION_KEYS: ring, ENCRYPTION_KEY_ID: 'k1' });
      expect(msg).toBe('ENCRYPTION_KEYS key "k1" must be exactly 64 hex characters (32 bytes)');
      expect(msg).not.toContain(K1.slice(0, 16));
    });

    test('malformed entries, bad and repeated ids are refused without echoing what was pasted', () => {
      expect(problem({ ENCRYPTION_KEYS: K1, ENCRYPTION_KEY_ID: 'k1' })).toMatch(/entry 1 is not in the form id:key/);
      const swapped = problem({ ENCRYPTION_KEYS: `${K1}:k1`, ENCRYPTION_KEY_ID: 'k1' });
      expect(swapped).toMatch(/entry 1: the id must be/);
      expect(swapped).not.toContain(K1.slice(0, 16));
      expect(problem({ ENCRYPTION_KEYS: `k1:${K1},k1:${K2}`, ENCRYPTION_KEY_ID: 'k1' })).toMatch(/names key "k1" more than once/);
    });

    test('a missing primary is refused: no ENCRYPTION_KEY_ID, an id not in the ring, an id with no ring', () => {
      expect(problem({ ENCRYPTION_KEY: OLD, ENCRYPTION_KEYS: `k1:${K1}` })).toMatch(/^ENCRYPTION_KEY_ID not set/);
      expect(problem({ ENCRYPTION_KEY: OLD, ENCRYPTION_KEYS: `k1:${K1},k2:${K2}`, ENCRYPTION_KEY_ID: 'k3' }))
        .toBe('ENCRYPTION_KEY_ID "k3" is not one of the keys in ENCRYPTION_KEYS (k1, k2)');
      expect(problem({ ENCRYPTION_KEY: OLD, ENCRYPTION_KEY_ID: 'k1' })).toMatch(/^ENCRYPTION_KEY_ID is set but ENCRYPTION_KEYS is empty/);
      const pasted = problem({ ENCRYPTION_KEYS: `k1:${K1}`, ENCRYPTION_KEY_ID: K1 });
      expect(pasted).toMatch(/^ENCRYPTION_KEY_ID must be/);
      expect(pasted).not.toContain(K1.slice(0, 16));
    });

    test('a bad legacy key is still refused beside a good keyring, and every problem is reported at once', () => {
      expect(problem({ ENCRYPTION_KEY: 'change_this', ENCRYPTION_KEYS: `k1:${K1}`, ENCRYPTION_KEY_ID: 'k1' }))
        .toBe('ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
      expect(problem({ ENCRYPTION_KEY: 'ab'.repeat(16), ENCRYPTION_KEYS: `k1:${K1.slice(2)}`, ENCRYPTION_KEY_ID: 'k1' }))
        .toBe('ENCRYPTION_KEY must be 64 hex characters (32 bytes); ENCRYPTION_KEYS key "k1" must be exactly 64 hex characters (32 bytes)');
    });

    test('a string is still answered as ENCRYPTION_KEY alone, as before rotation', () => {
      expect(keyProblem(OLD)).toBeNull();
      expect(keyProblem(undefined)).toMatch(/^ENCRYPTION_KEY not set/);
    });
  });
});
