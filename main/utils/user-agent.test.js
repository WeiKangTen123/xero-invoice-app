// What an admin reads for the browser a sign-in or a session came from.
// Real User-Agent strings, as current browsers send them.
const { describeUserAgent } = require('./user-agent');

const UA = {
  chromeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  safariIphone:  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  edgeWindows:   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  firefoxMac:    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0',
  safariMac:     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  safariIpad:    'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeIphone:  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1',
  chromebook:    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
};

describe('utils/user-agent describeUserAgent', () => {
  test.each([
    ['chromeWindows', { browser: 'Chrome',  os: 'Windows',  device: 'desktop', label: 'Chrome · Windows' }],
    ['safariIphone',  { browser: 'Safari',  os: 'iOS',      device: 'mobile',  label: 'Safari · iPhone' }],
    ['edgeWindows',   { browser: 'Edge',    os: 'Windows',  device: 'desktop', label: 'Edge · Windows' }],
    ['firefoxMac',    { browser: 'Firefox', os: 'macOS',    device: 'desktop', label: 'Firefox · macOS' }],
    ['safariMac',     { browser: 'Safari',  os: 'macOS',    device: 'desktop', label: 'Safari · macOS' }],
    ['chromeAndroid', { browser: 'Chrome',  os: 'Android',  device: 'mobile',  label: 'Chrome · Android' }],
    ['safariIpad',    { browser: 'Safari',  os: 'iOS',      device: 'tablet',  label: 'Safari · iPad' }],
    ['chromeIphone',  { browser: 'Chrome',  os: 'iOS',      device: 'mobile',  label: 'Chrome · iPhone' }],
    ['chromebook',    { browser: 'Chrome',  os: 'ChromeOS', device: 'desktop', label: 'Chrome · ChromeOS' }],
  ])('%s', (name, expected) => {
    expect(describeUserAgent(UA[name])).toEqual(expected);
  });

  test('no versions anywhere: browsers freeze the system version they send', () => {
    for (const ua of Object.values(UA)) {
      expect(JSON.stringify(describeUserAgent(ua))).not.toMatch(/\d/);
    }
  });

  test.each([[''], ['   '], [null], [undefined]])('nothing sent (%p) is "Unknown device"', ua => {
    expect(describeUserAgent(ua)).toEqual({ browser: null, os: null, device: null, label: 'Unknown device' });
  });

  test('a script names itself', () => {
    expect(describeUserAgent('curl/8.4.0')).toEqual({ browser: null, os: null, device: null, label: 'curl' });
    expect(describeUserAgent('python-requests/2.31.0').label).toBe('python-requests');
  });

  test('a header that names nothing at all is "Unknown device"', () => {
    expect(describeUserAgent('???').label).toBe('Unknown device');
  });
});
