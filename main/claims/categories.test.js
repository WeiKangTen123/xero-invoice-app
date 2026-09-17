const { CATEGORIES, CATEGORY_NAMES, canonicalCategory } = require('./categories');

describe('claims/categories — the one list every reader and matcher shares', () => {
  test('ten named categories, each with a scope line for the prompt', () => {
    expect(CATEGORY_NAMES).toHaveLength(10);
    for (const c of CATEGORIES) {
      expect(typeof c.name).toBe('string');
      expect(c.scope.length).toBeGreaterThan(10);
    }
    expect(new Set(CATEGORY_NAMES).size).toBe(10);
  });

  test('canonicalCategory forgives case and spacing, and rejects anything else', () => {
    expect(canonicalCategory(' staff  welfare ')).toBe('Staff Welfare');
    expect(canonicalCategory('Entertainment / Meals')).toBe('Entertainment/Meals');
    expect(canonicalCategory('SOFTWARE/UTILITIES')).toBe('Software/Utilities');
    expect(canonicalCategory('Bribes')).toBeNull();
    expect(canonicalCategory(null)).toBeNull();
    expect(canonicalCategory(42)).toBeNull();
  });
});
