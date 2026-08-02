const axios  = require('axios');
const logger = require('./logger');

// Gemini-only — Nvidia/OpenRouter were removed. Both models below are called through
// the same OpenAI-compatible endpoint; only the `model` field differs, so rotating
// between them on a quota error is a same-shape retry, not a provider switch.
const GEMINI_URL    = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];

// Returns every key available to try, in rotation order: the user's added keys
// (oldest first, via the multi-key Setup UI) first, then the legacy single-field
// value if that's all an account has, then the .env fallback shared across users
// with nothing configured of their own.
function _resolveKeys(userId) {
  const keys = [];
  if (userId) {
    const { getGeminiKeys, getUserConfig } = require('./users');
    for (const row of getGeminiKeys(userId)) keys.push(row.apiKey);
    if (!keys.length) {
      const legacy = getUserConfig(userId).Gemini_API_KEY;
      if (legacy) keys.push(legacy);
    }
  }
  if (!keys.length && process.env.Gemini_API_KEY) keys.push(process.env.Gemini_API_KEY);
  if (!keys.length) throw new Error('No Gemini API key configured — add one in Setup');
  return keys;
}

function _isQuotaError(err) {
  const status = err.response?.status;
  return status === 429 || status === 503;
}

// ── Per-user rate limiter (15 RPM sliding window, 5 concurrent) ───────────────
// Shared across both models — conservative default matching each model's own cap.

const RPM           = 15;
const RPM_WINDOW_MS = 60_000;
const MAX_CONCURRENT = 5;

class UserRateLimiter {
  constructor(rpm, windowMs, maxConcurrent) {
    this.rpm = rpm;
    this.windowMs = windowMs;
    this.maxConcurrent = maxConcurrent;
    this.timestamps = [];
    this.queue = [];
    this.running = 0;
    this._drainTimer = null;
  }

  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    while (this.queue.length > 0 && this.running < this.maxConcurrent) {
      const now = Date.now();
      const cutoff = now - this.windowMs;
      while (this.timestamps.length && this.timestamps[0] <= cutoff) this.timestamps.shift();

      if (this.timestamps.length >= this.rpm) {
        if (!this._drainTimer) {
          const waitMs = this.timestamps[0] + this.windowMs - now + 5;
          this._drainTimer = setTimeout(() => { this._drainTimer = null; this._drain(); }, waitMs);
          logger.info(`Gemini rate limit reached — next slot in ${Math.ceil(waitMs / 1000)}s`);
        }
        return;
      }

      const { fn, resolve, reject } = this.queue.shift();
      this.timestamps.push(Date.now());
      this.running++;

      fn().then(resolve, reject).finally(() => { this.running--; this._drain(); });
    }
  }
}

const _limiters = new Map();
function _getLimiter(userId) {
  const key = userId || 'default';
  if (!_limiters.has(key)) _limiters.set(key, new UserRateLimiter(RPM, RPM_WINDOW_MS, MAX_CONCURRENT));
  return _limiters.get(key);
}

// ── Core call, with model rotation on quota errors ───────────────────────────

async function _callOnce(model, key, messages, opts) {
  const response = await axios.post(
    GEMINI_URL,
    {
      model,
      messages,
      temperature: opts.temperature ?? 0,
      max_tokens:  opts.maxTokens ?? 800,
    },
    {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      timeout: 120_000,
    }
  );
  const choice = response.data.choices?.[0];
  if (!choice?.message?.content) throw new Error(`Gemini returned empty response (model: ${model})`);
  return choice.message.content;
}

// Two-level rotation: for the current key, try every model in GEMINI_MODELS order;
// only once ALL models are exhausted (quota/rate-limited) on that key does it move
// to the next key. No backoff wait between attempts — a different model or key has
// its own separate quota, so waiting on the exhausted one first is pointless. Any
// non-quota error (bad request, auth failure) fails fast instead of burning through
// every remaining model/key on a request that will fail the exact same way there too.
async function callGemini(userId, messages, opts = {}) {
  const keys = _resolveKeys(userId);
  const limiter = _getLimiter(userId);

  return limiter.enqueue(async () => {
    let lastErr;
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      for (const model of GEMINI_MODELS) {
        try {
          return await _callOnce(model, key, messages, opts);
        } catch (err) {
          lastErr = err;
          if (_isQuotaError(err)) {
            logger.warn(`Gemini quota/rate limit on ${model} (key ${k + 1}/${keys.length}) — rotating`, { userId });
            continue;
          }
          throw err;
        }
      }
      if (k < keys.length - 1) {
        logger.warn(`All models exhausted on key ${k + 1}/${keys.length} — moving to next key`, { userId });
      }
    }
    throw lastErr;
  });
}

module.exports = { callGemini, GEMINI_MODELS };
