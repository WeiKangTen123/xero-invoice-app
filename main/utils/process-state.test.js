describe('process-state', () => {
  let processState;

  beforeEach(() => {
    jest.resetModules();
    processState = require('./process-state');
  });

  test('getStatus starts with no lastScan recorded', () => {
    const s = processState.forUser('u1');
    expect(s.getStatus(false).lastScan).toBeNull();
  });

  test('notifyScan records emailsFound and a fresh timestamp', () => {
    const s = processState.forUser('u1');
    s.notifyScan(3);
    const { lastScan } = s.getStatus(true);
    expect(lastScan.emailsFound).toBe(3);
    expect(new Date(lastScan.checkedAt).toString()).not.toBe('Invalid Date');
  });

  test('notifyScan(0) is a valid distinct result from "never scanned"', () => {
    const s = processState.forUser('u1');
    s.notifyScan(0);
    expect(s.getStatus(true).lastScan).toEqual(expect.objectContaining({ emailsFound: 0 }));
  });

  test('lastScan is isolated per user', () => {
    const a = processState.forUser('userA');
    const b = processState.forUser('userB');
    a.notifyScan(5);
    expect(b.getStatus(false).lastScan).toBeNull();
  });
});
