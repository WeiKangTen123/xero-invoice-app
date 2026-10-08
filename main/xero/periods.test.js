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

// The year starts on the 1st of the month after the year-end month. It used to
// start the day after the year-end DATE, which on 29 Feb 2028 for a 28 Feb
// year end made the year Feb 2028 – Jan 2029.
describe('xero/periods — the financial year around a February year end', () => {
  const { _fiscalYearStart, _toDateLabel, _monthsBetween } = periods;
  const span = w => `${w.months[0].label} .. ${w.months[w.months.length - 1].label}`;
  const d = (year, month, day) => ({ year, month, day });
  const DEC   = { month: 12, day: 31 };
  const FEB28 = { month: 2, day: 28 };
  const FEB29 = { month: 2, day: 29 };

  test('a 28 Feb year end in a leap year: 29 Feb is the last day of the year, not the first of the next', () => {
    expect(_fiscalYearStart(d(2028, 2, 28), FEB28)).toEqual(d(2027, 3, 1));
    expect(_fiscalYearStart(d(2028, 2, 29), FEB28)).toEqual(d(2027, 3, 1));
    expect(_fiscalYearStart(d(2028, 3, 1),  FEB28)).toEqual(d(2028, 3, 1));
    expect(span(_resolvePeriod('fy',     d(2028, 2, 29), FEB28))).toBe('Mar 2027 .. Feb 2028');
    expect(span(_resolvePeriod('fy-ytd', d(2028, 2, 29), FEB28))).toBe('Mar 2027 .. Feb 2028');
    expect(span(_resolvePeriod('fy',     d(2028, 3, 1),  FEB28))).toBe('Mar 2028 .. Feb 2029');
  });

  test('a 28 Feb year end in a common year', () => {
    expect(_fiscalYearStart(d(2027, 2, 28), FEB28)).toEqual(d(2026, 3, 1));
    expect(_fiscalYearStart(d(2027, 3, 1),  FEB28)).toEqual(d(2027, 3, 1));
    expect(span(_resolvePeriod('fy', d(2027, 2, 28), FEB28))).toBe('Mar 2026 .. Feb 2027');
  });

  test('a 29 Feb year end in a common year ends on the 28th, so 1 March starts the new year', () => {
    expect(_fiscalYearStart(d(2027, 2, 28), FEB29)).toEqual(d(2026, 3, 1));
    expect(_fiscalYearStart(d(2027, 3, 1),  FEB29)).toEqual(d(2027, 3, 1));
    expect(span(_resolvePeriod('fy', d(2027, 3, 1), FEB29))).toBe('Mar 2027 .. Feb 2028');
    // ...and in a leap year it is the 29th, as written.
    expect(_fiscalYearStart(d(2028, 2, 29), FEB29)).toEqual(d(2027, 3, 1));
    expect(_fiscalYearStart(d(2028, 3, 1),  FEB29)).toEqual(d(2028, 3, 1));
  });

  test('ordinary month-end year ends are unchanged, the year always starting on a 1st', () => {
    const cases = [
      [{ month: 12, day: 31 }, d(2026, 10, 7),  d(2026, 1, 1)],
      [{ month: 12, day: 31 }, d(2026, 12, 31), d(2026, 1, 1)],
      [{ month: 12, day: 31 }, d(2027, 1, 1),   d(2027, 1, 1)],
      [{ month: 3,  day: 31 }, d(2026, 3, 31),  d(2025, 4, 1)],
      [{ month: 3,  day: 31 }, d(2026, 4, 1),   d(2026, 4, 1)],
      [{ month: 6,  day: 30 }, d(2026, 6, 30),  d(2025, 7, 1)],
      [{ month: 6,  day: 30 }, d(2026, 7, 1),   d(2026, 7, 1)],
      [{ month: 9,  day: 30 }, d(2028, 2, 29),  d(2027, 10, 1)],
      [undefined,              d(2026, 10, 7),  d(2026, 1, 1)],   // no year end known: calendar year
    ];
    for (const [fye, today, start] of cases) expect({ fye, today, start: _fiscalYearStart(today, fye) }).toEqual({ fye, today, start });
  });

  test('every day of a leap year, for every month-end year end, falls inside its own financial year', () => {
    for (let m = 1; m <= 12; m++) {
      const fye = { month: m, day: new Date(Date.UTC(2027, m, 0)).getUTCDate() };   // the month's end in a common year
      for (let t = Date.UTC(2028, 0, 1); t < Date.UTC(2029, 0, 1); t += 86400000) {
        const dt = new Date(t);
        const today = d(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
        const keys = _resolvePeriod('fy', today, fye).months.map(x => x.key);
        const todayKey = `${today.year}-${String(today.month).padStart(2, '0')}`;
        if (!keys.includes(todayKey) || keys.length !== 12) throw new Error(`fy for ${todayKey}-${today.day}, year end ${m}/${fye.day}: ${keys[0]}..${keys[11]}`);
      }
    }
  });

  test('"Year to date" only for a span that opens the financial year and stays inside it', () => {
    const MAR  = { month: 3, day: 31 };
    const OCT7 = d(2026, 10, 7);
    expect(_toDateLabel(_monthsBetween('2026-04', '2026-09'), MAR, OCT7)).toBe('Year to date');
    expect(_toDateLabel(_monthsBetween('2026-04', '2027-03'), MAR, OCT7)).toBe('Year to date');
    expect(_toDateLabel(_monthsBetween('2026-04', '2027-04'), MAR, OCT7)).toBe('Period to date');   // 13 months
    expect(_toDateLabel(_monthsBetween('2026-05', '2026-09'), MAR, OCT7)).toBe('Period to date');   // starts mid-year
    expect(_toDateLabel(_monthsBetween('2026-01', '2026-12'), MAR, OCT7)).toBe('Period to date');
    expect(_toDateLabel(_monthsBetween('2026-01', '2026-12'), { month: 12, day: 31 }, OCT7)).toBe('Year to date');
    expect(_toDateLabel(_monthsBetween('2026-03', '2026-05'), FEB28, d(2026, 5, 20))).toBe('Year to date');
    expect(_toDateLabel([], MAR, OCT7)).toBe('Period to date');
  });

  // Opening on a financial year's first month is not enough: last year, next
  // year and this year's first quarter all do, and none of their to-date
  // figures is the year's so far. The span has to be the year today is in and
  // run at least to the last closed month.
  test('…and only the financial year today is in, read no earlier than its last closed month', () => {
    const MAR  = { month: 3, day: 31 };
    const OCT7 = d(2026, 10, 7);
    expect(_toDateLabel(_monthsBetween('2025-04', '2026-03'), MAR, OCT7)).toBe('Period to date');   // last year
    expect(_toDateLabel(_monthsBetween('2027-04', '2028-03'), MAR, OCT7)).toBe('Period to date');   // next year
    expect(_toDateLabel(_monthsBetween('2026-04', '2026-06'), MAR, OCT7)).toBe('Period to date');   // the first quarter, read in October
    expect(_toDateLabel(_monthsBetween('2026-04', '2026-08'), MAR, OCT7)).toBe('Period to date');   // stops a month short of what has closed
    expect(_toDateLabel(_monthsBetween('2026-04', '2026-09'), MAR, OCT7)).toBe('Year to date');     // exactly what has closed
    expect(_toDateLabel(_monthsBetween('2026-04', '2026-10'), MAR, OCT7)).toBe('Year to date');     // through today's month
    expect(_toDateLabel(_monthsBetween('2026-01', '2026-03'), DEC, OCT7)).toBe('Period to date');   // Jan–Mar, read in October
    expect(_toDateLabel(_monthsBetween('2026-01', '2026-10'), DEC, OCT7)).toBe('Year to date');
    // The year's first month, with nothing closed yet, is still the year to date.
    expect(_toDateLabel(_monthsBetween('2026-04', '2026-04'), MAR, d(2026, 4, 7))).toBe('Year to date');
    expect(_toDateLabel(_monthsBetween('2026-04', '2027-03'), MAR, d(2026, 4, 1))).toBe('Year to date');
    // Without today there is no telling, so no claim is made.
    expect(_toDateLabel(_monthsBetween('2026-04', '2026-09'), MAR)).toBe('Period to date');
    expect(_toDateLabel(_monthsBetween('2026-04', '2026-09'), MAR, null)).toBe('Period to date');
  });

  test('so of the presets only the two that are this financial year read as a year to date', () => {
    const MAR  = { month: 3, day: 31 };
    const OCT7 = d(2026, 10, 7);
    const label = (preset, fye = MAR) => _toDateLabel(_resolvePeriod(preset, OCT7, fye).months, fye, OCT7);
    expect(['fy', 'fy-ytd'].map(p => label(p))).toEqual(['Year to date', 'Year to date']);
    for (const p of ['prev-fy', 'next-fy', 'last-12', 'rolling', 'last-6', 'last-3', 'this-quarter', 'last-quarter', 'this-month', 'last-month', 'cy', 'cy-ytd']) {
      expect({ p, label: label(p) }).toEqual({ p, label: 'Period to date' });
    }
    // For a December year end the calendar presets are the financial ones.
    expect(['cy', 'cy-ytd', 'fy', 'fy-ytd'].map(p => label(p, DEC))).toEqual(Array(4).fill('Year to date'));
    expect(['prev-fy', 'next-fy'].map(p => label(p, DEC))).toEqual(['Period to date', 'Period to date']);
  });
});

// A year end that is not the last day of its month: 5 April, as in the UK.
// In whole months its year opens in April itself — most of April is on the
// new year's side of the 5th — and the first days of April go with it, since
// a month can only be in one year and the year must always contain today.
// Starting the year in May, as for a month-end year end, put every April
// outside both years.
describe('xero/periods — a year end that is not the end of its month', () => {
  const { _fiscalYearStart, _toDateLabel, _monthsBetween } = periods;
  const span = w => `${w.months[0].label} .. ${w.months[w.months.length - 1].label}`;
  const d = (year, month, day) => ({ year, month, day });
  const APR5  = { month: 4, day: 5 };
  const DEC15 = { month: 12, day: 15 };

  test('today 6–30 April: the year opened this April, so year to date is April alone', () => {
    for (const day of [6, 15, 30]) {
      expect(_fiscalYearStart(d(2026, 4, day), APR5)).toEqual(d(2026, 4, 1));
      expect(span(_resolvePeriod('fy-ytd', d(2026, 4, day), APR5))).toBe('Apr 2026 .. Apr 2026');
      expect(span(_resolvePeriod('fy',     d(2026, 4, day), APR5))).toBe('Apr 2026 .. Mar 2027');
    }
  });

  test('the first days of April go with it, and March is the old year\'s last month', () => {
    expect(_fiscalYearStart(d(2026, 4, 1), APR5)).toEqual(d(2026, 4, 1));
    expect(_fiscalYearStart(d(2026, 4, 5), APR5)).toEqual(d(2026, 4, 1));
    expect(_fiscalYearStart(d(2026, 3, 31), APR5)).toEqual(d(2025, 4, 1));
    expect(span(_resolvePeriod('fy',      d(2026, 3, 31), APR5))).toBe('Apr 2025 .. Mar 2026');
    expect(span(_resolvePeriod('fy-ytd',  d(2026, 10, 7), APR5))).toBe('Apr 2026 .. Oct 2026');
    expect(span(_resolvePeriod('prev-fy', d(2026, 10, 7), APR5))).toBe('Apr 2025 .. Mar 2026');
    expect(span(_resolvePeriod('next-fy', d(2026, 10, 7), APR5))).toBe('Apr 2027 .. Mar 2028');
  });

  test('a mid-December year end opens its year in December', () => {
    expect(_fiscalYearStart(d(2026, 12, 20), DEC15)).toEqual(d(2026, 12, 1));
    expect(_fiscalYearStart(d(2026, 12, 3),  DEC15)).toEqual(d(2026, 12, 1));
    expect(_fiscalYearStart(d(2026, 11, 30), DEC15)).toEqual(d(2025, 12, 1));
    expect(span(_resolvePeriod('fy', d(2027, 1, 10), DEC15))).toBe('Dec 2026 .. Nov 2027');
  });

  test('every day of a leap year, for a year end on the 5th of every month, falls inside its own twelve-month year', () => {
    for (let m = 1; m <= 12; m++) {
      const fye = { month: m, day: 5 };
      for (let t = Date.UTC(2028, 0, 1); t < Date.UTC(2029, 0, 1); t += 86400000) {
        const dt = new Date(t);
        const today = d(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
        const keys = _resolvePeriod('fy', today, fye).months.map(x => x.key);
        const todayKey = `${today.year}-${String(today.month).padStart(2, '0')}`;
        if (!keys.includes(todayKey) || keys.length !== 12 || +keys[0].slice(5) !== m) throw new Error(`fy for ${todayKey}-${today.day}, year end ${m}/5: ${keys[0]}..${keys[11]}`);
      }
    }
  });

  test('a month-end year end is read exactly as before, the 29th or 28th of February included', () => {
    expect(_fiscalYearStart(d(2026, 4, 1),  { month: 3, day: 31 })).toEqual(d(2026, 4, 1));
    expect(_fiscalYearStart(d(2026, 3, 31), { month: 3, day: 31 })).toEqual(d(2025, 4, 1));
    expect(_fiscalYearStart(d(2026, 7, 1),  { month: 6, day: 30 })).toEqual(d(2026, 7, 1));
    expect(_fiscalYearStart(d(2028, 2, 29), { month: 2, day: 28 })).toEqual(d(2027, 3, 1));
    expect(_fiscalYearStart(d(2027, 3, 1),  { month: 2, day: 29 })).toEqual(d(2027, 3, 1));
    // A day past the month's end (a stored value that cannot be) is a month end too.
    expect(_fiscalYearStart(d(2026, 5, 1),  { month: 4, day: 31 })).toEqual(d(2026, 5, 1));
  });

  test('"Year to date" follows the same first month', () => {
    const OCT7 = d(2026, 10, 7);
    expect(_toDateLabel(_monthsBetween('2026-04', '2026-09'), APR5, OCT7)).toBe('Year to date');
    expect(_toDateLabel(_monthsBetween('2026-04', '2027-03'), APR5, OCT7)).toBe('Year to date');
    expect(_toDateLabel(_monthsBetween('2026-05', '2026-09'), APR5, OCT7)).toBe('Period to date');
    expect(_toDateLabel(_monthsBetween('2025-04', '2026-03'), APR5, OCT7)).toBe('Period to date');
    expect(_toDateLabel(_resolvePeriod('fy-ytd', d(2026, 4, 20), APR5).months, APR5, d(2026, 4, 20))).toBe('Year to date');
  });
});
