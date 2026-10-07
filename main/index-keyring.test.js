// The startup check with a rotated key, in a real node process like
// index-startup.test.js (which covers ENCRYPTION_KEY alone, the configuration
// production runs today). What matters is that index.js hands keyProblem()
// the whole environment: a keyring without ENCRYPTION_KEY must start, and a
// keyring whose primary key is missing must not.
//
// main/.env is never read (dotenv is stubbed in the child); data, database
// and logs go to a temp folder and Slack is off.
const { spawn } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const STRONG = 'k'.repeat(48);
const K1 = 'b2'.repeat(32), K2 = 'c3'.repeat(32);

function boot(env, until) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xero-keyring-'));
  fs.mkdirSync(path.join(dir, 'logs'));
  const childEnv = { ...process.env };
  for (const k of ['JWT_SECRET', 'ENCRYPTION_KEY', 'ENCRYPTION_KEYS', 'ENCRYPTION_KEY_ID', 'NODE_ENV', 'JEST_WORKER_ID']) delete childEnv[k];
  Object.assign(childEnv, {
    NODE_ENV: 'production', JWT_SECRET: STRONG, SLACK_WEBHOOK_URL: '',
    DATA_DIR: path.join(dir, 'data'), DB_PATH: path.join(dir, 'data', 'app.db'), LOGS_DIR: path.join(dir, 'logs'),
    PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'info',
  }, env);
  const script = `require('dotenv').config = () => ({ parsed: {} }); require(${JSON.stringify(path.join(__dirname, 'index.js'))});`;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env: childEnv });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const poll  = setInterval(() => { if (until(out)) child.kill(); }, 50);
    const limit = setTimeout(() => child.kill(), 25000);
    child.on('error', reject);
    child.on('exit', code => {
      clearInterval(poll); clearTimeout(limit);
      const dbCreated = fs.existsSync(childEnv.DB_PATH);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a file still held; the OS temp folder will do */ }
      resolve({ code, out, dbCreated });
    });
  });
}

describe('startup check with ENCRYPTION_KEYS (separate node process)', () => {
  test('a keyring naming a primary key it does not hold refuses to start, before the database is touched', async () => {
    const { code, out, dbCreated } = await boot(
      { ENCRYPTION_KEY: K1, ENCRYPTION_KEYS: `2026-10:${K2}`, ENCRYPTION_KEY_ID: '2027-04' },
      () => false, // runs until it exits on its own
    );
    expect(code).toBe(1);
    expect(out).toMatch(/STARTUP REFUSED[\s\S]*ENCRYPTION_KEY_ID "2027-04" is not one of the keys in ENCRYPTION_KEYS \(2026-10\)/);
    expect(out).not.toContain(K2.slice(0, 16));
    expect(dbCreated).toBe(false);
  }, 30000);

  test('a keyring without ENCRYPTION_KEY starts — the state after the old key is removed', async () => {
    const { out } = await boot(
      { ENCRYPTION_KEYS: `2026-10:${K2}`, ENCRYPTION_KEY_ID: '2026-10' },
      o => /Server running on 127\.0\.0\.1/.test(o),
    );
    expect(out).toMatch(/Server running on 127\.0\.0\.1/);
    expect(out).not.toMatch(/STARTUP REFUSED|FATAL/);
  }, 30000);
});
