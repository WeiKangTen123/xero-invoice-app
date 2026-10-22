const jwt = require('jsonwebtoken');

// 2-step sign-in's own rules (utils/mfa.js), below the routes: the codes are
// the ones every authenticator app makes (RFC 6238's published vectors), a
// code is good for a step either side of now and never twice, recovery codes
// are single use and kept only as hashes, the secret is kept encrypted, and
// the half-made sign-in (mfaToken) is one account's, five minutes long, five
// wrong codes deep and used once.
describe('utils/mfa', () => {
  let db, users, mfa, jane;
  const STEP = 30 * 1000;
  const T0 = Date.UTC(2026, 9, 22, 9, 0, 0);   // a fixed now, on a step boundary
  const row = id => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    db    = require('../db');
    users = require('./users');
    mfa   = require('./mfa');
    jane  = await users.createUser('jane@test.com', 'Fixture-pass-2026', 'user');
  });
  afterEach(() => { delete process.env.MFA_REQUIRED_FOR_ADMINS; });

  // Turns 2-step on for `id` at `now`, as the set-up page would: the secret
  // and the recovery codes.
  function turnOn(id, now = T0) {
    const { secret } = mfa.beginSetup(id);
    const result = mfa.enable(id, mfa.codeAt(secret, now), now);
    expect(result.ok).toBe(true);
    return { secret, recoveryCodes: result.recoveryCodes };
  }

  describe('codes', () => {
    test("RFC 6238's SHA-1 test vectors, cut to six digits", () => {
      const secret = mfa.base32Encode(Buffer.from('12345678901234567890'));
      expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
      for (const [seconds, eight] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
        [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
        expect(mfa.codeAt(secret, seconds * 1000)).toBe(eight.slice(-6));
      }
    });

    test('base32 round-trips, forgiving case, spaces and padding, and refusing anything else', () => {
      const bytes = Buffer.from('a secret of twenty b');
      const text = mfa.base32Encode(bytes);
      expect(mfa.base32Decode(text)).toEqual(bytes);
      expect(mfa.base32Decode(`${text.toLowerCase().replace(/(.{4})/g, '$1 ')}==`)).toEqual(bytes);
      expect(() => mfa.base32Decode('ABC1')).toThrow();
      const secret = mfa.generateSecret();
      expect(secret).toMatch(/^[A-Z2-7]{32}$/);   // 20 bytes
      expect(mfa.generateSecret()).not.toBe(secret);
    });

    test('a code is good for its step and one either side, and only after the last step accepted', () => {
      const secret = mfa.generateSecret();
      const now = T0 + 10 * 1000;
      expect(mfa.matchStep(secret, mfa.codeAt(secret, now), { now })).toBe(mfa.stepAt(now));
      expect(mfa.matchStep(secret, mfa.codeAt(secret, now - STEP), { now })).toBe(mfa.stepAt(now) - 1);
      expect(mfa.matchStep(secret, mfa.codeAt(secret, now + STEP), { now })).toBe(mfa.stepAt(now) + 1);
      expect(mfa.matchStep(secret, mfa.codeAt(secret, now - 2 * STEP), { now })).toBeNull();
      expect(mfa.matchStep(secret, mfa.codeAt(secret, now + 2 * STEP), { now })).toBeNull();
      // Spaces as some apps show them; a number as a form may send it.
      const code = mfa.codeAt(secret, now);
      expect(mfa.matchStep(secret, `${code.slice(0, 3)} ${code.slice(3)}`, { now })).toBe(mfa.stepAt(now));
      if (!code.startsWith('0')) expect(mfa.matchStep(secret, Number(code), { now })).toBe(mfa.stepAt(now));
      // Already used: that step and every one before it.
      expect(mfa.matchStep(secret, code, { now, lastStep: mfa.stepAt(now) })).toBeNull();
      for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined, {}]) expect(mfa.matchStep(secret, bad, { now })).toBeNull();
    });

    test('the otpauth URL and the QR code an app scans', async () => {
      const url = mfa.otpauthUrl('jane@test.com', 'JBSWY3DPEHPK3PXP');
      expect(url).toBe('otpauth://totp/Financial%20Automation:jane%40test.com?secret=JBSWY3DPEHPK3PXP'
        + '&issuer=Financial%20Automation&algorithm=SHA1&digits=6&period=30');
      const qr = await mfa.qrSvgDataUrl(url);
      expect(qr).toMatch(/^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/);
      expect(Buffer.from(qr.split(',')[1], 'base64').toString('utf8')).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
    });

    test('recovery codes: ten of xxxx-xxxx-xxxx from an alphabet with nothing to misread, compared however typed', () => {
      const codes = mfa.generateRecoveryCodes();
      expect(codes).toHaveLength(10);
      expect(new Set(codes).size).toBe(10);
      for (const c of codes) expect(c).toMatch(/^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/);
      const c = codes[0];
      const hash = mfa.hashRecoveryCode(c);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      for (const typed of [c.toUpperCase(), c.replace(/-/g, ''), ` ${c.replace(/-/g, ' ')} `]) expect(mfa.hashRecoveryCode(typed)).toBe(hash);
      expect(mfa.hashRecoveryCode('short')).toBeNull();
      expect(mfa.looksLikeRecoveryCode(c)).toBe(true);
      expect(mfa.looksLikeRecoveryCode('123456')).toBe(false);
    });
  });

  describe('who must have it', () => {
    test('admins must, on every server; MFA_REQUIRED_FOR_ADMINS says otherwise; off by default only under the test suite', () => {
      expect(mfa.requiredForAdmins({ NODE_ENV: 'production' })).toBe(true);
      expect(mfa.requiredForAdmins({})).toBe(true);
      expect(mfa.requiredForAdmins({ NODE_ENV: 'test' })).toBe(false);
      expect(mfa.requiredForAdmins({ NODE_ENV: 'test', MFA_REQUIRED_FOR_ADMINS: 'true' })).toBe(true);
      expect(mfa.requiredForAdmins({ NODE_ENV: 'production', MFA_REQUIRED_FOR_ADMINS: 'false' })).toBe(false);
      process.env.MFA_REQUIRED_FOR_ADMINS = 'true';
      expect(mfa.requiredFor({ role: 'admin' })).toBe(true);
      expect(mfa.requiredFor({ role: 'user' })).toBe(false);
      expect(mfa.setupRequired({ role: 'admin' })).toBe(true);
      expect(mfa.setupRequired({ role: 'admin', mfa_enabled_at: 'x', mfa_secret: 'y' })).toBe(false);
    });
  });

  describe('an account', () => {
    test('set-up keeps the secret pending and encrypted; a right code turns it on with ten recovery codes kept as hashes', () => {
      expect(mfa.status(jane.id)).toEqual({ enabled: false, enabledAt: null, required: false, recoveryCodesLeft: 0 });
      const first = mfa.beginSetup(jane.id);
      const { secret, otpauthUrl } = mfa.beginSetup(jane.id);   // asked again: replaced
      expect(otpauthUrl).toContain(`secret=${secret}`);
      expect(row(jane.id).mfa_pending_secret).toMatch(/^enc:v[12]:/);
      expect(row(jane.id).mfa_pending_secret).not.toContain(secret);
      expect(mfa.enable(jane.id, mfa.codeAt(first.secret, T0), T0)).toEqual({ ok: false, reason: 'wrong_code' });
      expect(mfa.enable(jane.id, '000000', T0).ok).toBe(false);
      const result = mfa.enable(jane.id, mfa.codeAt(secret, T0), T0);
      expect(result).toEqual({ ok: true, recoveryCodes: expect.any(Array), enabledAt: new Date(T0).toISOString() });
      const r = row(jane.id);
      expect(r).toMatchObject({ mfa_pending_secret: null, mfa_enabled_at: new Date(T0).toISOString(), mfa_last_step: mfa.stepAt(T0) });
      expect(r.mfa_secret).toMatch(/^enc:v[12]:/);
      expect(require('./crypto').decrypt(r.mfa_secret)).toBe(secret);
      expect(JSON.parse(r.mfa_recovery)).toEqual(result.recoveryCodes.map(mfa.hashRecoveryCode));
      expect(r.mfa_recovery).not.toContain(result.recoveryCodes[0]);
      expect(mfa.status(jane.id)).toEqual({ enabled: true, enabledAt: new Date(T0).toISOString(), required: false, recoveryCodesLeft: 10 });
      expect(users.getUser(jane.id).mfaEnabled).toBe(true);
      // On already: no second set-up, no second enable.
      expect(mfa.beginSetup(jane.id)).toBeNull();
      expect(mfa.enable(jane.id, mfa.codeAt(secret, T0 + STEP), T0 + STEP)).toEqual({ ok: false, reason: 'already' });
    });

    test('enable with no set-up under way says so', () => {
      expect(mfa.enable(jane.id, '123456', T0)).toEqual({ ok: false, reason: 'no_setup' });
    });

    test('verifyCode: a right code once; the code that turned it on, or any code twice, never', () => {
      const { secret } = turnOn(jane.id, T0);
      expect(mfa.verifyCode(jane.id, mfa.codeAt(secret, T0), T0)).toBe(false);   // used by enable
      const later = T0 + 2 * STEP;
      expect(mfa.verifyCode(jane.id, mfa.codeAt(secret, later), later)).toBe(true);
      expect(mfa.verifyCode(jane.id, mfa.codeAt(secret, later), later)).toBe(false);
      // The step before the one used is no use either, though still in the window.
      expect(mfa.verifyCode(jane.id, mfa.codeAt(secret, later - STEP), later)).toBe(false);
      expect(mfa.verifyCode(jane.id, mfa.codeAt(secret, later + STEP), later)).toBe(true);
      expect(mfa.verifyCode(jane.id, 'nonsense', later)).toBe(false);
    });

    test('a recovery code works once; new ones void the old; turning off clears everything', () => {
      const { recoveryCodes } = turnOn(jane.id);
      expect(mfa.useRecoveryCode(jane.id, recoveryCodes[3].toUpperCase())).toBe(9);
      expect(mfa.useRecoveryCode(jane.id, recoveryCodes[3])).toBeNull();
      expect(mfa.useRecoveryCode(jane.id, 'aaaa-aaaa-aaaa')).toBeNull();
      expect(mfa.recoveryCodesLeft(jane.id)).toBe(9);
      const fresh = mfa.regenerateRecoveryCodes(jane.id);
      expect(fresh).toHaveLength(10);
      expect(mfa.useRecoveryCode(jane.id, recoveryCodes[0])).toBeNull();
      expect(mfa.useRecoveryCode(jane.id, fresh[0])).toBe(9);
      expect(mfa.turnOff(jane.id)).toBe(true);
      expect(row(jane.id)).toMatchObject({ mfa_secret: null, mfa_pending_secret: null, mfa_enabled_at: null, mfa_last_step: null, mfa_recovery: null });
      expect(mfa.turnOff(jane.id)).toBe(false);
      expect(mfa.regenerateRecoveryCodes(jane.id)).toBeNull();
      expect(mfa.useRecoveryCode(jane.id, fresh[1])).toBeNull();
    });
  });

  describe('the half-made sign-in (mfaToken)', () => {
    const secret = () => require('../middleware/auth-middleware').jwtSecret();

    test("one account's, audience 'mfa', five minutes, and what the password step learnt", () => {
      const token = mfa.issueChallenge(jane.id, { passwordChange: true, viaKnownAddress: true });
      const claims = jwt.verify(token, secret(), { audience: 'mfa' });
      expect(claims).toMatchObject({ id: jane.id, pwc: true, kna: true, aud: 'mfa', jti: expect.stringMatching(/^[0-9a-f]{32}$/) });
      expect(claims.exp - claims.iat).toBe(5 * 60);
      expect(mfa.readChallenge(token)).toEqual({ claims, jti: claims.jti });
      const plain = jwt.decode(mfa.issueChallenge(jane.id));
      expect(plain.pwc).toBeUndefined();
      expect(plain.kna).toBeUndefined();
    });

    test('spent once; dead after five wrong codes; ended on demand', () => {
      const a = mfa.issueChallenge(jane.id);
      const { jti } = mfa.readChallenge(a);
      expect(mfa.spendChallenge(jti)).toBe(true);
      expect(mfa.spendChallenge(jti)).toBe(false);
      expect(mfa.readChallenge(a)).toEqual({ error: 'used' });

      const b = mfa.issueChallenge(jane.id);
      const jb = mfa.readChallenge(b).jti;
      for (let i = 1; i <= 4; i++) expect(mfa.countWrongCode(jb)).toEqual({ wrong: i, dead: false });
      expect(mfa.countWrongCode(jb)).toEqual({ wrong: 5, dead: true });
      expect(mfa.readChallenge(b)).toEqual({ error: 'too_many' });
      expect(mfa.spendChallenge(jb)).toBe(false);

      const c = mfa.issueChallenge(jane.id);
      mfa.endChallenge(mfa.readChallenge(c).jti);
      expect(mfa.readChallenge(c)).toEqual({ error: 'ended' });
    });

    test('a session token, a forged one, an expired one, or one from before a restart is no mfaToken', () => {
      const auth = require('../middleware/auth-middleware');
      expect(mfa.readChallenge(auth.signSession({ id: jane.id, email: jane.email, role: 'user' }))).toEqual({ error: 'invalid' });
      expect(mfa.readChallenge(jwt.sign({ id: jane.id }, 'not-the-secret', { audience: 'mfa', jwtid: 'x' }))).toEqual({ error: 'invalid' });
      expect(mfa.readChallenge(jwt.sign({ id: jane.id, iat: Math.floor(Date.now() / 1000) - 600 }, secret(),
        { audience: 'mfa', expiresIn: 300, jwtid: 'y' }))).toEqual({ error: 'expired' });
      // Well signed and in date, but this process never issued it.
      expect(mfa.readChallenge(jwt.sign({ id: jane.id }, secret(), { audience: 'mfa', expiresIn: 300, jwtid: 'z' }))).toEqual({ error: 'expired' });
      for (const v of [undefined, null, '', 42]) expect(mfa.readChallenge(v)).toEqual({ error: 'invalid' });
    });
  });
});
