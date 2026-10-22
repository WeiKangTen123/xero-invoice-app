// The daily retention run: the audit prune (two years; sign-ins 90 days; the
// sessions 30) and the sweep for deleted accounts' folders, which used to run
// only at boot. The real prune against the in-memory database; the sweep is
// tested on its own (utils/account-cleanup.test.js) and is only watched here.
const fs   = require('fs');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;

describe('jobs/account-retention', () => {
  let job, db, logger, auditLog, cleanup, sessions, users, owner;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    db       = require('../db');
    logger   = require('../utils/logger');
    auditLog = require('../utils/audit-log');
    cleanup  = require('../utils/account-cleanup');
    sessions = require('../utils/sessions');
    users    = require('../utils/users');
    job      = require('./account-retention');
    owner    = await users.createUser('owner@test.com', 'password123', 'auto');
  });

  afterEach(() => {
    job.stop();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('runOnce', () => {
    test('prunes what has outlived its limit, without a restart', () => {
      const ago = days => new Date(Date.now() - days * DAY).toISOString();
      const ins = db.prepare('INSERT INTO admin_events (at, action) VALUES (?, ?)');
      ins.run(ago(731), 'user.sign_out'); ins.run(ago(700), 'user.sign_out');
      ins.run(ago(91), 'login.success');  ins.run(ago(89), 'login.success');
      const old = sessions.startSession(owner.id);
      const fresh = sessions.startSession(owner.id);
      db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(ago(31), old);

      expect(job.runOnce().events).toEqual({ invoices: 0, admin: 2, sessions: 1 });
      // The two-year-old event and the 91-day-old sign-in went; the rest stay.
      expect(db.prepare('SELECT action FROM admin_events ORDER BY at').all().map(r => r.action)).toEqual(['user.sign_out', 'login.success']);
      expect(db.prepare('SELECT id FROM sessions').all().map(r => r.id)).toEqual([fresh]);
    });

    test('sweeps the folders of deleted accounts', () => {
      const gone = `${Date.now() - 30 * DAY}abcdef01`;
      const dir  = path.join(require('../utils/paths').usersDir(), gone);
      fs.mkdirSync(dir, { recursive: true });
      expect(job.runOnce().folders).toEqual({ removed: [gone], kept: [] });
      expect(fs.existsSync(dir)).toBe(false);
    });

    test('a part that throws is a warning, the other part still runs, and nothing is thrown', () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      jest.spyOn(auditLog, 'pruneOldEvents').mockImplementation(() => { throw new Error('no such table: admin_events'); });
      const sweep = jest.spyOn(cleanup, 'sweepOrphanFolders').mockReturnValue({ removed: ['x'], kept: [] });
      expect(job.runOnce()).toEqual({ events: null, links: 0, folders: { removed: ['x'], kept: [] } });
      expect(sweep).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('Daily prune of old events and sessions failed', { error: 'no such table: admin_events' });

      auditLog.pruneOldEvents.mockReturnValue({ invoices: 0, admin: 0, sessions: 0 });
      sweep.mockImplementation(() => { throw new Error('EACCES'); });
      expect(job.runOnce()).toEqual({ events: { invoices: 0, admin: 0, sessions: 0 }, links: 0, folders: { removed: [], kept: [] } });
      expect(warn).toHaveBeenCalledWith('Daily sweep for the data folders of deleted accounts failed', { error: 'EACCES' });

      jest.spyOn(require('../utils/auth-tokens'), 'prune').mockImplementation(() => { throw new Error('no such table: auth_tokens'); });
      expect(job.runOnce().links).toBeNull();
      expect(warn).toHaveBeenCalledWith('Daily prune of old invite and reset links failed', { error: 'no such table: auth_tokens' });
    });

    test('prunes invite and reset links used or run out more than 30 days ago', () => {
      const authTokens = require('../utils/auth-tokens');
      const live = authTokens.issue(owner.id, 'reset', { ttlMs: authTokens.RESET_TTL_MS });
      const old  = authTokens.issue(owner.id, 'invite', { ttlMs: authTokens.INVITE_TTL_MS, now: Date.now() - 40 * DAY });
      db.prepare("UPDATE auth_tokens SET used_at = ? WHERE purpose = 'invite'").run(new Date(Date.now() - 31 * DAY).toISOString());
      expect(job.runOnce().links).toBe(1);
      expect(db.prepare('SELECT token_hash FROM auth_tokens').all().map(r => r.token_hash)).toEqual([authTokens.hashToken(live)]);
      expect(old).not.toBe(live);
    });
  });

  describe('start', () => {
    test('runs daily, on a timer that never holds the process open; a second start adds nothing', () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      const timers = [];
      const fake = global.setInterval;
      jest.spyOn(global, 'setInterval').mockImplementation((...args) => {
        const t = fake(...args);
        const own = typeof t.unref === 'function' ? t.unref.bind(t) : () => t;
        t.unref = jest.fn(own);
        timers.push(t);
        return t;
      });
      const prune = jest.spyOn(auditLog, 'pruneOldEvents').mockReturnValue({ invoices: 0, admin: 0, sessions: 0 });
      const sweep = jest.spyOn(cleanup, 'sweepOrphanFolders').mockReturnValue({ removed: [], kept: [] });

      expect(job.start()).toBe(true);
      expect(job.start()).toBe(false);
      expect(timers).toHaveLength(1);
      expect(timers[0].unref).toHaveBeenCalled();

      // Boot has already pruned and swept (index.js): nothing until a day has passed.
      jest.advanceTimersByTime(job.DAY_MS - 1);
      expect(prune).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(prune).toHaveBeenCalledTimes(1);
      expect(sweep).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(job.DAY_MS);
      expect(prune).toHaveBeenCalledTimes(2);

      job.stop();
      jest.advanceTimersByTime(2 * job.DAY_MS);
      expect(prune).toHaveBeenCalledTimes(2);
      // And it can be started again after a stop.
      expect(job.start()).toBe(true);
    });
  });
});
