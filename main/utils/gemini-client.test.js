jest.mock('axios');
jest.mock('./users', () => ({
  getGeminiKeys: jest.fn(),
  getUserConfig: jest.fn(),
}));

const axios = require('axios');
const { getGeminiKeys, getUserConfig } = require('./users');

function quotaError() {
  const err = new Error('quota exceeded');
  err.response = { status: 429 };
  return err;
}

function authError() {
  const err = new Error('invalid api key');
  err.response = { status: 401 };
  return err;
}

function okResponse(text) {
  return { data: { choices: [{ message: { content: text } }] } };
}

describe('gemini-client rotation', () => {
  const { callGemini } = require('./gemini-client');

  beforeEach(() => {
    jest.clearAllMocks();
    getGeminiKeys.mockReturnValue([]);
    getUserConfig.mockReturnValue({});
    delete process.env.Gemini_API_KEY;
  });

  test('throws a clear error when no key is configured anywhere', async () => {
    await expect(callGemini('user1', [])).rejects.toThrow('No Gemini API key configured');
  });

  test('falls back to legacy single Gemini_API_KEY when no multi-keys exist', async () => {
    getUserConfig.mockReturnValue({ Gemini_API_KEY: 'legacy-key' });
    axios.post.mockResolvedValue(okResponse('hi'));

    const result = await callGemini('user1', [{ role: 'user', content: 'hi' }]);
    expect(result).toBe('hi');
    expect(axios.post.mock.calls[0][2].headers.Authorization).toBe('Bearer legacy-key');
  });

  test('rotates through every model on the same key before failing', async () => {
    getGeminiKeys.mockReturnValue([{ apiKey: 'key-1' }]);
    axios.post.mockRejectedValue(quotaError());

    await expect(callGemini('user1', [])).rejects.toThrow('quota exceeded');
    // GEMINI_MODELS has 2 entries — both should have been tried on the one key.
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  test('only moves to the next key once every model on the current key is exhausted', async () => {
    getGeminiKeys.mockReturnValue([{ apiKey: 'key-1' }, { apiKey: 'key-2' }]);
    axios.post
      .mockRejectedValueOnce(quotaError()) // key-1, model A
      .mockRejectedValueOnce(quotaError()) // key-1, model B
      .mockResolvedValueOnce(okResponse('ok from key-2')); // key-2, model A

    const result = await callGemini('user1', []);
    expect(result).toBe('ok from key-2');
    expect(axios.post).toHaveBeenCalledTimes(3);
    expect(axios.post.mock.calls[2][2].headers.Authorization).toBe('Bearer key-2');
  });

  test('a non-quota error fails fast without trying remaining models/keys', async () => {
    getGeminiKeys.mockReturnValue([{ apiKey: 'key-1' }, { apiKey: 'key-2' }]);
    axios.post.mockRejectedValue(authError());

    await expect(callGemini('user1', [])).rejects.toThrow('invalid api key');
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('multi-keys take priority over the legacy single-field value', async () => {
    getGeminiKeys.mockReturnValue([{ apiKey: 'key-multi' }]);
    getUserConfig.mockReturnValue({ Gemini_API_KEY: 'key-legacy' });
    axios.post.mockResolvedValue(okResponse('ok'));

    await callGemini('user1', []);
    expect(axios.post.mock.calls[0][2].headers.Authorization).toBe('Bearer key-multi');
  });
});
