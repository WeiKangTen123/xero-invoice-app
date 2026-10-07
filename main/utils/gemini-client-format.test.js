// Structured output. Callers pass a JSON Schema as opts.responseFormat and it
// goes to the endpoint as OpenAI's response_format. A schema the endpoint
// refuses (400) must not stop the call: it is asked once more in plain JSON
// mode, the refusal is logged and remembered, and a 400 that has nothing to do
// with the schema still fails fast.
jest.mock('axios');
jest.mock('./users', () => ({ getGeminiKeys: jest.fn(), getUserConfig: jest.fn() }));
jest.mock('./logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const axios = require('axios');
const logger = require('./logger');
const { getGeminiKeys, getUserConfig } = require('./users');
const { callGemini, PLAIN_JSON, _refusedSchemas } = require('./gemini-client');
const { jsonSchemaFormat, nullable } = require('./llm-json');

const ok = text => ({ data: { choices: [{ message: { content: text }, finish_reason: 'stop' }] } });
const cutOff = text => ({ data: { choices: [{ message: { content: text }, finish_reason: 'length' }] } });
function badRequest(message) {
  const err = new Error('Request failed with status code 400');
  err.response = { status: 400, data: { error: { code: 400, message } } };
  return err;
}
const sent = i => axios.post.mock.calls[i][1];

const FORMAT = jsonSchemaFormat('thing', {
  type: 'object', properties: { name: nullable({ type: 'string' }) }, required: ['name'],
});

let uid, n = 0;
beforeEach(() => {
  uid = `fmt-${++n}`;
  jest.clearAllMocks();
  axios.post.mockReset();
  _refusedSchemas.clear();
  getGeminiKeys.mockReturnValue([{ apiKey: 'k1' }]);
  getUserConfig.mockReturnValue({});
  delete process.env.GEMINI_MODELS;
});

test('the schema is sent as response_format in the shape the endpoint documents', async () => {
  axios.post.mockResolvedValue(ok('{"name":"x"}'));
  await callGemini(uid, [{ role: 'user', content: 'hi' }], { responseFormat: FORMAT });
  expect(sent(0).response_format).toEqual({
    type: 'json_schema',
    json_schema: { name: 'thing', schema: { type: 'object', properties: { name: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['name'] } },
  });
});

test('no format asked for, none sent — chat and the narrative are unchanged', async () => {
  axios.post.mockResolvedValue(ok('hello'));
  await callGemini(uid, [{ role: 'user', content: 'hi' }]);
  expect(sent(0)).not.toHaveProperty('response_format');
});

test('a refused schema (400) is asked once more in plain JSON mode, and the refusal is logged', async () => {
  axios.post
    .mockRejectedValueOnce(badRequest('Invalid JSON payload received. Unknown name "anyOf"'))
    .mockResolvedValueOnce(ok('{"name":"x"}'));
  const out = await callGemini(uid, [{ role: 'user', content: 'hi' }], { responseFormat: FORMAT });
  expect(out).toBe('{"name":"x"}');
  expect(axios.post).toHaveBeenCalledTimes(2);
  expect(sent(1).response_format).toEqual({ type: 'json_object' });
  expect(sent(1).response_format).toEqual(PLAIN_JSON);
  // Same model, same key: it is the schema that changed, nothing else.
  expect(sent(1).model).toBe(sent(0).model);
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('refused the "thing" response schema'), expect.objectContaining({ schema: 'thing' }));
});

test('once refused, that model is not sent that schema again — no wasted request per call', async () => {
  axios.post
    .mockRejectedValueOnce(badRequest('Unknown name "anyOf"'))
    .mockResolvedValueOnce(ok('{"name":"a"}'))
    .mockResolvedValueOnce(ok('{"name":"b"}'));
  await callGemini(uid, [{ role: 'user', content: 'one' }], { responseFormat: FORMAT });
  await callGemini(uid, [{ role: 'user', content: 'two' }], { responseFormat: FORMAT });
  expect(axios.post).toHaveBeenCalledTimes(3);
  expect(sent(2).response_format).toEqual({ type: 'json_object' });
});

test('a 400 in plain JSON mode as well was never about the schema: it fails, after one fallback only', async () => {
  axios.post.mockRejectedValue(badRequest('Request payload size exceeds the limit'));
  await expect(callGemini(uid, [{ role: 'user', content: 'hi' }], { responseFormat: FORMAT })).rejects.toThrow('400');
  expect(axios.post).toHaveBeenCalledTimes(2);
  // Not remembered: the schema was not shown to be the problem.
  expect(_refusedSchemas.size).toBe(0);
});

test('a 400 without a schema is not retried at all, as before', async () => {
  axios.post.mockRejectedValue(badRequest('Invalid JSON payload'));
  await expect(callGemini(uid, [{ role: 'user', content: 'hi' }])).rejects.toThrow('400');
  expect(axios.post).toHaveBeenCalledTimes(1);
});

test('a retired model name (400 "model not found") still rotates, it is not mistaken for a refused schema', async () => {
  const gone = badRequest('model gemini-old is not found for API version v1beta');
  axios.post.mockRejectedValueOnce(gone).mockResolvedValueOnce(ok('{"name":"x"}'));
  await callGemini(uid, [{ role: 'user', content: 'hi' }], { responseFormat: FORMAT });
  expect(axios.post).toHaveBeenCalledTimes(2);
  expect(sent(1).model).not.toBe(sent(0).model);
  expect(sent(1).response_format.type).toBe('json_schema');
});

test('a cut-off reply after the fallback is retried larger in plain JSON mode, not with the refused schema', async () => {
  axios.post
    .mockRejectedValueOnce(badRequest('Unknown name "anyOf"'))
    .mockResolvedValueOnce(cutOff('{"na'))
    .mockResolvedValueOnce(ok('{"name":"x"}'));
  const out = await callGemini(uid, [{ role: 'user', content: 'hi' }], { responseFormat: FORMAT, maxTokens: 100 });
  expect(out).toBe('{"name":"x"}');
  expect(axios.post).toHaveBeenCalledTimes(3);
  expect(sent(2).response_format).toEqual({ type: 'json_object' });
  expect(sent(2).max_tokens).toBeGreaterThan(100);
});
