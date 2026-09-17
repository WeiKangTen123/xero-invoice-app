const jwt = require('jsonwebtoken');
const { rateLimitKey } = require('./rate-limit-key');
const { jwtSecret } = require('./auth-middleware');

const req = (over = {}) => ({ headers: {}, path: '/api/invoices', ip: '10.0.0.1', ...over });

describe('middleware/rate-limit-key — who shares a bucket', () => {
  test('a signed-in request is keyed by user, not by the office IP', () => {
    const token = jwt.sign({ id: 'u1' }, jwtSecret());
    expect(rateLimitKey(req({ headers: { authorization: `Bearer ${token}` } }))).toBe('user:u1');
  });

  test('a bad token falls back to the IP', () => {
    expect(rateLimitKey(req({ headers: { authorization: 'Bearer nope' } }))).toBe('ip:10.0.0.1');
  });

  test('no token at all is the IP', () => {
    expect(rateLimitKey(req())).toBe('ip:10.0.0.1');
  });

  test('a phone capture link is keyed by its token, so one phone cannot drain the office', () => {
    expect(rateLimitKey(req({ path: '/api/receipts/capture/abc123/status' }))).toBe('capture:abc123');
    expect(rateLimitKey(req({ path: '/api/receipts/capture/abc123' }))).toBe('capture:abc123');
  });
});
