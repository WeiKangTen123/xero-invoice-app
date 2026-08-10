const logger = require('../utils/logger');

/**
 * Retry wrapper for Xero API calls.
 * Handles 429 rate-limit responses using Retry-After header when available,
 * falling back to exponential backoff.
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
 * xero-node v7 throws errors where the full HTTP response is JSON-stringified
 * into err.message rather than populating err.response. Parse it out.
 * Returns { status, body } — body is always a plain object (or null).
 */
function _parseXeroErr(err) {
  let parsed = null;
  if (err?.message && typeof err.message === 'string') {
    try { parsed = JSON.parse(err.message); } catch (_) {}
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
  return { status, body, retryAfter, wwwAuthenticate };
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
  const { status, body } = _parseXeroErr(err);
  if (status === 429) return 'Xero rate limit exceeded — try again in a minute';
  return (
    body?.Elements?.[0]?.ValidationErrors?.[0]?.Message ||
    body?.Detail   ||
    body?.Message  ||
    err?.message   ||
    String(err)
  );
}

module.exports = { withRetry, xeroErrMsg, _parseXeroErr, isScopeError };
