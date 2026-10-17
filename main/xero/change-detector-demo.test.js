// Live updates for a demo account: there are none, said so, and never
// looked for. Real users and database; the SDK class is replaced so a look
// could be seen, and the demo folder is stubbed to its contract.
jest.mock('xero-node', () => ({ AccountingApi: jest.fn(() => ({ getJournals: jest.fn(), getBudgets: jest.fn() })) }));
jest.mock('./demo/api', () => ({
  DEMO_TENANT: { tenantId: 'demo-company', tenantName: 'Demo Company Pte Ltd' },
  DEMO_TOKEN_PREFIX: 'demo:',
  isDemoToken: t => typeof t === 'string' && t.startsWith('demo:'),
  userIdFromDemoToken: t => (typeof t === 'string' && t.startsWith('demo:') ? t.slice(5) : null),
  demoApiFor: jest.fn(() => ({ getJournals: jest.fn(), getBudgets: jest.fn() })),
}));

describe('xero/change-detector — a demo account', () => {
  let detector, users, db, demo;
  const T = 'demo-company';
  const clock = Date.parse('2026-10-10T09:00:00.000Z');
  const now = () => new Date(clock);

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    require('../db/migrate').run();
    db       = require('../db');
    users    = require('../utils/users');
    detector = require('./change-detector');
    demo = await users.createUser('demo@test.com', 'password123', 'user', { demo: true });
  });

  const row = () => db.prepare('SELECT * FROM xero_change_cursor WHERE user_id = ? AND tenant_id = ?').get(demo.id, T);

  test('version: nothing changed, checked now, not live and why — without a cursor row', () => {
    expect(detector.version(demo.id, T, now)).toEqual({
      live: false, liveReason: 'Demo data does not change', changedAt: null, changeReason: null, checkedAt: '2026-10-10T09:00:00.000Z',
    });
    expect(detector.REASONS.demo).toBe('Demo data does not change');
    expect(row()).toBeUndefined();
    // The default clock is the real one.
    expect(Date.now() - Date.parse(detector.version(demo.id, T).checkedAt)).toBeLessThan(10_000);
  });

  test('a view is noted like any other, and version still answers the demo way', () => {
    detector.noteViewed(demo.id, T, now());
    expect(detector.version(demo.id, T, now)).toMatchObject({ live: false, liveReason: 'Demo data does not change', checkedAt: '2026-10-10T09:00:00.000Z' });
  });

  test('it is never due, and a poll makes no call and writes nothing', async () => {
    expect(detector.due(demo.id, T, clock)).toBe(false);
    const result = await detector.pollTenant(demo.id, T, { now });
    expect(result).toEqual({ live: false, liveReason: 'Demo data does not change', changed: false, reason: null, calls: 0 });
    expect(row()).toBeUndefined();
    expect(require('xero-node').AccountingApi).not.toHaveBeenCalled();
    expect(require('./demo/api').demoApiFor).not.toHaveBeenCalled();
  });

  test('a real account with nothing connected is still answered as before', async () => {
    const real = await users.createUser('real@test.com', 'password123', 'user');
    expect(detector.due(real.id, 't-1', clock)).toBe(true);
    expect(await detector.pollTenant(real.id, 't-1', { now })).toMatchObject({ live: false, liveReason: 'Xero is not connected' });
    expect(detector.version(real.id, 't-1')).toMatchObject({ live: false, liveReason: 'Xero is not connected', checkedAt: null });
  });
});
