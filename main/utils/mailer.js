// Email from the app itself: invite and password-reset links, and the notice
// that a password was changed (utils/mail-templates.js). One SMTP account for
// the whole server, set by an admin in Setup -> Email (routes/setup.js,
// written to main/.env and to process.env at once), so it is read from
// process.env on every use and a saved change needs no restart:
//
//   SMTP_HOST       the mail server, e.g. smtp.gmail.com
//   SMTP_PORT       465 (TLS from the start, the default) or 587 (STARTTLS)
//   SMTP_USER       the account it signs in as, which is also the From address
//   SMTP_PASS       its password; for Gmail an App Password
//   SMTP_FROM_NAME  the name mail comes from (default "Financial Automation")
//   APP_BASE_URL    this app's public address, which every link starts with
//
// A link is never built from the request's Host header: whoever sends the
// request chooses that header, and a reset link pointing at their own server
// would hand them the token when the person clicks it. Without APP_BASE_URL
// the origin of XERO_OAUTH_REDIRECT_URI is used, which is this server's
// public address on any deployment that connects to Xero; without either
// there is no address to send, and appBaseUrl() is null.
//
// send() never throws to its caller: a mail that could not go is
// { sent: false, error }, which the routes turn into "here is the link to
// hand over" rather than a failure. The password is never logged or returned.
const nodemailer = require('nodemailer');
const logger     = require('./logger');

const DEFAULT_PORT      = 465;
const DEFAULT_FROM_NAME = 'Financial Automation';

// Long enough for a slow server, short enough that an admin pressing Send
// test email is not left waiting on one that will never answer.
const TIMEOUTS = { connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000 };

// A transport put in place by the tests (nodemailer's jsonTransport), used
// instead of SMTP. Never set outside them.
let _testTransport = null;

function _env(key) {
  return String(process.env[key] ?? '').trim();
}

function _port() {
  const n = Number(_env('SMTP_PORT'));
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

// The server-wide settings, as read now.
function settings() {
  return {
    host: _env('SMTP_HOST'), port: _port(), user: _env('SMTP_USER'), pass: String(process.env.SMTP_PASS ?? ''),
    fromName: _env('SMTP_FROM_NAME') || DEFAULT_FROM_NAME,
  };
}

// Whether there is enough to send with: a server, an account and its
// password.
function isConfigured() {
  const s = settings();
  return !!(s.host && s.user && s.pass);
}

// The origin (scheme, host and port, no path) of an http or https URL, or
// null for anything else.
function _origin(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  try {
    const url = new URL(s);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

// The public address every link starts with (see the top of this file), or
// null when there is none to use.
function appBaseUrl() {
  return _origin(process.env.APP_BASE_URL) || _origin(process.env.XERO_OAUTH_REDIRECT_URI);
}

// The link that opens the set-password page with this token, or null with no
// public address. The token is in the fragment, after #, which the browser
// keeps to itself: the page reads it and posts it (routes/auth.js).
function linkFor(rawToken) {
  const base = appBaseUrl();
  return base ? `${base}/set-password#t=${rawToken}` : null;
}

// An error's message as it may be shown and logged: one line, cut short, and
// with the password taken out should a server ever echo it back.
function _cleanError(err, pass) {
  let text = String((err && (err.message || err.response)) || err || 'The email could not be sent');
  if (pass) text = text.split(pass).join('[password]');
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

function _transport(s) {
  if (_testTransport) return _testTransport;
  return nodemailer.createTransport({
    host: s.host, port: s.port,
    // 465 speaks TLS from the first byte; any other port must upgrade with
    // STARTTLS before the password is sent, and a server that will not is
    // refused rather than sent it in clear.
    secure: s.port === 465, requireTLS: s.port !== 465,
    auth: { user: s.user, pass: s.pass },
    ...TIMEOUTS,
  });
}

// Sends one message. Resolves { sent: true } or { sent: false, error }, never
// rejects. `to` is one address; text and html are the same message twice
// (mail-templates.js), for a reader that shows only one.
async function send({ to, subject, text, html }) {
  const s = settings();
  if (!isConfigured()) return { sent: false, error: 'Email is not set up on this server (Setup → Email).' };
  try {
    await _transport(s).sendMail({
      // The display name in quotes and the account's own address, which is
      // what Gmail and most servers require the sender to be.
      from: { name: s.fromName, address: s.user },
      to, subject, text, html,
    });
    logger.info('Email sent', { to, subject });
    return { sent: true };
  } catch (err) {
    const error = _cleanError(err, s.pass);
    logger.warn('Email could not be sent', { to, subject, host: s.host, port: s.port, code: err && err.code, error });
    return { sent: false, error };
  }
}

// For the tests only: send through this transport instead of SMTP (null
// puts SMTP back).
function _setTransportForTests(transport) {
  _testTransport = transport || null;
}

module.exports = {
  settings, isConfigured, appBaseUrl, linkFor, send, _setTransportForTests,
  DEFAULT_PORT, DEFAULT_FROM_NAME,
};
