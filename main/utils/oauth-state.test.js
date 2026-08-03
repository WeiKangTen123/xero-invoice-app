describe('oauth-state', () => {
  let oauthState;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    oauthState = require('./oauth-state');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('create/consume round-trips to the same userId', () => {
    const state = oauthState.create('user-1');
    expect(oauthState.consume(state)).toBe('user-1');
  });

  test('consume is single-use — a second consume of the same state returns null', () => {
    const state = oauthState.create('user-1');
    oauthState.consume(state);
    expect(oauthState.consume(state)).toBeNull();
  });

  test('an unknown/garbage state returns null, not a throw', () => {
    expect(() => oauthState.consume('not-a-real-state')).not.toThrow();
    expect(oauthState.consume('not-a-real-state')).toBeNull();
  });

  test('two different users get two different, independently-resolvable states', () => {
    const stateA = oauthState.create('user-a');
    const stateB = oauthState.create('user-b');
    expect(stateA).not.toBe(stateB);
    expect(oauthState.consume(stateB)).toBe('user-b');
    expect(oauthState.consume(stateA)).toBe('user-a');
  });

  test('a state older than the TTL expires and returns null', () => {
    const state = oauthState.create('user-1');
    jest.advanceTimersByTime(11 * 60 * 1000); // TTL is 10 minutes
    expect(oauthState.consume(state)).toBeNull();
  });

  test('a state within the TTL is still valid', () => {
    const state = oauthState.create('user-1');
    jest.advanceTimersByTime(9 * 60 * 1000);
    expect(oauthState.consume(state)).toBe('user-1');
  });
});
