// IP locations from the offline DB-IP databases. maxmind itself is replaced:
// the real databases are 130 MB and fetched monthly, and nothing in a test may
// download them. Each "database" here is a small file on disk (so the module's
// own checks for the files, and for a newer copy, run for real) and a reader
// that answers from a table.
jest.mock('maxmind', () => ({ open: jest.fn() }));

const fs   = require('fs');
const path = require('path');

const CITY = {
  '8.8.8.8': {
    city: { names: { en: 'Mountain View' } }, subdivisions: [{ names: { en: 'California' } }],
    country: { iso_code: 'US', names: { en: 'United States', de: 'Vereinigte Staaten' } },
  },
  '202.188.0.133': {
    city: { names: { en: 'Kuala Lumpur' } }, subdivisions: [{ names: { en: 'Kuala Lumpur' } }],
    country: { iso_code: 'MY', names: { en: 'Malaysia' } },
  },
  '2001:4860::8888': { country: { iso_code: 'CA', names: { en: 'Canada' } } },
};
const ASN = {
  '8.8.8.8': { autonomous_system_number: 15169, autonomous_system_organization: 'Google LLC' },
  '202.188.0.133': { autonomous_system_number: 4788, autonomous_system_organization: 'TM TECHNOLOGY SERVICES SDN BHD' },
  '9.9.9.9': { autonomous_system_number: 19281, autonomous_system_organization: 'Quad9' },
};

describe('utils/geoip', () => {
  let geoip, maxmind, logger;

  const reader = table => ({ get: jest.fn(ip => table[ip] || null), metadata: {} });
  const writeDb = (kind, contents = kind, mtime = new Date('2026-10-01T00:00:00Z')) => {
    fs.mkdirSync(geoip.GEOIP_DIR, { recursive: true });
    const file = geoip.fileFor(kind);
    fs.writeFileSync(file, contents);
    fs.utimesSync(file, mtime, mtime);
    return file;
  };
  // Answers each file by its name, as maxmind.open(file) would.
  const serve = (tables = { city: CITY, asn: ASN }) => maxmind.open.mockImplementation(async file => {
    const kind = Object.keys(geoip.DATABASES).find(k => file === geoip.fileFor(k));
    if (!kind || !tables[kind]) throw new Error(`not a database: ${file}`);
    return reader(tables[kind]);
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));

  beforeEach(() => {
    jest.resetModules();
    maxmind = require('maxmind');
    maxmind.open.mockReset();
    geoip  = require('./geoip');
    logger = require('./logger');
    fs.rmSync(geoip.GEOIP_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    geoip._reset();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('the databases live in the data folder, never in the repository', () => {
    expect(geoip.GEOIP_DIR).toBe(path.join(process.env.DATA_DIR, 'geoip'));
    expect(geoip.fileFor('city')).toBe(path.join(process.env.DATA_DIR, 'geoip', 'dbip-city-lite.mmdb'));
    expect(geoip.fileFor('asn')).toBe(path.join(process.env.DATA_DIR, 'geoip', 'dbip-asn-lite.mmdb'));
  });

  test('ATTRIBUTION is the credit CC BY 4.0 asks for', () => {
    expect(geoip.ATTRIBUTION).toEqual({ text: 'IP Geolocation by DB-IP', url: 'https://db-ip.com' });
  });

  describe('private addresses', () => {
    test.each([
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.10', '169.254.10.20', '100.64.0.1', '0.0.0.0',
      '::1', '::', 'fe80::1', 'fe80::1%eth0', 'fd12:3456::1', 'fc00::1', '[::1]',
      '::ffff:127.0.0.1', '::ffff:192.168.0.5', '::FFFF:7f00:1', '0:0:0:0:0:ffff:c0a8:0001',
    ])('%s is a private network, with no database at all', ip => {
      expect(geoip.lookupIp(ip)).toEqual({ private: true });
      expect(geoip.isPrivateIp(ip)).toBe(true);
      expect(maxmind.open).not.toHaveBeenCalled();
    });

    test.each(['172.32.0.1', '172.15.0.1', '100.63.0.1', '100.128.0.1', '8.8.8.8', '::ffff:8.8.8.8', '2001:4860::8888'])(
      '%s is not', ip => { expect(geoip.isPrivateIp(ip)).toBe(false); },
    );
  });

  describe('addresses as they arrive', () => {
    test.each([
      ['::ffff:8.8.8.8', '8.8.8.8'],
      ['::ffff:808:808', '8.8.8.8'],
      [' 8.8.8.8 ', '8.8.8.8'],
      ['[2001:4860:0:0:0:0:0:8888]', '2001:4860::8888'],
      ['2001:4860::8888%en0', '2001:4860::8888'],
      ['2001:4860:0000::8888', '2001:4860::8888'],
    ])('%s is looked up as %s', (given, as) => {
      expect(geoip.normalizeIp(given)).toBe(as);
    });

    test.each([null, undefined, '', 'nonsense', '1.2.3', '256.1.1.1', '8.8.8.8:443x'])('%p is not an address: null', ip => {
      expect(geoip.normalizeIp(ip)).toBeNull();
      expect(geoip.lookupIp(ip)).toBeNull();
    });
  });

  describe('with no database files', () => {
    test('a public address is null, and ready() is not an error', async () => {
      await expect(geoip.ready()).resolves.toBeUndefined();
      expect(geoip.lookupIp('8.8.8.8')).toBeNull();
      expect(maxmind.open).not.toHaveBeenCalled();
      expect(geoip.databaseDates()).toEqual({ city: null, asn: null });
    });
  });

  describe('with both databases', () => {
    beforeEach(() => {
      writeDb('city');
      writeDb('asn');
      serve();
    });

    test('a public address: city, region, country, its code and the network', async () => {
      await geoip.ready();
      expect(geoip.lookupIp('8.8.8.8')).toEqual({
        city: 'Mountain View', region: 'California', country: 'United States', countryCode: 'US', org: 'Google LLC',
      });
      expect(maxmind.open).toHaveBeenCalledTimes(2);
    });

    test('an IPv4 client on a dual-stack socket (::ffff:) is looked up as its IPv4 address', async () => {
      await geoip.ready();
      expect(geoip.lookupIp('::ffff:8.8.8.8')).toEqual(geoip.lookupIp('8.8.8.8'));
      expect(geoip.lookupIp('::ffff:8.8.8.8').city).toBe('Mountain View');
    });

    test('what one database does not know is null; what neither knows is null', async () => {
      await geoip.ready();
      expect(geoip.lookupIp('2001:4860::8888')).toEqual({ city: null, region: null, country: 'Canada', countryCode: 'CA', org: null });
      expect(geoip.lookupIp('9.9.9.9')).toEqual({ city: null, region: null, country: null, countryCode: null, org: 'Quad9' });
      expect(geoip.lookupIp('203.0.113.9')).toBeNull();
    });

    test('opened once, however many lookups and ready() calls', async () => {
      await geoip.ready();
      await geoip.ready();
      for (let i = 0; i < 20; i++) geoip.lookupIp('8.8.8.8');
      await Promise.all([geoip.ready(), geoip.ready()]);
      expect(maxmind.open).toHaveBeenCalledTimes(2);
    });

    test('a lookup never opens a file itself: before ready() it is null, and the open starts behind it', async () => {
      expect(geoip.lookupIp('8.8.8.8')).toBeNull();
      await flush();
      expect(maxmind.open).toHaveBeenCalledTimes(2);
      expect(geoip.lookupIp('8.8.8.8').city).toBe('Mountain View');
    });

    test('a replaced file is opened again, and its answers are the new ones', async () => {
      await geoip.ready();
      expect(geoip.lookupIp('8.8.8.8').city).toBe('Mountain View');
      serve({ city: { '8.8.8.8': { city: { names: { en: 'Ashburn' } }, country: { iso_code: 'US', names: { en: 'United States' } } } }, asn: ASN });
      writeDb('city', 'a newer, longer file', new Date('2026-11-01T00:00:00Z'));
      await geoip.ready();
      expect(geoip.lookupIp('8.8.8.8').city).toBe('Ashburn');
      expect(maxmind.open).toHaveBeenCalledTimes(3);   // the network file was not touched
    });

    test('a lookup notices a replaced file within a minute, without ready()', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      await geoip.ready();
      writeDb('city', 'newer', new Date('2026-11-01T00:00:00Z'));
      serve({ city: { '8.8.8.8': { city: { names: { en: 'Ashburn' } } } }, asn: ASN });
      geoip.lookupIp('8.8.8.8');
      await flush();
      expect(maxmind.open).toHaveBeenCalledTimes(2);
      jest.advanceTimersByTime(geoip.RECHECK_MS);
      expect(geoip.lookupIp('8.8.8.8').city).toBe('Mountain View');   // the old one answers meanwhile
      await flush();
      expect(geoip.lookupIp('8.8.8.8').city).toBe('Ashburn');
    });

    test('a deleted file is no longer answered from', async () => {
      await geoip.ready();
      fs.unlinkSync(geoip.fileFor('city'));
      fs.unlinkSync(geoip.fileFor('asn'));
      await geoip.ready();
      expect(geoip.lookupIp('8.8.8.8')).toBeNull();
    });

    test('dropped after IDLE_MS unused, and opened again on the next ready()', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      await geoip.ready();
      jest.advanceTimersByTime(geoip.IDLE_MS - 1000);
      expect(geoip.lookupIp('8.8.8.8').city).toBe('Mountain View');   // used: the clock starts again
      jest.advanceTimersByTime(geoip.IDLE_MS - 1000);
      expect(geoip.lookupIp('8.8.8.8').city).toBe('Mountain View');
      jest.advanceTimersByTime(geoip.IDLE_MS + 1000);
      await geoip.ready();
      expect(maxmind.open).toHaveBeenCalledTimes(4);
      expect(geoip.lookupIp('8.8.8.8').city).toBe('Mountain View');
    });

    test('databaseDates says when each file was written', () => {
      expect(geoip.databaseDates()).toEqual({ city: new Date('2026-10-01T00:00:00Z'), asn: new Date('2026-10-01T00:00:00Z') });
    });
  });

  test('only the city file: locations without a network', async () => {
    writeDb('city');
    serve();
    await geoip.ready();
    expect(geoip.lookupIp('8.8.8.8')).toMatchObject({ city: 'Mountain View', org: null });
  });

  test('a file that will not open is warned about once, answers null, and is tried again only when replaced', async () => {
    writeDb('city', 'not a database');
    writeDb('asn');
    serve({ asn: ASN });
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    await geoip.ready();
    await geoip.ready();
    expect(geoip.lookupIp('8.8.8.8')).toEqual({ city: null, region: null, country: null, countryCode: null, org: 'Google LLC' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ file: 'dbip-city-lite.mmdb' });
    expect(maxmind.open).toHaveBeenCalledTimes(2);
    writeDb('city', 'fixed', new Date('2026-11-01T00:00:00Z'));
    serve();
    await geoip.ready();
    expect(geoip.lookupIp('8.8.8.8').city).toBe('Mountain View');
  });

  describe('locationLabel', () => {
    test.each([
      [{ city: 'Kuala Lumpur', country: 'Malaysia', org: 'Maxis Broadband Sdn.Bhd.' }, 'Kuala Lumpur, Malaysia · Maxis Broadband'],
      [{ city: 'Singapore', country: 'Singapore', org: 'Singtel' }, 'Singapore · Singtel'],
      // DB-IP names Singapore by its district; a city-state is named once.
      [{ city: 'Singapore (Geylang)', country: 'Singapore', org: 'Starhub Ltd.' }, 'Singapore · Starhub'],
      [{ city: 'Mountain View', country: 'United States', org: 'Google LLC' }, 'Mountain View, United States · Google'],
      [{ city: 'Sydney', country: 'Australia', org: 'Cloudflare, Inc.' }, 'Sydney, Australia · Cloudflare'],
      [{ city: null, country: 'Canada', org: null }, 'Canada'],
      [{ city: null, country: null, org: 'Quad9' }, 'Quad9'],
      [{ city: 'Lyon', country: null, org: null }, 'Lyon'],
      [{ private: true }, 'Private network'],
      [{ city: null, country: null, org: null }, ''],
      [null, ''],
      [undefined, ''],
    ])('%j -> %p', (geo, label) => {
      expect(geoip.locationLabel(geo)).toBe(label);
    });
  });
});
