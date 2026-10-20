// Sign-in sessions at the store: what a sign-in writes, how often use is
// written, how a session ends, what the lists say, and what is pruned.
describe('utils/sessions', () => {
  let db, users, sessions, jane, john;
  const MIN  = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY  = 24 * HOUR;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    db       = require('../db');
    users    = require('./users');
    sessions = require('./sessions');
    jane = await users.createUser('jane@test.com', 'password123', 'user');
    john = await users.createUser('john@test.com', 'password123', 'user');
  });

  const row = sid => db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
  // Moves a session's clock back, as if it had been used `ms` ago.
  const lastSeen = (sid, ms) => db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(new Date(Date.now() - ms).toISOString(), sid);

  test('the table and the index the lists read by exist', () => {
    const cols = db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name);
    expect(cols).toEqual(['id', 'user_id', 'created_at', 'last_seen_at', 'first_ip', 'last_ip', 'user_agent', 'ended_at', 'ended_reason', 'ended_by']);
    expect(db.prepare('PRAGMA index_info(idx_sessions_user)').all().map(c => c.name)).toEqual(['user_id', 'last_seen_at']);
    expect(sessions.SESSION_LIFETIME_MS).toBe(require('../middleware/auth-middleware').SESSION_TTL_SECONDS * 1000);
  });

  test('startSession: a random 16-byte id, and the address and browser it began from', () => {
    const sid = sessions.startSession(jane.id, { ip: '203.0.113.5', userAgent: '  Mozilla/5.0 (Windows)  ' });
    expect(sid).toMatch(/^[0-9a-f]{32}$/);
    expect(sessions.startSession(jane.id)).not.toBe(sid);
    expect(row(sid)).toEqual({
      id: sid, user_id: jane.id, created_at: expect.any(String), last_seen_at: expect.any(String),
      first_ip: '203.0.113.5', last_ip: '203.0.113.5', user_agent: 'Mozilla/5.0 (Windows)',
      ended_at: null, ended_reason: null, ended_by: null,
    });
    expect(row(sid).last_seen_at).toBe(row(sid).created_at);
    // A browser's description is kept to 300 characters.
    const long = sessions.startSession(jane.id, { userAgent: 'x'.repeat(1000) });
    expect(row(long).user_agent).toHaveLength(sessions.USER_AGENT_MAX);
    expect(sessions.USER_AGENT_MAX).toBe(300);
  });

  test('userAgentOf reads the header from a request, trimmed and cut short, or null', () => {
    const req = ua => ({ get: name => (name === 'User-Agent' ? ua : undefined) });
    expect(sessions.userAgentOf(req(' Safari '))).toBe('Safari');
    expect(sessions.userAgentOf(req('y'.repeat(400)))).toHaveLength(300);
    expect(sessions.userAgentOf(req(undefined))).toBeNull();
    expect(sessions.userAgentOf(req('   '))).toBeNull();
    expect(sessions.userAgentOf({ headers: { 'user-agent': 'curl/8' } })).toBe('curl/8');
    expect(sessions.userAgentOf(null)).toBeNull();
  });

  test('touchSession writes at most once a minute, keeps the last address when none is given, and never touches an ended session', () => {
    const sid = sessions.startSession(jane.id, { ip: '10.0.0.1' });
    const started = row(sid).last_seen_at;
    const t0 = Date.now();
    // The sign-in itself was the first touch.
    sessions.touchSession(sid, { ip: '10.0.0.2', now: t0 + 30 * 1000 });
    expect(row(sid)).toMatchObject({ last_seen_at: started, last_ip: '10.0.0.1' });
    sessions.touchSession(sid, { ip: '10.0.0.2', now: t0 + MIN });
    expect(row(sid)).toMatchObject({ last_seen_at: new Date(t0 + MIN).toISOString(), last_ip: '10.0.0.2', first_ip: '10.0.0.1' });
    sessions.touchSession(sid, { ip: '10.0.0.3', now: t0 + MIN + 59 * 1000 });
    expect(row(sid).last_ip).toBe('10.0.0.2');
    sessions.touchSession(sid, { now: t0 + 2 * MIN });
    expect(row(sid)).toMatchObject({ last_seen_at: new Date(t0 + 2 * MIN).toISOString(), last_ip: '10.0.0.2' });

    sessions.endSession(sid, 'logout');
    const ended = row(sid).last_seen_at;
    sessions.touchSession(sid, { ip: '10.0.0.9', now: t0 + 10 * MIN });
    expect(row(sid)).toMatchObject({ last_seen_at: ended, last_ip: '10.0.0.2' });
    expect(() => sessions.touchSession(null)).not.toThrow();
  });

  test('endSession ends one session with why and who; a second end keeps the first reason', () => {
    const a = sessions.startSession(jane.id);
    const b = sessions.startSession(jane.id);
    expect(sessions.isSessionLive(a)).toBe(true);
    expect(sessions.endSession(a, 'revoked', john.id)).toBe(true);
    expect(row(a)).toMatchObject({ ended_at: expect.any(String), ended_reason: 'revoked', ended_by: john.id });
    expect(sessions.isSessionLive(a)).toBe(false);
    expect(sessions.isSessionLive(b)).toBe(true);
    expect(sessions.endSession(a, 'logout')).toBe(false);
    expect(row(a)).toMatchObject({ ended_reason: 'revoked', ended_by: john.id });
    expect(sessions.endSession(b, 'logout')).toBe(true);
    expect(row(b)).toMatchObject({ ended_reason: 'logout', ended_by: null });
    expect(sessions.endSession('nope', 'logout')).toBe(false);
  });

  test('endAllSessions ends every live session of one account, except the one named', () => {
    const keep  = sessions.startSession(jane.id);
    const other = sessions.startSession(jane.id);
    const gone  = sessions.startSession(jane.id);
    sessions.endSession(gone, 'logout');
    const his = sessions.startSession(john.id);
    expect(sessions.endAllSessions(jane.id, 'password_changed', { except: keep })).toBe(1);
    expect(sessions.isSessionLive(keep)).toBe(true);
    expect(row(other)).toMatchObject({ ended_reason: 'password_changed', ended_by: null });
    expect(row(gone).ended_reason).toBe('logout');           // already ended: left as it ended
    expect(sessions.isSessionLive(his)).toBe(true);           // nobody else's
    expect(sessions.endAllSessions(jane.id, 'disabled', { endedBy: john.id })).toBe(1);
    expect(row(keep)).toMatchObject({ ended_reason: 'disabled', ended_by: john.id });
  });

  test('isSessionLive: a session that exists and has not ended; nothing else', () => {
    expect(sessions.isSessionLive('0'.repeat(32))).toBe(false);
    expect(sessions.isSessionLive(null)).toBe(false);
    expect(sessions.isSessionLive(undefined)).toBe(false);
  });

  test('listSessions: in use by default, most recently used first; active:false adds the ended ones, and says when one ran out', () => {
    const now = Date.now();
    const old     = sessions.startSession(jane.id, { ip: '10.0.0.1', userAgent: 'Firefox' });
    const recent  = sessions.startSession(jane.id, { ip: '10.0.0.2', userAgent: 'Safari' });
    const ended   = sessions.startSession(jane.id, { ip: '10.0.0.3' });
    const stale   = sessions.startSession(jane.id, { ip: '10.0.0.4' });
    sessions.startSession(john.id);
    lastSeen(old, 3 * HOUR);
    lastSeen(recent, 5 * MIN);
    sessions.endSession(ended, 'logout');
    lastSeen(stale, DAY + MIN);

    const active = sessions.listSessions(jane.id, { now });
    expect(active.map(s => s.sid)).toEqual([recent, old]);
    expect(active[0]).toEqual({
      sid: recent, createdAt: expect.any(String), lastSeenAt: expect.any(String), firstIp: '10.0.0.2', lastIp: '10.0.0.2',
      userAgent: 'Safari', endedAt: null, endedReason: null,
    });
    expect(sessions.listSessions(jane.id)).toHaveLength(2);

    const all = sessions.listSessions(jane.id, { active: false, now });
    expect(all.map(s => s.sid)).toEqual([ended, recent, old, stale]);
    expect(all[0]).toMatchObject({ endedReason: 'logout', endedAt: expect.any(String) });
    // Nothing ended it: its last token ran out a day after it was last used.
    const ranOut = all.find(s => s.sid === stale);
    expect(ranOut).toMatchObject({ endedReason: 'expired' });
    expect(Date.parse(ranOut.endedAt)).toBe(Date.parse(ranOut.lastSeenAt) + DAY);
    expect(sessions.listSessions('nobody')).toEqual([]);
  });

  test('getSession: one session with the account it belongs to, or null', () => {
    const sid = sessions.startSession(jane.id, { ip: '10.0.0.1' });
    expect(sessions.getSession(sid)).toMatchObject({ sid, userId: jane.id, firstIp: '10.0.0.1', endedAt: null });
    expect(sessions.getSession('nope')).toBeNull();
    expect(sessions.getSession(null)).toBeNull();
  });

  test('pruneSessions deletes what was last used, or ended, more than 30 days ago', () => {
    const now = Date.now();
    const fresh   = sessions.startSession(jane.id);
    const idle    = sessions.startSession(jane.id);
    const endedOk = sessions.startSession(jane.id);
    const endedOld = sessions.startSession(jane.id);
    lastSeen(idle, 31 * DAY);
    lastSeen(endedOk, 29 * DAY);
    sessions.endSession(endedOk, 'logout');
    sessions.endSession(endedOld, 'logout');
    db.prepare('UPDATE sessions SET last_seen_at = ?, ended_at = ? WHERE id = ?')
      .run(new Date(now - 40 * DAY).toISOString(), new Date(now - 31 * DAY).toISOString(), endedOld);
    expect(sessions.pruneSessions(now)).toBe(2);
    expect(db.prepare('SELECT id FROM sessions ORDER BY id').all().map(r => r.id).sort()).toEqual([fresh, endedOk].sort());
    expect(sessions.SESSION_RETENTION_DAYS).toBe(30);
  });

  test("deleting an account deletes its sessions, and nobody else's", () => {
    const hers = sessions.startSession(jane.id);
    const his  = sessions.startSession(john.id);
    users.deleteUser(jane.id);
    expect(row(hers)).toBeUndefined();
    expect(row(his)).toBeTruthy();
  });
});
