// The category suggestion is held to a schema built from the company's own
// form: the category is an enum of its headings (or null), the row an enum of
// the lines asked about. An invented category cannot come back at all;
// normaliseSuggestions still filters, for the plain-JSON fallback.
const { suggestCategories, responseFormat } = require('./claim-categories');

const CATEGORIES = ['HOTEL ACCOMODATION (SGD)', 'ENTERTAINMENT/MEALS (SGD)', 'LOCAL TRAVEL COST\n(SGD)'];
const line = (no, description, category = null) => ({ row: { no, description, category }, receipt: null });

test('the call carries a schema naming the form\'s categories and the rows asked about', async () => {
  const callGemini = jest.fn().mockResolvedValue(JSON.stringify({ suggestions: [] }));
  await suggestCategories('u1', [line(1, 'Grab to meeting'), line(2, 'Hotel', CATEGORIES[0]), line(3, 'Lunch')], CATEGORIES, { callGemini });
  const { responseFormat: format } = callGemini.mock.calls[0][2];
  expect(format.type).toBe('json_schema');
  expect(format.json_schema.name).toBe('claim_categories');
  const item = format.json_schema.schema.properties.suggestions.items;
  // Only the blank lines: line 2 already has the claimant's own answer.
  expect(item.properties.rowNo.enum).toEqual(['1', '3']);
  // Headings with their wrapping folded, the way they are matched back.
  expect(item.properties.category).toEqual({ anyOf: [
    { type: 'string', enum: ['HOTEL ACCOMODATION (SGD)', 'ENTERTAINMENT/MEALS (SGD)', 'LOCAL TRAVEL COST (SGD)'] },
    { type: 'null' },
  ] });
  expect(item.properties.confidence.enum).toEqual(['high', 'low']);
});

test('the object reply the schema asks for is read, and the folded heading maps back to the form\'s own text', async () => {
  const callGemini = jest.fn().mockResolvedValue(JSON.stringify({ suggestions: [
    { rowNo: '1', category: 'LOCAL TRAVEL COST (SGD)', confidence: 'high' },
    { rowNo: '3', category: null, confidence: 'low' },
  ] }));
  const out = await suggestCategories('u1', [line(1, 'Grab to meeting'), line(3, 'Misc')], CATEGORIES, { callGemini });
  expect(out).toEqual([{ rowNo: '1', category: 'LOCAL TRAVEL COST\n(SGD)', confidence: 'high' }]);
});

test('each chunk gets a schema for its own rows', () => {
  const f = responseFormat([{ rowNo: '26' }, { rowNo: '27' }], CATEGORIES);
  expect(f.json_schema.schema.properties.suggestions.items.properties.rowNo.enum).toEqual(['26', '27']);
});
