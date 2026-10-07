const { _dateFromParts, _parseISODate } = require('./periods');

// The in-memory cache and the in-flight sharing that every Xero report goes
// through.
//
// One module owns both because there must be exactly one of each. Every report
// module reads and writes this one map and binds its fetchers through this one
// _dedupe, so getPerformance asking for getBudgetVariance shares a request with
// the /budget-variance route asking for the same thing, and a disconnect clears
// every report's entries at once. Nothing here knows about Xero.
//
// Cached in-memory per user+tenant(+range), same philosophy as token-cache.js.
// Two reasons, and the second now dominates: Xero's 60-calls/minute budget is
// shared with real invoice submission, and since March 2026 Xero bills on the
// data volume of GET requests, so a dashboard nobody is actively watching is a
// line item rather than merely rude.
//
// Held at 90s while rate limiting was the only concern. Raised because these
// figures move on the order of a day, not a minute, and because the cost of
// being wrong is visible and self-correcting: the page renders "Synced Xs ago"
// from fetchedAt, and the refresh control passes force=true to bypass this
// entirely. Turn it back down here if you would rather pay for fresher numbers.
const CACHE_TTL_MS = 5 * 60 * 1000;
// The chart of accounts, bank accounts, contacts and the organisation record
// change rarely and cost a GET each; five minutes was the wrong TTL for them.
// `force` still bypasses.
const DIRECTORY_TTL_MS = 6 * 60 * 60 * 1000;
const _cache = new Map(); // arbitrary string key -> { data, fetchedAt }

// Expiry alone never freed anything: a stale entry failed the TTL check on read
// and was then left in place, so the map only ever grew. Every distinct
// user + tenant + range + report combination stayed resident with its full
// payload, on a process that runs for days at a time.
//
// Two mechanisms, because either alone leaves a hole. Dropping an entry when a
// read finds it stale costs nothing and handles anything still being looked at;
// the sweep handles what nobody reads again — a tenant disconnected, a date
// range visited once. The cap is the backstop for a burst of distinct keys
// arriving faster than they expire.
const CACHE_MAX_ENTRIES = 500;

function _isStale(entry, now) {
  return now - entry.fetchedAt >= (entry.ttl || CACHE_TTL_MS);
}

function _pruneCache() {
  const now = Date.now();
  for (const [k, v] of _cache) {
    if (_isStale(v, now)) _cache.delete(k);
  }
  if (_cache.size > CACHE_MAX_ENTRIES) {
    // Still over after dropping every stale entry: evict oldest first, which is
    // the least likely to be read again.
    const byAge = [..._cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    for (let i = 0, drop = _cache.size - CACHE_MAX_ENTRIES; i < drop; i++) _cache.delete(byAge[i][0]);
  }
}

// `noGrace`: a person asking the model to re-analyse expects a fresh answer
// however recent the last one is; the grace window is for Xero fetch chains.
function _cacheGet(key, force, { noGrace = false } = {}) {
  const cached = _cache.get(key);
  if (!cached) return null;
  // Per-entry TTL, defaulting to the short one. Report data is cheap to refetch
  // and should stay near-live; generated commentary costs an LLM call, so it
  // opts into a much longer life via _cacheSet's third argument.
  if (_isStale(cached, Date.now())) {
    _cache.delete(key);
    return null;
  }
  // A forced read is a person clicking Refresh, and several reports built on
  // one base fetch each forward it — so one click could refetch Budget-vs-
  // Actual five times. A force within the grace window of a fresh fetch
  // reuses it; only an entry older than that is bypassed.
  if (force && (noGrace || Date.now() - cached.fetchedAt > FORCE_GRACE_MS)) return null;
  return { ...cached.data, cached: true, fetchedAt: cached.fetchedAt };
}

function _cacheSet(key, data, ttl) {
  // Swept on write rather than on a timer: a timer on a module that may never be
  // used keeps a handle alive for nothing, and writes are exactly when the map
  // grows.
  if (_cache.size >= CACHE_MAX_ENTRIES) _pruneCache();
  _cache.set(key, { data, fetchedAt: Date.now(), ttl });
  return { ...data, cached: false, fetchedAt: Date.now() };
}

const FORCE_GRACE_MS = 10_000;

// Identical work in flight is shared, not repeated. The Insights page fires
// /performance, /variance-insights and /narrative together on first load, and
// each cache miss used to become its own chain of Xero GETs (and its own LLM
// call). Every cached fetcher in the report modules is bound through this, so
// callers inside them share the same in-flight promise as callers outside.
//
// Sharing only works if the same request always produces the same key, and a
// plain JSON.stringify did not: it follows property order, and the routes build
// { timezone, force, period } where the reports that call each other build
// { timezone, period, force }. Those missed each other and both went to Xero.
// So keys sort their properties and drop undefined ones (a fetcher reads an
// undefined option as its default anyway), and a fetcher that takes options can
// name its defaults: an option left out and the same option passed at its
// default are then one request, not two. The filled-in options are also what
// the fetcher receives, so the key can never describe a different request from
// the one actually run.
const _inflight = new Map();
function _canonical(v) {
  if (Array.isArray(v)) return v.map(_canonical);
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = _canonical(v[k]);
    return out;
  }
  return v;
}
// Options are the third argument of every fetcher that names defaults.
function _withDefaults(args, defaults) {
  if (!defaults) return args;
  const [userId, tenantId, opts, ...rest] = args;
  return [userId, tenantId, { ...defaults, ..._canonical(opts || {}) }, ...rest];
}
function _dedupeKey(name, args) {
  return `${name}:${JSON.stringify(_canonical(args))}`;
}
function _dedupe(name, fn, defaults = null) {
  return function deduped(...given) {
    const args = _withDefaults(given, defaults);
    const key = _dedupeKey(name, args);
    let p = _inflight.get(key);
    if (!p) {
      p = Promise.resolve().then(() => fn.apply(this, args)).finally(() => _inflight.delete(key));
      _inflight.set(key, p);
    }
    return p;
  };
}

// How long a fetched period stays cached. A period that has already closed is
// effectively immutable — re-fetching Apr 2025 every 90 seconds is pure waste —
// but "closed" is not the same as "settled": late invoices and adjustments land
// during month-end, so a recently-ended period gets a short life rather than a
// long one. Anything still in progress keeps the original short TTL.
//
// Nothing here is ever a substitute for correctness: the Refresh button always
// forces, and the key includes the exact month span.
const TTL_OPEN_MS   = CACHE_TTL_MS;          // period includes the current month
const TTL_RECENT_MS = 10 * 60 * 1000;        // closed, but within the back-dating window
const TTL_CLOSED_MS = 6 * 60 * 60 * 1000;    // closed long enough to be settled
const BACKDATE_WINDOW_DAYS = 35;             // one month-end close, plus slack

function _periodCacheTtl(months, today) {
  if (!months?.length) return TTL_OPEN_MS;
  const end = _parseISODate(months[months.length - 1].endISO);
  if (!end) return TTL_OPEN_MS;
  const days = (_dateFromParts(today) - _dateFromParts(end)) / 86400000;
  if (days <= 0) return TTL_OPEN_MS;                       // still running, or in the future
  return days < BACKDATE_WINDOW_DAYS ? TTL_RECENT_MS : TTL_CLOSED_MS;
}

// Called on disconnect so nothing here can outlive the connection it came from.
function clearCache(userId) {
  for (const key of _cache.keys()) {
    if (key.includes(`:${userId}:`)) _cache.delete(key);
  }
}

module.exports = {
  CACHE_TTL_MS, DIRECTORY_TTL_MS, CACHE_MAX_ENTRIES, FORCE_GRACE_MS, _cache,
  _pruneCache, _cacheGet, _cacheSet, _canonical, _dedupeKey, _dedupe,
  TTL_OPEN_MS, TTL_RECENT_MS, TTL_CLOSED_MS, _periodCacheTtl, clearCache,
};
