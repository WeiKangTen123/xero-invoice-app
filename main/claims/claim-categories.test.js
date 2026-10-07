const { normaliseSuggestions, linesNeedingCategory, suggestCategories, _prompt } = require('./claim-categories');

// The categories come from the company's own form. Anything the model returns
// that is not one of them is discarded — a suggested category that does not
// exist on the form cannot be ticked, and inventing one would quietly introduce
// a category nobody agreed to.
const CATEGORIES = ['HOTEL ACCOMODATION (SGD)', 'ENTERTAINMENT/MEALS (SGD)', 'LOCAL TRAVEL COST (SGD)'];
const line = (no, description, category = null, merchant = null) =>
  ({ row: { no, description, category }, receipt: merchant ? { merchant } : null });

describe('claims/claim-categories', () => {
  describe('which lines get asked about', () => {
    test('only lines the claimant left blank', () => {
      // Their answer is never overwritten, and asking wastes a call.
      const lines = linesNeedingCategory([
        line(1, 'Grab to meeting'),
        line(2, 'Hotel in KL', 'HOTEL ACCOMODATION (SGD)'),
        line(3, 'Taxi home'),
      ]);
      expect(lines.map(l => l.rowNo)).toEqual(['1', '3']);
    });

    test('the receipt merchant is included as evidence when known', () => {
      expect(linesNeedingCategory([line(1, 'transport', null, 'Grab')])[0].merchant).toBe('Grab');
    });
  });

  describe('what comes back is filtered', () => {
    const lines = [{ rowNo: '1', description: 'Grab to meeting' }, { rowNo: '2', description: 'Lunch' }];

    test('keeps a suggestion naming a real category', () => {
      const out = normaliseSuggestions(
        [{ rowNo: '1', category: 'LOCAL TRAVEL COST (SGD)', confidence: 'high' }], lines, CATEGORIES);
      expect(out).toEqual([{ rowNo: '1', category: 'LOCAL TRAVEL COST (SGD)', confidence: 'high' }]);
    });

    test('an invented category is discarded, not passed through', () => {
      // The whole guard: a category that is not on the form cannot be ticked.
      const out = normaliseSuggestions([{ rowNo: '1', category: 'TAXIS AND RIDES' }], lines, CATEGORIES);
      expect(out).toEqual([]);
    });

    test('a reworded category is discarded too', () => {
      const out = normaliseSuggestions([{ rowNo: '1', category: 'Local travel' }], lines, CATEGORIES);
      expect(out).toEqual([]);
    });

    test('matching survives whitespace and case differences on the form heading', () => {
      // Real headings wrap: "LOCAL TRAVEL COST\n(SGD)".
      const out = normaliseSuggestions([{ rowNo: '1', category: 'local travel cost  (sgd)' }], lines, CATEGORIES);
      expect(out[0].category).toBe('LOCAL TRAVEL COST (SGD)');
    });

    test('a suggestion for a line we never asked about is ignored', () => {
      expect(normaliseSuggestions([{ rowNo: '99', category: CATEGORIES[0] }], lines, CATEGORIES)).toEqual([]);
    });

    test('only the first suggestion per line is kept', () => {
      const out = normaliseSuggestions(
        [{ rowNo: '1', category: CATEGORIES[0] }, { rowNo: '1', category: CATEGORIES[2] }], lines, CATEGORIES);
      expect(out).toHaveLength(1);
    });

    test('a null category is dropped rather than stored as a guess', () => {
      expect(normaliseSuggestions([{ rowNo: '1', category: null }], lines, CATEGORIES)).toEqual([]);
    });

    test('confidence defaults to low unless the model says high', () => {
      expect(normaliseSuggestions([{ rowNo: '1', category: CATEGORIES[0], confidence: 'medium' }], lines, CATEGORIES)[0].confidence).toBe('low');
    });

    test('junk shapes are handled', () => {
      expect(normaliseSuggestions(null, lines, CATEGORIES)).toEqual([]);
      expect(normaliseSuggestions('nope', lines, CATEGORIES)).toEqual([]);
      expect(normaliseSuggestions([null, 42, 'x'], lines, CATEGORIES)).toEqual([]);
    });
  });

  describe('suggestCategories', () => {
    test('asks only about blank lines and returns filtered suggestions', async () => {
      const callGemini = jest.fn().mockResolvedValue(JSON.stringify([
        { rowNo: '1', category: 'LOCAL TRAVEL COST (SGD)', confidence: 'high' },
      ]));
      const out = await suggestCategories('u1', [line(1, 'Grab to meeting'), line(2, 'Hotel', CATEGORIES[0])], CATEGORIES, { callGemini });
      expect(out).toHaveLength(1);
      const prompt = callGemini.mock.calls[0][1].find(m => m.role === 'user').content;
      expect(prompt).toContain('Grab to meeting');
      expect(prompt).not.toContain('Hotel');       // already answered
    });

    test('a model failure yields no suggestions rather than an error', async () => {
      // A missing category is a blank field for a person, not a broken import.
      const callGemini = jest.fn().mockRejectedValue(new Error('quota'));
      await expect(suggestCategories('u1', [line(1, 'x')], CATEGORIES, { callGemini })).resolves.toEqual([]);
    });

    test('nothing to ask means no call at all', async () => {
      const callGemini = jest.fn();
      expect(await suggestCategories('u1', [line(1, 'x', CATEGORIES[0])], CATEGORIES, { callGemini })).toEqual([]);
      expect(await suggestCategories('u1', [line(1, 'x')], [], { callGemini })).toEqual([]);
      expect(callGemini).not.toHaveBeenCalled();
    });

    test('a long form is asked about in chunks, and one failed chunk keeps the others', async () => {
      // All lines in one 800-token call came back cut off on a long form, and
      // every suggestion was lost with it.
      const { CHUNK_SIZE } = require('./claim-categories');
      const many = Array.from({ length: CHUNK_SIZE * 2 + 3 }, (_, i) => line(i + 1, `Trip ${i + 1}`));
      const callGemini = jest.fn()
        .mockImplementationOnce(async () => JSON.stringify([{ rowNo: '1', category: CATEGORIES[2] }]))
        .mockImplementationOnce(async () => { throw new Error('quota'); })
        .mockImplementationOnce(async () => JSON.stringify([{ rowNo: String(CHUNK_SIZE * 2 + 1), category: CATEGORIES[1] }]));
      const out = await suggestCategories('u1', many, CATEGORIES, { callGemini });
      expect(callGemini).toHaveBeenCalledTimes(3);
      const asked = callGemini.mock.calls.map(c => c[1].find(m => m.role === 'user').content);
      expect(asked[0]).toContain('Trip 1');
      expect(asked[0]).not.toContain(`Trip ${CHUNK_SIZE + 1}.`);
      expect(asked[2]).toContain(`Trip ${CHUNK_SIZE * 2 + 3}`);
      expect(out.map(s => String(s.rowNo))).toEqual(['1', String(CHUNK_SIZE * 2 + 1)]);
    });

    test('the prompt forbids inventing a category', () => {
      const p = _prompt([{ rowNo: '1', description: 'x' }], CATEGORIES);
      expect(p).toMatch(/Never invent one/i);
      expect(p).toMatch(/THE ONLY CATEGORIES ALLOWED/);
    });
  });
});
