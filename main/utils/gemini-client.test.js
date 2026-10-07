jest.mock('axios');
jest.mock('./users', () => ({
  getGeminiKeys: jest.fn(),
  getUserConfig: jest.fn(),
}));
jest.mock('./logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const axios = require('axios');
const logger = require('./logger');
const { getGeminiKeys, getUserConfig } = require('./users');

function httpError(status, message = `http ${status}`, data) {
  const err = new Error(message);
  err.response = { status, data };
  return err;
}
const quotaError = () => httpError(429, 'quota exceeded');
const authError  = () => httpError(401, 'invalid api key');

function okResponse(text, finish_reason = 'stop', usage) {
  return { data: { choices: [{ message: { content: text }, finish_reason }], usage } };
}

const modelOf = call => call[1].model;
const keyOf   = call => call[2].headers.Authorization.replace('Bearer ', '');

describe('gemini-client rotation', () => {
  const { callGemini, GEMINI_MODELS, geminiModels } = require('./gemini-client');

  // The limiter allows 15 calls a minute per user, so each test is its own user
  // and never waits on the calls an earlier test made.
  let uid, n = 0;
  beforeEach(() => {
    uid = `user-${++n}`;
    jest.clearAllMocks();
    axios.post.mockReset();
    getGeminiKeys.mockReturnValue([]);
    getUserConfig.mockReturnValue({});
    delete process.env.Gemini_API_KEY;
    delete process.env.GEMINI_MODELS;
  });

  test('throws a clear error when no key is configured anywhere', async () => {
    await expect(callGemini(uid, [])).rejects.toThrow('No Gemini API key configured');
  });

  test('falls back to legacy single Gemini_API_KEY when no multi-keys exist', async () => {
    getUserConfig.mockReturnValue({ Gemini_API_KEY: 'legacy-key' });
    axios.post.mockResolvedValue(okResponse('hi'));

    const result = await callGemini(uid, [{ role: 'user', content: 'hi' }]);
    expect(result).toBe('hi');
    expect(axios.post.mock.calls[0][2].headers.Authorization).toBe('Bearer legacy-key');
  });

  test('rotates through every model on the same key before failing', async () => {
    getGeminiKeys.mockReturnValue([{ apiKey: 'key-1' }]);
    axios.post.mockRejectedValue(quotaError());

    await expect(callGemini(uid, [])).rejects.toThrow('quota exceeded');
    // GEMINI_MODELS has 2 entries — both should have been tried on the one key.
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  test('only moves to the next key once every model on the current key is exhausted', async () => {
    getGeminiKeys.mockReturnValue([{ apiKey: 'key-1' }, { apiKey: 'key-2' }]);
    axios.post
      .mockRejectedValueOnce(quotaError()) // key-1, model A
      .mockRejectedValueOnce(quotaError()) // key-1, model B
      .mockResolvedValueOnce(okResponse('ok from key-2')); // key-2, model A

    const result = await callGemini(uid, []);
    expect(result).toBe('ok from key-2');
    expect(axios.post).toHaveBeenCalledTimes(3);
    expect(axios.post.mock.calls[2][2].headers.Authorization).toBe('Bearer key-2');
  });

  test('a malformed request fails fast without trying remaining models/keys', async () => {
    getGeminiKeys.mockReturnValue([{ apiKey: 'key-1' }, { apiKey: 'key-2' }]);
    axios.post.mockRejectedValue(httpError(400, 'bad request', { error: { message: 'Invalid JSON payload' } }));

    await expect(callGemini(uid, [])).rejects.toThrow('bad request');
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('multi-keys take priority over the legacy single-field value', async () => {
    getGeminiKeys.mockReturnValue([{ apiKey: 'key-multi' }]);
    getUserConfig.mockReturnValue({ Gemini_API_KEY: 'key-legacy' });
    axios.post.mockResolvedValue(okResponse('ok'));

    await callGemini(uid, []);
    expect(axios.post.mock.calls[0][2].headers.Authorization).toBe('Bearer key-multi');
  });

  // ── Outages: a retired model, a server fault, a refused key ───────────────

  describe.each([
    ['a 404 (retired model)', () => httpError(404, 'models/x is not found')],
    ['a 500', () => httpError(500, 'internal')],
    ['a 502', () => httpError(502, 'bad gateway')],
    ['a timeout', () => Object.assign(new Error('timeout of 120000ms exceeded'), { code: 'ECONNABORTED' })],
    ['an empty reply', null],
  ])('%s on the first model', (_label, makeErr) => {
    test('tries the next model on the same key', async () => {
      getGeminiKeys.mockReturnValue([{ apiKey: 'key-1' }, { apiKey: 'key-2' }]);
      if (makeErr) axios.post.mockRejectedValueOnce(makeErr());
      else axios.post.mockResolvedValueOnce({ data: { choices: [{ message: { content: '' }, finish_reason: 'stop' }] } });
      axios.post.mockResolvedValueOnce(okResponse('from model B'));

      await expect(callGemini(uid, [])).resolves.toBe('from model B');
      expect(axios.post.mock.calls.map(modelOf)).toEqual(GEMINI_MODELS);
      expect(axios.post.mock.calls.map(keyOf)).toEqual(['key-1', 'key-1']);
    });
  });

  test('a 400 that names an unknown model counts as a retired model, not a bad request', async () => {
    getGeminiKeys.mockReturnValue([{ apiKey: 'key-1' }]);
    axios.post
      .mockRejectedValueOnce(httpError(400, 'bad', { error: { message: 'model gemini-old is not found for API version v1beta' } }))
      .mockResolvedValueOnce(okResponse('ok'));
    await expect(callGemini(uid, [])).resolves.toBe('ok');
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  test('a retired model is not asked again on the next key', async () => {
    getGeminiKeys.mockReturnValue([{ apiKey: 'key-1' }, { apiKey: 'key-2' }]);
    axios.post
      .mockRejectedValueOnce(httpError(404, 'not found'))  // key-1, model A (retired)
      .mockRejectedValueOnce(quotaError())                 // key-1, model B (quota)
      .mockResolvedValueOnce(okResponse('ok'));            // key-2, model B
    await expect(callGemini(uid, [])).resolves.toBe('ok');
    expect(axios.post.mock.calls.map(c => `${keyOf(c)}:${modelOf(c)}`)).toEqual([
      `key-1:${GEMINI_MODELS[0]}`, `key-1:${GEMINI_MODELS[1]}`, `key-2:${GEMINI_MODELS[1]}`,
    ]);
  });

  test('server faults on every model do not walk every other key — another key cannot fix them', async () => {
    getGeminiKeys.mockReturnValue([{ apiKey: 'key-1' }, { apiKey: 'key-2' }, { apiKey: 'key-3' }]);
    axios.post.mockRejectedValue(httpError(500, 'internal'));
    await expect(callGemini(uid, [])).rejects.toThrow('internal');
    expect(axios.post).toHaveBeenCalledTimes(GEMINI_MODELS.length);
  });

  test.each([401, 403])('a %i on one key tries the next key instead of failing every key', async (status) => {
    getGeminiKeys.mockReturnValue([{ apiKey: 'key-1' }, { apiKey: 'key-2' }]);
    axios.post
      .mockRejectedValueOnce(httpError(status, 'invalid api key'))
      .mockResolvedValueOnce(okResponse('ok from key-2'));
    await expect(callGemini(uid, [])).resolves.toBe('ok from key-2');
    // Straight to the next key: the refused key is refused on every model.
    expect(axios.post.mock.calls.map(keyOf)).toEqual(['key-1', 'key-2']);
    expect(axios.post.mock.calls[1][1].model).toBe(GEMINI_MODELS[0]);
  });

  test('every key refused fails with the refusal', async () => {
    getGeminiKeys.mockReturnValue([{ apiKey: 'key-1' }, { apiKey: 'key-2' }]);
    axios.post.mockRejectedValue(authError());
    await expect(callGemini(uid, [])).rejects.toThrow('invalid api key');
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  // ── A reply cut off at max_tokens ─────────────────────────────────────────

  test('a reply cut off at max_tokens is asked for once more, with a larger limit', async () => {
    getGeminiKeys.mockReturnValue([{ apiKey: 'key-1' }]);
    axios.post
      .mockResolvedValueOnce(okResponse('{"reply": "half', 'length'))
      .mockResolvedValueOnce(okResponse('{"reply": "whole"}', 'stop'));

    await expect(callGemini(uid, [], { maxTokens: 800 })).resolves.toBe('{"reply": "whole"}');
    expect(axios.post).toHaveBeenCalledTimes(2);
    const [first, second] = axios.post.mock.calls.map(c => c[1]);
    expect(first.max_tokens).toBe(800);
    expect(second.max_tokens).toBeGreaterThan(800);
    expect(second.model).toBe(first.model);
  });

  test('a reply cut off twice fails as a truncation and is never sent identically again', async () => {
    getGeminiKeys.mockReturnValue([{ apiKey: 'key-1' }, { apiKey: 'key-2' }]);
    axios.post.mockResolvedValue(okResponse('{"partial', 'length'));

    const err = await callGemini(uid, [], { maxTokens: 800 }).catch(e => e);
    expect(err.code).toBe('GEMINI_TRUNCATED');
    expect(err.partial).toBe('{"partial');
    expect(require('./gemini-client').isTruncation(err)).toBe(true);
    // One original, one larger retry — no other model, no other key, no repeat.
    expect(axios.post).toHaveBeenCalledTimes(2);
    const limits = axios.post.mock.calls.map(c => c[1].max_tokens);
    expect(new Set(limits).size).toBe(2);
  });

  test('an empty reply marked "length" (all tokens spent thinking) is a truncation, not an empty reply', async () => {
    getGeminiKeys.mockReturnValue([{ apiKey: 'key-1' }]);
    axios.post
      .mockResolvedValueOnce({ data: { choices: [{ message: { content: null }, finish_reason: 'length' }] } })
      .mockResolvedValueOnce(okResponse('ok'));
    await expect(callGemini(uid, [], { maxTokens: 500 })).resolves.toBe('ok');
    expect(axios.post.mock.calls[1][1].max_tokens).toBeGreaterThan(500);
  });

  // ── Configuration and logging ─────────────────────────────────────────────

  test('the model list comes from GEMINI_MODELS when set, else the built-in list', async () => {
    expect(geminiModels()).toEqual(GEMINI_MODELS);
    process.env.GEMINI_MODELS = ' gemini-new-flash , gemini-new-pro,,gemini-new-flash ';
    expect(geminiModels()).toEqual(['gemini-new-flash', 'gemini-new-pro']);

    getGeminiKeys.mockReturnValue([{ apiKey: 'key-1' }]);
    axios.post.mockRejectedValueOnce(quotaError()).mockResolvedValueOnce(okResponse('ok'));
    await callGemini(uid, []);
    expect(axios.post.mock.calls.map(modelOf)).toEqual(['gemini-new-flash', 'gemini-new-pro']);
  });

  test('each call logs model, finish_reason and token usage — never the prompt', async () => {
    getGeminiKeys.mockReturnValue([{ apiKey: 'key-1' }]);
    axios.post.mockResolvedValue(okResponse('the reply', 'stop', { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }));
    await callGemini(uid, [{ role: 'user', content: 'SECRET INVOICE TEXT' }]);

    const call = logger.info.mock.calls.find(([msg]) => msg === 'Gemini call');
    expect(call[1]).toMatchObject({
      model: GEMINI_MODELS[0], finishReason: 'stop', promptTokens: 120, completionTokens: 30, totalTokens: 150,
    });
    const everything = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls]);
    expect(everything).not.toContain('SECRET INVOICE TEXT');
    expect(everything).not.toContain('the reply');
  });
});
