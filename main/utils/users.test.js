describe('users store (SQLite)', () => {
  let users;

  beforeEach(() => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('./users');
  });

  test('createUser / findByEmail / findById', async () => {
    const u = await users.createUser('a@test.com', 'password123', 'user');
    expect(u.email).toBe('a@test.com');
    expect(u.role).toBe('user');
    expect(users.findByEmail('A@Test.com').id).toBe(u.id);
    expect(users.findById(u.id).email).toBe('a@test.com');
  });

  test('first user via auto role becomes admin, second becomes user', async () => {
    const u1 = await users.createUser('first@test.com', 'password123', 'auto');
    const u2 = await users.createUser('second@test.com', 'password123', 'auto');
    expect(u1.role).toBe('admin');
    expect(u2.role).toBe('user');
  });

  test('createUser rejects duplicate email', async () => {
    await users.createUser('dup@test.com', 'password123', 'user');
    await expect(users.createUser('dup@test.com', 'password123', 'user')).rejects.toThrow('Email already exists');
  });

  test('validatePassword', async () => {
    const u = await users.createUser('pw@test.com', 'correcthorse', 'user');
    expect(await users.validatePassword('pw@test.com', 'correcthorse')).toMatchObject({ id: u.id });
    expect(await users.validatePassword('pw@test.com', 'wrongpass')).toBeNull();
  });

  test('getAllUsers includes online/lastSeenAt, sanitized from the raw last_seen_at column', async () => {
    const u = await users.createUser('list@test.com', 'password123', 'user');
    let listed = users.getAllUsers().find(x => x.id === u.id);
    expect(listed.online).toBe(false);
    expect(listed.lastSeenAt).toBeNull();

    users.touchLastSeen(u.id);
    listed = users.getAllUsers().find(x => x.id === u.id);
    expect(listed.online).toBe(true);
    expect(listed.lastSeenAt).toBeTruthy();
  });

  test('updateUserRole', async () => {
    const u = await users.createUser('role@test.com', 'password123', 'user');
    const updated = users.updateUserRole(u.id, 'admin');
    expect(updated.role).toBe('admin');
    expect(users.findById(u.id).role).toBe('admin');
  });

  test('saveUserConfig / getUserConfig round-trip, empty string clears field', async () => {
    const u = await users.createUser('cfg@test.com', 'password123', 'user');
    users.saveUserConfig(u.id, { XERO_CLIENT_ID: 'abc', IMAP_HOST: 'imap.gmail.com' });
    let cfg = users.getUserConfig(u.id);
    expect(cfg.XERO_CLIENT_ID).toBe('abc');
    expect(cfg.IMAP_HOST).toBe('imap.gmail.com');

    users.saveUserConfig(u.id, { XERO_CLIENT_ID: '' });
    cfg = users.getUserConfig(u.id);
    expect(cfg.XERO_CLIENT_ID).toBeUndefined();
  });

  test('IMAP_LOOKBACK_DAYS round-trips through saveUserConfig / getUserConfig', async () => {
    const u = await users.createUser('lookback@test.com', 'password123', 'user');
    users.saveUserConfig(u.id, { IMAP_LOOKBACK_DAYS: '30' });
    expect(users.getUserConfig(u.id).IMAP_LOOKBACK_DAYS).toBe('30');
  });

  test('secret fields are encrypted at rest, non-secret fields stay plain', async () => {
    const u = await users.createUser('sec@test.com', 'password123', 'user');
    users.saveUserConfig(u.id, {
      XERO_CLIENT_ID:     'plain-client-id',
      XERO_CLIENT_SECRET: 'super-secret-value',
      IMAP_PASS:          'app-password-123',
      Gemini_API_KEY:     'AIzaFakeKeyForTest',
    });

    const db  = require('../db');
    const row = db.prepare('SELECT * FROM user_credentials WHERE user_id = ?').get(u.id);

    // Raw DB values for secret columns must NOT equal the plaintext...
    expect(row.xero_client_secret).not.toBe('super-secret-value');
    expect(row.imap_pass).not.toBe('app-password-123');
    expect(row.gemini_api_key).not.toBe('AIzaFakeKeyForTest');
    // ...and must be recognisably encrypted.
    expect(row.xero_client_secret.startsWith('enc:v1:')).toBe(true);
    // Non-secret columns stay plain, unchanged, queryable.
    expect(row.xero_client_id).toBe('plain-client-id');

    // getUserConfig still returns the real values, transparently decrypted.
    const cfg = users.getUserConfig(u.id);
    expect(cfg.XERO_CLIENT_SECRET).toBe('super-secret-value');
    expect(cfg.IMAP_PASS).toBe('app-password-123');
    expect(cfg.Gemini_API_KEY).toBe('AIzaFakeKeyForTest');
  });

  test('a legacy plaintext secret value (pre-encryption) is still readable', async () => {
    const u = await users.createUser('legacy@test.com', 'password123', 'user');
    const db = require('../db');
    // Simulate a row written before encryption existed — direct SQL, bypassing saveUserConfig.
    db.prepare('INSERT OR IGNORE INTO user_credentials (user_id) VALUES (?)').run(u.id);
    db.prepare('UPDATE user_credentials SET gemini_api_key = ? WHERE user_id = ?').run('legacy-plain-key', u.id);

    expect(users.getUserConfig(u.id).Gemini_API_KEY).toBe('legacy-plain-key');
  });

  test('getSetupStatus reflects configured sections', async () => {
    const u = await users.createUser('setup@test.com', 'password123', 'user');
    expect(users.getSetupStatus(u.id).ready).toBe(false);
    users.saveUserConfig(u.id, {
      XERO_CLIENT_ID: 'id', XERO_CLIENT_SECRET: 'secret',
      IMAP_HOST: 'h', IMAP_USER: 'u', IMAP_PASS: 'p',
    });
    expect(users.getSetupStatus(u.id).ready).toBe(true);
  });

  test('getSetupStatus treats an OAuth connection as configured, with no Custom Connection fields at all', async () => {
    const u = await users.createUser('oauth-setup@test.com', 'password123', 'user');
    expect(users.getSetupStatus(u.id).xero.configured).toBe(false);
    users.saveUserConfig(u.id, { XERO_CONNECTION_TYPE: 'oauth' });
    expect(users.getSetupStatus(u.id).xero.configured).toBe(true);
  });

  test('xero_oauth_refresh_token round-trips through the same encryption as the other secrets', async () => {
    const u = await users.createUser('oauth-token@test.com', 'password123', 'user');
    users.saveUserConfig(u.id, { XERO_OAUTH_REFRESH_TOKEN: 'refresh-token-abc123' });

    const db  = require('../db');
    const row = db.prepare('SELECT xero_oauth_refresh_token FROM user_credentials WHERE user_id = ?').get(u.id);
    expect(row.xero_oauth_refresh_token.startsWith('enc:v1:')).toBe(true);

    expect(users.getUserConfig(u.id).XERO_OAUTH_REFRESH_TOKEN).toBe('refresh-token-abc123');
  });

  test('each user can have their own xero_oauth_client_id/secret, secret encrypted, id plain', async () => {
    const u = await users.createUser('own-webapp@test.com', 'password123', 'user');
    users.saveUserConfig(u.id, { XERO_OAUTH_CLIENT_ID: 'this-users-client-id', XERO_OAUTH_CLIENT_SECRET: 'this-users-secret' });

    const db  = require('../db');
    const row = db.prepare('SELECT xero_oauth_client_id, xero_oauth_client_secret FROM user_credentials WHERE user_id = ?').get(u.id);
    expect(row.xero_oauth_client_id).toBe('this-users-client-id'); // not secret, stays plain
    expect(row.xero_oauth_client_secret.startsWith('enc:v1:')).toBe(true);

    const cfg = users.getUserConfig(u.id);
    expect(cfg.XERO_OAUTH_CLIENT_ID).toBe('this-users-client-id');
    expect(cfg.XERO_OAUTH_CLIENT_SECRET).toBe('this-users-secret');
  });

  test('TIMEZONE round-trips through saveUserConfig / getUserConfig, stored plain (not secret)', async () => {
    const u = await users.createUser('tz@test.com', 'password123', 'user');
    users.saveUserConfig(u.id, { TIMEZONE: 'Asia/Singapore' });

    const db  = require('../db');
    const row = db.prepare('SELECT timezone FROM user_credentials WHERE user_id = ?').get(u.id);
    expect(row.timezone).toBe('Asia/Singapore'); // plain, not "enc:v1:" prefixed

    expect(users.getUserConfig(u.id).TIMEZONE).toBe('Asia/Singapore');
  });

  describe('touchLastSeen / isOnline', () => {
    test('a brand-new user has no last_seen_at and is not online', async () => {
      const u = await users.createUser('fresh@test.com', 'password123', 'user');
      const found = users.findById(u.id);
      expect(found.last_seen_at).toBeFalsy();
      expect(users.isOnline(found.last_seen_at)).toBe(false);
    });

    test('touchLastSeen sets last_seen_at, and isOnline is true immediately after', async () => {
      const u = await users.createUser('touch@test.com', 'password123', 'user');
      users.touchLastSeen(u.id);
      const found = users.findById(u.id);
      expect(found.last_seen_at).toBeTruthy();
      expect(users.isOnline(found.last_seen_at)).toBe(true);
    });

    test('isOnline is false once last_seen_at is older than the online window', async () => {
      const u = await users.createUser('stale@test.com', 'password123', 'user');
      const db = require('../db');
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(tenMinutesAgo, u.id);
      expect(users.isOnline(tenMinutesAgo)).toBe(false);
    });

    test('a second touchLastSeen call within the throttle window does not re-write the DB', async () => {
      const u = await users.createUser('throttle@test.com', 'password123', 'user');
      users.touchLastSeen(u.id);
      const first = users.findById(u.id).last_seen_at;

      // Immediately touching again should be throttled — same timestamp, no new write.
      users.touchLastSeen(u.id);
      const second = users.findById(u.id).last_seen_at;
      expect(second).toBe(first);
    });
  });

  test('deleteUser cascades to credentials/settings/invoices', async () => {
    const u = await users.createUser('cascade@test.com', 'password123', 'user');
    users.saveUserConfig(u.id, { XERO_CLIENT_ID: 'abc' });
    const invoiceStore = require('./invoice-store');
    invoiceStore.forUser(u.id).add({ id: 'inv1', status: 'pending', processedAt: new Date().toISOString() });

    users.deleteUser(u.id);

    expect(users.findById(u.id)).toBeNull();
    expect(users.getUserConfig(u.id)).toEqual({});
    expect(invoiceStore.forUser(u.id).getAll()).toEqual([]);
  });

  describe('Gemini API keys (multi-key)', () => {
    test('addGeminiKey / getGeminiKeys round-trip, oldest first, encrypted at rest', async () => {
      const u = await users.createUser('gem1@test.com', 'password123', 'user');
      users.addGeminiKey(u.id, 'AIzaFirstKey', 'Personal');
      users.addGeminiKey(u.id, 'AIzaSecondKey');

      const keys = users.getGeminiKeys(u.id);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toMatchObject({ apiKey: 'AIzaFirstKey', label: 'Personal' });
      expect(keys[1]).toMatchObject({ apiKey: 'AIzaSecondKey', label: null });

      const db  = require('../db');
      const row = db.prepare('SELECT api_key FROM user_gemini_keys WHERE user_id = ? ORDER BY id').all(u.id)[0];
      expect(row.api_key.startsWith('enc:v1:')).toBe(true);
    });

    test('addGeminiKey rejects empty key', async () => {
      const u = await users.createUser('gem2@test.com', 'password123', 'user');
      expect(() => users.addGeminiKey(u.id, '')).toThrow('API key is required');
      expect(() => users.addGeminiKey(u.id, '   ')).toThrow('API key is required');
    });

    test('removeGeminiKey deletes only the owning user\'s key', async () => {
      const u1 = await users.createUser('gem3@test.com', 'password123', 'user');
      const u2 = await users.createUser('gem4@test.com', 'password123', 'user');
      const { id } = users.addGeminiKey(u1.id, 'AIzaOwnedByU1');

      expect(users.removeGeminiKey(u2.id, id)).toBe(false); // wrong owner
      expect(users.getGeminiKeys(u1.id)).toHaveLength(1);

      expect(users.removeGeminiKey(u1.id, id)).toBe(true);
      expect(users.getGeminiKeys(u1.id)).toHaveLength(0);
    });

    test('getSetupStatus.llm is true once a multi-key is added, with no legacy field set', async () => {
      const u = await users.createUser('gem5@test.com', 'password123', 'user');
      expect(users.getSetupStatus(u.id).llm.configured).toBe(false);
      users.addGeminiKey(u.id, 'AIzaOnlyKey');
      expect(users.getSetupStatus(u.id).llm.configured).toBe(true);
    });

    test('deleteUser cascades to user_gemini_keys', async () => {
      const u = await users.createUser('gem6@test.com', 'password123', 'user');
      users.addGeminiKey(u.id, 'AIzaCascadeKey');
      users.deleteUser(u.id);
      expect(users.getGeminiKeys(u.id)).toEqual([]);
    });
  });
});
