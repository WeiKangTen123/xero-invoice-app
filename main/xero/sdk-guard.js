const axios  = require('axios');
const logger = require('../utils/logger');

// Two defects in xero-node 7.0.0 that together let one dropped connection
// take the whole server down. Loaded by xero-utils.js, which every Xero module
// requires, so both are in place before the first call is made.
//
// 1. Every SDK method catches the axios failure and builds an ApiError from it,
//    and ApiError reads error.response.status with no check that a response
//    exists. On a network failure (ECONNRESET, ECONNREFUSED, DNS, timeout)
//    there is none, so the constructor throws inside the SDK's catch block.
//    That catch runs in an async function wrapped in `new Promise(...)`, so the
//    promise the app is awaiting never settles, and the throw escapes as an
//    unhandled rejection — which index.js treats as fatal and exits on.
//
// 2. The SDK sets no request timeout, so a Xero call that connects but never
//    answers holds the request (and any queue job behind it) forever.

const TIMEOUT_MS = 60_000;

// Read at request time rather than captured at load, so the test can shorten
// it without waiting a real minute.
const settings = { timeoutMs: TIMEOUT_MS };

const GUARDED = Symbol.for('xero-invoice-app.sdk-guard');

// ── 1. ApiError that tolerates a missing response ───────────────────────────
//
// Replacing the export works because the generated API classes never hold a
// reference to the class itself: each one keeps the module object
// (`const ApiError_1 = require("../../model/ApiError")`) and looks the class
// up at the moment of failure (`new ApiError_1.ApiError(error)`). Node caches
// that module object, so swapping its ApiError property here changes what
// every Accounting/Files/Payroll/... method constructs from then on.
//
// XeroClient's own token and /connections calls do not use ApiError (they
// reject with the raw axios error), so they were never exposed to this; the
// app does not use XeroClient in any case.
function installApiErrorGuard() {
  let mod;
  try {
    mod = require('xero-node/dist/model/ApiError');
  } catch (err) {
    logger.warn('xero-node ApiError module not found — network errors from the SDK are unguarded', { error: err.message });
    return;
  }
  const Original = mod.ApiError;
  if (typeof Original !== 'function') {
    logger.warn('xero-node ApiError export changed shape — network errors from the SDK are unguarded');
    return;
  }
  if (Original[GUARDED]) return;

  class SafeApiError extends Original {
    constructor(error) {
      const err = (error && typeof error === 'object') ? error : {};
      const hasResponse = !!(err.response && typeof err.response === 'object');
      const hasRequest  = !!(err.request && typeof err.request.getHeaders === 'function');
      // An ordinary HTTP failure goes through the SDK's own constructor
      // untouched. Anything else gets a stand-in with an empty response and
      // request, inheriting from the real error so any other field the SDK
      // reads is still there.
      super(hasResponse && hasRequest ? err : withDefaults(err, hasResponse, hasRequest));

      if (!hasResponse) {
        // Kept so the rejection still says what went wrong; without them the
        // serialised error is an empty shell and the user sees nothing useful.
        this.message = typeof err.message === 'string' ? err.message : String(error);
        this.code    = err.code || null;
      }

      // The SDK copies the outgoing headers, bearer token included, into the
      // error it serialises — and that string is what gets logged, and what
      // xeroErrMsg falls back to showing when Xero sends no message of its own.
      const headers = this.request && this.request.headers;
      if (headers && typeof headers === 'object') {
        for (const key of Object.keys(headers)) {
          if (/^authorization$/i.test(key)) headers[key] = '[redacted]';
        }
      }
    }

    generateError() {
      const out = super.generateError();
      if (this.statusCode === undefined) {
        // The SDK JSON-stringifies this object as the rejection, so the
        // message and code have to travel inside it for xeroErrMsg to find.
        out.message = this.message;
        out.code    = this.code;
      }
      return out;
    }
  }
  SafeApiError[GUARDED] = true;
  SafeApiError.Original = Original;

  mod.ApiError = SafeApiError;
}

function withDefaults(err, hasResponse, hasRequest) {
  const shim = Object.create(err);
  if (!hasResponse) shim.response = { status: undefined, data: undefined, headers: {} };
  if (!hasRequest) {
    const r = (err.request && typeof err.request === 'object') ? err.request : {};
    shim.request = {
      protocol: r.protocol, agent: r.agent, socket: r.socket,
      host: r.host, path: r.path, method: r.method,
      getHeaders: () => ({}),
    };
  }
  return shim;
}

// ── 2. Timeout on Xero requests only ────────────────────────────────────────
//
// xero-node has no axios of its own; it calls the same root axios instance as
// the Gemini client, which sets its own longer timeout for slow extractions.
// So this is not a change to axios.defaults: it is an interceptor that runs
// only for requests to a xero.com host or carrying the SDK's user-agent, and
// only fills in a timeout when the caller set none (the OAuth calls in
// connect.js and oauth.js keep their 10s). `synchronous: true` with runWhen
// means every other request goes through axios exactly as before.
//
// With axios's default transport this limit runs from the moment a socket is
// assigned until response headers arrive — DNS, connect, upload and Xero's
// processing included — and then applies as an idle limit while the body
// streams.
function isXeroRequest(config) {
  if (!config) return false;
  const h  = config.headers;
  const ua = h && (typeof h.get === 'function' ? h.get('user-agent') : (h['user-agent'] || h['User-Agent']));
  if (typeof ua === 'string' && /^xero-node/i.test(ua)) return true;
  try {
    const { hostname } = new URL(config.url, config.baseURL || undefined);
    return /(^|\.)xero\.com$/i.test(hostname);
  } catch (_) {
    return false;
  }
}

function applyTimeout(config) {
  if (!config.timeout) config.timeout = settings.timeoutMs;
  return config;
}

function installTimeout() {
  const interceptors = axios && axios.interceptors && axios.interceptors.request;
  // A test that replaces axios with a bare mock has no interceptors to attach to.
  if (!interceptors || typeof interceptors.use !== 'function') return;
  if (axios[GUARDED]) return;
  interceptors.use(applyTimeout, null, { synchronous: true, runWhen: isXeroRequest });
  axios[GUARDED] = true;
}

installApiErrorGuard();
installTimeout();

module.exports = { settings, isXeroRequest, TIMEOUT_MS };
