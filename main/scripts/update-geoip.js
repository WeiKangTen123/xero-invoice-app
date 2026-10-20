#!/usr/bin/env node
// Fetches DB-IP's free IP-location databases (city and network) into
// <data dir>/geoip/, where utils/geoip.js reads them. Run monthly by
// jobs/geoip-refresh.js; by hand:
//
//   node main/scripts/update-geoip.js
//
// DB-IP publishes each month's files early in that month, named for it
// (dbip-city-lite-2026-10.mmdb.gz). Early on the 1st this month's may not be
// up yet, so a 404 for it falls back to last month's.
//
// Each file is downloaded and unzipped into a temporary file beside the one in
// use, opened with maxmind to prove it is a database, and only then renamed
// over the old one. A rename within one folder replaces the file in one step,
// so a lookup never meets half a file, and a download that fails, is cut
// short or is not a database leaves the old file exactly as it was.
//
// The data is CC BY 4.0 (https://db-ip.com/db/lite.php): every page that
// shows a location from it says so (utils/geoip.js ATTRIBUTION).
const fs    = require('fs');
const path  = require('path');
const https = require('https');
const zlib  = require('zlib');
const { pipeline } = require('stream/promises');
const geoip = require('../utils/geoip');

const BASE_URL = 'https://download.db-ip.com/free';
// The download is about 60 MB for the city database. A connection that goes
// this long without a byte is dead, and a job waiting on it would wait for
// ever; the socket timeout ends it.
const IDLE_TIMEOUT_MS = 60 * 1000;
const MAX_REDIRECTS   = 3;

// DB-IP's name for each database, by geoip.js's.
const REMOTE_NAMES = { city: 'city', asn: 'asn' };
// What each database's metadata calls itself ("DBIP-City-Lite",
// "DBIP-ASN-Lite (compat=GeoLite2-ASN)"), so a city file can never be put in
// place of the network one or the other way round.
const EXPECTED_TYPE = { city: /city/i, asn: /asn/i };

// The months to try, newest first: this one, then the one before, in UTC.
function monthsToTry(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const label = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return [label(new Date(Date.UTC(y, m, 1))), label(new Date(Date.UTC(y, m - 1, 1)))];
}

function urlFor(kind, month) {
  return `${BASE_URL}/dbip-${REMOTE_NAMES[kind]}-lite-${month}.mmdb.gz`;
}

// A GET that answers the response stream of a 200, following a few redirects.
// Any other status is an error carrying it as err.status.
function _get(url, redirects = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'xero-invoice-app geoip updater' } }, res => {
      const status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(_get(new URL(res.headers.location, url).toString(), redirects - 1));
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(Object.assign(new Error(`${url} answered ${status}`), { status }));
        return;
      }
      resolve(res);
    });
    req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error(`${url} stopped sending for ${IDLE_TIMEOUT_MS / 1000}s`)));
    req.on('error', reject);
  });
}

// The response for the newest month DB-IP has published, with that month.
async function _download(kind, now) {
  const months = monthsToTry(now);
  for (let i = 0; i < months.length; i++) {
    try {
      return { res: await _get(urlFor(kind, months[i])), month: months[i] };
    } catch (err) {
      if (err.status === 404 && i < months.length - 1) continue;
      throw err;
    }
  }
  throw new Error(`no ${kind} database published`);
}

// Throws unless `file` opens with maxmind as a database of this kind.
async function _verify(kind, file) {
  const reader = await geoip.openDatabase(file);
  const type = reader && reader.metadata && reader.metadata.databaseType;
  if (!EXPECTED_TYPE[kind].test(String(type || ''))) {
    throw new Error(`the downloaded ${kind} file says it is "${type || 'nothing'}"`);
  }
}

// Downloads, checks and puts in place one database. Answers { kind, month,
// bytes }; throws, with the file in use untouched, when any step fails.
async function updateOne(kind, { dir = geoip.GEOIP_DIR, now = new Date() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, geoip.DATABASES[kind]);
  // Same folder as the file it replaces, so the rename is one step; not
  // ending in .mmdb, so nothing could open it as the database meanwhile.
  const tmp  = `${dest}.${process.pid}.${Date.now()}.download`;
  try {
    const { res, month } = await _download(kind, now);
    await pipeline(res, zlib.createGunzip(), fs.createWriteStream(tmp));
    await _verify(kind, tmp);
    const bytes = fs.statSync(tmp).size;
    fs.renameSync(tmp, dest);
    return { kind, month, bytes };
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* never written */ }
    throw err;
  }
}

// Both databases, each on its own: a failure of one never stops the other.
// Answers { updated: [{ kind, month, bytes }], failed: [{ kind, error }] }.
async function update({ dir = geoip.GEOIP_DIR, now = new Date(), kinds = Object.keys(geoip.DATABASES) } = {}) {
  const updated = [];
  const failed  = [];
  for (const kind of kinds) {
    try {
      updated.push(await updateOne(kind, { dir, now }));
    } catch (err) {
      failed.push({ kind, error: (err && err.message) || String(err) });
    }
  }
  return { updated, failed };
}

module.exports = { update, updateOne, monthsToTry, urlFor, BASE_URL, IDLE_TIMEOUT_MS };

if (require.main === module) {
  update().then(({ updated, failed }) => {
    for (const u of updated) console.log(`${u.kind}: ${u.month}, ${(u.bytes / 1048576).toFixed(1)} MB, in ${geoip.GEOIP_DIR}`);
    for (const f of failed) console.error(`${f.kind}: not updated (${f.error}); the file in use, if any, is unchanged`);
    console.log(geoip.ATTRIBUTION.text, geoip.ATTRIBUTION.url);
    process.exitCode = failed.length ? 1 : 0;
  });
}
