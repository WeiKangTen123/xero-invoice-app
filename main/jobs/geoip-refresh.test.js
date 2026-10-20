// The daily check that keeps the IP-location databases current. The fetch
// itself (scripts/update-geoip.js, tested on its own) is replaced, so nothing
// here downloads; the database files are real files whose dates the tests set.
jest.mock('../scripts/update-geoip', () => ({ update: jest.fn() }));

const fs = require('fs');

const DAY = 24 * 60 * 60 * 1000;

describe('jobs/geoip-refresh', () => {
  let job, geoip, updater, logger, now;

  const put = (kind, daysOld) => {
    fs.mkdirSync(geoip.GEOIP_DIR, { recursive: true });
    const file = geoip.fileFor(kind);
    fs.writeFileSync(file, kind);
    const at = new Date(now - daysOld * DAY);
    fs.utimesSync(file, at, at);
  };

  beforeEach(() => {
    jest.resetModules();
    updater = require('../scripts/update-geoip');
    updater.update.mockReset();
    updater.update.mockResolvedValue({ updated: [], failed: [] });
    geoip  = require('../utils/geoip');
    logger = require('../utils/logger');
    job    = require('./geoip-refresh');
    fs.rmSync(geoip.GEOIP_DIR, { recursive: true, force: true });
    now = Date.now();
  });

  afterEach(() => {
    job.stop();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('what is due', () => {
    test('both, when there are no files', () => {
      expect(job.dueDatabases(now)).toEqual(['city', 'asn']);
    });

    test('nothing, when both are under 35 days old', () => {
      put('city', 34);
      put('asn', 1);
      expect(job.dueDatabases(now)).toEqual([]);
    });

    test('only the one that is missing or older than 35 days', () => {
      put('city', 36);
      put('asn', 3);
      expect(job.dueDatabases(now)).toEqual(['city']);
      fs.unlinkSync(geoip.fileFor('city'));
      put('asn', 40);
      expect(job.dueDatabases(now)).toEqual(['city', 'asn']);
    });
  });

  describe('runOnce', () => {
    test('fetches only what is due', async () => {
      put('city', 2);
      updater.update.mockResolvedValue({ updated: [{ kind: 'asn', month: '2026-10', bytes: 9 }], failed: [] });
      const info = jest.spyOn(logger, 'info');
      const result = await job.runOnce({ now });
      expect(updater.update).toHaveBeenCalledWith({ now: new Date(now), kinds: ['asn'] });
      expect(result).toEqual({ ran: true, updated: [{ kind: 'asn', month: '2026-10', bytes: 9 }], failed: [] });
      expect(info).toHaveBeenCalledWith('IP location databases updated', { databases: ['asn 2026-10'] });
    });

    test('fetches nothing when both are current', async () => {
      put('city', 2);
      put('asn', 2);
      expect(await job.runOnce({ now })).toEqual({ ran: false, updated: [], failed: [] });
      expect(updater.update).not.toHaveBeenCalled();
    });

    test('a database that could not be fetched is a warning', async () => {
      updater.update.mockResolvedValue({ updated: [], failed: [{ kind: 'city', error: 'answered 503' }] });
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      await expect(job.runOnce({ now })).resolves.toMatchObject({ ran: true, failed: [{ kind: 'city' }] });
      expect(warn).toHaveBeenCalledWith('IP location database not updated', { database: 'city', error: 'answered 503' });
    });

    test('a fetch that throws is a warning too, never a rejection', async () => {
      updater.update.mockRejectedValue(new Error('disk full'));
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      await expect(job.runOnce({ now })).resolves.toEqual({ ran: true, updated: [], failed: [] });
      expect(warn).toHaveBeenCalledWith('IP location database refresh failed', { error: 'disk full' });
    });

    test('a call while one runs gets that run', async () => {
      let finish;
      updater.update.mockReturnValue(new Promise(resolve => { finish = resolve; }));
      const a = job.runOnce({ now });
      const b = job.runOnce({ now });
      finish({ updated: [], failed: [] });
      expect(await a).toBe(await b);
      expect(updater.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('start', () => {
    test('does nothing under the test suite: a run is a 60 MB download', () => {
      jest.useFakeTimers();
      expect(job.start()).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(2 * job.DAY_MS);
      expect(updater.update).not.toHaveBeenCalled();
    });

    test('checks shortly after boot, then daily, on timers that never hold the process open', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      const timers = [];
      for (const name of ['setTimeout', 'setInterval']) {
        const fake = global[name];
        jest.spyOn(global, name).mockImplementation((...args) => {
          const t = fake(...args);
          const own = typeof t.unref === 'function' ? t.unref.bind(t) : () => t;
          t.unref = jest.fn(own);
          timers.push(t);
          return t;
        });
      }
      expect(job.start({ force: true })).toBe(true);
      expect(job.start({ force: true })).toBe(true);   // a second start adds nothing
      expect(jest.getTimerCount()).toBe(2);
      expect(timers).toHaveLength(2);
      for (const t of timers) expect(t.unref).toHaveBeenCalled();

      jest.advanceTimersByTime(job.FIRST_RUN_DELAY_MS - 1);
      expect(updater.update).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      await new Promise(resolve => setImmediate(resolve));
      expect(updater.update).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(job.DAY_MS);
      await new Promise(resolve => setImmediate(resolve));
      expect(updater.update).toHaveBeenCalledTimes(2);

      job.stop();
      jest.advanceTimersByTime(job.DAY_MS);
      expect(updater.update).toHaveBeenCalledTimes(2);
    });
  });
});
