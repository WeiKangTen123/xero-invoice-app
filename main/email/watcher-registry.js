const net               = require('net');
const Imap              = require('imap');
const { simpleParser } = require('mailparser');
const emailQueue        = require('../queue/email-queue');
const emailWorker       = require('../queue/email-worker');
const processState      = require('../utils/process-state');
const settingsStore     = require('../utils/settings-store');
const logger            = require('../utils/logger');
const { resolveImapSettings } = require('./imap-settings');

const RECONNECT_BASE_MS   = 10000;
const RECONNECT_MAX_MS    = 300000; // 5 min cap
const RECONNECT_MAX_TRIES = 20;
const UPDATE_DEBOUNCE_MS  = 3000;

// Why a watcher is not watching, as the status endpoint reports it. Only MANUAL
// is somebody's decision (the Stop button, logging out, an admin), so only
// MANUAL clears the saved "keep my mailbox watched" setting. The others happen
// to a watcher, not by choice: a restart resumes it (routes/process.js
// resumeWatchers) once whatever stopped it may have gone away.
const STOP_REASONS = Object.freeze({
  MANUAL:   'manual',
  IDLE:     'idle',          // email/idle-sweeper.js, owner away past the cutoff
  AUTH:     'auth-failed',   // the mail server refused the password
  RETRIES:  'max-retries',   // the server stayed unreachable through every retry
  SHUTDOWN: 'shutdown',      // the server process is stopping
});

// registry: userId → WatcherState object
const _registry = new Map();

function _newState(userId) {
  return {
    userId,
    imap:             null,
    onInvoice:        null,
    credentials:      null,    // stored so reconnect can reuse them
    intentionalStop:  false,
    reconnectAttempt: 0,
    fetchInProgress:  false,
    fetchPending:     false,
    debounceTimer:    null,
    pollId:           null,
    reconnectTimer:   null,
    // What getStatus() reports: why it stopped, when, the error behind it, and
    // during a backoff when the next attempt is due.
    stopReason:       null,
    stoppedAt:        null,
    lastError:        null,
    nextRetryAt:      null,
    // s.imap is set as soon as `new Imap()` is constructed — well before the
    // connection handshake finishes and the inbox is actually selected. A
    // manual rescan that lands in that window calls .search() on a mailbox
    // that isn't open yet, which the imap library throws synchronously for
    // ("No mailbox is currently selected"). This flag is the real "safe to
    // search" signal — only true once openBox has actually succeeded.
    mailboxReady:     false,
  };
}

function _getState(userId) {
  if (!_registry.has(userId)) _registry.set(userId, _newState(userId));
  return _registry.get(userId);
}

// Loopback is the one place an unverifiable certificate is expected: Proton
// Bridge serves IMAP on 127.0.0.1 with its own self-signed certificate, and
// traffic that never leaves the machine cannot be intercepted on the way.
function _isLoopback(host) {
  const h = String(host || '').trim().toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

// TLS settings for an IMAP connection to `host`. The certificate is checked
// for every remote server: unchecked, anyone on the network path can present
// their own and collect the app password at login.
//
// servername is set because node-imap hands tls.connect a socket it opened
// itself, and Node then sends no SNI unless told. Gmail answers a client
// without SNI with a placeholder certificate that fails the check, so turning
// verification on without it would break every Gmail mailbox. An IP address is
// not a valid SNI name, so none is sent for one. A company server signed by a
// private CA is trusted by adding that CA through NODE_EXTRA_CA_CERTS, not by
// switching the check off.
function imapTlsOptions(host) {
  const options = { rejectUnauthorized: !_isLoopback(host) };
  if (host && !net.isIP(String(host))) options.servername = String(host);
  return options;
}

// Cancels everything scheduled for a watcher: a pending reconnect, the poll,
// the rescan debounce.
function _clearTimers(s) {
  if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
  if (s.debounceTimer)  { clearTimeout(s.debounceTimer);  s.debounceTimer  = null; }
  if (s.pollId)         { clearInterval(s.pollId);        s.pollId         = null; }
  s.nextRetryAt = null;
}

function _markStopped(s, reason, error = null) {
  s.stopReason  = reason;
  s.stoppedAt   = new Date().toISOString();
  s.lastError   = error;
  s.nextRetryAt = null;
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

// A bill forwarded "as attachment" arrives as a whole email inside this one
// (message/rfc822). mailparser hands that over as one opaque attachment, so
// the PDF inside it was never seen. Each such email is parsed here, one level
// down, and passed on as `forwarded` for the queue to take its documents from
// (queue/email-queue.js). One level is what forwarding produces; an email
// forwarded inside a forwarded one is left unopened.
const _isAttachedEmail = a =>
  String(a?.contentType || '').toLowerCase() === 'message/rfc822' || /\.eml$/i.test(a?.filename || '');

async function _parseMail(raw) {
  const parsed = await simpleParser(raw);
  const forwarded = [];
  for (const a of parsed?.attachments || []) {
    if (!_isAttachedEmail(a) || !a.content) continue;
    try {
      forwarded.push(await simpleParser(a.content));
    } catch (err) {
      // The outer email still queues: its own attachments and body are intact.
      logger.warn('An email attached to a message could not be read', { file: a.filename, error: err.message });
    }
  }
  if (forwarded.length) parsed.forwarded = forwarded;
  return parsed;
}

function _fetchUnseen(s) {
  if (!s.mailboxReady) { logger.warn(`[user:${s.userId}] Fetch skipped — mailbox not open yet`); return; }
  if (s.fetchInProgress) { s.fetchPending = true; return; }
  s.fetchInProgress = true;

  const since = new Date();
  since.setDate(since.getDate() - s.settings.lookbackDays);
  const sinceStr = since.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
  const criteria = ['UNSEEN', ['SINCE', sinceStr]];
  if (s.settings.filterFrom) {
    criteria.push(['FROM', s.settings.filterFrom]);
  }

  s.imap.search(criteria, (err, uids) => {
    if (err) {
      logger.error(`[user:${s.userId}] IMAP search error`, { error: err.message });
      s.fetchInProgress = false;
      if (s.fetchPending) { s.fetchPending = false; _fetchUnseen(s); }
      return;
    }

    // Recorded for both an empty and a non-empty result — the UI needs to be able
    // to say "checked, found nothing" just as much as "found N emails".
    processState.forUser(s.userId).notifyScan(uids?.length || 0);

    if (!uids?.length) {
      s.fetchInProgress = false;
      if (s.fetchPending) { s.fetchPending = false; _fetchUnseen(s); }
      return;
    }

    logger.info(`[user:${s.userId}] Processing ${uids.length} unseen email(s)`);
    // Not marked seen by the fetch: the mail is flagged only after its job is
    // on disk. With markSeen at fetch time, anything that failed between here
    // and enqueue (a parse error, a bad Date header, a full disk) was a mail
    // already read in the mailbox and gone from the queue — lost silently.
    const f       = s.imap.fetch(uids, { bodies: '', markSeen: false });
    const pending = [];

    f.on('message', (msg) => {
      const chunks = [];
      let uid = null;
      msg.once('attributes', attrs => { uid = attrs && attrs.uid; });
      msg.on('body', (stream) => {
        // Accumulate raw Buffer chunks — do NOT toString per-chunk because a
        // multi-byte UTF-8 character can be split across TCP packet boundaries,
        // and converting each chunk independently corrupts those characters.
        stream.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        stream.once('end', () => {
          // The raw bytes go to the parser as they are. Decoding them as UTF-8
          // first turned every Latin-1 byte in a body into U+FFFD and mangled
          // any attachment sent with Content-Transfer-Encoding: binary (a PDF
          // full of high bytes) before mailparser ever saw it. mailparser reads
          // each part's own charset and encoding from the Buffer.
          const rawBuffer = Buffer.concat(chunks);
          pending.push(
            _parseMail(rawBuffer)
              .then(parsed => {
                // Persist the email to the file-based queue before processing.
                // This guarantees that even a mid-LLM server restart (nodemon, crash)
                // does not lose the job — the worker will recover it on the next boot.
                const job = emailQueue.enqueue(s.userId, parsed);
                logger.info(`[user:${s.userId}] Email queued`, { jobId: job.id, subject: parsed.subject });
                emailWorker.kickWorker(s.userId);
                if (uid != null && s.imap) {
                  s.imap.addFlags(uid, ['\\Seen'], err => {
                    if (err) logger.warn(`[user:${s.userId}] Could not mark email seen`, { uid, error: err.message });
                  });
                }
              })
              .catch(err => logger.error(`[user:${s.userId}] Failed to queue email`, { error: err.message }))
          );
        });
      });
    });

    f.once('error', err => {
      logger.error(`[user:${s.userId}] Fetch error`, { error: err.message });
      s.fetchInProgress = false;
      if (s.fetchPending) { s.fetchPending = false; _fetchUnseen(s); }
    });

    f.once('end', () => {
      Promise.allSettled(pending).then(() => {
        logger.info(`[user:${s.userId}] Fetch complete`);
      }).catch(err => {
        logger.error(`[user:${s.userId}] Error in fetch batch`, { error: err.message });
      }).finally(() => {
        s.fetchInProgress = false;
        if (s.fetchPending) { s.fetchPending = false; _fetchUnseen(s); }
      });
    });
  });
}

// ── Connection ────────────────────────────────────────────────────────────────

// Every disconnect funnels through here, and it is deliberately the ONLY place
// that increments the attempt counter or schedules a retry.
//
// The old code incremented and scheduled independently in BOTH the 'error' and
// 'end' handlers. A dropped socket makes node-imap emit both, so one disconnect
// cost two attempts and started two reconnects — each of which built a fresh
// Imap instance while the previous one stayed alive with its listeners attached.
// The next drop then fired four events, then eight. Gmail routinely closes idle
// IDLE connections, so a healthy mailbox burned the 20-attempt budget in about
// ten normal drops and stopped for good with "stop and reconfigure", while the
// credentials were perfectly valid.
//
// Three guards make that impossible:
//   * `imap !== s.imap` ignores events from an instance we have already replaced
//   * `s.reconnectTimer` ignores a second event for the same disconnect
//   * the timer is held on state, so stop() can cancel a pending retry
function _scheduleReconnect(s, imap, reason, err) {
  const { userId } = s;
  if (s.intentionalStop) return;
  if (imap && s.imap && imap !== s.imap) return;  // stale instance, already superseded
  if (s.reconnectTimer) return;                   // this disconnect is already handled

  s.mailboxReady = false;
  if (s.pollId) { clearInterval(s.pollId); s.pollId = null; }
  s.lastError = err ? err.message : `Connection ${reason}`;

  s.reconnectAttempt++;
  if (s.reconnectAttempt > RECONNECT_MAX_TRIES) {
    logger.error(`[user:${userId}] IMAP: max reconnect attempts reached — stop and reconfigure`);
    _teardown(s.imap);
    s.imap = null;
    _markStopped(s, STOP_REASONS.RETRIES, s.lastError);
    return;
  }

  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, s.reconnectAttempt - 1), RECONNECT_MAX_MS);
  logger.warn(
    `[user:${userId}] IMAP ${reason} (attempt ${s.reconnectAttempt}/${RECONNECT_MAX_TRIES}), ` +
    `reconnecting in ${Math.round(delay / 1000)}s`,
    err ? { error: err.message } : undefined
  );

  // Drop the dead instance before building a new one, so its listeners can't
  // fire against the state we are about to reuse.
  _teardown(s.imap);
  s.imap = null;

  s.nextRetryAt    = new Date(Date.now() + delay).toISOString();
  s.reconnectTimer = setTimeout(() => {
    s.reconnectTimer = null;
    s.nextRetryAt    = null;
    if (s.intentionalStop) return;
    try { _connect(s); } catch (e) {
      // Counted and retried like any other failed attempt. Returning here
      // left a watcher with no connection and nothing scheduled: off for good,
      // with nothing to say so.
      logger.error(`[user:${userId}] Reconnect failed`, { error: e.message });
      _scheduleReconnect(s, s.imap, 'reconnect failed', e);
    }
  }, delay);
}

// Detaches listeners and closes an Imap instance we are finished with. Without
// removeAllListeners an orphan keeps emitting into the live state.
function _teardown(imap) {
  if (!imap) return;
  try {
    imap.removeAllListeners();
    // A bare EventEmitter THROWS on an 'error' event with no listener, and
    // node-imap can still emit one while the socket finishes closing. Without
    // this sink that becomes an uncaughtException, which index.js turns into a
    // process exit — so tearing down a dead connection would take the server
    // with it.
    imap.on('error', () => {});
  } catch (_) {}
  try { imap.end(); } catch (_) {}
}

// The retry budget is enforced in _scheduleReconnect alone. A second check
// here gave up one attempt early and without recording why, so the 20th
// scheduled retry silently did nothing.
function _connect(s) {
  const { userId, settings, onInvoice } = s;

  s.intentionalStop = false;
  s.fetchInProgress = false;
  s.fetchPending    = false;
  s.mailboxReady    = false;
  s.onInvoice       = onInvoice;

  const pollMs = settings.pollMs;

  const imap = new Imap({
    user:        settings.user,
    password:    settings.password,
    host:        settings.host,
    port:        settings.port,
    tls:         true,
    tlsOptions:  imapTlsOptions(settings.host),
    keepalive:   true,
    authTimeout: 10000,
  });
  s.imap = imap;

  // The folder watched. The resolved settings carry none today (see
  // email/imap-settings.js), so this is the inbox; a `folder` there, from a
  // setting the user fills in, is all it takes to watch another one.
  const mailbox = settings.folder || 'INBOX';

  imap.once('ready', () => {
    if (imap !== s.imap) return;    // replaced or stopped while handshaking
    s.reconnectAttempt = 0;
    s.lastError        = null;
    logger.info(`[user:${userId}] IMAP connected, opening ${mailbox}`);

    imap.openBox(mailbox, false, (err) => {
      // openBox answers through a callback, which _teardown's
      // removeAllListeners does not cancel. Without this a superseded
      // connection could still open its inbox and start a poll on the live
      // state, and that interval would never be cleared.
      if (imap !== s.imap) return;
      if (err) {
        // Connected but no mailbox is a zombie: isRunning() true, no poll, no
        // reconnect. Treat it like any other dropped connection.
        _scheduleReconnect(s, imap, 'openBox failed', err);
        return;
      }

      s.mailboxReady = true;
      _fetchUnseen(s);

      imap.on('mail', () => {
        logger.info(`[user:${userId}] New mail received`);
        _fetchUnseen(s);
      });

      // Flag changes — debounced so marking 10 emails at once only triggers 1 scan
      imap.on('update', (_seqno, info) => {
        if (info?.flags && !info.flags.includes('\\Seen')) {
          if (s.debounceTimer) clearTimeout(s.debounceTimer);
          s.debounceTimer = setTimeout(() => {
            s.debounceTimer = null;
            logger.info(`[user:${userId}] Email(s) marked as unread — rescanning`);
            _fetchUnseen(s);
          }, UPDATE_DEBOUNCE_MS);
        }
      });

      if (s.pollId) clearInterval(s.pollId);
      s.pollId = setInterval(() => _fetchUnseen(s), pollMs);
      logger.info(`[user:${userId}] IMAP polling every ${pollMs / 1000}s`);
    });
  });

  // Both of these fire for a single dropped socket. Neither decides anything;
  // _scheduleReconnect de-duplicates them.
  imap.on('error', (err) => {
    // A rejected password will not fix itself. Retrying it through the full
    // backoff was ~1.5 hours of bad logins against the mail server; stop, and
    // say why in the log so the user reconfigures.
    if (err && err.source === 'authentication') {
      if (imap !== s.imap) return;
      logger.error(`[user:${s.userId}] IMAP authentication failed — watcher stopped; check IMAP_USER / IMAP_PASS`, { error: err.message });
      stop(s.userId, { reason: STOP_REASONS.AUTH, error: err.message });
      return;
    }
    _scheduleReconnect(s, imap, 'error', err);
  });

  imap.once('end', () => {
    if (s.intentionalStop) {
      logger.info(`[user:${s.userId}] IMAP connection closed (intentional stop)`);
      return;
    }
    _scheduleReconnect(s, imap, 'ended unexpectedly');
  });

  imap.connect();
}

// ── Public API ────────────────────────────────────────────────────────────────

// `credentials` is this user's stored settings; anything they left blank is
// worked out from `loginEmail` (see email/imap-settings.js), so an ordinary
// mailbox needs nothing but an app password.
function start(userId, credentials, onInvoice, { loginEmail = '' } = {}) {
  const s = _getState(userId);
  if (s.imap) {
    logger.warn(`[user:${userId}] Watcher already running`);
    return;
  }
  // A watcher waiting out a reconnect backoff has no connection, so it looks
  // stopped and a Start lands here. Its pending retry used to fire anyway and
  // connect a second time beside the connection made below; the second openBox
  // overwrote the first poll interval, so after stop() one socket and one
  // interval stayed alive. Starting now replaces the retry instead.
  _clearTimers(s);
  s.settings         = resolveImapSettings(credentials, loginEmail);
  s.onInvoice        = onInvoice;
  s.reconnectAttempt = 0;
  s.stopReason       = null;
  s.stoppedAt        = null;
  s.lastError        = null;
  _connect(s);
}

// `reason` is one of STOP_REASONS. Callers that pass none (the Stop button,
// logout in routes/auth.js, the admin routes) are a person choosing to stop
// it, so the saved setting is cleared and a restart leaves it off. Everything
// automatic passes its own reason and leaves the setting alone.
function stop(userId, { reason = STOP_REASONS.MANUAL, error = null } = {}) {
  if (reason === STOP_REASONS.MANUAL) {
    // Before the registry lookup: after a restart a mailbox can be switched on
    // in the database with no watcher in memory yet (resume skipped it), and
    // stopping it must still stick.
    try { settingsStore.forUser(userId).setWatcherEnabled(false); } catch (err) {
      logger.warn(`[user:${userId}] Could not record that the watcher was stopped`, { error: err.message });
    }
  }
  const s = _registry.get(userId);
  if (!s) return;
  const wasActive = !!(s.imap || s.reconnectTimer);
  s.intentionalStop  = true;
  s.reconnectAttempt = 0;
  // A retry scheduled before the stop would otherwise reconnect a watcher the
  // user just switched off.
  _clearTimers(s);
  if (s.imap) {
    // Torn down, not just ended: a late 'error' or 'end' from the closing
    // socket must not reach state a later start() is about to reuse.
    _teardown(s.imap);
    s.imap         = null;
    s.mailboxReady = false;
    s.onInvoice    = null;
  }
  // A stop of a watcher that had already stopped keeps the reason it stopped
  // for, so the shutdown sweep does not paper over "authentication failed";
  // a person pressing Stop is always recorded.
  if (wasActive || reason === STOP_REASONS.MANUAL) _markStopped(s, reason, error);
}

function rescan(userId) {
  const s = _registry.get(userId);
  // s.imap is set the instant `new Imap()` is constructed — well before the
  // handshake finishes and the inbox is actually selected. Gating on
  // mailboxReady (not just s.imap) is what stops a rescan fired in that
  // window from calling .search() on an unselected mailbox, which node-imap
  // throws synchronously for.
  if (!s?.imap || !s.mailboxReady) return false;
  logger.info(`[user:${userId}] Manual rescan triggered`);
  _fetchUnseen(s);
  return true;
}

function isRunning(userId) {
  return !!_registry.get(userId)?.imap;
}

// What the watcher is doing and, when it is not watching, why. `running` in
// the status response is isRunning(), which is false during a backoff and
// after every kind of stop alike; this tells them apart.
//   state:       'watching' | 'connecting' | 'reconnecting' | 'stopped'
//   reason:      a STOP_REASONS value while stopped, null if never started
//   error:       the error behind a failed login, exhausted retries or a backoff
//   stoppedAt:   when it stopped
//   nextRetryAt: when the next connection attempt is due, during a backoff
//   attempt:     which retry that will be, during a backoff
function getStatus(userId) {
  const s = _registry.get(userId);
  let state = 'stopped';
  if (s?.imap) state = s.mailboxReady ? 'watching' : 'connecting';
  else if (s?.reconnectTimer) state = 'reconnecting';
  const stopped = state === 'stopped';
  return {
    state,
    reason:      stopped ? s?.stopReason || null : null,
    error:       (stopped || state === 'reconnecting') ? s?.lastError || null : null,
    stoppedAt:   stopped ? s?.stoppedAt || null : null,
    nextRetryAt: state === 'reconnecting' ? s.nextRetryAt : null,
    attempt:     state === 'reconnecting' ? s.reconnectAttempt : 0,
  };
}

// Stops every live watcher. Needed in two places that both lacked it: server
// shutdown left IMAP sockets and their reconnect timers open on SIGTERM, and
// tests that started watchers left them running into later test files.
//
// A shutdown is not anyone switching their mailbox off, so the saved setting
// is left on and the next boot resumes it.
function stopAll() {
  const ids = [..._registry.keys()];
  for (const userId of ids) {
    try { stop(userId, { reason: STOP_REASONS.SHUTDOWN }); } catch (err) { logger.warn('Failed to stop watcher', { userId, error: err.message }); }
  }
  return ids.length;
}

// Starts again, at boot, every watcher its owner left on. The work is done by
// resumeWatchers in routes/process.js, which builds a watcher exactly as the
// Start button does (invoice handler and worker included); main/index.js
// reaches for it here, with the rest of the watcher lifecycle. Required at
// call time because that module requires this one.
function resumeWatchers(options) {
  return require('../routes/process').resumeWatchers(options);
}

module.exports = { start, stop, stopAll, rescan, isRunning, getStatus, resumeWatchers, imapTlsOptions, STOP_REASONS };
