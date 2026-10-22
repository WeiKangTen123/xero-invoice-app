// Alerts raised by traffic are throttled: a route failing on every request
// must be one Slack message per ten minutes, not one per request. Slack is
// never reached — axios is mocked.
jest.mock('axios', () => ({ post: jest.fn(async () => ({})) }));

describe('notifyErrorThrottled', () => {
  let axios, notify;
  beforeEach(() => {
    jest.resetModules();
    axios  = require('axios');
    notify = require('./notify');
    process.env.SLACK_WEBHOOK_URL = 'http://slack.test/hook';
  });
  afterEach(() => { delete process.env.SLACK_WEBHOOK_URL; });

  test('one alert per message per window; a new message, or the window passing, sends again', async () => {
    const t0 = 1_000_000;
    const send = (error, now) => notify.notifyErrorThrottled({ context: 'GET /x answered 500', error, now });
    expect(await send('database is locked', t0)).toBe(true);
    expect(await send('database is locked', t0 + 60_000)).toBe(false);
    expect(await send('database is locked', t0 + notify.THROTTLE_WINDOW_MS - 1)).toBe(false);
    expect(await send('something else', t0 + 1)).toBe(true);
    expect(await send('database is locked', t0 + notify.THROTTLE_WINDOW_MS)).toBe(true);
    expect(axios.post).toHaveBeenCalledTimes(3);
    expect(axios.post.mock.calls[0]).toEqual(['http://slack.test/hook', { text: expect.stringMatching(/Context: GET \/x answered 500\nError: database is locked/) }]);
  });

  test('an explicit key groups messages that differ only in detail', async () => {
    await notify.notifyErrorThrottled({ key: 'k', context: 'c', error: 'invoice 1 failed', now: 5 });
    await notify.notifyErrorThrottled({ key: 'k', context: 'c', error: 'invoice 2 failed', now: 6 });
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('without a webhook nothing is posted and nothing throws', async () => {
    delete process.env.SLACK_WEBHOOK_URL;
    await expect(notify.notifyErrorThrottled({ context: 'c', error: 'e', now: 1 })).resolves.toBe(true);
    expect(axios.post).not.toHaveBeenCalled();
  });
});

// Security alerts (routes/auth.js: a lock, a sign-in from a new country) are
// posted as written, at most once per message per ten minutes, and can never
// fail the sign-in that raised them.
describe('notifySecurity', () => {
  let axios, notify;
  beforeEach(() => {
    jest.resetModules();
    axios  = require('axios');
    axios.post.mockReset();
    axios.post.mockImplementation(async () => ({}));
    notify = require('./notify');
    process.env.SLACK_WEBHOOK_URL = 'http://slack.test/hook';
  });
  afterEach(() => { delete process.env.SLACK_WEBHOOK_URL; });

  test('posts the text as it is, once per text per window', async () => {
    const t0 = 2_000_000;
    const lock = '🔒 jane@test.com locked for 15 min after 5 failed sign-ins (IP 1.2.3.4)';
    expect(await notify.notifySecurity(lock, { now: t0 })).toBe(true);
    expect(await notify.notifySecurity(lock, { now: t0 + 60_000 })).toBe(false);
    expect(await notify.notifySecurity('🌏 jane@test.com signed in from Malaysia for the first time in 90 days (IP 5.6.7.8)', { now: t0 + 1 })).toBe(true);
    expect(await notify.notifySecurity(lock, { now: t0 + notify.THROTTLE_WINDOW_MS })).toBe(true);
    expect(axios.post.mock.calls.map(c => c[1].text)).toEqual([lock, expect.stringMatching(/^🌏 /), lock]);
    expect(axios.post.mock.calls[0][0]).toBe('http://slack.test/hook');
  });

  test('a security alert and an error alert with the same words are throttled apart', async () => {
    await notify.notifyErrorThrottled({ context: 'c', error: 'same words', now: 1 });
    expect(await notify.notifySecurity('same words', { now: 2 })).toBe(true);
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  test('never throws or rejects: no webhook, Slack failing, or nothing to say', async () => {
    delete process.env.SLACK_WEBHOOK_URL;
    await expect(notify.notifySecurity('a', { now: 1 })).resolves.toBe(true);
    expect(axios.post).not.toHaveBeenCalled();
    process.env.SLACK_WEBHOOK_URL = 'http://slack.test/hook';
    axios.post.mockImplementation(async () => { throw new Error('slack down'); });
    await expect(notify.notifySecurity('b', { now: 1 })).resolves.toBe(true);
    await expect(notify.notifySecurity('', { now: 1 })).resolves.toBe(false);
    await expect(notify.notifySecurity(undefined)).resolves.toBe(false);
  });
});

describe('notifyNotice', () => {
  let axios, notify;
  beforeEach(() => {
    jest.resetModules();
    axios  = require('axios');
    notify = require('./notify');
    process.env.SLACK_WEBHOOK_URL = 'http://slack.test/hook';
  });
  afterEach(() => { delete process.env.SLACK_WEBHOOK_URL; });

  test('posts the text as it is, every time: a notice is not a repeating alert', async () => {
    await expect(notify.notifyNotice('✅ ana@co.test accepted their invite')).resolves.toBe(true);
    await expect(notify.notifyNotice('✅ ana@co.test accepted their invite')).resolves.toBe(true);
    expect(axios.post.mock.calls).toEqual([
      ['http://slack.test/hook', { text: '✅ ana@co.test accepted their invite' }],
      ['http://slack.test/hook', { text: '✅ ana@co.test accepted their invite' }],
    ]);
  });

  test('never throws or rejects: Slack failing, or nothing to say', async () => {
    axios.post.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(notify.notifyNotice('x')).resolves.toBe(true);   // notifySlack logs and swallows it
    await expect(notify.notifyNotice('')).resolves.toBe(false);
    await expect(notify.notifyNotice(undefined)).resolves.toBe(false);
  });
});
