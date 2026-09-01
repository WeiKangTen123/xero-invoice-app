const pairing = require('./pairing');

// A pairing token is a bearer credential that travels in a URL and is displayed
// on screen as a QR code. Everything below exists to pin the properties that
// make that acceptable: it expires, it is bounded, it is scoped to one user,
// and it grants nothing but upload.
describe('utils/pairing', () => {
  beforeEach(() => { pairing._reset(); jest.useRealTimers(); });
  afterAll(() => { pairing._reset(); });

  describe('create', () => {
    test('mints a distinct, high-entropy token each time', () => {
      const a = pairing.create('u1'), b = pairing.create('u1');
      expect(a).not.toBe(b);
      // 32 random bytes in base64url.
      expect(a.length).toBeGreaterThanOrEqual(42);
      expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    test('a fresh token verifies and reports its budget', () => {
      const t = pairing.create('u1');
      const v = pairing.verify(t);
      expect(v.userId).toBe('u1');
      expect(v.usesLeft).toBe(pairing.MAX_USES);
      expect(v.expiresInMs).toBeGreaterThan(0);
      expect(v.expiresInMs).toBeLessThanOrEqual(pairing.TTL_MS);
    });

    test('a numeric user id is normalised, so lookups match either way', () => {
      const t = pairing.create(12345);
      expect(pairing.verify(t).userId).toBe('12345');
      expect(pairing.ownedBy(t, 12345)).toBe(true);
      expect(pairing.ownedBy(t, '12345')).toBe(true);
    });
  });

  describe('verify', () => {
    test('rejects unknown, empty and non-string tokens', () => {
      expect(pairing.verify('nope')).toBeNull();
      expect(pairing.verify('')).toBeNull();
      expect(pairing.verify(null)).toBeNull();
      expect(pairing.verify(undefined)).toBeNull();
      expect(pairing.verify({})).toBeNull();
    });

    test('does NOT consume — the phone checks before opening a camera', () => {
      const t = pairing.create('u1');
      pairing.verify(t); pairing.verify(t); pairing.verify(t);
      expect(pairing.verify(t).usesLeft).toBe(pairing.MAX_USES);
    });

    test('an expired token is rejected and forgotten', () => {
      jest.useFakeTimers();
      const t = pairing.create('u1');
      jest.advanceTimersByTime(pairing.TTL_MS + 1);
      expect(pairing.verify(t)).toBeNull();
      expect(pairing.activeCount()).toBe(0);
    });

    test('a token still alive just inside the window works', () => {
      jest.useFakeTimers();
      const t = pairing.create('u1');
      jest.advanceTimersByTime(pairing.TTL_MS - 1000);
      expect(pairing.verify(t)).not.toBeNull();
    });
  });

  describe('consume', () => {
    test('counts uploads down from the cap', () => {
      const t = pairing.create('u1');
      expect(pairing.consume(t)).toMatchObject({ uses: 1, usesLeft: pairing.MAX_USES - 1 });
      expect(pairing.verify(t).usesLeft).toBe(pairing.MAX_USES - 1);
    });

    test('records which receipts arrived, so the desktop can show the photos', () => {
      const t = pairing.create('u1');
      pairing.consume(t, 'r1');
      pairing.consume(t, 'r2');
      expect(pairing.status(t).receiptIds).toEqual(['r1', 'r2']);
      expect(pairing.verify(t).receiptIds).toEqual(['r1', 'r2']);
    });

    test('multiple uploads are allowed — a stack of receipts needs one scan', () => {
      // Single-use would force a rescan per receipt, which is the difference
      // between a feature people use and one they avoid.
      const t = pairing.create('u1');
      for (let i = 0; i < 5; i++) expect(pairing.consume(t)).not.toBeNull();
      expect(pairing.verify(t)).not.toBeNull();
    });

    test('the token stops AUTHORISING once the cap is reached', () => {
      const t = pairing.create('u1');
      for (let i = 0; i < pairing.MAX_USES; i++) pairing.consume(t, `r${i}`);
      // verify() gates uploads, so it must refuse. This is the check that stops
      // a spent pairing from accepting a twenty-first photo.
      expect(pairing.verify(t)).toBeNull();
    });

    test('a spent token can still be DESCRIBED, so the desktop renders what arrived', () => {
      const t = pairing.create('u1');
      for (let i = 0; i < pairing.MAX_USES; i++) pairing.consume(t, `r${i}`);
      const st = pairing.status(t);
      expect(st.alive).toBe(false);
      expect(st.spent).toBe(true);
      expect(st.receiptIds).toHaveLength(pairing.MAX_USES);
    });

    test('status and verify disagree by design on a spent token', () => {
      // Conflating them once allowed uploads past the cap.
      const t = pairing.create('u1');
      for (let i = 0; i < pairing.MAX_USES; i++) pairing.consume(t);
      expect(pairing.verify(t)).toBeNull();      // authorisation: refused
      expect(pairing.status(t)).not.toBeNull();  // description: still available
    });

    test('consuming an unknown token is null, not a throw', () => {
      expect(pairing.consume('nope')).toBeNull();
    });
  });

  describe('revoke and ownership', () => {
    test('revoking kills the token immediately', () => {
      const t = pairing.create('u1');
      expect(pairing.revoke(t)).toBe(true);
      expect(pairing.verify(t)).toBeNull();
      expect(pairing.revoke(t)).toBe(false);
    });

    test('a token belongs to exactly one user', () => {
      const t = pairing.create('u1');
      expect(pairing.ownedBy(t, 'u1')).toBe(true);
      expect(pairing.ownedBy(t, 'u2')).toBe(false);
      expect(pairing.ownedBy('nope', 'u1')).toBe(false);
    });

    test('one user\'s token never resolves to another user', () => {
      const a = pairing.create('alice'), b = pairing.create('bob');
      expect(pairing.verify(a).userId).toBe('alice');
      expect(pairing.verify(b).userId).toBe('bob');
    });
  });

  describe('housekeeping', () => {
    test('expired entries are swept rather than accumulating', () => {
      jest.useFakeTimers();
      pairing.create('u1'); pairing.create('u2');
      expect(pairing.activeCount()).toBe(2);
      jest.advanceTimersByTime(pairing.TTL_MS + 1);
      expect(pairing.activeCount()).toBe(0);
    });
  });
});
