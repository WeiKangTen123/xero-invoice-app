const Imap              = require('imap');
const { simpleParser } = require('mailparser');
const { parseInvoice } = require('./parser');
const logger           = require('../utils/logger');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

// ── State ─────────────────────────────────────────────────────────────────────
let imapInstance     = null;
let onInvoiceGlobal  = null;
let _intentionalStop = false;

// Reconnect back-off: doubles each failure, capped at 5 minutes, resets on success
let _reconnectAttempt = 0;
const RECONNECT_BASE_MS = 10000;
const RECONNECT_MAX_MS  = 300000; // 5 min
const RECONNECT_MAX_TRIES = 20;   // give up after 20 consecutive failures

// Fetch semaphore — only one fetchUnseen runs at a time
let _fetchInProgress = false;
let _fetchPending    = false;

// Debounce for the IMAP `update` event — coalesces rapid flag changes into 1 scan
let _updateDebounceTimer = null;
const UPDATE_DEBOUNCE_MS = 3000; // wait 3 s after last flag-change before scanning

// ── Minimum poll interval (never below 30 s regardless of env var) ────────────
const MIN_POLL_MS  = 30000;
const pollMs = Math.max(
  parseInt(process.env.IMAP_POLL_INTERVAL_MS) || 60000,
  MIN_POLL_MS
);

// ── Helpers ───────────────────────────────────────────────────────────────────
function createImap() {
  return new Imap({
    user:        process.env.IMAP_USER,
    password:    process.env.IMAP_PASS,
    host:        process.env.IMAP_HOST,
    port:        Number(process.env.IMAP_PORT) || 993,
    tls:         true,
    tlsOptions:  { rejectUnauthorized: false },
    keepalive:   true,
    authTimeout: 10000,
  });
}

function openInbox(imap, cb) {
  imap.openBox('INBOX', false, cb);
}

function buildSearchCriteria() {
  const since = new Date();
  since.setDate(since.getDate() - 40);
  const sinceStr = since.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
  const criteria = ['UNSEEN', ['SINCE', sinceStr]];
  if (process.env.IMAP_FILTER_FROM) {
    criteria.push(['FROM', process.env.IMAP_FILTER_FROM]);
  }
  return criteria;
}

// Serialise all IMAP fetches behind a simple semaphore.
// If a fetch is already in progress, mark "pending" so one more run fires after.
function fetchUnseen(imap, onInvoice) {
  if (_fetchInProgress) {
    _fetchPending = true;
    return;
  }
  _fetchInProgress = true;

  imap.search(buildSearchCriteria(), (err, uids) => {
    if (err) {
      logger.error('IMAP search error', { error: err.message });
      _fetchInProgress = false;
      if (_fetchPending) { _fetchPending = false; fetchUnseen(imap, onInvoice); }
      return;
    }
    if (!uids || !uids.length) {
      _fetchInProgress = false;
      if (_fetchPending) { _fetchPending = false; fetchUnseen(imap, onInvoice); }
      return;
    }

    logger.info(`Processing ${uids.length} unseen email(s)`);
    const f = imap.fetch(uids, { bodies: '', markSeen: true });
    const pending = [];

    f.on('message', (msg) => {
      let rawBuffer = '';
      msg.on('body', (stream) => {
        stream.on('data', chunk => rawBuffer += chunk.toString('utf8'));
        stream.once('end', () => {
          pending.push(
            simpleParser(rawBuffer)
              .then(async parsed => {
                const invoices = await parseInvoice(parsed);
                if (invoices?.length) {
                  for (const invoice of invoices) await onInvoice(invoice);
                } else {
                  logger.warn('Email had no parseable invoice data', {
                    subject: parsed.subject,
                    from:    parsed.from?.text,
                  });
                }
              })
              .catch(err => logger.error('Failed to parse email', { error: err.message }))
          );
        });
      });
    });

    f.once('error', err => {
      logger.error('Fetch error', { error: err.message });
      _fetchInProgress = false;
      if (_fetchPending) { _fetchPending = false; fetchUnseen(imap, onInvoice); }
    });

    f.once('end', async () => {
      // Wait for all message handlers to finish before clearing the semaphore
      await Promise.allSettled(pending);
      logger.info('Fetch complete');
      _fetchInProgress = false;
      if (_fetchPending) { _fetchPending = false; fetchUnseen(imap, onInvoice); }
    });
  });
}

// ── Watcher ───────────────────────────────────────────────────────────────────
function startWatcher(onInvoice) {
  if (_reconnectAttempt >= RECONNECT_MAX_TRIES) {
    logger.error('IMAP: max reconnect attempts reached — giving up. Restart the server to retry.');
    return;
  }

  _intentionalStop = false;
  _fetchInProgress = false;
  _fetchPending    = false;

  const imap = createImap();
  imapInstance    = imap;
  onInvoiceGlobal = onInvoice;

  imap.once('ready', () => {
    _reconnectAttempt = 0; // reset back-off on successful connection
    logger.info('IMAP connected, opening INBOX');

    openInbox(imap, (err) => {
      if (err) {
        logger.error('Failed to open inbox', { error: err.message });
        return;
      }

      fetchUnseen(imap, onInvoice);

      // Real-time new mail
      imap.on('mail', () => {
        logger.info('New mail received, processing...');
        fetchUnseen(imap, onInvoice);
      });

      // Flag changes (e.g. user marks email as unread) — debounced so rapid
      // flag storms (marking 10 emails at once) only trigger a single scan.
      imap.on('update', (_seqno, info) => {
        if (info?.flags && !info.flags.includes('\\Seen')) {
          if (_updateDebounceTimer) clearTimeout(_updateDebounceTimer);
          _updateDebounceTimer = setTimeout(() => {
            _updateDebounceTimer = null;
            logger.info('Email(s) marked as unread — rescanning inbox');
            fetchUnseen(imap, onInvoice);
          }, UPDATE_DEBOUNCE_MS);
        }
      });

      logger.info(`IMAP polling every ${pollMs / 1000}s`);
      setInterval(() => fetchUnseen(imap, onInvoice), pollMs);
    });
  });

  imap.on('error', (err) => {
    if (_intentionalStop) return;
    _reconnectAttempt++;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, _reconnectAttempt - 1), RECONNECT_MAX_MS);
    logger.error(`IMAP error (attempt ${_reconnectAttempt}/${RECONNECT_MAX_TRIES}), reconnecting in ${Math.round(delay / 1000)}s`, { error: err.message });
    setTimeout(() => { if (!_intentionalStop) startWatcher(onInvoice); }, delay);
  });

  imap.once('end', () => {
    if (_intentionalStop) {
      logger.info('IMAP connection closed (intentional stop)');
      return;
    }
    _reconnectAttempt++;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, _reconnectAttempt - 1), RECONNECT_MAX_MS);
    logger.warn(`IMAP connection ended unexpectedly (attempt ${_reconnectAttempt}/${RECONNECT_MAX_TRIES}), reconnecting in ${Math.round(delay / 1000)}s`);
    setTimeout(() => { if (!_intentionalStop) startWatcher(onInvoice); }, delay);
  });

  imap.connect();
}

function stopWatcher() {
  _intentionalStop  = true;
  _reconnectAttempt = 0;
  if (_updateDebounceTimer) { clearTimeout(_updateDebounceTimer); _updateDebounceTimer = null; }
  if (imapInstance) {
    try { imapInstance.end(); } catch (_) {}
    imapInstance    = null;
    onInvoiceGlobal = null;
  }
}

function rescanNow() {
  if (!imapInstance || !onInvoiceGlobal) return false;
  logger.info('Manual rescan triggered');
  fetchUnseen(imapInstance, onInvoiceGlobal);
  return true;
}

module.exports = { startWatcher, stopWatcher, rescanNow };
