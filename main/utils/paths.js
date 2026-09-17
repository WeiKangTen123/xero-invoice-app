const path = require('path');

// Where runtime data lives. One answer for every module that writes files —
// receipts, PDFs, the mail queue, the job queue, backups — instead of each
// deriving its own `../data/users`. Overridable so tests (jest.setup.js)
// never touch main/data, and so the data can live on another disk.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');

const usersDir   = () => path.join(DATA_DIR, 'users');
const userDir    = userId => path.join(usersDir(), String(userId));
const backupsDir = () => path.join(DATA_DIR, 'backups');

module.exports = { DATA_DIR, usersDir, userDir, backupsDir };
