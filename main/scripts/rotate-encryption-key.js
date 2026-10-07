#!/usr/bin/env node
// Re-encrypts every stored credential with the primary key — the key
// ENCRYPTION_KEY_ID names in ENCRYPTION_KEYS. This is the second half of
// rotating the encryption key; docs/RUNBOOK.md ("Rotate the encryption key")
// has the whole procedure, including the restart and the backup that must
// come before this.
//
//   node main/scripts/rotate-encryption-key.js --dry-run   # checks and counts, writes nothing
//   node main/scripts/rotate-encryption-key.js             # re-encrypts
//
// Run by hand only. Nothing at boot re-encrypts anything: moving every secret
// to another key is a decision with a backup in front of it, and a server
// that did it on start would do it again on every crash loop.
//
// All of it happens in one transaction. Every value is decrypted before
// anything is written, and read back and decrypted again after writing,
// inside the transaction; a value that fails either check rolls the whole
// run back. The database is either entirely on the primary key or exactly
// as it was — never half rotated, with no list of which half.
//
// Exits non-zero when it refuses or fails. No secret is printed.
const fs   = require('fs');
const path = require('path');
const { encrypt, decrypt, isEncrypted, keyProblem, keyIdOf, primaryKeyId } = require('../utils/crypto');

class Refusal extends Error {}

// Every column that holds encrypt() output. user_credentials' list is the one
// users.js encrypts on save, so a secret column added there is rotated here
// without anyone remembering to; the Gemini keys table is the only other
// place encrypt() is written to the database.
function targets() {
  const { ENCRYPTED_COLUMNS } = require('../utils/users');
  return [
    ...[...ENCRYPTED_COLUMNS].map(column => ({ table: 'user_credentials', key: 'user_id', column })),
    { table: 'user_gemini_keys', key: 'id', column: 'api_key' },
  ];
}

function _columns(db, table) {
  return db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name);
}

// Encrypted values in a column this script does not know about would stay on
// the old key, and removing that key — the last step of a rotation — would
// then make them unreadable with nothing to say why. Finding any means the
// list above is out of date, so the run stops before changing anything.
function _strays(db, known) {
  const found = [];
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  for (const { name: table } of tables) {
    for (const column of _columns(db, table)) {
      if (known.has(`${table}.${column}`)) continue;
      // substr, not LIKE: LIKE ignores case, and only this exact prefix is ours.
      const { n } = db.prepare(
        `SELECT COUNT(*) AS n FROM "${table}" WHERE typeof("${column}") = 'text' AND substr("${column}", 1, 7) IN ('enc:v1:', 'enc:v2:')`,
      ).get();
      if (n) found.push(`${table}.${column} (${n})`);
    }
  }
  return found;
}

const sourceLabel = value => keyIdOf(value) ? `key "${keyIdOf(value)}"` : 'ENCRYPTION_KEY (enc:v1)';

// Returns one entry per column: how many encrypted values it holds, how many
// were (or, in a dry run, would be) re-encrypted and from which keys, how many
// were already on the primary key, and how many are plaintext — values saved
// before encryption existed, which decrypt() reads as they are. Those are
// counted and left alone: this moves encrypted values between keys, and a
// plaintext secret is encrypted the next time it is saved in Setup.
function rotate({ db, dryRun = false, log = console.log } = {}) {
  const problem = keyProblem(process.env);
  if (problem) throw new Refusal(`the encryption keys in .env are not usable: ${problem}`);
  const primary = primaryKeyId();
  if (!primary) {
    throw new Refusal('no primary key is configured, so there is nothing to rotate to. Add the new key to ' +
      'ENCRYPTION_KEYS, name it in ENCRYPTION_KEY_ID and restart the server first (docs/RUNBOOK.md, "Rotate the encryption key").');
  }
  if (!_columns(db, 'user_credentials').length) {
    throw new Refusal(`there is no user_credentials table in ${db.name} — is this the app's database (DB_PATH)?`);
  }

  const all     = targets();
  const strays  = _strays(db, new Set(all.map(t => `${t.table}.${t.column}`)));
  if (strays.length) {
    throw new Refusal(`encrypted values were found in columns this script does not know about: ${strays.join(', ')}. ` +
      'Add them to targets() in main/scripts/rotate-encryption-key.js and run it again.');
  }

  const report   = [];
  const failures = [];
  const where    = (t, k) => `${t.table}.${t.column} where ${t.key} = ${JSON.stringify(k)}`;

  const run = db.transaction(() => {
    for (const t of all) {
      const entry = { table: t.table, column: t.column, present: true, encrypted: 0, rotated: 0, onPrimary: 0, plaintext: 0, from: {} };
      report.push(entry);
      if (!_columns(db, t.table).includes(t.column)) { entry.present = false; continue; }

      const rows   = db.prepare(`SELECT "${t.key}" AS k, "${t.column}" AS v FROM "${t.table}" WHERE "${t.column}" IS NOT NULL AND "${t.column}" != ''`).all();
      const update = db.prepare(`UPDATE "${t.table}" SET "${t.column}" = ? WHERE "${t.key}" = ? AND "${t.column}" = ?`);
      const reread = db.prepare(`SELECT "${t.column}" AS v FROM "${t.table}" WHERE "${t.key}" = ?`);
      const written = [];

      for (const { k, v } of rows) {
        if (!isEncrypted(v)) { entry.plaintext++; continue; }
        entry.encrypted++;
        let plain;
        try { plain = decrypt(v); } catch (err) { failures.push(`${where(t, k)} cannot be decrypted: ${err.message}`); continue; }
        if (keyIdOf(v) === primary) { entry.onPrimary++; continue; }

        const next = encrypt(plain);
        let roundTrips = false;
        try { roundTrips = keyIdOf(next) === primary && decrypt(next) === plain; } catch {}
        if (!roundTrips) { failures.push(`${where(t, k)} did not read back after re-encrypting with key "${primary}"`); continue; }

        const from = sourceLabel(v);
        entry.from[from] = (entry.from[from] || 0) + 1;
        entry.rotated++;
        if (dryRun) continue;
        // The old value in the WHERE is a guard, not a lookup: a row that no
        // longer holds what was decrypted above is a failure, not overwritten.
        if (update.run(next, k, v).changes !== 1) { failures.push(`${where(t, k)} was not updated`); continue; }
        written.push({ k, plain });
      }

      // Read back from the database what was written, rather than trusting
      // the value in hand: this is what the server will read from now on.
      for (const { k, plain } of written) {
        const stored = reread.get(k)?.v;
        let ok = false;
        try { ok = keyIdOf(stored) === primary && decrypt(stored) === plain; } catch {}
        if (!ok) failures.push(`${where(t, k)} does not decrypt after being written`);
      }
    }
    if (failures.length) {
      throw new Refusal(`${failures.length} value(s) failed, so nothing was changed:\n  - ${failures.join('\n  - ')}`);
    }
  });
  // IMMEDIATE takes the write lock before the first read, so the running
  // server cannot save a credential between this reading a row and writing
  // it back; its write waits the few milliseconds this takes.
  if (dryRun) run(); else run.immediate();

  _print(report, { primary, dryRun, log });
  return report;
}

function _print(report, { primary, dryRun, log }) {
  const name = e => `${e.table}.${e.column}`;
  const width = Math.max(...report.map(e => name(e).length));
  const verb  = dryRun ? 'to re-encrypt' : 're-encrypted';
  log(dryRun
    ? `Dry run: checking every stored credential against key "${primary}". Nothing is written.`
    : `Re-encrypted stored credentials with key "${primary}".`);
  log('');
  const totals = { encrypted: 0, rotated: 0, onPrimary: 0, plaintext: 0, from: {} };
  for (const e of report) {
    if (!e.present) { log(`  ${name(e).padEnd(width)}  not in this database`); continue; }
    log(`  ${name(e).padEnd(width)}  ${String(e.encrypted).padStart(3)} encrypted: ${e.rotated} ${verb}, ${e.onPrimary} already on "${primary}"` +
      (e.plaintext ? `; ${e.plaintext} plaintext, left as is` : ''));
    for (const k of ['encrypted', 'rotated', 'onPrimary', 'plaintext']) totals[k] += e[k];
    for (const [from, n] of Object.entries(e.from)) totals.from[from] = (totals.from[from] || 0) + n;
  }
  const from = Object.entries(totals.from).map(([label, n]) => `${n} from ${label}`).join(', ');
  log('');
  log(`Total: ${totals.encrypted} encrypted, ${totals.rotated} ${verb}${from ? ` (${from})` : ''}, ` +
    `${totals.onPrimary} already on "${primary}"; every one decrypted${dryRun ? '' : ' before and after'}.`);
  if (totals.plaintext) log(`${totals.plaintext} plaintext value(s) left as is; each is encrypted the next time it is saved in Setup.`);
  if (!totals.rotated) log(`Every encrypted value is on "${primary}"; nothing ${dryRun ? 'needs' : 'needed'} re-encrypting.`);
  else if (dryRun) log('Nothing was written. Run again without --dry-run to re-encrypt.');
}

if (require.main === module) {
  const args    = process.argv.slice(2);
  const unknown = args.filter(a => a !== '--dry-run');
  if (unknown.length) {
    console.error(`Unknown argument: ${unknown.join(' ')}\nUsage: node main/scripts/rotate-encryption-key.js [--dry-run]`);
    process.exit(2);
  }
  // Loaded here rather than at the top so that requiring this file (the tests
  // do) never reads the real .env into the process.
  require('dotenv').config({ path: path.join(__dirname, '../.env') });
  try {
    const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/app.db');
    // db/index.js creates the file when it is missing; a mistyped DB_PATH
    // would then "rotate" an empty new database and report success.
    if (process.env.NODE_ENV !== 'test' && !fs.existsSync(dbPath)) throw new Refusal(`no database at ${dbPath}`);
    rotate({ db: require('../db'), dryRun: args.includes('--dry-run') });
  } catch (err) {
    console.error(err instanceof Refusal
      ? `Refused: ${err.message}`
      : `Failed, and rolled back — nothing was changed: ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { rotate, targets, Refusal };
