const { _idleUserIds, IDLE_MS } = require('./idle-sweeper');

// The sweeper stops mailbox watchers for abandoned sessions. It is a backstop,
// not a leash — logging out stops your own watcher immediately, so the only job
// here is catching sessions nobody ever came back to. Being too eager would turn
// an unattended automation into one that only runs while someone is watching.
describe('email/idle-sweeper — who gets swept (pure)', () => {
  const NOW  = Date.parse('2026-08-25T12:00:00Z');
  const ago  = ms => new Date(NOW - ms).toISOString();
  const HOUR = 3600000;

  test('the cutoff is 8 hours, not minutes — overnight invoices still get collected', () => {
    expect(IDLE_MS).toBe(8 * HOUR);
  });

  test('an account seen recently is left running', () => {
    const seen = { u1: ago(5 * 60 * 1000), u2: ago(7 * HOUR) };
    expect(_idleUserIds(['u1', 'u2'], seen, NOW)).toEqual([]);
  });

  test('an account idle past the cutoff is swept', () => {
    const seen = { u1: ago(9 * HOUR), u2: ago(30 * HOUR) };
    expect(_idleUserIds(['u1', 'u2'], seen, NOW).sort()).toEqual(['u1', 'u2']);
  });

  test('exactly at the boundary is not yet idle — only strictly past it', () => {
    expect(_idleUserIds(['u1'], { u1: ago(IDLE_MS) }, NOW)).toEqual([]);
    expect(_idleUserIds(['u1'], { u1: ago(IDLE_MS + 1000) }, NOW)).toEqual(['u1']);
  });

  test('a missing or unparseable last_seen is LEFT ALONE, never swept', () => {
    // Stopping a watcher is disruptive and silent. "We don't know when they were
    // last here" is not evidence that they are gone.
    expect(_idleUserIds(['u1'], {}, NOW)).toEqual([]);
    expect(_idleUserIds(['u1'], { u1: null }, NOW)).toEqual([]);
    expect(_idleUserIds(['u1'], { u1: '' }, NOW)).toEqual([]);
    expect(_idleUserIds(['u1'], { u1: 'not-a-date' }, NOW)).toEqual([]);
  });

  test('only accounts with a RUNNING watcher are considered', () => {
    // u2 is long idle but isn't in the running list, so it must not appear.
    const seen = { u1: ago(20 * HOUR), u2: ago(99 * HOUR) };
    expect(_idleUserIds(['u1'], seen, NOW)).toEqual(['u1']);
  });

  test('a clock skew that puts last_seen in the future does not sweep', () => {
    expect(_idleUserIds(['u1'], { u1: new Date(NOW + 5 * HOUR).toISOString() }, NOW)).toEqual([]);
  });
});
