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

  test('the dead Nvidia/OpenRouter columns are dropped on migrate, and every secret column is encrypted', async () => {
    // An older database still carries the three columns (with live keys in
    // plaintext). Simulate one, then migrate: the columns must be gone.
    const db = require('../db');
    const cols = () => db.prepare('PRAGMA table_info(user_credentials)').all().map(c => c.name);
    for (const c of ['nvidia_api_key', 'openrouter_api_key', 'openrouter_model']) {
      if (!cols().includes(c)) db.exec(`ALTER TABLE user_credentials ADD COLUMN ${c} TEXT`);
    }
    const u = await users.createUser('old@test.com', 'password123', 'user');
    db.prepare('INSERT OR IGNORE INTO user_credentials (user_id) VALUES (?)').run(u.id);
    db.prepare('UPDATE user_credentials SET nvidia_api_key = ?, openrouter_api_key = ?, openrouter_model = ? WHERE user_id = ?').run('nv-key', 'or-key', 'm', u.id);
    db.pragma('user_version = 3');   // an older database: the drop step has not run yet
    require('../db/migrate').run();
    expect(cols()).toEqual(expect.not.arrayContaining(['nvidia_api_key', 'openrouter_api_key', 'openrouter_model']));
    expect(users.getUserConfig(u.id)).toEqual({});           // nothing else was disturbed
    // Nothing that looks like a credential may be mapped to a plaintext column.
    for (const col of Object.values(users.CONFIG_KEY_TO_COLUMN)) {
      if (/key|secret|pass|token/.test(col)) expect(users.ENCRYPTED_COLUMNS.has(col)).toBe(true);
    }
  });

  test('getUserDefaults: the user setting wins, then the environment, then one literal per kind', async () => {
    // Currency and account-code fallbacks were spelled in six files with five
    // different values ('SGD'/'USD', '429'/'200'/'310').
    const u = await users.createUser('defaults@test.com', 'password123', 'user');
    const prev = { c: process.env.DEFAULT_CURRENCY, a: process.env.DEFAULT_ACCOUNT_CODE };
    try {
      delete process.env.DEFAULT_CURRENCY; delete process.env.DEFAULT_ACCOUNT_CODE;
      expect(users.getUserDefaults(u.id)).toMatchObject({ currency: 'SGD', accountCode: { claim: '429', bill: '310', invoice: '200' }, timezone: 'Asia/Singapore' });
      process.env.DEFAULT_ACCOUNT_CODE = '999';
      expect(users.getUserDefaults(u.id).accountCode).toEqual({ claim: '999', bill: '999', invoice: '999' });
      users.saveUserConfig(u.id, { DEFAULT_CURRENCY: 'USD', DEFAULT_ACCOUNT_CODE: '412', TIMEZONE: 'UTC' });
      expect(users.getUserDefaults(u.id)).toMatchObject({ currency: 'USD', accountCode: { claim: '412', bill: '412', invoice: '412' }, timezone: 'UTC' });
      expect(users.getUserDefaults(null).currency).toBe('SGD');
    } finally {
      if (prev.c === undefined) delete process.env.DEFAULT_CURRENCY; else process.env.DEFAULT_CURRENCY = prev.c;
      if (prev.a === undefined) delete process.env.DEFAULT_ACCOUNT_CODE; else process.env.DEFAULT_ACCOUNT_CODE = prev.a;
    }
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

  test('a Gmail account needs only an app password — host and mailbox follow from the address', async () => {
    const u = await users.createUser('mailbox-auto@gmail.com', 'password123', 'user');
    users.saveUserConfig(u.id, { XERO_CONNECTION_TYPE: 'oauth' });
    expect(users.getSetupStatus(u.id).imap.configured).toBe(false);
    users.saveUserConfig(u.id, { IMAP_PASS: 'app-password' });
    expect(users.getSetupStatus(u.id).imap.configured).toBe(true);
    expect(users.getSetupStatus(u.id).ready).toBe(true);
  });

  test('an address whose provider is unknown still has to be told its server', async () => {
    const u = await users.createUser('finance@acme-corp.example', 'password123', 'user');
    users.saveUserConfig(u.id, { XERO_CONNECTION_TYPE: 'oauth', IMAP_PASS: 'app-password' });
    expect(users.getSetupStatus(u.id).imap.configured).toBe(false);
    users.saveUserConfig(u.id, { IMAP_HOST: 'mail.acme-corp.example' });
    expect(users.getSetupStatus(u.id).imap.configured).toBe(true);
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

  describe('password rules', () => {
    test('twelve characters, not the email address, not a common password; nothing else', () => {
      expect(users.PASSWORD_MIN_LENGTH).toBe(12);
      const tooShort = 'Password must be at least 12 characters';
      expect(users.passwordProblem('elevenchars')).toBe(tooShort);
      expect(users.passwordProblem(undefined)).toBe(tooShort);
      expect(users.passwordProblem(123456789012)).toBe(tooShort);   // not a string
      // The account's own address, in any case, with or without the domain.
      const isEmail = 'Password must not be your email address';
      expect(users.passwordProblem('Jane.Doe@Example.com', 'jane.doe@example.com')).toBe(isEmail);
      expect(users.passwordProblem('jane.doe@example.com', ' JANE.DOE@example.com ')).toBe(isEmail);
      expect(users.passwordProblem('somebody-long', 'somebody-long@example.com')).toBe(isEmail);
      expect(users.passwordProblem('jane.doe@example.com')).toBeNull();   // no account given: the rule has nothing to compare
      // The published list (common-passwords.js), in any case.
      const common = 'That password is too common; choose another';
      expect(users.passwordProblem('qwerty123456')).toBe(common);
      expect(users.passwordProblem('QWERTY123456', 'jane@example.com')).toBe(common);
      // No composition rules: long and plain is fine.
      expect(users.passwordProblem('correct horse battery staple', 'jane@example.com')).toBeNull();
      expect(users.passwordProblem('twelve chars', 'jane@example.com')).toBeNull();
    });
  });

  // The rule on its own, with no database: five wrong passwords lock, each
  // lock inside a day of the last is twice as long, up to a day.
  describe('sign-in lockout rule (lockAfterFailure)', () => {
    const T0 = Date.parse('2026-10-16T10:00:00.000Z');
    const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
    const fresh = { failed_logins: 0, locked_until: null, lock_count: 0, last_locked_at: null };
    const fail = (row, n, at) => { let r = row; for (let i = 0; i < n; i++) r = users.lockAfterFailure(r, at); return r; };

    test('four wrong passwords count; the fifth locks for 15 minutes and starts the count again', () => {
      expect(users.LOCK_AFTER_FAILURES).toBe(5);
      const four = fail(fresh, 4, T0);
      expect(four).toEqual({ ...fresh, failed_logins: 4, locked: false });
      const locked = users.lockAfterFailure(four, T0);
      expect(locked).toEqual({
        failed_logins: 0, locked_until: new Date(T0 + 15 * MIN).toISOString(), lock_count: 1,
        last_locked_at: new Date(T0).toISOString(), locked: true, lockMinutes: 15,
      });
      // In force until the end, with the whole minutes left (never zero).
      expect(users.lockStatus(locked, T0 + 1)).toEqual({ lockedUntil: locked.locked_until, lockMinutes: 15 });
      expect(users.lockStatus(locked, T0 + 14 * MIN + 30 * 1000)).toEqual({ lockedUntil: locked.locked_until, lockMinutes: 1 });
      expect(users.lockStatus(locked, T0 + 15 * MIN)).toBeNull();
      expect(users.lockStatus(fresh, T0)).toBeNull();
      expect(users.lockStatus(null, T0)).toBeNull();
    });

    test('each lock within 24 hours of the last is twice as long: 15, 30, 60 ... and never more than a day', () => {
      let row = fail(fresh, 5, T0);
      const lengths = [row.lockMinutes];
      let at = T0;
      for (let i = 0; i < 8; i++) {
        at += 23 * HOUR;
        row = fail(row, 5, at);
        lengths.push(row.lockMinutes);
      }
      expect(lengths).toEqual([15, 30, 60, 120, 240, 480, 960, 1440, 1440]);
      expect(row.lock_count).toBe(9);
      expect(Date.parse(row.locked_until) - at).toBe(DAY);
    });

    test('a lock a full day or more after the last starts over at 15 minutes', () => {
      const first  = fail(fresh, 5, T0);
      expect(fail(first, 5, T0 + DAY)).toMatchObject({ lock_count: 1, lockMinutes: 15 });
      expect(fail(first, 5, T0 + DAY - 1)).toMatchObject({ lock_count: 2, lockMinutes: 30 });
      // The count survives a lock that has ended: the failures after it are
      // counted from zero, the next lock still doubles.
      const after = fail(first, 4, T0 + HOUR);
      expect(after).toMatchObject({ failed_logins: 4, lock_count: 1, locked: false, locked_until: first.locked_until });
    });
  });

  describe('sign-in lockout in the database', () => {
    test('recordFailedLogin applies the rule to the row; a sign-in and an unlock clear it', async () => {
      const u = await users.createUser('db-lock@test.com', 'password123', 'user');
      for (let i = 0; i < 4; i++) expect(users.recordFailedLogin(u.id).locked).toBe(false);
      expect(users.findById(u.id).failed_logins).toBe(4);
      const fifth = users.recordFailedLogin(u.id);
      expect(fifth.locked).toBe(true);
      expect(users.findById(u.id)).toMatchObject({ failed_logins: 0, lock_count: 1, locked_until: fifth.locked_until, last_locked_at: fifth.last_locked_at });
      expect(users.lockStatus(users.findById(u.id))).toMatchObject({ lockedUntil: fifth.locked_until });
      // As the Admin page sees it.
      expect(users.getAllUsers().find(x => x.id === u.id)).toMatchObject({ failedLogins: 0, lockedUntil: fifth.locked_until, lastLoginAt: null });

      users.recordSuccessfulLogin(u.id);
      expect(users.findById(u.id)).toMatchObject({ failed_logins: 0, lock_count: 0, locked_until: null, last_locked_at: null, last_login_at: expect.any(String) });
      expect(users.getAllUsers().find(x => x.id === u.id).lastLoginAt).toBe(users.findById(u.id).last_login_at);

      users.recordFailedLogin(u.id); users.recordFailedLogin(u.id);
      expect(users.unlockAccount(u.id)).toMatchObject({ id: u.id, failedLogins: 0, lockedUntil: null });
      expect(users.findById(u.id)).toMatchObject({ failed_logins: 0, lock_count: 0, locked_until: null, last_locked_at: null });

      expect(users.recordFailedLogin('nope')).toBeNull();
      expect(() => users.unlockAccount('nope')).toThrow('User not found');
    });

    test('a lock that has ended is no longer reported as lockedUntil', async () => {
      const u = await users.createUser('ended@test.com', 'password123', 'user');
      for (let i = 0; i < 5; i++) users.recordFailedLogin(u.id);
      expect(users.getAllUsers().find(x => x.id === u.id).lockedUntil).toBeTruthy();
      require('../db').prepare('UPDATE users SET locked_until = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), u.id);
      expect(users.getAllUsers().find(x => x.id === u.id).lockedUntil).toBeNull();
      expect(users.lockStatus(users.findById(u.id))).toBeNull();
    });
  });

  describe('temporary passwords', () => {
    test('createUser and an admin reset mark a temporary password good for a day; the person\'s own change takes the marks off', async () => {
      const own = await users.createUser('own@test.com', 'password123', 'user');
      expect(own.mustChangePassword).toBe(false);
      expect(users.findById(own.id)).toMatchObject({ must_change_password: 0, temp_password_expires_at: null });

      const before = Date.now();
      const temp = await users.createUser('temp@test.com', 'password123', 'user', { temporary: true });
      expect(temp.mustChangePassword).toBe(true);
      let row = users.findById(temp.id);
      expect(row.must_change_password).toBe(1);
      const expires = Date.parse(row.temp_password_expires_at);
      expect(expires - before).toBeGreaterThanOrEqual(users.TEMP_PASSWORD_TTL_MS);
      expect(expires - Date.now()).toBeLessThanOrEqual(users.TEMP_PASSWORD_TTL_MS);
      expect(users.temporaryPasswordExpired(row)).toBe(false);
      expect(users.temporaryPasswordExpired(row, expires)).toBe(true);
      // A password the person chose has no expiry, however old.
      expect(users.temporaryPasswordExpired(users.findById(own.id), Date.now() + 365 * 24 * 60 * 60 * 1000)).toBe(false);

      const hash = await users.verifiedPasswordHash(temp.id, 'password123');
      expect(await users.setPassword(temp.id, 'chosen-by-me-2026', { ifCurrentHash: hash })).toBe(true);
      expect(users.findById(temp.id)).toMatchObject({ must_change_password: 0, temp_password_expires_at: null });
      expect(users.getAllUsers().find(x => x.id === temp.id).mustChangePassword).toBe(false);

      // An admin's reset: temporary again, and the account is unlocked.
      for (let i = 0; i < 5; i++) users.recordFailedLogin(temp.id);
      expect(users.lockStatus(users.findById(temp.id))).not.toBeNull();
      await users.setPassword(temp.id, 'admin-reset-2026', { temporary: true });
      row = users.findById(temp.id);
      expect(row).toMatchObject({ must_change_password: 1, temp_password_expires_at: expect.any(String), failed_logins: 0, lock_count: 0, locked_until: null, last_locked_at: null });
      expect(await users.validatePassword('temp@test.com', 'admin-reset-2026')).toMatchObject({ id: temp.id, mustChangePassword: true });
    });

    test('setPassword applies the password rules, with the email rule for that account', async () => {
      const u = await users.createUser('rules@test.com', 'password123', 'user');
      await expect(users.setPassword(u.id, 'rules@test.com')).rejects.toThrow('Password must not be your email address');
      await expect(users.setPassword(u.id, 'elevenchars')).rejects.toThrow('at least 12 characters');
      await expect(users.setPassword(u.id, 'qwerty123456')).rejects.toThrow('too common');
      expect(await users.validatePassword('rules@test.com', 'password123')).not.toBeNull();
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
