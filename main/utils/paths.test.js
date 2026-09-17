// Every module that writes files derived its own `../data/users`; under jest
// that meant test receipts landed in the REAL data folder (and, because the
// deploy script runs the suite on the box, in production data) and test log
// lines in the real logs. One module says where data lives; jest.setup points
// it at a temp dir.
const path = require('path');
const os   = require('os');
const paths = require('./paths');

test('DATA_DIR is honoured', () => {
  expect(process.env.DATA_DIR).toBeTruthy();
  expect(paths.DATA_DIR).toBe(process.env.DATA_DIR);
  expect(paths.usersDir()).toBe(path.join(process.env.DATA_DIR, 'users'));
  expect(paths.userDir('u1')).toBe(path.join(process.env.DATA_DIR, 'users', 'u1'));
  expect(paths.backupsDir()).toBe(path.join(process.env.DATA_DIR, 'backups'));
});

test('under jest the data dir is a temp dir, never the repo', () => {
  expect(paths.DATA_DIR.startsWith(os.tmpdir())).toBe(true);
  expect(paths.DATA_DIR.includes('xero-invoice-app-master/main/data')).toBe(false);
});

test('the stores write under it', () => {
  const rs = require('./receipt-store').forUser('paths-user');
  const name = rs.save('r1', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg');
  expect(rs.getPath(name).startsWith(paths.userDir('paths-user'))).toBe(true);
});

test('the logger is silent under jest and opens no log files', () => {
  const logger = require('./logger');
  expect(logger.transports.every(t => t.silent === true || t.level === 'silent' || !t.filename)).toBe(true);
  expect(logger.transports.some(t => t.filename)).toBe(false);
});
