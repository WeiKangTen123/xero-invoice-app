// Everything the mailbox watcher needs, worked out rather than asked for.
//
// The setup form used to present seven boxes and treat all of them as the
// user's problem, including a poll interval in milliseconds. Six of the seven
// can be decided from the account itself: the server follows from the email
// domain, the login is the address, and port, polling and lookback have one
// sensible value each. Only the app password cannot be derived.
//
// Anything typed by hand always wins — a company mail server, a shared mailbox,
// a slower poll — so this narrows what must be entered without taking away
// control.

// Servers for the providers a small business actually uses. Deliberately a
// short list of certainties: a wrong guess (mail.<domain>, say) fails at
// connect time with a DNS error the user cannot act on, which is worse than
// asking them for the hostname their IT gave them.
const HOST_BY_DOMAIN = {
  'gmail.com':       'imap.gmail.com',
  'googlemail.com':  'imap.gmail.com',
  'outlook.com':     'outlook.office365.com',
  'hotmail.com':     'outlook.office365.com',
  'live.com':        'outlook.office365.com',
  'msn.com':         'outlook.office365.com',
  'yahoo.com':       'imap.mail.yahoo.com',
  'yahoo.co.uk':     'imap.mail.yahoo.com',
  'icloud.com':      'imap.mail.me.com',
  'me.com':          'imap.mail.me.com',
  'mac.com':         'imap.mail.me.com',
  'aol.com':         'imap.aol.com',
  'zoho.com':        'imap.zoho.com',
  'fastmail.com':    'imap.fastmail.com',
  'proton.me':       '127.0.0.1',            // Proton Bridge runs locally; port comes from the bridge
  'protonmail.com':  '127.0.0.1',
};

const DEFAULT_PORT          = 993;     // TLS IMAP, effectively universal
const DEFAULT_POLL_MS       = 60000;
const MIN_POLL_MS           = 30000;   // a faster poll buys nothing and risks the provider throttling
const DEFAULT_LOOKBACK_DAYS = 100;
const MAX_LOOKBACK_DAYS     = 365;     // guards against a typo'd extra zero turning every poll into a multi-year search

function hostForEmail(email) {
  const at = String(email || '').trim().toLowerCase();
  const domain = at.includes('@') ? at.slice(at.lastIndexOf('@') + 1) : '';
  if (!domain) return null;
  return HOST_BY_DOMAIN[domain] || null;
}

function _int(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function _text(raw) {
  const v = String(raw ?? '').trim();
  return v.length ? v : null;
}

// config: this user's stored settings (blank/missing means "decide for me").
// loginEmail: the address they sign in with, used when no mailbox is named.
function resolveImapSettings(config = {}, loginEmail = '') {
  const automatic = [];
  const stored = key => _text(config[key]);

  const user = stored('IMAP_USER') || _text(loginEmail);
  if (!stored('IMAP_USER') && user) automatic.push('IMAP_USER');

  // The mailbox being watched decides the server, which is not always the
  // account's own address: someone signing in with Gmail may watch a shared
  // Outlook mailbox.
  const host = stored('IMAP_HOST') || hostForEmail(user);
  if (!stored('IMAP_HOST') && host) automatic.push('IMAP_HOST');

  const port = _int(stored('IMAP_PORT'), DEFAULT_PORT);
  if (stored('IMAP_PORT') === null) automatic.push('IMAP_PORT');

  const pollMs = Math.max(_int(stored('IMAP_POLL_INTERVAL_MS'), DEFAULT_POLL_MS), MIN_POLL_MS);
  if (stored('IMAP_POLL_INTERVAL_MS') === null) automatic.push('IMAP_POLL_INTERVAL_MS');

  const lookbackDays = Math.min(_int(stored('IMAP_LOOKBACK_DAYS'), DEFAULT_LOOKBACK_DAYS), MAX_LOOKBACK_DAYS);
  if (stored('IMAP_LOOKBACK_DAYS') === null) automatic.push('IMAP_LOOKBACK_DAYS');

  const password = _text(config.IMAP_PASS);

  return {
    host, port, user, password,
    pollMs, lookbackDays,
    filterFrom: stored('IMAP_FILTER_FROM'),
    // Enough to connect. The password is the only part nothing can supply.
    ready: !!(host && user && password),
    automatic,
  };
}

// What a blank box will actually use, as text, for the setup form to show in
// place of "Enter IMAP_PORT". A null means there is nothing to offer and the
// field has to be filled in.
function automaticImapValues(loginEmail = '') {
  return {
    IMAP_HOST:             hostForEmail(loginEmail),
    IMAP_PORT:             String(DEFAULT_PORT),
    IMAP_USER:             _text(loginEmail),
    IMAP_POLL_INTERVAL_MS: String(DEFAULT_POLL_MS),
    IMAP_LOOKBACK_DAYS:    String(DEFAULT_LOOKBACK_DAYS),
  };
}

module.exports = {
  hostForEmail, resolveImapSettings, automaticImapValues,
  HOST_BY_DOMAIN, DEFAULT_PORT, DEFAULT_POLL_MS, MIN_POLL_MS, DEFAULT_LOOKBACK_DAYS, MAX_LOOKBACK_DAYS,
};
