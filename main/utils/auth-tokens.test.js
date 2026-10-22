// Invite and reset links (utils/auth-tokens.js) and the accounts they are for
// (users.js: an invited account has no password until the link is used).
// The real module against the in-memory database.
const MIN  = 60 * 1000;
const HOUR = 60 * MIN;
const DAY  = 24 * HOUR;

describe('utils/auth-tokens', () => {
  let db, users, tokens, admin, person;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    db     = require('../db');
    users  = require('./users');
    tokens = require('./auth-tokens');
    admin  = await users.createUser('admin@test.com', 'Admin-pass-2026', 'admin');
    person = await users.createUser('person@test.com', 'Person-pass-2026', 'user');
  });

  const rows = () => db.prepare('SELECT * FROM auth_tokens ORDER BY id').all();

  describe('issue', () => {
    test('gives a 43-character base64url token and stores only its SHA-256', () => {
      const raw = tokens.issue(person.id, 'reset', { ttlMs: tokens.RESET_TTL_MS });
      expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const [row] = rows();
      expect(row.token_hash).toBe(require('crypto').createHash('sha256').update(raw).digest('hex'));
      expect(JSON.stringify(rows())).not.toContain(raw);
      expect(row).toMatchObject({ user_id: person.id, purpose: 'reset', email: 'person@test.com', created_by: null, used_at: null });
      expect(Date.parse(row.expires_at) - Date.parse(row.created_at)).toBe(30 * MIN);
    });

    test('records the admin who made it, and how long it lives', () => {
      tokens.issue(person.id, 'reset', { ttlMs: tokens.ADMIN_RESET_TTL_MS, createdBy: admin.id, now: 1_000_000 });
      expect(rows()[0]).toMatchObject({ created_by: admin.id, created_at: new Date(1_000_000).toISOString(), expires_at: new Date(1_000_000 + DAY).toISOString() });
      expect([tokens.INVITE_TTL_MS, tokens.RESET_TTL_MS, tokens.ADMIN_RESET_TTL_MS]).toEqual([7 * DAY, 30 * MIN, DAY]);
    });

    test('a second link of the same kind voids the first; another kind is left alone', () => {
      const first  = tokens.issue(person.id, 'reset', { ttlMs: HOUR });
      const second = tokens.issue(person.id, 'reset', { ttlMs: HOUR });
      expect(first).not.toBe(second);
      expect(tokens.peek(first)).toEqual({ ok: false, reason: 'invalid' });
      expect(tokens.peek(second)).toMatchObject({ ok: true, purpose: 'reset' });
      expect(rows()).toHaveLength(1);
    });

    test('a used link is kept when a new one is issued, so it still reads as used', () => {
      const first = tokens.issue(person.id, 'reset', { ttlMs: HOUR });
      expect(tokens.consume(first, () => {}).ok).toBe(true);
      tokens.issue(person.id, 'reset', { ttlMs: HOUR });
      expect(tokens.peek(first)).toEqual({ ok: false, reason: 'used', purpose: 'reset' });
    });

    test('refuses an unknown purpose, no lifetime, or no account', () => {
      expect(() => tokens.issue(person.id, 'login', { ttlMs: HOUR })).toThrow('Unknown link purpose');
      expect(() => tokens.issue(person.id, 'reset', {})).toThrow('lifetime');
      expect(() => tokens.issue('nobody', 'reset', { ttlMs: HOUR })).toThrow('User not found');
      expect(rows()).toEqual([]);
    });
  });

  describe('peek', () => {
    test('a good link says what it is for, for whom, by whom and until when', () => {
      const raw = tokens.issue(person.id, 'reset', { ttlMs: DAY, createdBy: admin.id });
      expect(tokens.peek(raw)).toEqual({
        ok: true, purpose: 'reset', userId: person.id, email: 'person@test.com', expiresAt: rows()[0].expires_at, createdBy: admin.id,
      });
    });

    test('invalid: anything that is not one of ours', () => {
      for (const raw of [undefined, null, 42, {}, '', 'short', 'x'.repeat(43) + '=', 'A'.repeat(44), require('crypto').randomBytes(32).toString('base64url')]) {
        expect(tokens.peek(raw)).toEqual({ ok: false, reason: 'invalid' });
      }
    });

    test('expired: past its time, and says which kind it was', () => {
      const raw = tokens.issue(person.id, 'reset', { ttlMs: 30 * MIN, now: Date.now() - 31 * MIN });
      expect(tokens.peek(raw)).toEqual({ ok: false, reason: 'expired', purpose: 'reset' });
      expect(tokens.peek(raw, { now: Date.now() - 2 * MIN }).ok).toBe(true);
    });

    test('invalid once the account changes its address, is disabled or is deleted', () => {
      const raw = tokens.issue(person.id, 'reset', { ttlMs: HOUR });
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run('moved@test.com', person.id);
      expect(tokens.peek(raw)).toEqual({ ok: false, reason: 'invalid', purpose: 'reset' });
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run('person@test.com', person.id);
      expect(tokens.peek(raw).ok).toBe(true);

      users.setDisabled(person.id, true);
      expect(tokens.peek(raw)).toMatchObject({ ok: false, reason: 'invalid' });
      users.setDisabled(person.id, false);
      expect(tokens.peek(raw).ok).toBe(true);

      users.deleteUser(person.id);
      expect(tokens.peek(raw)).toEqual({ ok: false, reason: 'invalid' });   // the link went with the account
    });

    test('an invite is only for an account still invited, and a reset only for one with a password', async () => {
      const invited = await users.createUser('new@test.com', null, 'user', { invited: true });
      const reset   = tokens.issue(invited.id, 'reset', { ttlMs: HOUR });
      expect(tokens.peek(reset)).toMatchObject({ ok: false, reason: 'invalid' });
      const invite  = tokens.issue(person.id, 'invite', { ttlMs: HOUR });
      expect(tokens.peek(invite)).toMatchObject({ ok: false, reason: 'invalid' });
      expect(tokens.peek(tokens.issue(invited.id, 'invite', { ttlMs: HOUR })).ok).toBe(true);
    });
  });

  describe('consume', () => {
    test('marks the link used and runs fn once, inside one transaction', () => {
      const raw = tokens.issue(person.id, 'reset', { ttlMs: HOUR });
      const fn  = jest.fn(row => {
        expect(db.inTransaction).toBe(true);
        expect(row.used_at).toBeNull();   // the row as read before the mark
        return 'written';
      });
      expect(tokens.consume(raw, fn)).toMatchObject({ ok: true, purpose: 'reset', userId: person.id, result: 'written' });
      expect(fn).toHaveBeenCalledTimes(1);
      expect(rows()[0].used_at).toEqual(expect.any(String));
      expect(tokens.consume(raw, fn)).toEqual({ ok: false, reason: 'used', purpose: 'reset' });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('a fn that throws writes nothing and leaves the link working', () => {
      const raw = tokens.issue(person.id, 'reset', { ttlMs: HOUR });
      expect(() => tokens.consume(raw, () => { db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(person.id); throw new Error('disk full'); }))
        .toThrow('disk full');
      expect(users.findById(person.id).role).toBe('user');
      expect(tokens.peek(raw).ok).toBe(true);
    });

    test('refuses what peek refuses: invalid, expired, used', () => {
      const fn = jest.fn();
      expect(tokens.consume('nope', fn)).toEqual({ ok: false, reason: 'invalid' });
      const old = tokens.issue(person.id, 'reset', { ttlMs: MIN, now: Date.now() - HOUR });
      expect(tokens.consume(old, fn)).toEqual({ ok: false, reason: 'expired', purpose: 'reset' });
      expect(fn).not.toHaveBeenCalled();
    });
  });

  test('revoke deletes the unused links of one kind', async () => {
    const invited = await users.createUser('new@test.com', null, 'user', { invited: true });
    const invite  = tokens.issue(invited.id, 'invite', { ttlMs: DAY });
    expect(tokens.revoke(invited.id, 'invite')).toBe(1);
    expect(tokens.peek(invite)).toEqual({ ok: false, reason: 'invalid' });
    expect(tokens.revoke(invited.id, 'invite')).toBe(0);
  });

  test('prune deletes links used or run out more than 30 days ago, and nothing newer', () => {
    const now = Date.now();
    const fresh   = tokens.issue(person.id, 'reset', { ttlMs: HOUR });
    tokens.issue(admin.id, 'reset', { ttlMs: HOUR, now: now - 31 * DAY });                 // ran out 31 days ago
    const usedOld = tokens.issue(person.id, 'invite', { ttlMs: 60 * DAY, now: now - 40 * DAY });
    db.prepare('UPDATE auth_tokens SET used_at = ? WHERE token_hash = ?').run(new Date(now - 31 * DAY).toISOString(), tokens.hashToken(usedOld));
    expect(tokens.prune({ now })).toBe(2);
    expect(rows().map(r => r.token_hash)).toEqual([tokens.hashToken(fresh)]);
  });
});

describe('utils/users — invited accounts', () => {
  let db, users, tokens;

  beforeEach(() => {
    jest.resetModules();
    require('../db/migrate').run();
    db     = require('../db');
    users  = require('./users');
    tokens = require('./auth-tokens');
  });

  test("an invited account holds '!' for a password, which nothing matches", async () => {
    const u = await users.createUser('new@test.com', 'ignored-password-2026', 'user', { invited: true });
    const row = users.findById(u.id);
    expect(row).toMatchObject({ password: '!', must_change_password: 0, temp_password_expires_at: null, password_changed_at: null });
    expect(users.isInvited(row)).toBe(true);
    for (const typed of ['!', '', 'ignored-password-2026', '$argon2id$', 'anything at all']) {
      expect(await users.verifyPassword('!', typed)).toBe(false);
    }
    expect(await users.validatePassword('new@test.com', '!')).toBeNull();
    expect(users.needsRehash('!')).toBe(false);
  });

  // Answered at once, the speed would say the address has an account. The
  // dummy check is a real Argon2id (or bcrypt) hash at full cost, which takes
  // well over a few milliseconds; a refusal without it takes well under one.
  test('a check against an invited account costs a real hash, so its speed gives nothing away', async () => {
    await users.createUser('new@test.com', null, 'user', { invited: true });
    await users.verifyDummy('warm-up');
    const t0 = process.hrtime.bigint();
    expect(await users.validatePassword('new@test.com', 'guess-2026-xyz')).toBeNull();
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeGreaterThan(3);
  });

  test('sanitize says invited, until when its newest link works, and whether none does', async () => {
    const u = await users.createUser('new@test.com', null, 'user', { invited: true });
    expect(u).toMatchObject({ invited: true, inviteExpiresAt: null, inviteExpired: true });
    tokens.issue(u.id, 'invite', { ttlMs: 7 * DAY });
    const expiresAt = db.prepare('SELECT expires_at FROM auth_tokens').get().expires_at;
    expect(users.getUser(u.id)).toMatchObject({ invited: true, inviteExpiresAt: expiresAt, inviteExpired: false });
    expect(users.getAllUsers()[0]).toMatchObject({ invited: true, inviteExpiresAt: expiresAt, inviteExpired: false });

    db.prepare('UPDATE auth_tokens SET expires_at = ?').run(new Date(Date.now() - MIN).toISOString());
    expect(users.getUser(u.id)).toMatchObject({ invited: true, inviteExpired: true });
    tokens.revoke(u.id, 'invite');
    expect(users.getUser(u.id)).toMatchObject({ invited: true, inviteExpiresAt: null, inviteExpired: true });

    const real = await users.createUser('real@test.com', 'Real-pass-2026', 'user');
    expect(real).toMatchObject({ invited: false, inviteExpiresAt: null, inviteExpired: false });
    expect(users.getUser('nobody')).toBeNull();
  });

  test('a password set any other way voids every unused link of the account', async () => {
    const u = await users.createUser('new@test.com', null, 'user', { invited: true });
    const invite = tokens.issue(u.id, 'invite', { ttlMs: DAY });
    await users.setPassword(u.id, 'Admin-temp-2026', { temporary: true });   // an admin's temporary password
    expect(tokens.peek(invite)).toEqual({ ok: false, reason: 'invalid' });
    expect(users.getUser(u.id).invited).toBe(false);

    const reset = tokens.issue(u.id, 'reset', { ttlMs: DAY });
    const hash  = await users.verifiedPasswordHash(u.id, 'Admin-temp-2026');
    await users.setPassword(u.id, 'Chosen-by-me-2026', { ifCurrentHash: hash });   // their own change
    expect(tokens.peek(reset)).toEqual({ ok: false, reason: 'invalid' });
  });

  test('setPasswordHash writes a chosen password: the temporary marks come off and the date is kept', async () => {
    const u = await users.createUser('temp@test.com', 'Admin-temp-2026', 'user', { temporary: true });
    const hash = await users.hashPassword('Chosen-by-me-2026');
    users.setPasswordHash(u.id, hash);
    expect(users.findById(u.id)).toMatchObject({ password: hash, must_change_password: 0, temp_password_expires_at: null });
    expect(users.findById(u.id).password_changed_at).toEqual(expect.any(String));
    expect(await users.validatePassword('temp@test.com', 'Chosen-by-me-2026')).toMatchObject({ id: u.id });
  });
});
