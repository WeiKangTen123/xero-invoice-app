// The monthly fetch of DB-IP's databases. Nothing here reaches DB-IP: https.get
// is replaced by a table of URLs and what each answers, and maxmind by a
// reader that says which database a file is from its contents ("CITY ..." or
// "ASN ..."), so the steps around them run for real: the month fallback, the
// gunzip into a temporary file, the check, the rename, and the cleanup when a
// step fails.
jest.mock('maxmind', () => ({ open: jest.fn() }));

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const zlib  = require('zlib');
const { Readable } = require('stream');
const { EventEmitter } = require('events');

const NOW = new Date('2026-10-20T06:00:00Z');
const URL_FOR = (kind, month) => `https://download.db-ip.com/free/dbip-${kind}-lite-${month}.mmdb.gz`;

describe('scripts/update-geoip', () => {
  let update, geoip, maxmind, routes, requested, renames;

  // url -> { status, body (bytes, gzipped for you unless raw), location }
  function serve(table) {
    routes = table;
    requested = [];
    jest.spyOn(https, 'get').mockImplementation((url, opts, cb) => {
      requested.push(url);
      const req = new EventEmitter();
      req.setTimeout = jest.fn();
      req.destroy = err => req.emit('error', err);
      const route = routes[url] || { status: 404 };
      process.nextTick(() => {
        if (route.error) return req.emit('error', route.error);
        const body = route.body === undefined ? Buffer.alloc(0) : (route.raw ? route.body : zlib.gzipSync(route.body));
        const res = Readable.from([body]);
        res.statusCode = route.status || 200;
        res.headers = route.location ? { location: route.location } : {};
        cb(res);
      });
      return req;
    });
  }

  const files = () => (fs.existsSync(geoip.GEOIP_DIR) ? fs.readdirSync(geoip.GEOIP_DIR).sort() : []);
  const read = kind => fs.readFileSync(geoip.fileFor(kind), 'utf8');
  const put = (kind, text) => { fs.mkdirSync(geoip.GEOIP_DIR, { recursive: true }); fs.writeFileSync(geoip.fileFor(kind), text); };

  beforeEach(() => {
    jest.resetModules();
    maxmind = require('maxmind');
    maxmind.open.mockReset();
    // What the file says it is, as a database's metadata would; "BROKEN" is
    // no database at all. Records what the file in use held at that moment.
    maxmind.open.mockImplementation(async file => {
      const text = fs.readFileSync(file, 'utf8');
      if (text.startsWith('BROKEN')) throw new Error('Unknown type NaN at offset 1');
      const dest = Object.keys(geoip.DATABASES).map(geoip.fileFor).find(f => file.startsWith(f));
      maxmind.open.inUseAtCheck = dest && fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
      return { metadata: { databaseType: text.startsWith('CITY') ? 'DBIP-City-Lite' : text.startsWith('ASN') ? 'DBIP-ASN-Lite (compat=GeoLite2-ASN)' : 'Something-Else' } };
    });
    geoip  = require('../utils/geoip');
    update = require('./update-geoip');
    fs.rmSync(geoip.GEOIP_DIR, { recursive: true, force: true });
    renames = [];
    const realRename = fs.renameSync;
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => { renames.push([from, to]); return realRename(from, to); });
  });

  afterEach(() => { jest.restoreAllMocks(); });

  test('the months tried: this one, then the one before, across a year end', () => {
    expect(update.monthsToTry(NOW)).toEqual(['2026-10', '2026-09']);
    expect(update.monthsToTry(new Date('2027-01-01T00:30:00Z'))).toEqual(['2027-01', '2026-12']);
    expect(update.urlFor('city', '2026-10')).toBe(URL_FOR('city', '2026-10'));
    expect(update.urlFor('asn', '2026-10')).toBe(URL_FOR('asn', '2026-10'));
  });

  test("this month's files are fetched, unzipped, checked and put in place", async () => {
    serve({
      [URL_FOR('city', '2026-10')]: { body: 'CITY october' },
      [URL_FOR('asn', '2026-10')]:  { body: 'ASN october' },
    });
    const result = await update.update({ now: NOW });
    expect(result).toEqual({
      updated: [{ kind: 'city', month: '2026-10', bytes: 12 }, { kind: 'asn', month: '2026-10', bytes: 11 }],
      failed: [],
    });
    expect(read('city')).toBe('CITY october');
    expect(read('asn')).toBe('ASN october');
    expect(requested).toEqual([URL_FOR('city', '2026-10'), URL_FOR('asn', '2026-10')]);
    // Nothing left behind but the two databases.
    expect(files()).toEqual(['dbip-asn-lite.mmdb', 'dbip-city-lite.mmdb']);
  });

  test('a 404 for this month (DB-IP publishes early in the month) falls back to last month', async () => {
    serve({
      [URL_FOR('city', '2026-09')]: { body: 'CITY september' },
      [URL_FOR('asn', '2026-09')]:  { body: 'ASN september' },
    });
    const result = await update.update({ now: NOW });
    expect(result.updated.map(u => u.month)).toEqual(['2026-09', '2026-09']);
    expect(requested).toEqual([
      URL_FOR('city', '2026-10'), URL_FOR('city', '2026-09'), URL_FOR('asn', '2026-10'), URL_FOR('asn', '2026-09'),
    ]);
    expect(read('city')).toBe('CITY september');
  });

  test('the new file is checked beside the old one, and renamed over it in one step', async () => {
    put('city', 'CITY old');
    serve({ [URL_FOR('city', '2026-10')]: { body: 'CITY new' } });
    await update.updateOne('city', { now: NOW });
    // While the download was checked, the file in use was still the old one.
    expect(maxmind.open.inUseAtCheck).toBe('CITY old');
    expect(renames).toHaveLength(1);
    const [from, to] = renames[0];
    expect(to).toBe(geoip.fileFor('city'));
    expect(path.dirname(from)).toBe(path.dirname(to));
    expect(from).not.toMatch(/\.mmdb$/);
    expect(read('city')).toBe('CITY new');
  });

  describe('a failure keeps the file in use as it was, and leaves no temporary file', () => {
    beforeEach(() => { put('city', 'CITY old'); put('asn', 'ASN old'); });

    test.each([
      ['nothing published for either month', {}, /answered 404/],
      ['a server error (no fallback for that)', { [URL_FOR('city', '2026-10')]: { status: 500 } }, /answered 500/],
      ['a download that is not gzip', { [URL_FOR('city', '2026-10')]: { body: Buffer.from('<html>oops</html>'), raw: true } }, /incorrect header check/],
      ['a file that is no database', { [URL_FOR('city', '2026-10')]: { body: 'BROKEN bytes' } }, /Unknown type/],
      ['the network database where the city one should be', { [URL_FOR('city', '2026-10')]: { body: 'ASN wrong file' } }, /says it is "DBIP-ASN-Lite/],
      ['a connection that fails', { [URL_FOR('city', '2026-10')]: { error: new Error('socket hang up') } }, /socket hang up/],
    ])('%s', async (_name, table, error) => {
      serve(table);
      await expect(update.updateOne('city', { now: NOW })).rejects.toThrow(error);
      expect(read('city')).toBe('CITY old');
      expect(files()).toEqual(['dbip-asn-lite.mmdb', 'dbip-city-lite.mmdb']);
      expect(renames).toEqual([]);
    });

    test('and one database failing never stops the other', async () => {
      serve({ [URL_FOR('asn', '2026-10')]: { body: 'ASN october' } });
      const result = await update.update({ now: NOW });
      expect(result.updated).toEqual([{ kind: 'asn', month: '2026-10', bytes: 11 }]);
      expect(result.failed).toEqual([{ kind: 'city', error: expect.stringMatching(/answered 404/) }]);
      expect(read('city')).toBe('CITY old');
      expect(read('asn')).toBe('ASN october');
    });
  });

  test('a redirect is followed', async () => {
    serve({
      [URL_FOR('city', '2026-10')]: { status: 302, location: 'https://cdn.example.test/city.gz' },
      'https://cdn.example.test/city.gz': { body: 'CITY via cdn' },
    });
    await update.updateOne('city', { now: NOW });
    expect(read('city')).toBe('CITY via cdn');
  });

  test('a connection that goes quiet is ended rather than waited on for ever', async () => {
    serve({ [URL_FOR('city', '2026-10')]: { body: 'CITY october' } });
    await update.updateOne('city', { now: NOW });
    const req = https.get.mock.results[0].value;
    expect(req.setTimeout).toHaveBeenCalledWith(update.IDLE_TIMEOUT_MS, expect.any(Function));
  });

  test('only the databases asked for', async () => {
    serve({ [URL_FOR('asn', '2026-10')]: { body: 'ASN october' } });
    const result = await update.update({ now: NOW, kinds: ['asn'] });
    expect(result).toEqual({ updated: [{ kind: 'asn', month: '2026-10', bytes: 11 }], failed: [] });
    expect(requested).toEqual([URL_FOR('asn', '2026-10')]);
  });
});
