// Where an IP address is, from DB-IP's free "Lite" databases kept on this
// server: the city and the network (the company that owns the address), so an
// admin reading an account's sign-ins can tell "Singapore · Singtel" from a
// datacentre on the other side of the world. Offline on purpose: an address
// looked up with an online service is an address handed to that service, and
// a lookup must never wait on someone else's server.
//
// The two files live in <data dir>/geoip/ and are fetched once a month by
// scripts/update-geoip.js (run by jobs/geoip-refresh.js, or by hand). Until
// they have been fetched every lookup answers null, and the pages that show a
// location show none; nothing else depends on them.
//
// DB-IP's Lite data is CC BY 4.0: wherever a location from it is shown, the
// page must say where it came from. ATTRIBUTION is that line.
//
// Lookups are synchronous, so a caller can map a list of addresses in one
// pass. A lookup never reads a file: the city database is about 130 MB, and
// reading it in one go on a request would stall every other request on the
// server while it loaded. Call `await ready()` first; it opens (or reopens,
// when the update has replaced a file) whatever needs it, off the main thread.
// A lookup made without it answers from whatever is already open and starts
// the open in the background.
//
// What is open is dropped again after IDLE_MS without a lookup: the only page
// that shows locations is opened now and then, and 130 MB is a lot to hold
// for it on a small server.
const fs     = require('fs');
const net    = require('net');
const path   = require('path');
const logger = require('./logger');
const { DATA_DIR } = require('./paths');

const GEOIP_DIR = path.join(DATA_DIR, 'geoip');
const DATABASES = Object.freeze({ city: 'dbip-city-lite.mmdb', asn: 'dbip-asn-lite.mmdb' });

const ATTRIBUTION = Object.freeze({ text: 'IP Geolocation by DB-IP', url: 'https://db-ip.com' });

// How often a lookup looks at the files for a newer copy, and how long an
// open database is kept without being used.
const RECHECK_MS = 60 * 1000;
const IDLE_MS    = 10 * 60 * 1000;

// kind -> { reader, mtimeMs, size, checkedAt } for each open database.
const _open    = new Map();
// kind -> the open in progress, so two requests never read the file twice.
const _loading = new Map();
// kind -> "mtime:size" of a file that would not open, so a broken file is
// warned about once and not on every request.
const _failed  = new Map();
let _lastUsed  = 0;
let _idleTimer = null;

const fileFor = kind => path.join(GEOIP_DIR, DATABASES[kind]);

function _stat(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? st : null;
  } catch (_) {
    return null;
  }
}

const _version = st => `${st.mtimeMs}:${st.size}`;

// Opens one database file with maxmind and answers its reader. Throws when the
// file is not a database maxmind can read. The update script checks a fresh
// download with this before it replaces the file in use.
async function openDatabase(file) {
  return require('maxmind').open(file);
}

// The idle drop: one timer, unref'd so it never keeps the process alive,
// rearmed for whatever is left of the idle time when it fires early.
function _armIdle() {
  if (_idleTimer) return;
  const wait = Math.max(1000, _lastUsed + IDLE_MS - Date.now());
  _idleTimer = setTimeout(() => {
    _idleTimer = null;
    if (!_open.size) return;
    if (Date.now() - _lastUsed >= IDLE_MS) _open.clear();
    else _armIdle();
  }, wait);
  if (typeof _idleTimer.unref === 'function') _idleTimer.unref();
}

// Opens `kind` if its file is there and not already open as it is now on disk.
// Never rejects: a file that will not open leaves whatever was open before.
function _load(kind) {
  if (_loading.has(kind)) return _loading.get(kind);
  const file = fileFor(kind);
  const st   = _stat(file);
  const have = _open.get(kind);
  if (!st) {
    _open.delete(kind);
    return Promise.resolve();
  }
  if (have && _version(have) === _version(st)) {
    have.checkedAt = Date.now();
    return Promise.resolve();
  }
  if (_failed.get(kind) === _version(st)) return Promise.resolve();
  const p = openDatabase(file)
    .then(reader => {
      _open.set(kind, { reader, mtimeMs: st.mtimeMs, size: st.size, checkedAt: Date.now() });
      _failed.delete(kind);
      _lastUsed = Date.now();
      _armIdle();
    })
    .catch(err => {
      _failed.set(kind, _version(st));
      logger.warn('IP location database could not be opened', { file: DATABASES[kind], error: err && err.message });
    })
    .finally(() => { _loading.delete(kind); });
  _loading.set(kind, p);
  return p;
}

// Opens both databases if they need it (first use, or a file replaced since).
// Resolves when done; never rejects. Missing files are not an error.
function ready() {
  _lastUsed = Date.now();
  return Promise.all(Object.keys(DATABASES).map(_load)).then(() => undefined);
}

// Started from a lookup: open what is not open, or look for a newer file once
// a minute. In the background; this lookup answers from what is open now.
function _refreshInBackground(now) {
  for (const kind of Object.keys(DATABASES)) {
    const have = _open.get(kind);
    if (!have || now - have.checkedAt >= RECHECK_MS) {
      if (have) have.checkedAt = now;
      _load(kind);
    }
  }
}

// ── Addresses ────────────────────────────────────────────────────────────────

// The address in the form it is looked up in, or null when it is not one: no
// brackets or zone, IPv6 written the one canonical way, and an IPv4 address
// carried inside IPv6 (::ffff:1.2.3.4, as Node reports IPv4 clients on a dual-
// stack socket, or ::ffff:102:304) as the IPv4 address it is.
function normalizeIp(ip) {
  let s = String(ip ?? '').trim();
  if (!s) return null;
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    s = s.slice(1, end > 0 ? end : undefined);
  }
  const zone = s.indexOf('%');
  if (zone > 0) s = s.slice(0, zone);
  const kind = net.isIP(s);
  if (kind === 4) return s;
  if (kind !== 6) return null;
  // The URL parser writes IPv6 the canonical way: lower case, zeros compressed.
  try { s = new URL(`http://[${s}]/`).hostname.slice(1, -1); } catch (_) { return null; }
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted && net.isIPv4(dotted[1])) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
  }
  return s;
}

// Addresses that name no place: this machine, a home or office network, a
// carrier's shared NAT range, and self-assigned link-local addresses.
function _privateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}
function _privateV6(ip) {
  if (ip === '::' || ip === '::1') return true;
  const first = ip.startsWith('::') ? 0 : parseInt(ip.split(':')[0], 16);
  return (first & 0xfe00) === 0xfc00     // fc00::/7, unique local
    || (first & 0xffc0) === 0xfe80;      // fe80::/10, link-local
}

function isPrivateIp(ip) {
  const s = normalizeIp(ip);
  if (!s) return false;
  return net.isIPv4(s) ? _privateV4(s) : _privateV6(s);
}

// ── Lookups ──────────────────────────────────────────────────────────────────

const _name = o => (o && o.names && (o.names.en || Object.values(o.names)[0])) || null;

function _get(kind, ip) {
  const have = _open.get(kind);
  if (!have) return null;
  try { return have.reader.get(ip) || null; } catch (_) { return null; }
}

/**
 * Where `ip` is: { city, region, country, countryCode, org } (any of them
 * null when the database does not say), { private: true } for a loopback,
 * private or link-local address, or null when the address is not one, the
 * databases are not open (see ready()), or neither knows it.
 */
function lookupIp(ip) {
  const s = normalizeIp(ip);
  if (!s) return null;
  if (net.isIPv4(s) ? _privateV4(s) : _privateV6(s)) return { private: true };
  const now = Date.now();
  _lastUsed = now;
  _refreshInBackground(now);
  const place = _get('city', s);
  const asn   = _get('asn', s);
  if (!place && !asn) return null;
  return {
    city:        _name(place && place.city),
    region:      _name(place && place.subdivisions && place.subdivisions[0]),
    country:     _name(place && place.country),
    countryCode: (place && place.country && place.country.iso_code) || null,
    org:         (asn && asn.autonomous_system_organization) || null,
  };
}

// A network's name without the company-registration tail, which is most of
// it on a small screen: "Singapore Telecommunications Ltd" reads as
// "Singapore Telecommunications".
const COMPANY_SUFFIX = /[\s,]+(?:pte\.?|ltd\.?|limited|inc\.?|llc|l\.l\.c\.|sdn\.?\s*bhd\.?|bhd\.?|co\.?|corp\.?|corporation|gmbh|plc|pty\.?|s\.?a\.?|b\.?v\.?)$/i;
function _shortOrg(org) {
  let s = String(org || '').trim();
  for (let i = 0; i < 4 && COMPANY_SUFFIX.test(s); i++) s = s.replace(COMPANY_SUFFIX, '').trim();
  return s || String(org || '').trim();
}

// A city-state, which DB-IP names by its district: "Singapore (Geylang)" in
// Singapore is Singapore. A district from an IP address is a guess anyway.
function _cityState(city, country) {
  const c = city.toLowerCase();
  const n = country.toLowerCase();
  return c === n || c.startsWith(`${n} (`);
}

/**
 * One line for a lookup's answer: "Kuala Lumpur, Malaysia · Maxis",
 * "Singapore · Singtel" (a city-state is named once), "Private network", or
 * "" when there is nothing to say.
 */
function locationLabel(geo) {
  if (!geo) return '';
  if (geo.private) return 'Private network';
  let place = geo.city || geo.country || '';
  if (geo.city && geo.country) place = _cityState(geo.city, geo.country) ? geo.country : `${geo.city}, ${geo.country}`;
  return [place, geo.org ? _shortOrg(geo.org) : ''].filter(Boolean).join(' · ');
}

// Whether each database file is there, and when it was written, for the
// refresh job. { city: Date|null, asn: Date|null }.
function databaseDates() {
  const out = {};
  for (const kind of Object.keys(DATABASES)) {
    const st = _stat(fileFor(kind));
    out[kind] = st ? st.mtime : null;
  }
  return out;
}

// For tests: forget everything open, as a fresh process would.
function _reset() {
  _open.clear();
  _loading.clear();
  _failed.clear();
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = null;
  _lastUsed = 0;
}

module.exports = {
  lookupIp, locationLabel, ready, normalizeIp, isPrivateIp, openDatabase, databaseDates, fileFor,
  ATTRIBUTION, GEOIP_DIR, DATABASES, RECHECK_MS, IDLE_MS, _reset,
};
