// One-time migration: encrypts any plaintext values already sitting in
// user_credentials' sensitive columns (from before at-rest encryption was added).
// Safe to re-run — encrypt() output is left alone by isEncrypted(), so an
// already-encrypted value is never double-encrypted.
//
// Requires ENCRYPTION_KEY to be set (see main/.env.example).
// Usage: node db/migrate-encrypt-secrets.js

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const db = require('./index');
const { encrypt, isEncrypted } = require('../utils/crypto');
const { ENCRYPTED_COLUMNS } = require('../utils/users');

function run() {
  const rows = db.prepare('SELECT user_id, ' + [...ENCRYPTED_COLUMNS].join(', ') + ' FROM user_credentials').all();
  let changed = 0;

  for (const row of rows) {
    const sets = [];
    const args = [];
    for (const column of ENCRYPTED_COLUMNS) {
      const value = row[column];
      if (value == null || value === '' || isEncrypted(value)) continue;
      sets.push(`${column} = ?`);
      args.push(encrypt(value));
    }
    if (sets.length) {
      db.prepare(`UPDATE user_credentials SET ${sets.join(', ')} WHERE user_id = ?`).run(...args, row.user_id);
      changed++;
    }
  }

  console.log(`Encrypted plaintext credentials for ${changed} user(s) (${rows.length} total).`);
}

if (require.main === module) run();

module.exports = { run };
