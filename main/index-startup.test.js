// The server's own secrets are checked before anything else runs. These boot
// main/index.js in a real node process, because what is being tested is
// whether that process exits: a missing JWT_SECRET used to fall back to a
// value published in this repository whenever NODE_ENV was not 'production'.
//
// main/.env is never read (dotenv is stubbed in the child), so each test says
// exactly which secrets exist. Data, database and logs go to a temp folder,
// and Slack is a local server in this process — nothing leaves the machine.
const { spawn } = require('child_process');
const http = require('http');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const KEY    = 'ab'.repeat(32);
const STRONG = 'k'.repeat(48);

let slack, posts = [];
beforeAll(done => {
  slack = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; }).on('end', () => {
      try { posts.push(JSON.parse(body).text); } catch { posts.push(body); }
      res.end('ok');
    });
  }).listen(0, '127.0.0.1', done);
});
afterAll(() => new Promise(resolve => slack.close(() => resolve())));
beforeEach(() => { posts = []; });

// Resolves when the child exits, or — when `until(out)` is given — once it is
// true and every expected Slack post has arrived, killing the child then.
function boot(env, { until, slackPosts = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xero-boot-'));
  fs.mkdirSync(path.join(dir, 'logs'));
  const childEnv = { ...process.env };
  for (const k of ['JWT_SECRET', 'ENCRYPTION_KEY', 'NODE_ENV', 'JEST_WORKER_ID']) delete childEnv[k];
  Object.assign(childEnv, {
    DATA_DIR: path.join(dir, 'data'), DB_PATH: path.join(dir, 'data', 'app.db'), LOGS_DIR: path.join(dir, 'logs'),
    PORT: '0', HOST: '127.0.0.1', DEPLOY_SHA: 'abc1234', LOG_LEVEL: 'info',
    SLACK_WEBHOOK_URL: `http://127.0.0.1:${slack.address().port}/hook`,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  });
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k]; else childEnv[k] = v;
  }
  const script = `require('dotenv').config = () => ({ parsed: {} }); require(${JSON.stringify(path.join(__dirname, 'index.js'))});`;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env: childEnv });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const poll = until && setInterval(() => {
      if (until(out) && posts.length >= slackPosts) child.kill();
    }, 50);
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

describe('startup secrets check (separate node process)', () => {
  test.each([
    ['production', 'production'],
    ['development', 'development'],
    ['NODE_ENV unset', undefined],
  ])('no JWT_SECRET: refuses to start in %s, before the database is touched, and says why on Slack', async (_label, NODE_ENV) => {
    const { code, out, dbCreated } = await boot({ NODE_ENV, ENCRYPTION_KEY: KEY });
    expect(code).toBe(1);
    expect(out).toMatch(/STARTUP REFUSED[\s\S]*JWT_SECRET is not set/);
    expect(out).not.toMatch(/Server running/);
    expect(dbCreated).toBe(false);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/STARTUP REFUSED[\s\S]*JWT_SECRET is not set/);
  }, 30000);

  test('an empty JWT_SECRET is missing too', async () => {
    const { code, out } = await boot({ NODE_ENV: 'production', JWT_SECRET: '', ENCRYPTION_KEY: KEY });
    expect(code).toBe(1);
    expect(out).toMatch(/JWT_SECRET is not set/);
  }, 30000);

  test('no ENCRYPTION_KEY, or one crypto.js cannot use, refuses to start', async () => {
    let r = await boot({ NODE_ENV: 'production', JWT_SECRET: STRONG });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ENCRYPTION_KEY not set/);
    expect(r.dbCreated).toBe(false);

    r = await boot({ NODE_ENV: 'production', JWT_SECRET: STRONG, ENCRYPTION_KEY: 'change_this_to_a_64_char_hex_string' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ENCRYPTION_KEY must be 64 hex characters/);
  }, 60000);

  test('both missing: one refusal names both', async () => {
    const { code, out } = await boot({ NODE_ENV: 'production' });
    expect(code).toBe(1);
    expect(out).toMatch(/JWT_SECRET is not set[\s\S]*ENCRYPTION_KEY not set/);
  }, 30000);

  // The production .env cannot be seen from here, so nothing short of missing
  // may stop the server. A short secret, and a key written in upper case with
  // a stray trailing character (which crypto.js has always accepted), start.
  test('a short JWT_SECRET only warns and alerts; the server starts, migrations and all', async () => {
    const { out, dbCreated } = await boot(
      { NODE_ENV: 'production', JWT_SECRET: 'too-short', ENCRYPTION_KEY: KEY.toUpperCase() + 'z' },
      { until: o => /Server running on 127\.0\.0\.1/.test(o), slackPosts: 1 },
    );
    expect(out).toMatch(/WARNING: JWT_SECRET is only 9 characters; use at least 32/);
    expect(out).toMatch(/Server running on 127\.0\.0\.1/);
    expect(out).not.toMatch(/STARTUP REFUSED|FATAL/);
    expect(dbCreated).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/server started anyway[\s\S]*JWT_SECRET is only 9 characters/);
  }, 40000);
});
