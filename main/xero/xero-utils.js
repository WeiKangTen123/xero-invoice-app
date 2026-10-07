const logger = require('../utils/logger');
// Every Xero module requires this file, so loading the guard here puts the
// SDK's network-error fix and request timeout in place before any call.
require('./sdk-guard');

/**
 * Retry wrapper for Xero API calls.
 * Handles 429 rate-limit responses using Retry-After header when available,
 * falling back to exponential backoff.
 *
 * Network failures and timeouts are deliberately not retried. A reset or a
 * timed-out write may already have landed in Xero, so repeating it risks a
 * duplicate invoice; and five attempts behind a 60-second timeout would hold
 * the caller for five minutes. They fail once, with xeroErrMsg's message.
 */
async function withRetry(fn, retries = 5, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const { status, retryAfter } = _parseXeroErr(err);
      const isRateLimit = status === 429;
      const retryAfterMs = parseInt(retryAfter || '0') * 1000;

      if (isRateLimit && attempt < retries) {
        const wait = retryAfterMs || delayMs * Math.pow(2, attempt - 1);
        logger.warn(`Xero rate limited — retrying in ${Math.round(wait / 1000)}s`, { attempt, retries });
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw err;
      }
    }
  }
}

/**
 * xero-node throws the full HTTP response JSON-stringified — confirmed live
 * that for at least some calls (getPayments) the thrown value is a raw
 * string itself (typeof err === 'string', not an Error, no .message at
 * all), not "an Error object whose .message holds the JSON" as this used to
 * assume. A raw string has no .message property, so that assumption meant
 * this never even attempted to parse it — every error of that shape fell
 * through to a raw JSON dump instead of a real message. Handles both shapes.
 * Returns { status, body } — body is always a plain object (or null).
 */
function _parseXeroErr(err) {
  let parsed = null;
  const raw = typeof err === 'string' ? err : (typeof err?.message === 'string' ? err.message : null);
  if (raw) {
    try { parsed = JSON.parse(raw); } catch (_) {}
  }
  const status = parsed?.response?.statusCode || parsed?.statusCode
    || err?.response?.statusCode || err?.statusCode || 0;
  let body = parsed?.body || parsed?.response?.body
    || err?.body || err?.response?.body || null;
  if (typeof body === 'string' && body) {
    try { body = JSON.parse(body); } catch (_) {}
  }
  const retryAfter = parsed?.response?.headers?.['retry-after']
    || err?.response?.headers?.['retry-after']
    || err?.headers?.['retry-after'] || null;
  const wwwAuthenticate = parsed?.response?.headers?.['www-authenticate']
    || err?.response?.headers?.['www-authenticate']
    || err?.headers?.['www-authenticate'] || null;
  // Only a failure with no HTTP response has these: sdk-guard.js carries the
  // socket error's code and message inside the SDK's serialised rejection, and
  // a direct axios call leaves them on the error itself.
  const code = (typeof parsed?.code === 'string' && parsed.code)
    || (typeof err?.code === 'string' && err.code) || null;
  const message = (typeof parsed?.message === 'string' && parsed.message) || null;
  return { status, body, retryAfter, wwwAuthenticate, code, message };
}

// Socket- and DNS-level failures: no response came back at all.
const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT',
  'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EPIPE',
  'ERR_NETWORK', 'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

/**
 * A plain-language message when the call never got an answer from Xero, or
 * null when it did. Without this a dropped connection surfaced as the SDK's
 * serialised error — a JSON dump — or as nothing at all.
 */
function _networkErrMsg(err, { status, code, message }) {
  if (status) return null;
  const text = message || (typeof err?.message === 'string' ? err.message : '');
  // axios reports its own timeout as ECONNABORTED "timeout of Nms exceeded";
  // ECONNABORTED without that wording is an aborted connection, not a timeout.
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT'
      || (code === 'ECONNABORTED' && /timeout/i.test(text))) {
    return 'Xero did not respond in time — please try again in a moment';
  }
  if (code && NETWORK_CODES.has(code)) {
    return `Could not reach Xero (${code}) — check the connection and try again`;
  }
  return null;
}

/**
 * A token that's valid but missing a required OAuth scope. Confirmed against
 * a live call (Payments, requested without accounting.payments.read): Xero
 * signals this with a 401 — not always 403, despite what this used to
 * assume — plus a `WWW-Authenticate: insufficient_scope` header. The header
 * is what actually distinguishes "right token, just missing a scope" from
 * "wrong/expired token", since both can come back as a plain 401; a bare 403
 * is kept as a defensive fallback in case some other endpoint does use it.
 */
function isScopeError(err) {
  const { status, wwwAuthenticate } = _parseXeroErr(err);
  if (wwwAuthenticate && /insufficient_scope/i.test(wwwAuthenticate)) return true;
  return status === 403;
}

/**
 * Extracts a human-readable error message from a xero-node error.
 */
function xeroErrMsg(err) {
  const parsed = _parseXeroErr(err);
  const { status, body } = parsed;
  if (status === 429) return 'Xero rate limit exceeded — try again in a minute';
  return (
    _networkErrMsg(err, parsed) ||
    body?.Elements?.[0]?.ValidationErrors?.[0]?.Message ||
    body?.Detail   ||
    body?.Message  ||
    parsed.message ||
    err?.message   ||
    String(err)
  );
}

// Every accounting scope the app uses, in one place. OAuth adds offline_access
// (refresh tokens); a Custom Connection has no refresh token to ask for. The
// two lists had drifted: budgets were added to OAuth only, so Custom
// Connection users got insufficient_scope on the whole dashboard.
const SCOPES = 'accounting.invoices accounting.contacts accounting.settings.read '
  + 'accounting.banktransactions.read accounting.reports.profitandloss.read accounting.reports.banksummary.read '
  + 'accounting.payments.read accounting.reports.budgetsummary.read accounting.budgets.read';

// Attaching the bill's PDF or the claim's receipt needs this, and without it
// every attachment was refused and only logged. Only the Web app (OAuth) flow
// asks for it. A Custom Connection's token request names its scopes outright,
// and Xero refuses the whole request when one of them was never granted to
// that connection, so adding it to SCOPES would disconnect every Custom
// Connection set up without it. Those connections post as before, and an
// attachment that is refused leaves a note on the row (xero/invoices.js).
const ATTACHMENTS_SCOPE = 'accounting.attachments';
const OAUTH_SCOPES = `${SCOPES} ${ATTACHMENTS_SCOPE}`;

module.exports = { withRetry, xeroErrMsg, _parseXeroErr, isScopeError, SCOPES, OAUTH_SCOPES, ATTACHMENTS_SCOPE };
