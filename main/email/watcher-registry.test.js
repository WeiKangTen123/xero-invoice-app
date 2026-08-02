const { _resolveLookbackDays } = require('./watcher-registry');

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
