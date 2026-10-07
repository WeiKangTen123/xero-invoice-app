require('../db/migrate').run();
const db      = require('../db');
const users   = require('./users');
const pairing = require('./pairing');

// verify() reads the owning account on every use, so the ids this file pairs
// for have to be real, enabled accounts.
const ACCOUNTS = ['u1', 'u2', 'alice', 'bob', '12345'];
function seedAccount(id) {
  db.prepare('INSERT OR IGNORE INTO users (id, email, password, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, `${id}@pairing.test`, 'not-a-hash', 'user', new Date().toISOString());
}
ACCOUNTS.forEach(seedAccount);

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

// ── Sliding expiry ──────────────────────────────────────────────────────────
describe('utils/pairing — the link follows the work', () => {
  beforeEach(() => { pairing._reset(); jest.useRealTimers(); });
  afterAll(() => { pairing._reset(); jest.useRealTimers(); });

  test('each upload pushes expiry back out, so a long stack is not cut off', () => {
    jest.useFakeTimers();
    const t = pairing.create('u1');

    // Nine minutes in, nearly dead — then a photo arrives.
    jest.advanceTimersByTime(pairing.TTL_MS - 60_000);
    expect(pairing.verify(t)).not.toBeNull();
    pairing.consume(t, 'r1');

    // Another nine minutes: without the extension this would be long gone.
    jest.advanceTimersByTime(pairing.TTL_MS - 60_000);
    expect(pairing.verify(t)).not.toBeNull();
    expect(pairing.status(t).expiresInMs).toBeGreaterThan(0);
  });

  test('an abandoned code still dies on time — nothing extends it', () => {
    // This is the case the short TTL exists for, and it must not regress.
    jest.useFakeTimers();
    const t = pairing.create('u1');
    jest.advanceTimersByTime(pairing.TTL_MS + 1);
    expect(pairing.verify(t)).toBeNull();
  });

  test('extending cannot outlive the upload cap', () => {
    jest.useFakeTimers();
    const t = pairing.create('u1');
    for (let i = 0; i < pairing.MAX_USES; i++) {
      jest.advanceTimersByTime(60_000);
      pairing.consume(t, `r${i}`);
    }
    // Still inside the extended window, but the budget is spent.
    expect(pairing.verify(t)).toBeNull();
  });

  test('revoking beats any amount of extending', () => {
    const t = pairing.create('u1');
    pairing.consume(t, 'r1');
    pairing.revoke(t);
    expect(pairing.verify(t)).toBeNull();
    expect(pairing.status(t)).toBeNull();
  });
});

// ── The account behind the link ────────────────────────────────────────────
// A capture link carries no session, so the checks that refuse a disabled or
// deleted account's sign-in and tokens never saw it: an open QR code kept
// taking uploads for the account. verify() gates every capture route.
describe('utils/pairing — the account behind the link', () => {
  beforeEach(() => { pairing._reset(); jest.useRealTimers(); seedAccount('owner'); users.setDisabled('owner', false); });
  afterAll(() => { pairing._reset(); });

  test("a disabled account's link is refused, and stays dead after it is enabled again", () => {
    const t = pairing.create('owner');
    expect(pairing.verify(t)).not.toBeNull();
    users.setDisabled('owner', true);
    expect(pairing.verify(t)).toBeNull();
    // Dropped, not paused: re-enabling the account must not revive a QR code
    // that was on screen when it was disabled.
    users.setDisabled('owner', false);
    expect(pairing.verify(t)).toBeNull();
    expect(pairing.status(t)).toBeNull();
  });

  test("a deleted account's link is refused", () => {
    const t = pairing.create('owner');
    users.deleteUser('owner');
    expect(pairing.verify(t)).toBeNull();
  });

  test("disabling one account leaves another account's link working", () => {
    const mine = pairing.create('owner'), theirs = pairing.create('u2');
    users.setDisabled('owner', true);
    expect(pairing.verify(mine)).toBeNull();
    expect(pairing.verify(theirs)).not.toBeNull();
  });
});

// Every dialog opening mints a code, and a code nobody closed stays live for
// its ten minutes. These bound how many upload links one account can have
// standing at once, and make sure signing out takes them all down.
describe('utils/pairing — how many links an account holds', () => {
  beforeEach(() => { pairing._reset(); jest.useRealTimers(); });
  afterAll(() => { pairing._reset(); });

  test('an account holds at most MAX_PER_USER live codes; the next revokes the oldest', () => {
    expect(pairing.MAX_PER_USER).toBe(3);
    const [a, b, c] = [pairing.create('u1'), pairing.create('u1'), pairing.create('u1')];
    expect([a, b, c].every(t => pairing.verify(t))).toBe(true);

    const d = pairing.create('u1');
    expect(pairing.verify(a)).toBeNull();          // the oldest went
    expect(pairing.verify(b)).not.toBeNull();
    expect(pairing.verify(c)).not.toBeNull();
    expect(pairing.verify(d)).not.toBeNull();

    pairing.create('u1');
    expect(pairing.verify(b)).toBeNull();          // and then the next oldest
    expect(pairing.activeCount()).toBe(3);
  });

  test("one account's codes never push out another's", () => {
    const theirs = pairing.create('u2');
    for (let i = 0; i < 10; i++) pairing.create('u1');
    expect(pairing.verify(theirs)).not.toBeNull();
    expect(pairing.activeCount()).toBe(4);
  });

  test('an expired code does not count towards the cap', () => {
    jest.useFakeTimers();
    const [a, b] = [pairing.create('u1'), pairing.create('u1')];
    jest.advanceTimersByTime(pairing.TTL_MS + 1);
    const fresh = [pairing.create('u1'), pairing.create('u1'), pairing.create('u1')];
    expect(fresh.every(t => pairing.verify(t))).toBe(true);
    expect(pairing.verify(a)).toBeNull();
    expect(pairing.verify(b)).toBeNull();
  });

  test('revokeForUser takes down every code the account holds, and only that account\'s', () => {
    const mine = [pairing.create('u1'), pairing.create('u1')];
    const theirs = pairing.create('u2');
    expect(pairing.revokeForUser('u1')).toBe(2);
    expect(mine.map(t => pairing.verify(t))).toEqual([null, null]);
    expect(pairing.status(mine[0])).toBeNull();
    expect(pairing.verify(theirs)).not.toBeNull();
    expect(pairing.revokeForUser('u1')).toBe(0);
  });

  test('revokeForUser matches a numeric id the way create() stores it', () => {
    const t = pairing.create(12345);
    expect(pairing.revokeForUser('12345')).toBe(1);
    expect(pairing.verify(t)).toBeNull();
  });
});

describe('utils/pairing — isLive, the rate limiter\'s question', () => {
  beforeEach(() => { pairing._reset(); jest.useRealTimers(); });

  test('true only for a code that could still take an upload', () => {
    const t = pairing.create('u1');
    expect(pairing.isLive(t)).toBe(true);
    expect(pairing.isLive('made-up')).toBe(false);
    expect(pairing.isLive('')).toBe(false);
    expect(pairing.isLive(null)).toBe(false);
    pairing.revoke(t);
    expect(pairing.isLive(t)).toBe(false);
  });

  test('a spent code is not live, though status() can still describe it', () => {
    const t = pairing.create('u1');
    for (let i = 0; i < pairing.MAX_USES; i++) pairing.consume(t, `r${i}`);
    expect(pairing.isLive(t)).toBe(false);
    expect(pairing.status(t).spent).toBe(true);
  });

  test('an expired code is not live, and asking does not change anything', () => {
    jest.useFakeTimers();
    const t = pairing.create('u1');
    jest.advanceTimersByTime(pairing.TTL_MS + 1);
    expect(pairing.isLive(t)).toBe(false);
  });
});
