const Imap              = require('imap');
const { simpleParser } = require('mailparser');
const emailQueue        = require('../queue/email-queue');
const emailWorker       = require('../queue/email-worker');
const processState      = require('../utils/process-state');
const logger            = require('../utils/logger');

const MIN_POLL_MS         = 30000;
const RECONNECT_BASE_MS   = 10000;
const RECONNECT_MAX_MS    = 300000; // 5 min cap
const RECONNECT_MAX_TRIES = 20;
const UPDATE_DEBOUNCE_MS  = 3000;
const DEFAULT_LOOKBACK_DAYS = 100;
const MAX_LOOKBACK_DAYS     = 365; // guards against an accidentally huge/slow IMAP SINCE search

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

// ── Fetch ─────────────────────────────────────────────────────────────────────

// Clamped so a blank/invalid/zero/negative value falls back to the default rather
// than searching since the epoch, and an absurdly large one (e.g. a typo'd extra
// zero) can't turn every poll into a multi-year IMAP SINCE search.
function _resolveLookbackDays(raw) {
  return Math.min(Math.max(parseInt(raw, 10) || DEFAULT_LOOKBACK_DAYS, 1), MAX_LOOKBACK_DAYS);
}

function _fetchUnseen(s) {
  if (!s.mailboxReady) { logger.warn(`[user:${s.userId}] Fetch skipped — mailbox not open yet`); return; }
  if (s.fetchInProgress) { s.fetchPending = true; return; }
  s.fetchInProgress = true;

  const lookbackDays = _resolveLookbackDays(s.credentials?.IMAP_LOOKBACK_DAYS);
  const since = new Date();
  since.setDate(since.getDate() - lookbackDays);
  const sinceStr = since.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
  const criteria = ['UNSEEN', ['SINCE', sinceStr]];
  if (s.credentials?.IMAP_FILTER_FROM) {
    criteria.push(['FROM', s.credentials.IMAP_FILTER_FROM]);
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
    const f       = s.imap.fetch(uids, { bodies: '', markSeen: true });
    const pending = [];

    f.on('message', (msg) => {
      const chunks = [];
      msg.on('body', (stream) => {
        // Accumulate raw Buffer chunks — do NOT toString per-chunk because a
        // multi-byte UTF-8 character can be split across TCP packet boundaries,
        // and converting each chunk independently corrupts those characters.
        stream.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        stream.once('end', () => {
          const rawBuffer = Buffer.concat(chunks).toString('utf8');
          pending.push(
            simpleParser(rawBuffer)
              .then(parsed => {
                // Persist the email to the file-based queue before processing.
                // This guarantees that even a mid-LLM server restart (nodemon, crash)
                // does not lose the job — the worker will recover it on the next boot.
                const job = emailQueue.enqueue(s.userId, parsed);
                logger.info(`[user:${s.userId}] Email queued`, { jobId: job.id, subject: parsed.subject });
                emailWorker.kickWorker(s.userId);
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

function _connect(s) {
  const { userId, credentials, onInvoice } = s;

  if (s.reconnectAttempt >= RECONNECT_MAX_TRIES) {
    logger.error(`[user:${userId}] IMAP: max reconnect attempts reached — stop and reconfigure`);
    return;
  }

  s.intentionalStop = false;
  s.fetchInProgress = false;
  s.fetchPending    = false;
  s.mailboxReady    = false;
  s.onInvoice       = onInvoice;

  const pollMs = Math.max(parseInt(credentials.IMAP_POLL_INTERVAL_MS) || 60000, MIN_POLL_MS);

  const imap = new Imap({
    user:        credentials.IMAP_USER,
    password:    credentials.IMAP_PASS,
    host:        credentials.IMAP_HOST || 'imap.gmail.com',
    port:        Number(credentials.IMAP_PORT) || 993,
    tls:         true,
    tlsOptions:  { rejectUnauthorized: false },
    keepalive:   true,
    authTimeout: 10000,
  });
  s.imap = imap;

  imap.once('ready', () => {
    s.reconnectAttempt = 0;
    logger.info(`[user:${userId}] IMAP connected, opening INBOX`);

    imap.openBox('INBOX', false, (err) => {
      if (err) {
        logger.error(`[user:${userId}] Failed to open inbox`, { error: err.message });
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

      s.pollId = setInterval(() => _fetchUnseen(s), pollMs);
      logger.info(`[user:${userId}] IMAP polling every ${pollMs / 1000}s`);
    });
  });

  imap.on('error', (err) => {
    s.mailboxReady = false;
    if (s.intentionalStop) return;
    s.reconnectAttempt++;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, s.reconnectAttempt - 1), RECONNECT_MAX_MS);
    logger.error(
      `[user:${userId}] IMAP error (attempt ${s.reconnectAttempt}/${RECONNECT_MAX_TRIES}), ` +
      `reconnecting in ${Math.round(delay / 1000)}s`,
      { error: err.message }
    );
    setTimeout(() => {
      if (!s.intentionalStop) {
        try { _connect(s); } catch (e) {
          logger.error(`[user:${userId}] Reconnect failed`, { error: e.message });
        }
      }
    }, delay);
  });

  imap.once('end', () => {
    s.mailboxReady = false;
    if (s.pollId) { clearInterval(s.pollId); s.pollId = null; }
    if (s.intentionalStop) {
      logger.info(`[user:${userId}] IMAP connection closed (intentional stop)`);
      return;
    }
    s.reconnectAttempt++;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, s.reconnectAttempt - 1), RECONNECT_MAX_MS);
    logger.warn(
      `[user:${userId}] IMAP ended unexpectedly (attempt ${s.reconnectAttempt}/${RECONNECT_MAX_TRIES}), ` +
      `reconnecting in ${Math.round(delay / 1000)}s`
    );
    setTimeout(() => {
      if (!s.intentionalStop) {
        try { _connect(s); } catch (e) {
          logger.error(`[user:${userId}] Reconnect after end failed`, { error: e.message });
        }
      }
    }, delay);
  });

  imap.connect();
}

// ── Public API ────────────────────────────────────────────────────────────────

function start(userId, credentials, onInvoice) {
  const s = _getState(userId);
  if (s.imap) {
    logger.warn(`[user:${userId}] Watcher already running`);
    return;
  }
  s.credentials     = credentials;
  s.onInvoice       = onInvoice;
  s.reconnectAttempt = 0;
  _connect(s);
}

function stop(userId) {
  const s = _registry.get(userId);
  if (!s) return;
  s.intentionalStop  = true;
  s.reconnectAttempt = 0;
  if (s.debounceTimer) { clearTimeout(s.debounceTimer); s.debounceTimer = null; }
  if (s.pollId)        { clearInterval(s.pollId);       s.pollId        = null; }
  if (s.imap) {
    try { s.imap.end(); } catch (_) {}
    s.imap         = null;
    s.mailboxReady = false;
    s.onInvoice    = null;
  }
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

module.exports = { start, stop, rescan, isRunning, _resolveLookbackDays }; // last one exposed for tests
