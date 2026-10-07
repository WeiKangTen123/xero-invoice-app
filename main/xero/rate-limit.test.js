// withRetry and Xero's rate limits. A 429 used to be waited out for whatever
// Retry-After said, with no cap — and on the daily limit that is hours, with
// posting parked behind it. Now the daily limit fails at once with when it
// resets, a minute-limit wait is capped at 60 s, and what is left of each
// organisation's allowance is recorded from Xero's headers.
const axios = require('axios');
const {
  withRetry, xeroErrMsg, getRateLimitBudget, _recordFromResponse, MAX_RATE_LIMIT_WAIT_MS,
} = require('./xero-utils');

// The shape xero-node 7 rejects with: the response JSON-stringified, with the
// outgoing headers (and so the organisation id) copied in.
const sdk429 = (headers, tenantId = 't-rate') => JSON.stringify({
  response: { statusCode: 429, body: {}, headers, request: { headers: { 'xero-tenant-id': tenantId } } },
  body: {},
});

afterEach(() => jest.useRealTimers());

describe('the daily limit', () => {
  test('fails at once, without waiting, saying when it resets', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-07T10:00:00Z') });
    const fn = jest.fn().mockRejectedValue(sdk429({
      'x-rate-limit-problem': 'day', 'retry-after': '7200', 'x-daylimit-remaining': '0',
    }, 't-day'));

    // With fake timers a wait would never end: settling at all proves there was none.
    const err = await withRetry(fn).catch(e => e);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(err).toMatchObject({ code: 'XERO_DAILY_LIMIT', statusCode: 429, tenantId: 't-day', resetAt: '2026-10-07T12:00:00.000Z' });
    expect(err.message).toBe("Xero's daily limit for this organisation is used up; it resets at 2026-10-07 12:00 UTC (in about 2 hours). Try again after that.");
    expect(xeroErrMsg(err)).toBe(err.message);
  });

  test('is recorded against the organisation', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-07T10:00:00Z') });
    const fn = jest.fn().mockRejectedValue(sdk429({ 'x-rate-limit-problem': 'day', 'retry-after': '600' }, 't-day-2'));
    await withRetry(fn).catch(() => {});
    expect(getRateLimitBudget('t-day-2')).toMatchObject({ dayRemaining: 0, dayLimitHit: true, resetAt: '2026-10-07T10:10:00.000Z' });
  });

  test('a 429 that names no limit, with nothing left for the day, counts as the daily one', async () => {
    jest.useFakeTimers();
    const fn = jest.fn().mockRejectedValue(sdk429({ 'x-daylimit-remaining': '0' }));
    await expect(withRetry(fn)).rejects.toMatchObject({ code: 'XERO_DAILY_LIMIT' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('xeroErrMsg says the same for a raw SDK error that never went through withRetry', () => {
    expect(xeroErrMsg(sdk429({ 'x-rate-limit-problem': 'day' }))).toMatch(/^Xero's daily limit for this organisation is used up; it resets within 24 hours/);
    expect(xeroErrMsg(sdk429({ 'x-rate-limit-problem': 'minute' }))).toBe('Xero rate limit exceeded — try again in a minute');
  });
});

describe('the minute limit', () => {
  test('a Retry-After longer than a minute is capped at 60 s', async () => {
    jest.useFakeTimers();
    const fn = jest.fn()
      .mockRejectedValueOnce(sdk429({ 'x-rate-limit-problem': 'minute', 'retry-after': '3600' }))
      .mockResolvedValueOnce('ok');

    const p = withRetry(fn);
    await jest.advanceTimersByTimeAsync(MAX_RATE_LIMIT_WAIT_MS - 1);
    expect(fn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(MAX_RATE_LIMIT_WAIT_MS).toBe(60_000);
  });

  test('a short Retry-After is waited exactly', async () => {
    jest.useFakeTimers();
    const fn = jest.fn()
      .mockRejectedValueOnce(sdk429({ 'x-rate-limit-problem': 'minute', 'retry-after': '5', 'x-minlimit-remaining': '0' }))
      .mockResolvedValueOnce('ok');
    const p = withRetry(fn);
    await jest.advanceTimersByTimeAsync(4_999);
    expect(fn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe('ok');
  });

  test('no Retry-After falls back to backoff; the last attempt\'s error is what is thrown', async () => {
    jest.useFakeTimers();
    const last = sdk429({ 'x-rate-limit-problem': 'concurrent' });
    const fn = jest.fn().mockRejectedValue(last);
    const p = withRetry(fn, 3, 1000).catch(e => e);
    await jest.advanceTimersByTimeAsync(1000 + 2000);
    expect(await p).toBe(last);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('the remaining allowance, per organisation', () => {
  const xeroResponse = (tenantId, headers, url = 'https://api.xero.com/api.xro/2.0/Invoices') => ({
    config: { url, headers: { 'xero-tenant-id': tenantId } }, headers, status: 200,
  });

  test('is recorded from an ordinary Xero response', () => {
    _recordFromResponse(xeroResponse('t-9', { 'x-daylimit-remaining': '812', 'x-minlimit-remaining': '57', 'x-appminlimit-remaining': '9990' }));
    expect(getRateLimitBudget('t-9')).toMatchObject({
      dayRemaining: 812, minuteRemaining: 57, appMinuteRemaining: 9990, dayLimitHit: false, resetAt: null,
    });
    // Kept separately for each organisation.
    _recordFromResponse(xeroResponse('t-10', { 'x-daylimit-remaining': '40' }));
    expect(getRateLimitBudget('t-9').dayRemaining).toBe(812);
    expect(getRateLimitBudget('t-10').dayRemaining).toBe(40);
  });

  test('a response from anywhere else is ignored', () => {
    _recordFromResponse(xeroResponse('t-other', { 'x-daylimit-remaining': '1' }, 'https://generativelanguage.googleapis.com/v1/models'));
    expect(getRateLimitBudget('t-other')).toBeNull();
  });

  test('every call through axios is recorded, whichever module made it', async () => {
    const adapter = async config => ({
      data: {}, status: 200, statusText: 'OK', config, request: {},
      headers: { 'x-daylimit-remaining': '999', 'x-minlimit-remaining': '59' },
    });
    await axios.get('https://api.xero.com/api.xro/2.0/Organisation', { headers: { 'xero-tenant-id': 't-wire' }, adapter });
    expect(getRateLimitBudget('t-wire')).toMatchObject({ dayRemaining: 999, minuteRemaining: 59 });
  });
});

test('a connection Xero refused is not retried', async () => {
  const { XeroReconnectError } = require('./xero-utils');
  const fn = jest.fn().mockRejectedValue(new XeroReconnectError());
  await expect(withRetry(fn, 5, 1)).rejects.toMatchObject({ needsReconnect: true });
  expect(fn).toHaveBeenCalledTimes(1);
});
