const path   = require('path');
const Database = require('better-sqlite3');

// Tests get an isolated in-memory DB per process; production/dev use a file on disk
// so data survives restarts. DB_PATH lets ops override the location if needed.
const DB_PATH = process.env.NODE_ENV === 'test'
  ? ':memory:'
  : (process.env.DB_PATH || path.join(__dirname, '../data/app.db'));

if (DB_PATH !== ':memory:') {
  require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = db;
module.exports.path = DB_PATH;
