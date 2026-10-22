// Sign-up and sign-in at the store: one form for an address, Argon2id hashes
// (bcrypt ones still accepted, and replaced), the password rules counted in
// characters, self-registration closed inside the transaction that inserts,
// and a lockout a right password checked at the same moment cannot wipe.
// Real users and database.
describe('users — addresses, passwords and sign-in', () => {
  let users, db;

  beforeEach(() => {
    jest.resetModules();
    require('../db/migrate').run();
    db    = require('../db');
    users = require('./users');
  });

  describe('email addresses', () => {
    test('normalizeEmail: trimmed, Unicode NFC, lower case; null for anything not a string', () => {
      expect(users.normalizeEmail('  Jane.Doe@Example.COM ')).toBe('jane.doe@example.com');
      expect(users.normalizeEmail('JOSÉ@Example.com')).toBe('josé@example.com');   // e + accent, one é
      expect(users.normalizeEmail('ÉLODIE@X.COM')).toBe('élodie@x.com');                     // past A-Z, unlike SQLite's lower()
      expect(users.normalizeEmail('')).toBe('');
      for (const v of [null, undefined, 42, {}]) expect(users.normalizeEmail(v)).toBeNull();
    });

    test('emailProblem: blank, too long, or not something@something.something', () => {
      expect(users.emailProblem('jane@example.com')).toBeNull();
      expect(users.emailProblem('  Jane@Example.com  ')).toBeNull();
      for (const v of [undefined, null, 42, '', '   ']) expect(users.emailProblem(v)).toBe('Enter an email address');
      expect(users.emailProblem(`${'a'.repeat(242)}@example.com`)).toBeNull();                    // 254
      expect(users.emailProblem(`${'a'.repeat(243)}@example.com`)).toBe('That email address is too long');
      for (const v of ['jane', 'jane@', '@example.com', 'jane@example', 'ja ne@example.com', 'jane@@example.com', 'a@b@c.com']) {
        expect(users.emailProblem(v)).toBe('Enter a valid email address');
      }
    });

    test('createUser stores the address normalised, and it is found however it is typed', async () => {
      const u = await users.createUser('  Bob.Smith@Example.COM ', 'password123', 'user');
      expect(u.email).toBe('bob.smith@example.com');
      expect(users.findById(u.id).email).toBe('bob.smith@example.com');
      expect(users.findByEmail(' BOB.SMITH@example.com').id).toBe(u.id);
      const accented = await users.createUser('josé@example.com', 'password123', 'user');
      expect(users.findByEmail('JOSÉ@example.com').id).toBe(accented.id);
      for (const v of [null, undefined, '', '   ', 42]) expect(users.findByEmail(v)).toBeNull();
      expect(await users.validatePassword(' Bob.Smith@EXAMPLE.com ', 'password123')).toMatchObject({ id: u.id });
    });

    test('a bad address, and a second spelling of one already taken, are refused by code', async () => {
      await users.createUser('bob@example.com', 'password123', 'user');
      await expect(users.createUser(' BOB@Example.com', 'password123', 'user'))
        .rejects.toMatchObject({ code: 'EMAIL_EXISTS', message: 'An account with this email already exists' });
      await expect(users.createUser('not-an-address', 'password123', 'user'))
        .rejects.toMatchObject({ code: 'EMAIL_INVALID', message: 'Enter a valid email address' });
      await expect(users.createUser('   ', 'password123', 'user'))
        .rejects.toMatchObject({ code: 'EMAIL_INVALID', message: 'Enter an email address' });
      expect(users.getAllUsers()).toHaveLength(1);
    });

    test('the unique index has the last word on a row the lookup misses', async () => {
      // As migrate.js leaves two accounts that collide: as they were typed.
      db.prepare("INSERT INTO users (id, email, password, created_at) VALUES ('old', 'Carol@Example.com', 'x', '2026-01-01')").run();
      await expect(users.createUser('carol@example.com', 'password123', 'user')).rejects.toMatchObject({ code: 'EMAIL_EXISTS' });
    });

    test('the lookup is one equality on the column\'s index', () => {
      const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM users WHERE email = ?').all('x@example.com').map(r => r.detail).join(' ');
      expect(plan).toMatch(/SEARCH users USING (COVERING )?INDEX/);
    });
  });

  describe('self-registration makes the first account only (firstOnly)', () => {
    test('three at once: exactly one gets in, as the admin; the others are told registration is closed', async () => {
      const results = await Promise.allSettled(['a', 'b', 'c'].map(n =>
        users.createUser(`${n}@example.com`, 'password123', 'auto', { firstOnly: true })));
      const made = results.filter(r => r.status === 'fulfilled');
      expect(made).toHaveLength(1);
      expect(made[0].value.role).toBe('admin');
      for (const r of results.filter(x => x.status === 'rejected')) {
        expect(r.reason).toMatchObject({ code: 'REGISTRATION_CLOSED', message: 'Public registration is disabled. Contact your administrator.' });
      }
      expect(users.getAllUsers()).toHaveLength(1);
    });

    test('closed whatever the address, a taken one included; without firstOnly an admin still adds accounts', async () => {
      await users.createUser('first@example.com', 'password123', 'auto', { firstOnly: true });
      await expect(users.createUser('first@example.com', 'password123', 'auto', { firstOnly: true }))
        .rejects.toMatchObject({ code: 'REGISTRATION_CLOSED' });
      expect((await users.createUser('second@example.com', 'password123', 'auto')).role).toBe('user');
    });
  });

  describe('password rules', () => {
    const common = 'That password is too common; choose another';
    const short  = 'Password must be at least 12 characters';

    test('the long favourites the server used to let through are refused', () => {
      for (const p of ['password1234', '123456789012', 'aaaaaaaaaaaa', 'administrator', 'welcome12345', 'qwertyuiop12', 'Password@123']) {
        expect([p, users.passwordProblem(p, 'jane@example.com')]).toEqual([p, common]);
      }
    });

    test('counted in characters after NFC, not in UTF-16 units', () => {
      expect('😀'.repeat(6)).toHaveLength(12);
      expect(users.passwordProblem('😀'.repeat(6))).toBe(short);
      expect(users.passwordProblem('🐱🐶🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮')).toBeNull();     // twelve
      expect(users.passwordProblem('😀'.repeat(12))).toBe(common);              // one character over and over
      // e + accent is one character, é: eleven, though JavaScript counts twelve.
      expect('café au lai').toHaveLength(12);
      expect(users.passwordProblem('café au lai')).toBe(short);
      expect(users.passwordProblem('café au lait')).toBeNull();
    });

    test('at most 128 characters', () => {
      expect(users.PASSWORD_MAX_LENGTH).toBe(128);
      const phrase = 'correct horse battery staple '.repeat(5);
      expect(users.passwordProblem(phrase.slice(0, 128))).toBeNull();
      expect(users.passwordProblem(phrase.slice(0, 129))).toBe('Password must be at most 128 characters');
      expect(users.passwordProblem('🐱🐶'.repeat(64))).toBeNull();               // 128 characters, 256 units
      expect(users.passwordProblem('🐱🐶'.repeat(65))).toBe('Password must be at most 128 characters');
    });

    test('nothing but the words of this app, once digits and symbols are out', () => {
      for (const p of ['Xero2026!!!!', 'xeroxeroxero', 'Invoice-Invoice-1', 'FinancialAutomation1', 'flovon.flovon', 'Accounting#2026', 'invoices4finance']) {
        expect([p, users.passwordProblem(p)]).toEqual([p, common]);
      }
      for (const p of ['xero is my accountant', 'invoice parrot 2026', 'financially-stable']) {
        expect([p, users.passwordProblem(p)]).toEqual([p, null]);
      }
    });

    test('the email rule compares the address normalised', () => {
      expect(users.passwordProblem('josé.garcia@example.com', ' JOSÉ.Garcia@Example.com ')).toBe('Password must not be your email address');
    });
  });

  describe('password hashes', () => {
    test('new hashes are Argon2id with OWASP\'s parameters, and need nothing more', async () => {
      const hash = await users.hashPassword('correct horse battery');
      expect(hash).toMatch(/^\$argon2id\$v=19\$/);
      expect(hash.split('$')[3].split(',').sort()).toEqual(['m=19456', 'p=1', 't=2']);
      expect(users.ARGON2_OPTIONS).toEqual({ memoryCost: 19456, timeCost: 2, parallelism: 1 });
      expect(await users.verifyPassword(hash, 'correct horse battery')).toBe(true);
      expect(await users.verifyPassword(hash, 'correct horse batterY')).toBe(false);
      expect(users.needsRehash(hash)).toBe(false);
      const u = await users.createUser('argon@example.com', 'password123', 'user');
      expect(users.findById(u.id).password).toMatch(/^\$argon2id\$/);
      await users.setPassword(u.id, 'chosen-by-me-2026');
      expect(users.findById(u.id).password).toMatch(/^\$argon2id\$/);
    });

    test('past 72 bytes still counts: two passwords that differ only after it are two passwords', async () => {
      const head = 'x'.repeat(72);
      const hash = await users.hashPassword(`${head}-one`);
      expect(await users.verifyPassword(hash, `${head}-one`)).toBe(true);
      expect(await users.verifyPassword(hash, `${head}-two`)).toBe(false);
      // What bcrypt made of them: one password.
      const bcrypt = require('bcryptjs');
      expect(await bcrypt.compare(`${head}-two`, bcrypt.hashSync(`${head}-one`, 4))).toBe(true);
    });

    test('hashed in NFC: é typed as one character or as e and an accent is one password', async () => {
      const hash = await users.hashPassword('café au lait 2026');
      expect(await users.verifyPassword(hash, 'café au lait 2026')).toBe(true);
    });

    test('a hash that cannot be read, or no password, matches nothing and throws nothing', async () => {
      for (const [hash, pw] of [['not a hash', 'x'], ['$argon2id$v=19$m=19456,t=2,p=1$bad', 'x'], ['$2a$10$short', 'x'], [null, 'x'], ['$2a$10$x', undefined]]) {
        expect(await users.verifyPassword(hash, pw)).toBe(false);
      }
      await expect(users.hashPassword(undefined)).rejects.toThrow(TypeError);
    });

    test('needsRehash: every bcrypt hash, an Argon2 one that is weaker or not Argon2id; nothing that is not a hash', async () => {
      const argon2 = require('argon2');
      const bcrypt = require('bcryptjs');
      expect(users.needsRehash(bcrypt.hashSync('x', 4))).toBe(true);
      expect(users.needsRehash(bcrypt.hashSync('x', 12))).toBe(true);
      const make = opts => argon2.hash('x', { type: argon2.argon2id, ...users.ARGON2_OPTIONS, ...opts });
      expect(users.needsRehash(await make({ memoryCost: 4096 }))).toBe(true);
      expect(users.needsRehash(await make({ timeCost: 1 }))).toBe(true);
      expect(users.needsRehash(await make({ type: argon2.argon2i }))).toBe(true);
      expect(users.needsRehash(await make({ memoryCost: 65536, timeCost: 3 }))).toBe(false);   // stronger is kept
      for (const v of ['nonsense', '', null, undefined]) expect(users.needsRehash(v)).toBe(false);
    });

    test('a bcrypt hash from before still signs in, and is replaced by an Argon2id one as it does — once', async () => {
      const bcrypt = require('bcryptjs');
      const u = await users.createUser('legacy@example.com', 'placeholder-2026', 'user');
      const legacy = bcrypt.hashSync('legacy-password-2026', 10);
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(legacy, u.id);

      // Checking the current password for a change leaves the hash alone: it
      // is handed back as the one setPassword expects to replace.
      expect(await users.verifiedPasswordHash(u.id, 'legacy-password-2026')).toBe(legacy);
      expect(await users.validatePassword('legacy@example.com', 'wrong-password-2026')).toBeNull();
      expect(users.findById(u.id).password).toBe(legacy);

      expect(await users.validatePassword('legacy@example.com', 'legacy-password-2026')).toMatchObject({ id: u.id });
      const upgraded = users.findById(u.id).password;
      expect(upgraded).toMatch(/^\$argon2id\$/);
      expect(users.needsRehash(upgraded)).toBe(false);
      expect(await users.validatePassword('legacy@example.com', 'legacy-password-2026')).toMatchObject({ id: u.id });
      expect(users.findById(u.id).password).toBe(upgraded);
    });

    test('an old hash of a password typed not in NFC signs in as typed, and is replaced by one of the NFC form', async () => {
      const bcrypt = require('bcryptjs');
      const typed  = 'café-au-lait-2026';
      const u = await users.createUser('nfd@example.com', 'placeholder-2026', 'user');
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(bcrypt.hashSync(typed, 4), u.id);
      expect(await users.validatePassword('nfd@example.com', typed)).toMatchObject({ id: u.id });
      expect(users.findById(u.id).password).toMatch(/^\$argon2id\$/);
      // Now either way of typing it is the password.
      expect(await users.validatePassword('nfd@example.com', 'café-au-lait-2026')).toMatchObject({ id: u.id });
      expect(await users.validatePassword('nfd@example.com', typed)).toMatchObject({ id: u.id });
    });

    test('the replacement never undoes a password changed while it was being made', async () => {
      const bcrypt = require('bcryptjs');
      const u = await users.createUser('raced@example.com', 'placeholder-2026', 'user');
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(bcrypt.hashSync('old-password-2026', 4), u.id);
      const argon2 = require('argon2');
      const realHash = argon2.hash;
      // An admin's reset lands while the old password's new hash is being made.
      jest.spyOn(argon2, 'hash').mockImplementationOnce(async (...args) => {
        db.prepare('UPDATE users SET password = ? WHERE id = ?').run('$set-by-the-admin', u.id);
        return realHash(...args);
      });
      expect(await users.validatePassword('raced@example.com', 'old-password-2026')).toMatchObject({ id: u.id });
      expect(users.findById(u.id).password).toBe('$set-by-the-admin');
    });

    test('verifyDummy: a real check against a constant Argon2id hash, always false', async () => {
      const argon2 = require('argon2');
      const verify = jest.spyOn(argon2, 'verify');
      await expect(users.verifyDummy('any-password-at-all')).resolves.toBe(false);
      await expect(users.verifyDummy(undefined)).resolves.toBe(false);
      expect(verify).toHaveBeenCalledWith(expect.stringMatching(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/), 'any-password-at-all');
      expect(verify).toHaveBeenCalledTimes(2);
    });
  });

  describe('the lockout and a right password at the same moment', () => {
    test('a right password checked while a wrong one locks the account is refused, and the lock stands', async () => {
      const u = await users.createUser('race@example.com', 'right-password-2026', 'user');
      for (let i = 0; i < 4; i++) users.recordFailedLogin(u.id);
      // Two sign-ins arrive together, and both pass the lock check: none yet.
      expect(users.lockStatus(users.findById(u.id))).toBeNull();
      const [right, wrong] = await Promise.all([
        users.validatePassword('race@example.com', 'right-password-2026'),
        users.validatePassword('race@example.com', 'wrong-password-2026'),
      ]);
      // The wrong one is recorded first, and locks...
      expect(wrong).toBeNull();
      expect(users.recordFailedLogin(u.id).locked).toBe(true);
      // ...and the right one, checked meanwhile, clears nothing.
      expect(right).toMatchObject({ id: u.id });
      expect(users.recordSuccessfulLogin(u.id)).toBe(false);
      expect(users.lockStatus(users.findById(u.id))).not.toBeNull();
      expect(users.findById(u.id)).toMatchObject({ lock_count: 1, last_login_at: null });
    });

    test('recordSuccessfulLogin is true, and clears, for an account with no lock or one that has ended', async () => {
      const u = await users.createUser('clear@example.com', 'password123', 'user');
      users.recordFailedLogin(u.id);
      expect(users.recordSuccessfulLogin(u.id)).toBe(true);
      expect(users.findById(u.id)).toMatchObject({ failed_logins: 0, last_login_at: expect.any(String) });
      for (let i = 0; i < 5; i++) users.recordFailedLogin(u.id);
      const until = Date.parse(users.findById(u.id).locked_until);
      expect(users.recordSuccessfulLogin(u.id, until - 1)).toBe(false);
      expect(users.recordSuccessfulLogin(u.id, until)).toBe(true);
      expect(users.findById(u.id)).toMatchObject({ locked_until: null, lock_count: 0 });
      expect(users.recordSuccessfulLogin('nobody')).toBe(false);
    });

    test('wrong passwords checked together each count', async () => {
      const u = await users.createUser('many@example.com', 'right-password-2026', 'user');
      await Promise.all([1, 2, 3].map(async i => {
        if (!await users.validatePassword('many@example.com', `guess-number-${i}`)) users.recordFailedLogin(u.id);
      }));
      expect(users.findById(u.id).failed_logins).toBe(3);
    });
  });
});

// When the native module will not load, signing in must not break.
describe('users — without the argon2 module', () => {
  // Argon2id of 'stored-before-2026', made with the module, for an account
  // hashed while it still loaded.
  const STORED = '$argon2id$v=19$m=19456,p=1,t=2$yISn2dntZP2u6YogMVPIIg$wdbFa4Z2j8J5di2O5xp3HFJlX4zci2Scryeg0Pz6Yr0';
  let users, warn;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('argon2', () => { throw new Error('No native build was found for platform=test'); });
    require('../db/migrate').run();
    warn  = jest.spyOn(require('./logger'), 'warn');
    users = require('./users');
  });
  afterEach(() => jest.dontMock('argon2'));

  test('new hashes are bcrypt at cost 12, said once in the log, and signing in works', async () => {
    const u = await users.createUser('fallback@example.com', 'fallback-pass-2026', 'user');
    const hash = users.findById(u.id).password;
    expect(hash).toMatch(/^\$2[ab]\$12\$/);
    expect(await users.validatePassword('fallback@example.com', 'fallback-pass-2026')).toMatchObject({ id: u.id });
    expect(await users.validatePassword('fallback@example.com', 'fallback-pass-2027')).toBeNull();
    // Nothing better to replace it with until the module loads.
    expect(users.findById(u.id).password).toBe(hash);
    expect(users.needsRehash(hash)).toBe(false);
    expect(users.needsRehash(require('bcryptjs').hashSync('x', 4))).toBe(true);
    expect(await users.verifyDummy('whatever-was-typed')).toBe(false);
    expect(warn.mock.calls.filter(([m]) => /argon2 could not be loaded/.test(m))).toHaveLength(1);
  });

  test('an Argon2id hash already stored is checked with Node\'s own crypto.argon2, where this Node has one', async () => {
    expect(users.needsRehash(STORED)).toBe(false);
    if (typeof require('crypto').argon2 !== 'function') return;   // Node before 24.7: cannot be checked
    expect(await users.verifyPassword(STORED, 'stored-before-2026')).toBe(true);
    expect(await users.verifyPassword(STORED, 'stored-before-2027')).toBe(false);
  });
});
