// The sweep for the data folders of deleted accounts. Real files in a temp
// folder of their own per test, and the real (in-memory) database; nothing
// here touches main/data.
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;

describe('utils/account-cleanup sweepOrphanFolders', () => {
  let users, db, logger, cleanup, root, usersDir, accounts;

  // An account id as users.js makes one, created `daysAgo` days ago.
  const idFrom = (daysAgo, hex = 'abcdef01') => `${Date.now() - daysAgo * DAY}${hex}`;
  const folder = (name, files = { 'receipts/r.jpg': 'x' }) => {
    const dir = path.join(usersDir, name);
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const sweep = () => cleanup.sweepOrphanFolders({ usersDir });
  const recordDelete = id => require('./audit-log').recordAdminEvent({
    actor: { id: accounts[0].id, email: accounts[0].email }, target: { id, email: 'gone@test.com' }, action: 'user.delete', details: { role: 'user' },
  });

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users   = require('./users');
    db      = require('../db');
    logger  = require('./logger');
    cleanup = require('./account-cleanup');
    root     = fs.mkdtempSync(path.join(os.tmpdir(), 'account-cleanup-'));
    usersDir = path.join(root, 'users');
    fs.mkdirSync(usersDir);
    accounts = [await users.createUser('admin@test.com', 'password123', 'auto'), await users.createUser('user@test.com', 'password123', 'user')];
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("removes a deleted account's folder and leaves every live account's alone", async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
    const live = accounts.map(a => folder(a.id));
    const gone = idFrom(30);
    const goneDir = folder(gone, { 'receipts/r.jpg': 'x', 'email-queue/job.json': '{}' });
    expect(sweep()).toEqual({ removed: [gone], kept: [] });
    expect(fs.existsSync(goneDir)).toBe(false);
    for (const dir of live) expect(fs.existsSync(path.join(dir, 'receipts', 'r.jpg'))).toBe(true);
    expect(info).toHaveBeenCalledWith('Removed the data folders of deleted accounts', { ids: [gone] });
  });

  test('an id in the older form, the creation time alone, is an account id too', () => {
    const gone = String(Date.now() - 400 * DAY);
    folder(gone);
    expect(sweep().removed).toEqual([gone]);
  });

  test('anything not named as an account is not touched: other names, and files', () => {
    const others = ['backups', 'tmp', '123', `${Date.now() - DAY}xyz`, `${Date.now() - DAY}ABCDEF01`, `x${Date.now() - DAY}`];
    for (const name of others) folder(name);
    const file = path.join(usersDir, idFrom(10));
    fs.writeFileSync(file, 'not a folder');
    expect(sweep()).toEqual({ removed: [], kept: [] });
    for (const name of others) expect(fs.existsSync(path.join(usersDir, name))).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('not a folder');
  });

  test('never follows a link: a link named as an account is left, and a link inside a removed folder takes nothing with it', () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'precious.pdf'), 'keep me');
    // A junction on Windows: an ordinary symlink there needs administrator rights.
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    const linkName = idFrom(20, '0000aaaa');
    fs.symlinkSync(outside, path.join(usersDir, linkName), type);
    const gone = idFrom(30);
    const goneDir = folder(gone);
    fs.symlinkSync(outside, path.join(goneDir, 'pdfs'), type);

    expect(sweep()).toEqual({ removed: [gone], kept: [] });
    expect(fs.existsSync(goneDir)).toBe(false);
    expect(fs.lstatSync(path.join(usersDir, linkName)).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'precious.pdf'), 'utf8')).toBe('keep me');
  });

  // A database restored from an older backup has never heard of the accounts
  // made since it was taken; their files may be all that is left of them.
  test('a folder newer than every account is kept and reported, unless its deletion is on record', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const newer = `${Date.now() + 60 * 1000}deadbeef`;
    const newerDir = folder(newer);
    expect(sweep()).toEqual({ removed: [], kept: [newer] });
    expect(fs.existsSync(newerDir)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/is this database a restored backup\?/), { ids: [newer] });

    recordDelete(newer);
    expect(sweep()).toEqual({ removed: [newer], kept: [] });
    expect(fs.existsSync(newerDir)).toBe(false);
  });

  test('an empty users table removes nothing it has no record of deleting', () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const old = idFrom(300);
    folder(old);
    db.exec('PRAGMA foreign_keys = OFF; DELETE FROM users; PRAGMA foreign_keys = ON;');
    expect(sweep()).toEqual({ removed: [], kept: [old] });
    expect(fs.existsSync(path.join(usersDir, old))).toBe(true);
  });

  test('a folder whose account is made between the listing and the removal stays', () => {
    const late = idFrom(5);
    folder(late);
    const prepare = db.prepare.bind(db);
    jest.spyOn(db, 'prepare').mockImplementation(sql => {
      // The account appears just as the sweep looks again before removing.
      if (/SELECT 1 FROM users WHERE id = \?/.test(sql)) {
        prepare("INSERT INTO users (id, email, password, role, created_at) VALUES (?, 'late@test.com', 'x', 'user', ?)")
          .run(late, new Date(Date.now() - 5 * DAY).toISOString());
      }
      return prepare(sql);
    });
    expect(sweep().removed).toEqual([]);
    expect(fs.existsSync(path.join(usersDir, late))).toBe(true);
  });

  test('no users folder yet is nothing to do', () => {
    fs.rmSync(usersDir, { recursive: true });
    expect(sweep()).toEqual({ removed: [], kept: [] });
  });

  test('never throws: a database that cannot be read is a warning, and nothing is removed', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const gone = idFrom(30);
    folder(gone);
    jest.spyOn(db, 'prepare').mockImplementation(() => { throw new Error('database disk image is malformed'); });
    expect(sweep()).toEqual({ removed: [], kept: [] });
    expect(fs.existsSync(path.join(usersDir, gone))).toBe(true);
    expect(warn).toHaveBeenCalledWith('Sweep for the data folders of deleted accounts failed', { error: 'database disk image is malformed' });
  });

  test('a folder that cannot be removed is a warning, and the rest still go', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const [stuck, gone] = [idFrom(40, '11111111'), idFrom(30, '22222222')];
    folder(stuck); folder(gone);
    const rm = fs.rmSync;
    jest.spyOn(fs, 'rmSync').mockImplementation((p, opts) => {
      if (String(p).endsWith(stuck)) throw new Error('EBUSY: resource busy or locked');
      return rm(p, opts);
    });
    expect(sweep()).toEqual({ removed: [gone], kept: [] });
    expect(warn).toHaveBeenCalledWith('Could not remove the data folder of a deleted account', { id: stuck, error: 'EBUSY: resource busy or locked' });
  });

  test('by default it sweeps the data folder the app uses (utils/paths.js)', () => {
    const paths = require('./paths');
    const gone = idFrom(30);
    const dir = path.join(paths.usersDir(), gone);
    fs.mkdirSync(dir, { recursive: true });
    expect(cleanup.sweepOrphanFolders().removed).toContain(gone);
    expect(fs.existsSync(dir)).toBe(false);
  });
});
