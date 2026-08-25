const EventEmitter = require('events');

// A minimal, fully test-controlled stand-in for node-imap's Imap class. Real
// tests advance it through 'ready' -> openBox -> (mailbox open) manually, so
// they can assert on exactly what watcher-registry does in the window before
// the mailbox is actually selected — that's the real bug this file covers.
class FakeImap extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.searchCalls = [];
    this.ended = false;
  }
  connect() { /* test fires 'ready' manually */ }
  openBox(name, readOnly, cb) { this._openBoxCb = cb; }
  resolveOpenBox(err) { this._openBoxCb(err || null); }
  search(criteria, cb) { this.searchCalls.push(criteria); cb(null, []); }
  fetch() { const f = new EventEmitter(); process.nextTick(() => f.emit('end')); return f; }
  end() { this.ended = true; this.emit('end'); }
}

jest.mock('imap', () => jest.fn());
jest.mock('mailparser', () => ({ simpleParser: jest.fn() }));
jest.mock('../queue/email-queue', () => ({ enqueue: jest.fn(() => ({ id: 'job1' })) }));
jest.mock('../queue/email-worker', () => ({ kickWorker: jest.fn(), startWorker: jest.fn() }));
jest.mock('../utils/process-state', () => ({ forUser: () => ({ notifyScan: jest.fn() }) }));

const Imap = require('imap');
Imap.mockImplementation(opts => new FakeImap(opts));

const watcherRegistry = require('./watcher-registry');
const { _resolveLookbackDays } = watcherRegistry;

function lastImapInstance() {
  return Imap.mock.results[Imap.mock.results.length - 1].value;
}

const CREDS = { IMAP_USER: 'a@test.com', IMAP_PASS: 'pw', IMAP_HOST: 'imap.test.com', IMAP_PORT: 993 };

describe('_resolveLookbackDays', () => {
  test('uses the configured value when it is a valid positive integer', () => {
    expect(_resolveLookbackDays('30')).toBe(30);
    expect(_resolveLookbackDays(7)).toBe(7);
  });

  test('falls back to the default (100) when unset', () => {
    expect(_resolveLookbackDays(undefined)).toBe(100);
    expect(_resolveLookbackDays(null)).toBe(100);
    expect(_resolveLookbackDays('')).toBe(100);
  });

  test('falls back to the default for a non-numeric value', () => {
    expect(_resolveLookbackDays('not-a-number')).toBe(100);
  });

  test('clamps zero/negative values up to at least 1 day', () => {
    expect(_resolveLookbackDays('0')).toBe(100); // 0 is falsy, so it hits the default fallback like unset
    expect(_resolveLookbackDays('-5')).toBe(1);
  });

  test('clamps an excessive value down to the 365-day cap', () => {
    expect(_resolveLookbackDays('5000')).toBe(365);
  });
});

// Regression coverage for a real production bug: clicking "Scan now" in the
// window between `start()` and the IMAP mailbox actually being selected threw
// "No mailbox is currently selected" (node-imap fails synchronously calling
// .search() on an unopened mailbox), which surfaced as an unhandled 500 and,
// worse, burned the rescan rate-limit's one slot for nothing.
describe('rescan vs. mailbox-open race', () => {
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
    Imap.mockImplementation(opts => new FakeImap(opts));
  });

  test('rescan() returns false (not a throw) before the mailbox has opened', () => {
    watcherRegistry.start('race-user-1', CREDS, jest.fn());
    const fake = lastImapInstance();
    fake.emit('ready'); // connected, but openBox hasn't resolved yet

    expect(() => watcherRegistry.rescan('race-user-1')).not.toThrow();
    expect(watcherRegistry.rescan('race-user-1')).toBe(false);
    expect(fake.searchCalls).toHaveLength(0); // .search() must never be reached
  });

  test('rescan() returns true and actually searches once the mailbox is open', () => {
    watcherRegistry.start('race-user-2', CREDS, jest.fn());
    const fake = lastImapInstance();
    fake.emit('ready');
    fake.resolveOpenBox(); // mailbox now open — this is what the real openBox callback does; also starts the poll interval

    expect(watcherRegistry.rescan('race-user-2')).toBe(true);
    expect(fake.searchCalls.length).toBeGreaterThan(0);

    watcherRegistry.stop('race-user-2'); // clears the poll interval opened above
  });

  test('isRunning() is true immediately after start(), even before mailboxReady', () => {
    // isRunning only ever meant "a connection attempt exists" — rescan is the
    // one that needs the stricter mailboxReady check, not this.
    watcherRegistry.start('race-user-3', CREDS, jest.fn());
    expect(watcherRegistry.isRunning('race-user-3')).toBe(true);
  });

  test('a dropped connection resets mailboxReady so a stale rescan cannot slip through mid-reconnect', () => {
    // 'end' schedules a reconnect via setTimeout (real delay: several seconds) —
    // fake timers so that scheduled callback never actually fires during the test.
    jest.useFakeTimers();
    watcherRegistry.start('race-user-4', CREDS, jest.fn());
    const fake = lastImapInstance();
    fake.emit('ready');
    fake.resolveOpenBox();
    expect(watcherRegistry.rescan('race-user-4')).toBe(true);

    fake.emit('end'); // connection drops; a reconnect gets scheduled but never runs (fake timers)
    expect(watcherRegistry.rescan('race-user-4')).toBe(false);

    watcherRegistry.stop('race-user-4');
  });
});

// ── Reconnect storm ─────────────────────────────────────────────────────────
// Regression coverage for the bug that silently killed a healthy mailbox.
//
// node-imap emits BOTH 'error' and 'end' for a single dropped socket. The old
// code incremented the attempt counter and scheduled a retry in each handler
// independently, so one disconnect cost two attempts and started two
// reconnects — each building a fresh Imap instance while the previous stayed
// alive with its listeners attached. The next drop fired four events, then
// eight. Gmail closes idle IDLE connections routinely, so a mailbox with
// perfectly valid credentials burned its 20-attempt budget in about ten normal
// drops and stopped for good.
describe('IMAP reconnect is de-duplicated per disconnect', () => {
  const CREDS2 = { IMAP_USER: 'b@test.com', IMAP_PASS: 'pw', IMAP_HOST: 'imap.test.com', IMAP_PORT: 993 };

  beforeEach(() => { jest.useFakeTimers(); Imap.mockClear(); Imap.mockImplementation(o => new FakeImap(o)); });
  afterEach(() => {
    jest.clearAllTimers(); jest.useRealTimers(); jest.clearAllMocks();
    Imap.mockImplementation(o => new FakeImap(o));
  });

  test('error + end from ONE socket drop schedules exactly ONE reconnect', () => {
    watcherRegistry.start('storm-1', CREDS2, jest.fn());
    const first = lastImapInstance();
    expect(Imap).toHaveBeenCalledTimes(1);

    // A real drop: node-imap emits both.
    first.emit('error', new Error('This socket has been ended by the other party'));
    first.emit('end');

    // Only one retry should be pending, so only one new connection appears.
    jest.runOnlyPendingTimers();
    expect(Imap).toHaveBeenCalledTimes(2);
    watcherRegistry.stop('storm-1');
  });

  test('repeated drops grow linearly, not exponentially', () => {
    watcherRegistry.start('storm-2', CREDS2, jest.fn());
    for (let i = 0; i < 5; i++) {
      const inst = lastImapInstance();
      inst.emit('error', new Error('socket ended'));
      inst.emit('end');
      jest.runOnlyPendingTimers();
    }
    // 1 initial + 5 reconnects. The old code doubled each round.
    expect(Imap).toHaveBeenCalledTimes(6);
    watcherRegistry.stop('storm-2');
  });

  test('an orphaned instance cannot schedule a reconnect after being replaced', () => {
    watcherRegistry.start('storm-3', CREDS2, jest.fn());
    const orphan = lastImapInstance();
    orphan.emit('end');
    jest.runOnlyPendingTimers();          // replaced by a new instance
    const live = lastImapInstance();
    expect(live).not.toBe(orphan);

    const before = Imap.mock.calls.length;
    orphan.emit('error', new Error('late event from a dead socket'));
    orphan.emit('end');
    jest.runOnlyPendingTimers();
    expect(Imap.mock.calls.length).toBe(before);   // stale events ignored
    watcherRegistry.stop('storm-3');
  });

  test('a successful connection resets the budget, so transient drops never accumulate', () => {
    watcherRegistry.start('storm-4', CREDS2, jest.fn());
    for (let i = 0; i < 30; i++) {          // far beyond the 20-attempt cap
      const inst = lastImapInstance();
      inst.emit('ready');                   // healthy connect resets the counter
      inst.resolveOpenBox(null);
      inst.emit('error', new Error('socket ended'));
      inst.emit('end');
      jest.runOnlyPendingTimers();
    }
    // Still reconnecting after 30 normal drops — this is the whole point.
    expect(Imap).toHaveBeenCalledTimes(31);
    watcherRegistry.stop('storm-4');
  });

  test('stop() cancels a pending retry — a stopped watcher must not revive', () => {
    watcherRegistry.start('storm-5', CREDS2, jest.fn());
    lastImapInstance().emit('end');        // schedules a retry
    const before = Imap.mock.calls.length;
    watcherRegistry.stop('storm-5');
    jest.runOnlyPendingTimers();
    expect(Imap.mock.calls.length).toBe(before);
    expect(watcherRegistry.isRunning('storm-5')).toBe(false);
  });
});
