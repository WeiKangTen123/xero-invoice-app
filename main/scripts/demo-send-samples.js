#!/usr/bin/env node
// Sends the invented demo documents (xero/demo/samples.js) to a mailbox one at
// a time, so the app's mailbox watcher picks each one up on camera during a
// demo recording.
//
// It runs on the server, because that is where the owner's mailbox app
// password is kept (encrypted, in the app's database). Mail goes out through
// the mailbox's own SMTP server (Gmail: smtp.gmail.com:465), signed in exactly
// as the watcher signs in to IMAP, from the mailbox address to the mailbox
// address. Nothing in Xero or in the app's records is touched, and no password
// is printed.
//
// Gmail files a message you send to yourself as already read, and the watcher
// only looks at unread mail. So after each send the script finds the message in
// the INBOX over IMAP (the watcher's own connection settings) by its
// X-Demo-Sample header and marks it unread. --leave-read skips that.
//
// The exact command, from a workstation:
//
//   gcloud compute ssh xero-automation --zone=us-central1-a --project=steady-hallway-504812-d1 --account=wkang@flovon.ai --command "cd /home/weika/xero-invoice-app; sudo -u weika -H node main/scripts/demo-send-samples.js --email weikangten@gmail.com --gap 30"
//
// Add --dry-run to that to see what would be sent without sending anything.
'use strict';

const path = require('path');

const KINDS = ['ar', 'ap', 'ap-photo'];
const DEFAULT_GAP_S = 30;
const FROM_NAME = 'Demo samples';
const SAMPLE_HEADER = 'X-Demo-Sample';
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
// How long to look for a sent message in the INBOX: Gmail can take a moment
// to file it. Six searches, two seconds apart, is about ten seconds.
const UNREAD_TRIES = 6;
const UNREAD_WAIT_MS = 2000;
const IMAP_CALL_TIMEOUT_MS = 15000;

const USAGE = `Usage: node main/scripts/demo-send-samples.js --email <app login email> [options]

Sends the invented demo documents to the account's own mailbox, one at a time,
through the mailbox's SMTP server, for the mailbox watcher to pick up. Each one
is then marked unread in the INBOX, since Gmail files mail sent to yourself as
read and the watcher only takes unread mail.

  --email <address>  the app account whose saved mailbox (Setup, Email / IMAP)
                     sends the mail (required unless only writing files)
  --to <address>     where to send (default: that mailbox's own address)
  --only <kinds>     only these kinds, comma-separated: ${KINDS.join(',')}
  --gap <seconds>    time from one send to the next (default ${DEFAULT_GAP_S}; none before the first)
  --leave-read       do not mark the sent emails unread
  --write <dir>      write the documents to <dir> and stop, without sending
  --send-too         with --write, send as well
  --dry-run          build everything and show what would be sent; connect to nothing
  --seed <text>      vary the invented documents (default: today's date)
  --help             this text

On the server:
  gcloud compute ssh xero-automation --zone=us-central1-a --project=steady-hallway-504812-d1 --account=wkang@flovon.ai --command "cd /home/weika/xero-invoice-app; sudo -u weika -H node main/scripts/demo-send-samples.js --email weikangten@gmail.com --gap 30"`;

// ── Arguments ────────────────────────────────────────────────────────────────
const VALUE_FLAGS = new Set(['--email', '--to', '--only', '--gap', '--write', '--seed']);
const SWITCHES = {
  '--send-too': 'sendToo', '--dry-run': 'dryRun', '--leave-read': 'leaveRead', '--help': 'help', '-h': 'help',
};

// Throws an Error naming the first problem; the caller prints it with USAGE.
function parseArgs(argv = []) {
  const out = {
    email: null, to: null, only: null, gap: DEFAULT_GAP_S,
    write: null, sendToo: false, dryRun: false, leaveRead: false, seed: null, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = String(argv[i]);
    const eq = /^(--[a-z-]+)=(.*)$/s.exec(raw);
    const flag = eq ? eq[1] : raw;
    if (SWITCHES[flag] && !eq) { out[SWITCHES[flag]] = true; continue; }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`unknown argument: ${raw}`);
    let value = eq ? eq[2] : argv[i + 1];
    if (!eq) {
      if (value === undefined || String(value).startsWith('--')) throw new Error(`${flag} needs a value`);
      i++;
    }
    value = String(value).trim();
    if (!value) throw new Error(`${flag} needs a value`);
    switch (flag) {
      case '--email': out.email = value; break;
      case '--to':    out.to = value; break;
      case '--write': out.write = value; break;
      case '--seed':  out.seed = value; break;
      case '--gap': {
        if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`--gap must be a number of seconds, 0 or more (got "${value}")`);
        out.gap = Number(value);
        break;
      }
      case '--only': {
        const kinds = [...new Set(value.split(',').map(k => k.trim().toLowerCase()).filter(Boolean))];
        const bad = kinds.filter(k => !KINDS.includes(k));
        if (bad.length) throw new Error(`--only takes ${KINDS.join(', ')} (not ${bad.join(', ')})`);
        if (!kinds.length) throw new Error('--only needs at least one kind');
        out.only = kinds;
        break;
      }
    }
  }
  if (out.help) return out;
  const sending = !out.write || out.sendToo;
  if (sending && !out.email) throw new Error('--email is required');
  if (out.email && !EMAIL_RE.test(out.email)) throw new Error('--email does not look like an email address');
  if (out.to && !EMAIL_RE.test(out.to)) throw new Error('--to does not look like an email address');
  if (out.sendToo && !out.write) throw new Error('--send-too only goes with --write');
  return out;
}

// ── SMTP for a mailbox ───────────────────────────────────────────────────────
// The sending server for the mailbox the watcher reads: its IMAP host with
// "imap." turned into "smtp.", implicit TLS on 465 (Gmail: smtp.gmail.com).
// The two providers in imap-settings.js whose SMTP server is not named that
// way, or not offered on 465, are listed. Any other host is used as it is,
// which is how most company mail servers are set up.
const SMTP_BY_IMAP_HOST = {
  'outlook.office365.com': { host: 'smtp.office365.com', port: 587 },
  'imap.mail.me.com':      { host: 'smtp.mail.me.com',   port: 587 },
};

function smtpFor(settings = {}) {
  const imapHost = String(settings.host || '').trim().toLowerCase();
  if (!imapHost) throw new Error('the mailbox has no server to send through');
  const known = SMTP_BY_IMAP_HOST[imapHost];
  const host = known ? known.host : imapHost.replace(/^imap\./, 'smtp.');
  const port = known ? known.port : 465;
  return {
    host, port,
    secure: port === 465,
    ...(port !== 465 && { requireTLS: true }),
    auth: { user: settings.user, pass: settings.password },
  };
}

// ── IMAP: marking what was sent unread ───────────────────────────────────────
// The watcher's connection (email/watcher-registry.js _connect), less its
// polling: same login, port, TLS and certificate checks.
function imapOptionsFor(settings, tlsOptions) {
  return {
    user:        settings.user,
    password:    settings.password,
    host:        settings.host,
    port:        settings.port,
    tls:         true,
    tlsOptions:  tlsOptions(settings.host),
    keepalive:   true,
    authTimeout: 10000,
  };
}

// As the watcher's _teardown: an 'error' with no listener would throw while the
// socket closes, so a sink stays attached.
function closeImap(imap) {
  if (!imap) return;
  try { imap.removeAllListeners(); imap.on('error', () => {}); } catch (_) { /* already gone */ }
  try { imap.end(); } catch (_) { /* already closed */ }
}

// Connects and opens INBOX read-write. Resolves { imap, box }.
function openInbox(Imap, options) {
  const imap = new Imap(options);
  const opened = new Promise((resolve, reject) => {
    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err, box) => (err ? reject(err) : resolve(box)));
    });
    // Stays attached for the whole run: a later error reaches the next search
    // as a failed command instead of crashing the process.
    imap.on('error', reject);
    imap.once('end', () => reject(new Error('the IMAP connection closed')));
  });
  imap.connect();
  return opened.then(box => ({ imap, box }), err => { closeImap(imap); throw err; });
}

// Finds each sent message by its X-Demo-Sample header (or, where the server
// does not search that header, its Message-ID) and removes \Seen. Only
// messages that arrived after the INBOX was opened count, so an earlier take
// with the same sample id is never touched.
function unreadMarker(imap, box, { tries = UNREAD_TRIES, waitMs = UNREAD_WAIT_MS } = {}) {
  const firstNew = Number(box && box.uidnext) || 0;
  const marked = new Set();
  // A command on a connection that has quietly died would never answer, and
  // would hang the run mid-recording; it is given up on instead.
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`IMAP ${method} got no answer`)), IMAP_CALL_TIMEOUT_MS);
    try {
      imap[method](...args, (err, value) => { clearTimeout(timer); return err ? reject(err) : resolve(value); });
    } catch (err) { clearTimeout(timer); reject(err); }
  });
  const find = async criteria => ((await call('search', criteria)) || [])
    .filter(uid => uid >= firstNew && !marked.has(uid));

  return {
    async mark(id, messageId) {
      let error = null;
      for (let t = 0; t < tries; t++) {
        if (t > 0) await sleep(waitMs);
        try {
          let uids = await find([['HEADER', SAMPLE_HEADER, id]]);
          if (!uids.length && messageId) uids = await find([['HEADER', 'MESSAGE-ID', messageId]]);
          if (uids.length) {
            await call('delFlags', uids, ['\\Seen']);
            uids.forEach(uid => marked.add(uid));
            return { uids };
          }
        } catch (err) { error = err; }
      }
      return { uids: [], error };
    },
  };
}

// ── What to send ─────────────────────────────────────────────────────────────
// The generator's emails in its order, narrowed to the kinds asked for.
function planSends(samples, only = null) {
  const emails = Array.isArray(samples && samples.emails) ? samples.emails : [];
  return only && only.length ? emails.filter(e => only.includes(e.kind)) : emails.slice();
}

function messageFor(email, { from, to }) {
  return {
    from: { name: FROM_NAME, address: from },
    to,
    subject: email.subject,
    text: email.text,
    attachments: (email.attachments || []).map(a => ({
      filename: a.filename, contentType: a.contentType, content: a.content,
    })),
    headers: { [SAMPLE_HEADER]: email.id },
  };
}

function sizeOf(email) {
  return Buffer.byteLength(String(email.text || ''))
    + (email.attachments || []).reduce((n, a) => n + (a.content ? a.content.length : 0), 0);
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function duration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function clock(d = new Date()) {
  return d.toTimeString().slice(0, 8);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── The app, loaded only when a mailbox is needed (so --help touches nothing) ─
function loadApp() {
  // Quiet: the app's info logs are not wanted here. An explicit LOG_LEVEL wins.
  if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'warn';
  require('dotenv').config({ path: path.join(__dirname, '../.env') });
  const users = require('../utils/users');
  return {
    findUser: email => users.findByEmail(email),
    // The watcher's own resolution (email/imap-settings.js): IMAP_USER or the
    // account email, the host from that address, IMAP_PASS decrypted.
    mailbox: userId => users.getImapSettings(userId),
    tlsOptions: host => require('../email/watcher-registry').imapTlsOptions(host),
  };
}

// The account's mailbox, or a reason it cannot send.
function mailboxFor(app, email) {
  const user = app.findUser(email);
  if (!user) return { error: `No app account signs in as ${email}.` };
  const settings = app.mailbox(user.id) || {};
  if (!settings.password) {
    return { error: `${email} has no mailbox app password saved. Save it under Setup, Email / IMAP (for Gmail, an app password from https://myaccount.google.com/apppasswords), then run this again. Nothing was sent.` };
  }
  if (!settings.user || !settings.host) {
    return { error: `${email} has no mailbox server or address the app can work out. Fill them in under Setup, Email / IMAP. Nothing was sent.` };
  }
  return { settings };
}

// ── Run ──────────────────────────────────────────────────────────────────────
// Returns the exit code. `deps` replaces the app, the generator, the mailer and
// the output in tests.
async function main(argv = process.argv.slice(2), deps = {}) {
  const print = deps.print || (line => console.log(line));
  const printErr = deps.printErr || (line => console.error(line));

  let args;
  try { args = parseArgs(argv); } catch (err) { printErr(`${err.message}\n\n${USAGE}`); return 2; }
  if (args.help) { print(USAGE); return 0; }

  const sending = !args.write || args.sendToo;

  // The mailbox first: a missing password should stop the run before anything
  // is generated or written.
  let app = null, mailbox = null;
  if (sending) {
    app = (deps.loadApp || loadApp)();
    const found = mailboxFor(app, args.email);
    if (found.error) { printErr(found.error); return 1; }
    mailbox = found.settings;
  }

  const generator = deps.samples || require('../xero/demo/samples');
  const samples = await generator.buildSamples({ seed: args.seed || undefined });

  if (args.write) {
    const dir = path.resolve(args.write);
    const written = await generator.writeSamples(dir, samples);
    print(`Wrote ${written.length} file${written.length === 1 ? '' : 's'} to ${dir}`);
    for (const p of written) print(`  ${p}`);
    if (!args.sendToo) return 0;
  }

  const sends = planSends(samples, args.only);
  if (!sends.length) { printErr(`No sample email${args.only ? ` of kind ${args.only.join(', ')}` : ''} to send.`); return 1; }

  const from = mailbox.user;
  const to = args.to || from;
  const smtp = smtpFor(mailbox);
  const total = sends.reduce((n, e) => n + sizeOf(e), 0);
  const gapMs = Math.round(args.gap * 1000);
  // Marking unread only means something in the mailbox this account reads.
  const toSelf = to.toLowerCase() === from.toLowerCase();
  const markUnread = !args.leaveRead && toSelf;

  print(`${args.dryRun ? 'Dry run: would send' : 'Sending'} ${sends.length} email${sends.length === 1 ? '' : 's'} (${kb(total)}), ${args.gap}s apart`);
  print(`  from  "${FROM_NAME}" <${from}>`);
  print(`  to    ${to}`);
  print(`  via   ${smtp.host}:${smtp.port}`);
  if (markUnread) print(`  then  each marked unread in INBOX at ${mailbox.host}:${mailbox.port}`);
  else if (args.leaveRead) print('  then  left as the mailbox files them (--leave-read)');
  else print(`  then  not marked unread: ${to} is not the mailbox ${from}`);
  print(`The demo account's sender filter must be ${from}, and the owner's own watcher must be stopped, or it will take these emails first.`);

  if (args.dryRun) {
    sends.forEach((e, i) => {
      print(`  +${duration(i * gapMs).padStart(6)}  ${e.kind.padEnd(8)}  ${e.subject}  (${kb(sizeOf(e))}, ${(e.attachments || []).length} attachment${(e.attachments || []).length === 1 ? '' : 's'})`);
    });
    print(`Dry run: ${sends.length} email${sends.length === 1 ? '' : 's'} (${kb(total)}) over ${duration((sends.length - 1) * gapMs)}. Nothing was sent.`);
    return 0;
  }

  const nodemailer = deps.nodemailer || require('nodemailer');
  const transport = nodemailer.createTransport(smtp);
  let imap = null, marker = null;
  const started = Date.now();
  let sent = 0, bytes = 0, unread = 0, missed = 0, lastSentAt = null;
  const summary = () => `${sent} of ${sends.length} (${kb(bytes)}) to ${to} in ${duration(Date.now() - started)}`
    + (markUnread ? `; ${unread} marked unread${missed ? `, ${missed} not found` : ''}` : '');
  try {
    // Sign in to both servers before the first send, so a wrong password fails
    // here and not mid-recording.
    try {
      await transport.verify();
    } catch (err) {
      printErr(`Could not sign in to ${smtp.host} as ${from}: ${err.message}. Nothing was sent.`);
      return 1;
    }
    if (markUnread) {
      try {
        const Imap = deps.Imap || require('imap');
        const opened = await openInbox(Imap, imapOptionsFor(mailbox, app.tlsOptions));
        imap = opened.imap;
        marker = unreadMarker(imap, opened.box);
      } catch (err) {
        printErr(`Could not open the INBOX at ${mailbox.host} as ${from} to mark the emails unread: ${err.message}. Nothing was sent. (--leave-read sends without marking them.)`);
        return 1;
      }
    }

    for (let i = 0; i < sends.length; i++) {
      const email = sends[i];
      // The gap runs from the previous send, so the time spent marking it
      // unread does not stretch the rhythm.
      const wait = lastSentAt === null ? 0 : gapMs - (Date.now() - lastSentAt);
      if (wait > 0) await sleep(wait);
      let info;
      try {
        lastSentAt = Date.now();
        info = await transport.sendMail(messageFor(email, { from, to }));
      } catch (err) {
        printErr(`${clock()}  ${email.kind.padEnd(8)}  FAILED  ${email.subject}: ${err.message}`);
        printErr(`Stopped: sent ${summary()}.`);
        return 1;
      }
      sent++;
      bytes += sizeOf(email);
      print(`${clock()}  ${email.kind.padEnd(8)}  ${email.subject}  (${kb(sizeOf(email))})`);

      if (marker) {
        const result = await marker.mark(email.id, info && info.messageId);
        if (result.uids.length) {
          unread++;
          print(`${clock()}  ${email.kind.padEnd(8)}  marked unread`);
        } else {
          missed++;
          const why = result.error ? ` (${result.error.message})` : '';
          printErr(`${clock()}  ${email.kind.padEnd(8)}  WARNING: "${email.subject}" was not found in the INBOX within ${duration((UNREAD_TRIES - 1) * UNREAD_WAIT_MS)}${why}. It may be marked read, and the watcher only takes unread mail: mark it unread in the mailbox.`);
        }
      }
    }
  } finally {
    if (typeof transport.close === 'function') transport.close();
    closeImap(imap);
  }
  print(`Sent ${summary()}.`);
  return 0;
}

if (require.main === module) {
  main().then(code => process.exit(code), err => {
    console.error(`demo-send-samples failed: ${(err && err.message) || err}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs, smtpFor, planSends, messageFor, imapOptionsFor, unreadMarker, main,
  USAGE, KINDS, DEFAULT_GAP_S, FROM_NAME, SAMPLE_HEADER, UNREAD_TRIES, UNREAD_WAIT_MS,
};
