#!/usr/bin/env node
// Turns off 2-step sign-in for one account, from the server's own shell. The
// way back for an admin who has lost both their phone and their recovery
// codes when there is no other admin to press Reset 2-step for them (Admin ›
// the account's panel, routes/admin.js mfa-reset), which is the usual way.
//
//   node main/scripts/mfa-reset.js you@example.com
//
// Run on the server as the app's user, from the app's folder:
//   sudo -u weika -H node main/scripts/mfa-reset.js you@example.com
//
// The same as the admin's reset: the secret, any set-up under way and the
// recovery codes go (utils/mfa.js turnOff), every session of the account is
// ended, and an admin is asked to set 2-step up again at the next sign-in.
// Recorded in the admin trail with no actor (it was the server's shell, not
// an account) and sent to Slack, since whoever can run this can also read the
// database: it is for the owner, on their own server. Run by hand only.
//
// Exits non-zero when it refuses or fails. Nothing secret is printed.
const fs   = require('fs');
const path = require('path');

class Refusal extends Error {}

// The work, apart from the command line, so the tests can run it.
async function resetMfa(email, { log = console.log } = {}) {
  const users    = require('../utils/users');
  const mfa      = require('../utils/mfa');
  const sessions = require('../utils/sessions');
  const auditLog = require('../utils/audit-log');
  const notify   = require('../utils/notify');

  const problem = users.emailProblem(email);
  if (problem) throw new Refusal(problem);
  const target = users.findByEmail(email);
  if (!target) throw new Refusal(`no account uses ${users.normalizeEmail(email)}`);

  const wasOn = mfa.turnOff(target.id);
  users.invalidateSessions(target.id);
  sessions.endAllSessions(target.id, 'mfa_reset');
  auditLog.recordAdminEvent({ actor: null, target, action: 'mfa.reset', details: { role: target.role, via: 'server script', wasOn } });

  log(wasOn
    ? `2-step sign-in turned off for ${target.email}; every session it had is signed out.`
    : `${target.email} had no 2-step sign-in on; its sessions are signed out all the same.`);
  if (target.role === 'admin') log('As an admin, it is asked to set 2-step up again at its next sign-in.');

  // Awaited, so the process does not end before Slack has it. Never fatal.
  try {
    await notify.notifySecurity(`🔐 2-step sign-in turned off for ${target.email}${target.role === 'admin' ? ' (an admin)' : ''} from the server's shell`);
  } catch (_) { /* the reset stands; the alert is best effort */ }
  return { email: target.email, wasOn };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith('-')) {
    console.error('Usage: node main/scripts/mfa-reset.js <email>');
    process.exit(2);
  }
  // Loaded here rather than at the top so that requiring this file (the tests
  // do) never reads the real .env into the process.
  require('dotenv').config({ path: path.join(__dirname, '../.env') });
  (async () => {
    try {
      const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/app.db');
      // db/index.js creates the file when it is missing; a mistyped DB_PATH
      // would then "reset" an account in an empty new database.
      if (process.env.NODE_ENV !== 'test' && !fs.existsSync(dbPath)) throw new Refusal(`no database at ${dbPath}`);
      await resetMfa(args[0]);
    } catch (err) {
      console.error(err instanceof Refusal ? `Refused: ${err.message}` : `Failed: ${err.message}`);
      process.exitCode = 1;
    }
  })();
}

module.exports = { resetMfa, Refusal };
