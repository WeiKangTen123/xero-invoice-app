const fs   = require('fs');
const path = require('path');
const db   = require('./index');

// Idempotent — CREATE TABLE/INDEX IF NOT EXISTS, safe to run on every boot.
function run() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
}

module.exports = { run };
