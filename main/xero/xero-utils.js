const axios  = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');
// Every Xero module requires this file, so loading the guard here puts the
// SDK's network-error fix and request timeout in place before any call.
const { isXeroRequest } = require('./sdk-guard');

// ── Xero's rate limits ───────────────────────────────────────────────────────
//
// Counted per organisation, per Xero app: 60 calls a minute, 5 at a time, and
// a daily allowance that depends on when the app was created — 5,000 calls a
// day for an app created before 2 March 2026, 1,000 for one created after.
// Every user here registers their own Xero app, so anyone who set theirs up
// recently is on the 1,000 tier and can spend a day's allowance in an
// afternoon of reports. On top of those, one app gets 10,000 calls a minute
// across all of its organisations.
//
// Xero reports what is left on every response (X-DayLimit-Remaining,
// X-MinLimit-Remaining, X-AppMinLimit-Remaining) and, on a 429, which limit
// was hit (X-Rate-Limit-Problem: day, minute, appminute or concurrent) with a
// Retry-After in seconds.

// The longest withRetry will wait before trying again. A minute limit clears
// within a minute; a Retry-After longer than that is the daily limit or
// something like it, and holding a request, a queue job or a bulk post for
// hours behind it looks exactly like a hang.
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

/**
 * Retry wrapper for Xero API calls.
 * Retries a 429 that clears within a minute (the per-minute, app-wide or
 * concurrent limit), waiting what Retry-After says up to MAX_RATE_LIMIT_WAIT_MS,
 * or exponential backoff when it says nothing. A 429 for the DAILY limit fails
 * at once with a message saying when it resets: nothing sent before then can
 * succeed, and the old uncapped wait parked posting for hours.
 *
 * Network failures and timeouts are deliberately not retried. A reset or a
 * timed-out write may already have landed in Xero, so repeating it risks a
 * duplicate invoice; and five attempts behind a 60-second timeout would hold
 * the caller for five minutes. They fail once, with xeroErrMsg's message.
 * Nor is a connection Xero no longer accepts (XeroReconnectError): only a
 * person reconnecting can fix that.
 */
async function withRetry(fn, retries = 5, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const parsed = _parseXeroErr(err);
      if (parsed.status !== 429) throw err;

      _recordRateLimit(parsed.tenantId, parsed.headers);
      if (_isDayLimit(parsed)) {
        const dayErr = _dailyLimitError(parsed, err);
        logger.warn('Xero daily limit reached — failing now instead of waiting', { tenantId: parsed.tenantId, resetAt: dayErr.resetAt });
        throw dayErr;
      }
      if (attempt >= retries) throw err;

      const retryAfterMs = _retryAfterSeconds(parsed) * 1000;
      const wait = Math.min(retryAfterMs || delayMs * Math.pow(2, attempt - 1), MAX_RATE_LIMIT_WAIT_MS);
      logger.warn(`Xero rate limited — retrying in ${Math.round(wait / 1000)}s`, {
        attempt, retries, problem: parsed.rateLimitProblem, tenantId: parsed.tenantId,
      });
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// A header from a plain object (any case) or an AxiosHeaders instance.
function _header(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  if (typeof headers.get === 'function') {
    try {
      const v = headers.get(name);
      if (v !== undefined && v !== null) return v;
    } catch (_) { /* not an AxiosHeaders after all */ }
  }
  const want = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === want && headers[key] !== undefined && headers[key] !== null) return headers[key];
  }
  return null;
}

function _firstHeader(sources, name) {
  for (const h of sources) {
    const v = _header(h, name);
    if (v !== null) return v;
  }
  return null;
}

function _intOrNull(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * xero-node throws the full HTTP response JSON-stringified — confirmed live
 * that for at least some calls (getPayments) the thrown value is a raw
 * string itself (typeof err === 'string', not an Error, no .message at
 * all), not "an Error object whose .message holds the JSON" as this used to
 * assume. A raw string has no .message property, so that assumption meant
 * this never even attempted to parse it — every error of that shape fell
 * through to a raw JSON dump instead of a real message. Handles both shapes.
 * Returns { status, body, ... } — body is always a plain object (or null).
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
  // The SDK's serialised error, an axios error, or a hand-built one: the
  // response headers can sit in any of these.
  const headerSources = [parsed?.response?.headers, err?.response?.headers, err?.headers];
  const headers = headerSources.find(h => h && typeof h === 'object') || null;
  const retryAfter      = _firstHeader(headerSources, 'retry-after');
  const wwwAuthenticate = _firstHeader(headerSources, 'www-authenticate');
  const problem         = _firstHeader(headerSources, 'x-rate-limit-problem');
  // Which organisation the call was for: the SDK copies the outgoing headers
  // into its error, and an axios error keeps its request config.
  const tenantId = _firstHeader([
    parsed?.response?.request?.headers, err?.response?.request?.headers, err?.config?.headers,
  ], 'xero-tenant-id') || (typeof err?.tenantId === 'string' ? err.tenantId : null);
  // Only a failure with no HTTP response has these: sdk-guard.js carries the
  // socket error's code and message inside the SDK's serialised rejection, and
  // a direct axios call leaves them on the error itself.
  const code = (typeof parsed?.code === 'string' && parsed.code)
    || (typeof err?.code === 'string' && err.code) || null;
  const message = (typeof parsed?.message === 'string' && parsed.message) || null;
  return {
    status, body, retryAfter, wwwAuthenticate, code, message, headers, tenantId,
    rateLimitProblem:  problem ? String(problem).toLowerCase() : null,
    dayLimitRemaining: _intOrNull(_firstHeader(headerSources, 'x-daylimit-remaining')),
    minLimitRemaining: _intOrNull(_firstHeader(headerSources, 'x-minlimit-remaining')),
  };
}

function _retryAfterSeconds(parsed) {
  const s = _intOrNull(parsed.retryAfter);
  return s && s > 0 ? s : 0;
}

// Xero names the limit it hit; a 429 that does not say, with no calls left
// for the day, is treated as the daily one too.
function _isDayLimit(parsed) {
  if (parsed.rateLimitProblem) return parsed.rateLimitProblem === 'day';
  return parsed.dayLimitRemaining === 0;
}

// ── Remaining daily budget, per organisation ────────────────────────────────
//
// Kept from the headers of every Xero response (see the axios interceptor
// below), so how much of the day's allowance is left can be reported without
// spending a call to find out. In memory: a restart forgets it until the next
// call, which says again.
const _budgets = new Map(); // tenantId -> { dayRemaining, minuteRemaining, appMinuteRemaining, dayLimitHit, resetAt, updatedAt }

function _recordRateLimit(tenantId, headers, now = Date.now()) {
  if (!tenantId || !headers) return;
  const day     = _intOrNull(_header(headers, 'x-daylimit-remaining'));
  const minute  = _intOrNull(_header(headers, 'x-minlimit-remaining'));
  const appMin  = _intOrNull(_header(headers, 'x-appminlimit-remaining'));
  const problem = _header(headers, 'x-rate-limit-problem');
  const dayHit  = problem ? String(problem).toLowerCase() === 'day' : false;
  if (day === null && minute === null && appMin === null && !dayHit) return;

  const prev = _budgets.get(tenantId) || {};
  const retryAfter = _intOrNull(_header(headers, 'retry-after'));
  const dayRemaining = dayHit ? 0 : (day ?? prev.dayRemaining ?? null);
  _budgets.set(tenantId, {
    dayRemaining,
    minuteRemaining:    minute ?? prev.minuteRemaining ?? null,
    appMinuteRemaining: appMin ?? prev.appMinuteRemaining ?? null,
    dayLimitHit:        dayRemaining === 0,
    // Only a 429 says when the day comes back; a later call with calls left
    // means it already has.
    resetAt:            dayHit && retryAfter > 0 ? new Date(now + retryAfter * 1000).toISOString()
                        : (dayRemaining === 0 ? prev.resetAt || null : null),
    updatedAt:          new Date(now).toISOString(),
  });
}

/** What is left of this organisation's Xero allowance, as Xero last reported it, or null. */
function getRateLimitBudget(tenantId) {
  const b = _budgets.get(tenantId);
  return b ? { ...b } : null;
}

// Every Xero response passes through here, success or failure, so the budget
// is current whichever module made the call and whether or not it went
// through withRetry. xero-node uses the shared axios instance (sdk-guard.js);
// only responses from Xero that name an organisation are recorded.
const RECORDER = Symbol.for('xero-invoice-app.rate-limit-recorder');
function _recordFromResponse(response) {
  try {
    if (!response || !isXeroRequest(response.config)) return;
    const tenantId = _header(response.config && response.config.headers, 'xero-tenant-id');
    _recordRateLimit(tenantId, response.headers);
  } catch (_) { /* reporting must never break a call */ }
}
function _installRecorder() {
  const interceptors = axios && axios.interceptors && axios.interceptors.response;
  // A test that replaces axios with a bare mock has no interceptors to attach to.
  if (!interceptors || typeof interceptors.use !== 'function') return;
  if (axios[RECORDER]) return;
  interceptors.use(
    res => { _recordFromResponse(res); return res; },
    err => { _recordFromResponse(err && err.response); return Promise.reject(err); },
  );
  axios[RECORDER] = true;
}
_installRecorder();

// When the daily allowance comes back, in words a person can act on.
function _dailyLimitMsg(resetAt, now = Date.now()) {
  if (!resetAt) {
    return "Xero's daily limit for this organisation is used up; it resets within 24 hours. Try again after that.";
  }
  const mins = Math.max(1, Math.round(Math.max(0, resetAt.getTime() - now) / 60_000));
  const when = mins < 90 ? `in about ${mins} minute${mins === 1 ? '' : 's'}` : `in about ${Math.round(mins / 60)} hours`;
  const at   = resetAt.toISOString().slice(0, 16).replace('T', ' ');
  return `Xero's daily limit for this organisation is used up; it resets at ${at} UTC (${when}). Try again after that.`;
}

function _dailyLimitError(parsed, cause) {
  const seconds = _retryAfterSeconds(parsed);
  const resetAt = seconds ? new Date(Date.now() + seconds * 1000) : null;
  const err = new Error(_dailyLimitMsg(resetAt));
  err.name             = 'XeroDailyLimitError';
  err.code             = 'XERO_DAILY_LIMIT';
  err.statusCode       = 429;
  err.rateLimitProblem = 'day';
  err.resetAt          = resetAt ? resetAt.toISOString() : null;
  err.tenantId         = parsed.tenantId || null;
  err.cause            = cause;
  return err;
}

// ── A connection Xero no longer accepts ─────────────────────────────────────
//
// Xero's token endpoint answers 400 with an OAuth error code. invalid_grant
// means the refresh token is dead — revoked by the user or an admin, or
// expired after 60 days without a refresh — and no retry can bring it back.
// invalid_client / unauthorized_client mean the app's own Client ID or Secret
// was refused. Before this they surfaced as "Request failed with status code
// 400", and every request tried the dead token again.
const CREDENTIALS_REFUSED = "Xero refused this app's Client ID or Secret. Check them in Setup, then connect again.";
const RECONNECT_REASONS = {
  invalid_grant:       'Xero no longer accepts this connection: it was revoked, or it went 60 days without being used. Reconnect Xero in Setup.',
  invalid_client:      CREDENTIALS_REFUSED,
  unauthorized_client: CREDENTIALS_REFUSED,
};
const DEFAULT_RECONNECT_REASON = 'Xero no longer accepts this connection. Reconnect Xero in Setup.';

class XeroReconnectError extends Error {
  constructor(reason, { cause = null, oauthError = null } = {}) {
    super(reason || DEFAULT_RECONNECT_REASON);
    this.name           = 'XeroReconnectError';
    this.code           = 'XERO_RECONNECT_REQUIRED';
    this.needsReconnect = true;
    this.reason         = this.message;
    this.oauthError     = oauthError;
    if (cause) this.cause = cause;
  }
}

// The OAuth error code from a failed call to Xero's identity server, or null.
function tokenErrorCode(err) {
  let data = err?.response?.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (_) { data = null; }
  }
  return data && typeof data.error === 'string' ? data.error : null;
}

/** The plain-language reason a token request failure needs a person to reconnect, or null when it does not. */
function reconnectReason(err) {
  const code = tokenErrorCode(err);
  return (code && RECONNECT_REASONS[code]) || null;
}

function isReconnectError(err) {
  return !!(err && typeof err === 'object' && (err.needsReconnect === true || err.code === 'XERO_RECONNECT_REQUIRED'));
}

// Which credentials a refusal was for: a short one-way digest of the client
// id, secret and (for OAuth) refresh token. A connection marked as refused is
// tried again once any of them changes — a new secret saved in Setup, or a
// new refresh token from reconnecting — without anything having to clear the
// mark by hand. The digest cannot be turned back into any of them.
function credentialFingerprint(...parts) {
  // A JSON array, not a joined string, so no secret containing the separator
  // can make two different sets of credentials look alike.
  return crypto.createHash('sha256').update(JSON.stringify(parts.map(p => String(p ?? '')))).digest('hex').slice(0, 16);
}

// The scopes Xero granted, from a token response: its `scope` field, or the
// `scope` claim inside the access token. Null when neither says.
function grantedScopesFrom(data) {
  if (typeof data?.scope === 'string' && data.scope.trim()) return data.scope.trim().split(/\s+/);
  try {
    const payload = String(data?.access_token || '').split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (Array.isArray(claims.scope)) return claims.scope.map(String);
    if (typeof claims.scope === 'string') return claims.scope.split(/\s+/).filter(Boolean);
  } catch (_) { /* not a JWT we can read */ }
  return null;
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
  // Already written for a person: a connection to reconnect, or the daily limit.
  if (isReconnectError(err) || err?.code === 'XERO_DAILY_LIMIT') return err.message;
  const reason = reconnectReason(err);
  if (reason) return reason;
  const parsed = _parseXeroErr(err);
  const { status, body } = parsed;
  if (status === 429) {
    if (_isDayLimit(parsed)) {
      const seconds = _retryAfterSeconds(parsed);
      return _dailyLimitMsg(seconds ? new Date(Date.now() + seconds * 1000) : null);
    }
    return 'Xero rate limit exceeded — try again in a minute';
  }
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

module.exports = {
  withRetry, xeroErrMsg, _parseXeroErr, isScopeError, SCOPES, OAUTH_SCOPES, ATTACHMENTS_SCOPE,
  XeroReconnectError, reconnectReason, tokenErrorCode, isReconnectError, credentialFingerprint, grantedScopesFrom,
  getRateLimitBudget, MAX_RATE_LIMIT_WAIT_MS, DEFAULT_RECONNECT_REASON,
  _recordRateLimit, _recordFromResponse, _dailyLimitMsg,
};
