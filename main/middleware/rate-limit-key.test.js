require('../db/migrate').run();
const jwt = require('jsonwebtoken');
const { rateLimitKey } = require('./rate-limit-key');
const { jwtSecret } = require('./auth-middleware');
const pairing = require('../utils/pairing');

const req = (over = {}) => ({ headers: {}, path: '/api/invoices', ip: '10.0.0.1', query: {}, ...over });
const imageToken = (over = {}) => jwt.sign({ userId: 'u1', invoiceId: 'r1', purpose: 'receipt', ...over }, jwtSecret(), { expiresIn: 300 });

describe('middleware/rate-limit-key — who shares a bucket', () => {
  beforeEach(() => pairing._reset());
  afterAll(() => pairing._reset());

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

  describe('phone capture links', () => {
    test('a live link is keyed by its token, so one phone cannot drain the office', () => {
      const t = pairing.create('u1');
      expect(rateLimitKey(req({ path: `/api/receipts/capture/${t}/status` }))).toBe(`capture:${t}`);
      expect(rateLimitKey(req({ path: `/api/receipts/capture/${t}` }))).toBe(`capture:${t}`);
    });

    test('a made-up link counts against its IP, so varying the path is not a fresh allowance', () => {
      expect(rateLimitKey(req({ path: '/api/receipts/capture/abc123/status' }))).toBe('ip:10.0.0.1');
      expect(rateLimitKey(req({ path: '/api/receipts/capture/abc123' }))).toBe('ip:10.0.0.1');
    });

    test('a revoked, expired or spent link counts against its IP too', () => {
      const revoked = pairing.create('u1');
      pairing.revoke(revoked);
      expect(rateLimitKey(req({ path: `/api/receipts/capture/${revoked}` }))).toBe('ip:10.0.0.1');

      const spent = pairing.create('u2');
      for (let i = 0; i < pairing.MAX_USES; i++) pairing.consume(spent, `r${i}`);
      expect(rateLimitKey(req({ path: `/api/receipts/capture/${spent}` }))).toBe('ip:10.0.0.1');

      jest.useFakeTimers();
      try {
        const old = pairing.create('u3');
        jest.advanceTimersByTime(pairing.TTL_MS + 1);
        expect(rateLimitKey(req({ path: `/api/receipts/capture/${old}` }))).toBe('ip:10.0.0.1');
      } finally { jest.useRealTimers(); }
    });
  });

  describe('receipt images', () => {
    // An <img> sends no Authorization header, so these used to land in the
    // office IP's bucket, and a pairing dialog full of thumbnails drained it.
    test('an image fetched with a valid token goes to its owner\'s image bucket', () => {
      expect(rateLimitKey(req({ path: '/api/receipts/r1/image', query: { token: imageToken(), w: '160' } }))).toBe('image:u1');
    });

    test('the image bucket is separate from the same user\'s API calls', () => {
      const api = rateLimitKey(req({ headers: { authorization: `Bearer ${jwt.sign({ id: 'u1' }, jwtSecret())}` } }));
      const img = rateLimitKey(req({ path: '/api/receipts/r1/image', query: { token: imageToken() } }));
      expect(api).not.toBe(img);
    });

    test('a token that does not verify, or is for another receipt or purpose, counts against the IP', () => {
      const at = query => rateLimitKey(req({ path: '/api/receipts/r1/image', query }));
      expect(at({ token: 'garbage' })).toBe('ip:10.0.0.1');
      expect(at({})).toBe('ip:10.0.0.1');
      expect(at({ token: imageToken({ invoiceId: 'r2' }) })).toBe('ip:10.0.0.1');
      expect(at({ token: imageToken({ purpose: 'pdf' }) })).toBe('ip:10.0.0.1');
      expect(at({ token: jwt.sign({ userId: 'u1', invoiceId: 'r1', purpose: 'receipt' }, 'not-our-secret') })).toBe('ip:10.0.0.1');
      expect(at({ token: jwt.sign({ userId: 'u1', invoiceId: 'r1', purpose: 'receipt', exp: Math.floor(Date.now() / 1000) - 10 }, jwtSecret()) })).toBe('ip:10.0.0.1');
      expect(at({ token: ['a', 'b'] })).toBe('ip:10.0.0.1');
    });
  });
});
