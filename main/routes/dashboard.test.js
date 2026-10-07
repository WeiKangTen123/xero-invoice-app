// deploy.sh proves a deploy by comparing the server's checkout with the local
// commit. That says what is on disk, not what is running: health now names
// the commit the process was started from, so the check can look at that.
const fs      = require('fs');
const path    = require('path');
const request = require('supertest');
const express = require('express');
const { serverFor } = require('../scripts/test-server');

const appWith = health => {
  const app = express();
  app.get('/dashboard/health', health);
  return app;
};
const mockRes = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });

test('health names the running commit, so a deploy can prove what is live', async () => {
  const { body } = await request(serverFor(appWith(require('./dashboard').health))).get('/dashboard/health').expect(200);
  expect(body.status).toBe('healthy');
  expect(body.commit).toMatch(/^[0-9a-f]{7,40}$/);
});

test('DEPLOY_SHA, when set by the deploy, wins over the checkout', () => {
  jest.resetModules();
  process.env.DEPLOY_SHA = 'abc1234';
  try {
    const res = mockRes();
    require('./dashboard').health({}, res);
    expect(res.json.mock.calls[0][0].commit).toBe('abc1234');
  } finally { delete process.env.DEPLOY_SHA; }
});

// Health used to be static JSON: a server whose database had gone away still
// said "healthy". It now checks the database, the disk and the backups, and
// keeps the original fields exactly, first, because deploy.sh greps the body.
describe('health checks', () => {
  const backups = () => require('../utils/paths').backupsDir();
  afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock('../db');
    fs.rmSync(backups(), { recursive: true, force: true });
  });

  test('a working server is 200 with the original fields first and the checks after them', async () => {
    const res = await request(serverFor(appWith(require('./dashboard').health))).get('/dashboard/health').expect(200);
    const { body } = res;
    expect(Object.keys(body).slice(0, 3)).toEqual(['status', 'commit', 'timestamp']);
    expect(body.status).toBe('healthy');
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    expect(body.uptimeSeconds).toEqual(expect.any(Number));
    expect(body.checks.database).toEqual({ ok: true });
    expect(body.checks.disk).toMatchObject({ freeBytes: expect.any(Number), totalBytes: expect.any(Number) });
    expect(Array.isArray(body.warnings)).toBe(true);
    // What deploy.sh actually runs against the body.
    expect(res.text).toMatch(/healthy/);
    expect(res.text.match(/.*"commit":"([0-9a-f]*)".*/)[1]).toBe(body.commit);
  });

  test('a fresh backup is reported and raises no warning', async () => {
    fs.mkdirSync(backups(), { recursive: true });
    fs.writeFileSync(path.join(backups(), 'app-2026-10-01T00-00-00-000Z.db'), 'x');
    fs.writeFileSync(path.join(backups(), 'app-2026-10-07T00-00-00-000Z.db'), 'x');
    fs.writeFileSync(path.join(backups(), 'notes.txt'), 'not a backup');
    const old = new Date(Date.now() - 6 * 24 * 3600 * 1000);
    fs.utimesSync(path.join(backups(), 'app-2026-10-01T00-00-00-000Z.db'), old, old);
    const { body } = await request(serverFor(appWith(require('./dashboard').health))).get('/dashboard/health').expect(200);
    expect(body.checks.backup).toMatchObject({ ok: true, newest: 'app-2026-10-07T00-00-00-000Z.db' });
    expect(body.warnings.join(' ')).not.toMatch(/backup/i);
  });

  test('a stale or missing backup, or a nearly full disk, is a warning and still 200', async () => {
    const health = require('./dashboard').health;
    let { body } = await request(serverFor(appWith(health))).get('/dashboard/health').expect(200);
    expect(body.checks.backup.ok).toBe(false);
    expect(body.warnings).toContain('No database backup found');

    fs.mkdirSync(backups(), { recursive: true });
    const file = path.join(backups(), 'app-2026-09-01T00-00-00-000Z.db');
    fs.writeFileSync(file, 'x');
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    fs.utimesSync(file, old, old);
    jest.spyOn(fs, 'statfsSync').mockReturnValue({ bsize: 4096, blocks: 2621440, bavail: 25600 }); // 10GB disk, 100MB free
    ({ body } = await request(serverFor(appWith(health))).get('/dashboard/health').expect(200));
    expect(body.status).toBe('healthy');
    expect(body.checks.backup).toMatchObject({ ok: false, newest: 'app-2026-09-01T00-00-00-000Z.db' });
    expect(body.checks.disk).toMatchObject({ ok: false, freeBytes: 25600 * 4096 });
    expect(body.warnings).toContainEqual(expect.stringMatching(/^Newest database backup is 72(\.\d)? hours old$/));
    expect(body.warnings).toContainEqual(expect.stringMatching(/^Low disk space on the data volume: 0\.1GB free/));
  });

  test('a database that cannot answer SELECT 1 is a 503 "unhealthy", and the commit is still there', async () => {
    jest.resetModules();
    jest.doMock('../db', () => ({ prepare: () => { throw Object.assign(new Error('database disk image is malformed at /srv/x.db'), { code: 'SQLITE_CORRUPT' }); } }));
    const { body } = await request(serverFor(appWith(require('./dashboard').health))).get('/dashboard/health').expect(503);
    expect(body.status).toBe('unhealthy');
    expect(body.commit).toBeTruthy();
    // The code, not the message: the endpoint is public and messages carry paths.
    expect(body.checks.database).toEqual({ ok: false, error: 'SQLITE_CORRUPT' });
    expect(JSON.stringify(body)).not.toMatch(/srv/);
  });
});
