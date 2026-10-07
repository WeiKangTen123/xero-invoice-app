// The model calls behind the Insights page, over figures already computed.
//
// Variance commentary: asked for with a schema, and a reply that cannot be
// read — or a call that fails — comes back as the computed defaults, marked
// source 'figures' with a short cache life, never as though the model had
// answered (it was labelled 'gemini' and cached for thirty minutes).
//
// Narrative: a cut-off reply is not sent again identically.
const ai = require('./ai-insights');

const categories = [
  { key: 'revenue', title: 'Revenue mix', actual: 50000, budget: 45000, variance: 5000, topDrivers: [], defaultReason: 'rev default' },
  { key: 'opex', title: 'Operating expense', actual: 20000, budget: 21000, variance: -1000, topDrivers: [], defaultReason: 'opex default' },
];
const candidates = [{ account: 'Consulting Income', actual: 30000, budget: 25000, variance: 5000 }];
const ask = callGemini => ai.requestVarianceInsights('u1', { org: 'Acme', fyLabel: 'FY2026', closed: 3, categories, candidates }, { callGemini });

describe('requestVarianceInsights', () => {
  test('asks with the insights schema, account names held to the ones it was shown', async () => {
    const callGemini = jest.fn().mockResolvedValue(JSON.stringify({ categories: [], reasons: [] }));
    await ask(callGemini);
    const { responseFormat } = callGemini.mock.calls[0][2];
    expect(responseFormat.type).toBe('json_schema');
    expect(responseFormat.json_schema.name).toBe('variance_insights');
    const schema = responseFormat.json_schema.schema;
    expect(schema.required).toEqual(['categories', 'reasons']);
    expect(schema.properties.categories.items.properties.key.enum).toEqual(['revenue', 'delivery', 'opex', 'cash']);
    expect(schema.properties.reasons.items.properties.account.enum).toEqual(['Consulting Income']);
  });

  test('an answer is source "gemini", cached on the caller\'s own TTL', async () => {
    const callGemini = jest.fn().mockResolvedValue(JSON.stringify({
      categories: [{ key: 'revenue', reason: 'Consulting ran ahead of plan.' }],
      reasons: [{ account: 'Consulting Income', reason: 'Two new retainers.' }],
    }));
    const out = await ask(callGemini);
    expect(out.source).toBe('gemini');
    expect(out.failed).toBeUndefined();
    expect(out.cacheTtlMs).toBeNull();
    expect(out.categories[0].reason).toBe('Consulting ran ahead of plan.');
    expect(out.lines[0].reason).toBe('Two new retainers.');
  });

  test('a reply that cannot be read is the defaults, marked, with a short cache life', async () => {
    const out = await ask(jest.fn().mockResolvedValue('Sorry, I cannot help with that.'));
    expect(out.source).toBe('figures');
    expect(out.failed).toBe('unparsed');
    expect(out.cacheTtlMs).toBe(ai.INSIGHT_FAILURE_TTL_MS);
    expect(out.cacheTtlMs).toBeLessThan(30 * 60 * 1000);
    expect(out.categories.map(c => c.reason)).toEqual(['rev default', 'opex default']);
    expect(out.lines).toBe(candidates);
  });

  test('a failed call and a cut-off reply are marked the same way, and say which', async () => {
    const failed = await ask(jest.fn().mockRejectedValue(new Error('quota')));
    expect(failed).toMatchObject({ source: 'figures', failed: 'unavailable', cacheTtlMs: ai.INSIGHT_FAILURE_TTL_MS });
    const cut = await ask(jest.fn().mockRejectedValue(Object.assign(new Error('cut'), { code: 'GEMINI_TRUNCATED' })));
    expect(cut).toMatchObject({ source: 'figures', failed: 'truncated' });
  });

  test('_parseInsights itself carries the marker, for a caller that parses on its own', () => {
    const out = ai._parseInsights('not json', categories, candidates);
    expect(out).toMatchObject({ source: 'figures', failed: 'unparsed', cacheTtlMs: ai.INSIGHT_FAILURE_TTL_MS });
    // The older accounts-only form keeps its contract.
    expect(ai._parseInsights('not json', candidates)).toEqual([]);
  });

  test('a schema shapes the reply, it does not ground it: an invented figure is still dropped', async () => {
    const callGemini = jest.fn().mockResolvedValue(JSON.stringify({
      categories: [{ key: 'revenue', reason: 'Revenue beat plan by SGD 987,654.' }], reasons: [],
    }));
    const out = await ask(callGemini);
    expect(out.source).toBe('gemini');
    expect(out.categories[0].reason).toBe('rev default');
  });
});

describe('requestNarrative', () => {
  const facts = ai._narrativeFacts({ period: { label: 'FY2026' }, workingCapital: { receivable: 1000 }, organisation: { currency: 'SGD' } });

  test('a cut-off reply is not asked for again', async () => {
    const callGemini = jest.fn().mockRejectedValue(Object.assign(new Error('cut off'), { code: 'GEMINI_TRUNCATED' }));
    const out = await ai.requestNarrative('u1', facts, { callGemini, delayMs: 0 });
    expect(callGemini).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ raw: null, reason: 'truncated' });
  });

  test('any other failure gets its second attempt', async () => {
    const callGemini = jest.fn()
      .mockRejectedValueOnce(new Error('quota'))
      .mockResolvedValueOnce('Your customers are paying slowly.');
    const out = await ai.requestNarrative('u1', facts, { callGemini, delayMs: 0 });
    expect(callGemini).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ raw: 'Your customers are paying slowly.', reason: null });
  });

  test('two failures are "unavailable"', async () => {
    const callGemini = jest.fn().mockRejectedValue(new Error('quota'));
    const out = await ai.requestNarrative('u1', facts, { callGemini, delayMs: 0 });
    expect(callGemini).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ raw: null, reason: 'unavailable' });
  });

  test('the request is the narrative prompt, plain text — no schema', async () => {
    const callGemini = jest.fn().mockResolvedValue('Fine.');
    await ai.requestNarrative('u1', facts, { callGemini });
    const [, messages, opts] = callGemini.mock.calls[0];
    expect(messages[1].content).toBe(ai._narrativePrompt(facts));
    expect(opts.responseFormat).toBeUndefined();
  });
});
