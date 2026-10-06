const periods = require('./periods');

const {
  MAX_PERIOD_MONTHS, PERIOD_PRESETS, PeriodError, _isPeriodError,
  _checkRange, _periodFromQueryParams, _resolvePeriod,
} = periods;

// Every 12 months of a period costs a pair of Xero calls, and nothing bounded
// the span — from=1900-01&to=2100-12 was about 400 calls in one request. These
// pin the bound, and that it is enforced both where a request arrives and where
// a period becomes a month list, so no caller can get past it.
describe('xero/periods — which periods may be asked for', () => {
  const TODAY = { year: 2026, month: 10, day: 7 };
  const DEC   = { month: 12, day: 31 };
  const refused = fn => { try { fn(); } catch (err) { return err; } return null; };

  test('the cap is the widest span the period picker can produce', () => {
    expect(MAX_PERIOD_MONTHS).toBe(132);   // eleven years
  });

  test('132 months is accepted, 133 refused, whichever way round', () => {
    expect(() => _checkRange('2016-01', '2026-12')).not.toThrow();
    expect(() => _checkRange('2026-12', '2016-01')).not.toThrow();
    for (const [a, b] of [['2015-12', '2026-12'], ['2026-12', '2015-12']]) {
      const err = refused(() => _checkRange(a, b));
      expect(err).toBeInstanceOf(PeriodError);
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/Period too long — at most 132 months/);
    }
  });

  test('only YYYY-MM months between 1990 and 2100 are periods', () => {
    for (const ok of [['1990-01', '1990-12'], ['2100-01', '2100-12'], ['2026-01', '2026-01']]) {
      expect(() => _checkRange(...ok)).not.toThrow();
    }
    for (const bad of [
      ['1989-12', '1990-01'], ['2100-12', '2101-01'],          // outside the years
      ['2026-13', '2026-12'], ['2026-00', '2026-12'],          // no such month
      ['2026-1', '2026-12'], ['2026-01-01', '2026-12-31'],     // not YYYY-MM
      ['abc', '2026-12'], [null, '2026-12'], [['2026-01'], '2026-12'], [202601, '2026-12'],
    ]) {
      expect(_isPeriodError(refused(() => _checkRange(...bad)))).toBe(true);
    }
  });

  test('a query reads as a range, a preset, the legacy window, or the fallback', () => {
    expect(_periodFromQueryParams({ from: '2025-01', to: '2025-12' })).toEqual({ from: '2025-01', to: '2025-12' });
    expect(_periodFromQueryParams({ preset: 'prev-fy' })).toEqual({ preset: 'prev-fy' });
    expect(_periodFromQueryParams({ window: '2025-12' })).toEqual({ preset: '2025-12' });
    expect(_periodFromQueryParams({}, { preset: 'fy-ytd' })).toEqual({ preset: 'fy-ytd' });
    expect(_periodFromQueryParams({ from: '', to: '' }, undefined)).toBeUndefined();   // empty is absent
    expect(_periodFromQueryParams(undefined, 'x')).toBe('x');
  });

  test('a range wins over a preset, which then goes unchecked because it goes unused', () => {
    expect(_periodFromQueryParams({ from: '2025-01', to: '2025-12', preset: 'whatever' }))
      .toEqual({ from: '2025-01', to: '2025-12' });
  });

  test('half a range, an unknown preset or a non-string is refused, not swapped for the default', () => {
    for (const q of [
      { from: '2025-01' }, { to: '2025-12' },
      { preset: 'garbage' }, { preset: 'custom' }, { window: 'nope' },
      { preset: '2026-13' }, { preset: '1900-12' }, { preset: ['fy'] },
      { from: ['2025-01', '2025-02'], to: '2025-12' },
    ]) {
      const err = refused(() => _periodFromQueryParams(q, { preset: 'fy-ytd' }));
      expect({ q, refused: _isPeriodError(err) }).toEqual({ q, refused: true });
    }
  });

  test('every preset accepted resolves as itself, never through the year-to-date fallback', () => {
    // If the accepted list and the resolver drift apart, an accepted preset
    // would quietly become year to date — the failure the check exists to stop.
    for (const p of PERIOD_PRESETS) {
      expect(_resolvePeriod(p, TODAY, DEC).key).toBe(p);
    }
  });

  test('the resolver refuses an over-long or malformed range itself, for callers that skip the route', () => {
    expect(_resolvePeriod({ from: '2016-01', to: '2026-12' }, TODAY, DEC).months).toHaveLength(132);
    for (const spec of [
      { from: '1900-01', to: '2100-12' },
      { from: '2015-12', to: '2026-12' },
      { from: 'nonsense', to: '2026-08' },
    ]) {
      expect(_isPeriodError(refused(() => _resolvePeriod(spec, TODAY, DEC)))).toBe(true);
    }
  });

  test('a refusal is recognised by name, so two copies of this module agree', () => {
    expect(_isPeriodError(Object.assign(new Error('x'), { name: 'PeriodError' }))).toBe(true);
    expect(_isPeriodError(new Error('x'))).toBe(false);
    expect(_isPeriodError(null)).toBe(false);
  });
});
