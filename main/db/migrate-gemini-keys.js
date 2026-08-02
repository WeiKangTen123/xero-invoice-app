// One-time migration: copies each user's legacy single user_credentials.gemini_api_key
// (if set) into the new user_gemini_keys table as their first key. Safe to re-run —
// skips a user who already has at least one row in user_gemini_keys.
//
// Usage: node db/migrate-gemini-keys.js

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
require('./migrate').run();
const db = require('./index');
const { getUserConfig, getGeminiKeys, addGeminiKey, readUsers } = require('../utils/users');

function run() {
  let migrated = 0;
  for (const u of readUsers()) {
    if (getGeminiKeys(u.id).length > 0) continue; // already has keys — skip
    const legacyKey = getUserConfig(u.id).Gemini_API_KEY;
    if (!legacyKey) continue;
    addGeminiKey(u.id, legacyKey, 'Migrated key');
    migrated++;
  }
  console.log(`Migrated ${migrated} legacy Gemini key(s) into user_gemini_keys.`);
}

if (require.main === module) run();

module.exports = { run };
