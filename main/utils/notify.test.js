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
