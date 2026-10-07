// The rotation script against scratch databases built from schema.sql and
// seeded the way the production server writes today: ENCRYPTION_KEY alone,
// so every secret is enc:v1. Nothing here reads main/.env or the real
// database — the in-process tests pass their own database, and the CLI runs
// in a child process with dotenv stubbed and DB_PATH in a temp folder.
const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { rotate, Refusal } = require('./rotate-encryption-key');
const { encrypt, decrypt, keyIdOf } = require('../utils/crypto');

const OLD = 'a1'.repeat(32), K1 = 'b2'.repeat(32), K2 = 'c3'.repeat(32), OTHER = 'e5'.repeat(32);
const SCHEMA = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');

const VARS  = ['ENCRYPTION_KEY', 'ENCRYPTION_KEYS', 'ENCRYPTION_KEY_ID'];
const saved = Object.fromEntries(VARS.map(k => [k, process.env[k]]));
const use = vars => {
  for (const k of VARS) { if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
};
afterEach(() => use(saved));

const ROTATING = { ENCRYPTION_KEY: OLD, ENCRYPTION_KEYS: `k2:${K2}`, ENCRYPTION_KEY_ID: 'k2' };

function seed(db) {
  db.exec(SCHEMA);
  use({ ENCRYPTION_KEY: OLD });
  const now = new Date().toISOString();
  for (const id of ['u1', 'u2']) db.prepare("INSERT INTO users (id, email, password, created_at) VALUES (?, ?, 'x', ?)").run(id, `${id}@example.com`, now);
  db.prepare(`INSERT INTO user_credentials (user_id, xero_client_id, xero_client_secret, imap_pass, xero_oauth_refresh_token)
              VALUES (?, ?, ?, ?, ?)`).run('u1', 'client-id-1', encrypt('xero-secret-1'), encrypt('imap-pass-1'), encrypt('refresh-1'));
  // A secret saved before encryption existed: read as it is, so left as it is.
  db.prepare(`INSERT INTO user_credentials (user_id, xero_client_id, xero_client_secret, imap_pass)
              VALUES (?, ?, ?, ?)`).run('u2', 'client-id-2', encrypt('xero-secret-2'), 'plaintext-imap-pass');
  const gemini = db.prepare('INSERT INTO user_gemini_keys (user_id, api_key, created_at) VALUES (?, ?, ?)');
  gemini.run('u1', encrypt('gemini-1'), now);
  gemini.run('u2', encrypt('gemini-2'), now);
  return db;
}
const scratch = () => seed(new Database(':memory:'));

const snapshot = db => JSON.stringify({
  credentials: db.prepare('SELECT * FROM user_credentials ORDER BY user_id').all(),
  gemini:      db.prepare('SELECT * FROM user_gemini_keys ORDER BY id').all(),
});
// Every secret as the app would read it.
const secrets = db => ({
  u1: db.prepare('SELECT xero_client_secret, imap_pass, xero_oauth_refresh_token FROM user_credentials WHERE user_id = ?').get('u1'),
  u2: db.prepare('SELECT xero_client_secret, imap_pass FROM user_credentials WHERE user_id = ?').get('u2'),
  gemini: db.prepare('SELECT api_key FROM user_gemini_keys ORDER BY id').all().map(r => r.api_key),
});
const decrypted = db => {
  const s = secrets(db);
  const d = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, decrypt(v)]));
  return { u1: d(s.u1), u2: d(s.u2), gemini: s.gemini.map(decrypt) };
};
const PLAIN = {
  u1: { xero_client_secret: 'xero-secret-1', imap_pass: 'imap-pass-1', xero_oauth_refresh_token: 'refresh-1' },
  u2: { xero_client_secret: 'xero-secret-2', imap_pass: 'plaintext-imap-pass' },
  gemini: ['gemini-1', 'gemini-2'],
};
const quiet = () => {};
const row = (report, table, column) => report.find(e => e.table === table && e.column === column);

describe('rotate-encryption-key', () => {
  test('refuses with no primary key, or with keys keyProblem() rejects, and changes nothing', () => {
    const db = scratch();
    const before = snapshot(db);
    use({ ENCRYPTION_KEY: OLD });
    expect(() => rotate({ db, log: quiet })).toThrow(Refusal);
    expect(() => rotate({ db, log: quiet })).toThrow(/no primary key is configured/);
    use({ ENCRYPTION_KEY: OLD, ENCRYPTION_KEYS: `k2:${K2}`, ENCRYPTION_KEY_ID: 'k3' });
    expect(() => rotate({ db, log: quiet })).toThrow(/not usable: ENCRYPTION_KEY_ID "k3" is not one of the keys/);
    expect(snapshot(db)).toBe(before);
  });

  test('a dry run checks and counts every value and writes nothing', () => {
    const db = scratch();
    const before = snapshot(db);
    use(ROTATING);
    const lines = [];
    const report = rotate({ db, dryRun: true, log: l => lines.push(l) });

    expect(snapshot(db)).toBe(before);
    expect(row(report, 'user_credentials', 'xero_client_secret')).toMatchObject({ encrypted: 2, rotated: 2, onPrimary: 0, plaintext: 0 });
    expect(row(report, 'user_credentials', 'imap_pass')).toMatchObject({ encrypted: 1, rotated: 1, plaintext: 1 });
    expect(row(report, 'user_credentials', 'xero_oauth_refresh_token')).toMatchObject({ encrypted: 1, rotated: 1 });
    expect(row(report, 'user_credentials', 'gemini_api_key')).toMatchObject({ encrypted: 0, rotated: 0 });
    expect(row(report, 'user_gemini_keys', 'api_key')).toMatchObject({ encrypted: 2, rotated: 2, from: { 'ENCRYPTION_KEY (enc:v1)': 2 } });
    const out = lines.join('\n');
    expect(out).toMatch(/^Dry run/);
    expect(out).toMatch(/user_gemini_keys\.api_key\s+2 encrypted: 2 to re-encrypt, 0 already on "k2"/);
    expect(out).toMatch(/Total: 6 encrypted, 6 to re-encrypt \(6 from ENCRYPTION_KEY \(enc:v1\)\), 0 already on "k2"/);
    expect(out).toMatch(/Nothing was written/);
    for (const secret of ['xero-secret-1', 'imap-pass-1', 'refresh-1', 'gemini-1', 'plaintext-imap-pass']) expect(out).not.toContain(secret);
  });

  test('re-encrypts every enc:v1 value as enc:v2 under the primary key, and the old key can then go', () => {
    const db = scratch();
    use(ROTATING);
    const report = rotate({ db, log: quiet });
    expect(report.reduce((n, e) => n + e.rotated, 0)).toBe(6);

    const s = secrets(db);
    for (const value of [...Object.values(s.u1), s.u2.xero_client_secret, ...s.gemini]) expect(value).toMatch(/^enc:v2:k2:/);
    expect(s.u2.imap_pass).toBe('plaintext-imap-pass');
    expect(db.prepare('SELECT xero_client_id FROM user_credentials ORDER BY user_id').all().map(r => r.xero_client_id)).toEqual(['client-id-1', 'client-id-2']);
    expect(decrypted(db)).toEqual(PLAIN);

    // Run again: everything is already on the primary key, so nothing moves.
    const after = snapshot(db);
    const again = rotate({ db, log: quiet });
    expect(again.reduce((n, e) => n + e.rotated, 0)).toBe(0);
    expect(again.reduce((n, e) => n + e.onPrimary, 0)).toBe(6);
    expect(snapshot(db)).toBe(after);

    // With ENCRYPTION_KEY removed, every secret still reads.
    use({ ENCRYPTION_KEYS: `k2:${K2}`, ENCRYPTION_KEY_ID: 'k2' });
    expect(decrypted(db)).toEqual(PLAIN);
  });

  test('the next rotation moves enc:v2 values from the old id to the new one', () => {
    const db = scratch();
    use({ ENCRYPTION_KEY: OLD, ENCRYPTION_KEYS: `k1:${K1}`, ENCRYPTION_KEY_ID: 'k1' });
    rotate({ db, log: quiet });
    use({ ENCRYPTION_KEYS: `k1:${K1},k2:${K2}`, ENCRYPTION_KEY_ID: 'k2' });
    // A value written by the server after the restart, already on k2.
    db.prepare('UPDATE user_credentials SET gemini_api_key = ? WHERE user_id = ?').run(encrypt('gemini-new'), 'u1');
    const report = rotate({ db, log: quiet });
    expect(row(report, 'user_credentials', 'xero_client_secret').from).toEqual({ 'key "k1"': 2 });
    expect(row(report, 'user_credentials', 'gemini_api_key')).toMatchObject({ encrypted: 1, rotated: 0, onPrimary: 1 });
    expect(secrets(db).gemini.map(keyIdOf)).toEqual(['k2', 'k2']);
    use({ ENCRYPTION_KEYS: `k2:${K2}`, ENCRYPTION_KEY_ID: 'k2' });
    expect(decrypted(db)).toEqual(PLAIN);
  });

  // The bad value is in the last table the script visits, so every other
  // value has already been rewritten inside the transaction when it fails:
  // this is the rollback being tested, not an early exit.
  test.each([
    ['encrypted under a different key', () => { use({ ENCRYPTION_KEY: OTHER }); return encrypt('gemini-3'); }, /cannot be decrypted: Unsupported state or unable to authenticate data/],
    ['under a key id that is not configured', () => { use({ ENCRYPTION_KEYS: `gone:${K1}`, ENCRYPTION_KEY_ID: 'gone' }); return encrypt('gemini-3'); }, /encrypted with key "gone", which is not in ENCRYPTION_KEYS/],
    ['tampered with', () => { use({ ENCRYPTION_KEY: OLD }); return encrypt('gemini-3').slice(0, -4) + 'abcd'; }, /cannot be decrypted/],
  ])('a value %s aborts the whole run, rolled back, naming the row', (_label, bad, reason) => {
    const db = scratch();
    db.prepare('INSERT INTO user_gemini_keys (user_id, api_key, created_at) VALUES (?, ?, ?)').run('u2', bad(), new Date().toISOString());
    const before = snapshot(db);
    use(ROTATING);
    let err;
    try { rotate({ db, log: quiet }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Refusal);
    expect(err.message).toMatch(/^1 value\(s\) failed, so nothing was changed/);
    expect(err.message).toMatch(/user_gemini_keys\.api_key where id = 3/);
    expect(err.message).toMatch(reason);
    expect(snapshot(db)).toBe(before);
    for (const value of Object.values(secrets(db).u1)) expect(value).toMatch(/^enc:v1:/);
  });

  test('encrypted values in a column it does not know about stop it before anything changes', () => {
    const db = scratch();
    db.prepare('UPDATE user_credentials SET imap_user = ? WHERE user_id = ?').run(encrypt('not-a-listed-secret'), 'u1');
    const before = snapshot(db);
    use(ROTATING);
    expect(() => rotate({ db, log: quiet })).toThrow(/columns this script does not know about: user_credentials\.imap_user \(1\)/);
    expect(snapshot(db)).toBe(before);
  });

  test('a database without the app\'s tables is refused', () => {
    use(ROTATING);
    expect(() => rotate({ db: new Database(':memory:'), log: quiet })).toThrow(/no user_credentials table/);
  });
});

// The command itself, as the runbook runs it: a separate node process that
// loads .env (stubbed here, so the real one is never read) and opens the
// database at DB_PATH.
describe('rotate-encryption-key (command line)', () => {
  const SCRIPT = path.join(__dirname, 'rotate-encryption-key.js');
  let dir, dbPath, stub;
  beforeEach(() => {
    dir    = fs.mkdtempSync(path.join(os.tmpdir(), 'xero-rotate-'));
    dbPath = path.join(dir, 'app.db');
    stub   = path.join(dir, 'no-dotenv.js');
    fs.writeFileSync(stub, `require(${JSON.stringify(require.resolve('dotenv'))}).config = () => ({ parsed: {} });\n`);
    const db = seed(new Database(dbPath));
    db.close();
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a file still held; the OS temp folder will do */ } });

  function run(args, keys) {
    const env = { ...process.env, NODE_ENV: 'production', DB_PATH: dbPath, DATA_DIR: path.join(dir, 'data'), LOGS_DIR: dir };
    for (const k of [...VARS, 'JEST_WORKER_ID']) delete env[k];
    Object.assign(env, keys);
    const r = spawnSync(process.execPath, ['-r', stub, SCRIPT, ...args], { env, encoding: 'utf8', timeout: 20000 });
    return { code: r.status, out: r.stdout + r.stderr };
  }
  const values = () => {
    const db = new Database(dbPath, { readonly: true });
    try { return secrets(db); } finally { db.close(); }
  };

  test('--dry-run writes nothing; the real run re-encrypts; both exit 0', () => {
    const before = values();
    let r = run(['--dry-run'], ROTATING);
    expect(r.out).toMatch(/Total: 6 encrypted, 6 to re-encrypt/);
    expect(r.code).toBe(0);
    expect(values()).toEqual(before);

    r = run([], ROTATING);
    expect(r.out).toMatch(/Re-encrypted stored credentials with key "k2"[\s\S]*Total: 6 encrypted, 6 re-encrypted/);
    expect(r.code).toBe(0);
    const after = values();
    expect(after.gemini.map(keyIdOf)).toEqual(['k2', 'k2']);
    use({ ENCRYPTION_KEYS: `k2:${K2}`, ENCRYPTION_KEY_ID: 'k2' });
    expect(after.gemini.map(decrypt)).toEqual(['gemini-1', 'gemini-2']);
  }, 30000);

  test('refuses and exits 1 with no primary key, or no database at DB_PATH (which it does not create)', () => {
    let r = run([], { ENCRYPTION_KEY: OLD });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Refused: no primary key is configured/);

    const missing = path.join(dir, 'nope', 'app.db');
    dbPath = missing;
    r = run([], ROTATING);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Refused: no database at/);
    expect(fs.existsSync(missing)).toBe(false);
  }, 30000);

  test('an unknown argument is refused before anything is opened', () => {
    const r = run(['--dryrun'], ROTATING);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/Unknown argument: --dryrun/);
  }, 30000);
});
