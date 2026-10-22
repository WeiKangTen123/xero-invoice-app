// main/scripts/mfa-reset.js: the server-shell way to turn off 2-step sign-in
// for an admin who has lost both phone and recovery codes. Real users,
// sessions, audit trail and 2-step module; Slack is stubbed.
describe('scripts/mfa-reset', () => {
  let users, mfa, sessions, auditLog, notify, resetMfa, Refusal;

  beforeEach(() => {
    jest.resetModules();
    require('../db/migrate').run();
    users    = require('../utils/users');
    mfa      = require('../utils/mfa');
    sessions = require('../utils/sessions');
    auditLog = require('../utils/audit-log');
    notify   = require('../utils/notify');
    jest.spyOn(notify, 'notifySecurity').mockResolvedValue(true);
    ({ resetMfa, Refusal } = require('./mfa-reset'));
  });

  afterEach(() => jest.restoreAllMocks());

  // An admin with 2-step on, as enabling through the routes leaves it.
  async function adminWithTwoStep(email) {
    const admin = await users.createUser(email, 'Admin-pass-2026-x', 'admin');
    const { secret } = await mfa.beginSetup(admin.id);
    const ok = mfa.enable(admin.id, mfa.codeAt(secret, Date.now()));
    expect(ok).toBeTruthy();
    expect(mfa.isEnabled(users.findById(admin.id))).toBe(true);
    return admin;
  }

  test('turns 2-step off, ends every session, and records it with no actor', async () => {
    const admin = await adminWithTwoStep('owner@test.com');
    const sid = sessions.startSession(admin.id, { ip: '1.2.3.4', userAgent: 'x' });
    const lines = [];
    const result = await resetMfa(' Owner@Test.com ', { log: line => lines.push(line) });

    expect(result).toEqual({ email: 'owner@test.com', wasOn: true });
    expect(mfa.isEnabled(users.findById(admin.id))).toBe(false);
    expect(mfa.setupRequired({ ...users.findById(admin.id) })).toBe(mfa.requiredForAdmins());
    expect(users.findById(admin.id).sessions_valid_from).not.toBeNull();
    expect(sessions.isSessionLive(sid)).toBe(false);
    const event = auditLog.listAdminEvents({ action: 'mfa.reset', limit: 1 }).events[0];
    expect(event).toMatchObject({ actorEmail: null, targetEmail: 'owner@test.com', details: { via: 'server script', wasOn: true } });
    expect(notify.notifySecurity).toHaveBeenCalledWith(expect.stringContaining('owner@test.com (an admin)'));
    expect(lines.join('\n')).toMatch(/turned off for owner@test.com/);
    expect(lines.join('\n')).not.toMatch(/Admin-pass|secret/i);
  });

  test('an account without 2-step is signed out all the same, and says so', async () => {
    await users.createUser('plain@test.com', 'Plain-pass-2026-x', 'user');
    const lines = [];
    expect(await resetMfa('plain@test.com', { log: l => lines.push(l) })).toEqual({ email: 'plain@test.com', wasOn: false });
    expect(lines[0]).toMatch(/had no 2-step sign-in on/);
  });

  test('refuses a bad or unknown address, changing nothing', async () => {
    await expect(resetMfa('not-an-email')).rejects.toBeInstanceOf(Refusal);
    await expect(resetMfa('nobody@test.com')).rejects.toThrow('no account uses nobody@test.com');
    expect(auditLog.listAdminEvents({ action: 'mfa.reset', limit: 5 }).events).toHaveLength(0);
  });

  test('a Slack failure does not undo the reset', async () => {
    const admin = await adminWithTwoStep('owner@test.com');
    notify.notifySecurity.mockRejectedValue(new Error('slack down'));
    await expect(resetMfa('owner@test.com', { log: () => {} })).resolves.toMatchObject({ wasOn: true });
    expect(mfa.isEnabled(users.findById(admin.id))).toBe(false);
  });
});
