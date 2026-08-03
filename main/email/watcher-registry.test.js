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
