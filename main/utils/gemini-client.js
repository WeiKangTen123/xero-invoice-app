const axios  = require('axios');
const logger = require('./logger');

// Gemini-only — Nvidia/OpenRouter were removed. Every model below is called through
// the same OpenAI-compatible endpoint; only the `model` field differs, so rotating
// between them is a same-shape retry, not a provider switch.
const GEMINI_URL    = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];

// The list is read from GEMINI_MODELS (comma-separated) on every call. Google
// retires model names on its own schedule, and a retired name answers 404 to
// every request; with the list baked into the code, the only fix was a deploy.
// An env change and a restart is enough now, and the built-in list stays the
// default so nothing has to be configured.
function geminiModels() {
  const fromEnv = String(process.env.GEMINI_MODELS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return fromEnv.length ? [...new Set(fromEnv)] : GEMINI_MODELS;
}

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

// ── What a failure means for the next attempt ───────────────────────────────
//
//   quota  — 429, or 503 (model overloaded). This key's allowance on this model
//            is spent; the next model has its own, and so does the next key.
//   key    — 401/403. The key itself is refused. Every model on it will be
//            refused the same way, but the next key may be fine. This used to
//            fail the whole call, so one revoked key blocked every key after it.
//   model  — 404 / "model not found". The name is retired or wrong for every
//            key, so it is skipped for the rest of this call.
//   server — 5xx, a timeout, a dropped connection, or an empty reply. A fault in
//            that model's serving, so the next model is tried.
//   fatal  — anything else (a malformed request) fails the same way everywhere,
//            and a cut-off reply has already had its one larger retry.
const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ESOCKETTIMEDOUT', 'EPIPE', 'EAI_AGAIN']);

function _bodyText(err) {
  const data = err.response?.data;
  if (!data) return '';
  try { return typeof data === 'string' ? data : JSON.stringify(data); } catch { return ''; }
}

function _classify(err) {
  if (!err) return 'fatal';
  if (err.code === 'GEMINI_TRUNCATED') return 'fatal';
  if (err.code === 'GEMINI_EMPTY') return 'server';
  const status = err.response?.status;
  if (status === 429 || status === 503) return 'quota';
  if (status === 401 || status === 403) return 'key';
  if (status === 404) return 'model';
  if (status === 400 && /model\b.{0,80}(not found|not supported|does not exist|is not available)|unknown model/i.test(_bodyText(err))) return 'model';
  if (status >= 500) return 'server';
  if (!status && (TIMEOUT_CODES.has(err.code) || /timeout/i.test(err.message || ''))) return 'server';
  return 'fatal';
}

// ── Per-user rate limiter (15 RPM sliding window, 5 concurrent) ───────────────
// Shared across every model — conservative default matching each model's own cap.

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

// ── One request ─────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 800;
// The ceiling for the one larger retry after a reply is cut off. Generous,
// because a reply that ran out of room once will run out again at a small step.
const MAX_RETRY_TOKENS   = 8192;

function _largerLimit(current, opts) {
  if (Number.isFinite(opts.retryMaxTokens)) return Math.max(current, opts.retryMaxTokens);
  return Math.min(MAX_RETRY_TOKENS, Math.max(current * 4, 2048));
}

// The reply stopped because it hit max_tokens. Google's compatibility layer
// says 'length'; its native name is MAX_TOKENS, accepted too in case it leaks.
const _isTruncated = reason => /^(length|max_tokens)$/i.test(String(reason || ''));

function _truncatedError(model, maxTokens, partial) {
  const err = new Error(`Gemini reply was cut off at ${maxTokens} tokens (model: ${model})`);
  err.code = 'GEMINI_TRUNCATED';
  err.partial = partial || '';
  return err;
}

// Logs what the call cost and how it ended — never the prompt or the reply,
// which carry invoice and financial data.
async function _callOnce(model, key, messages, opts, maxTokens, userId) {
  const started = Date.now();
  const response = await axios.post(
    GEMINI_URL,
    {
      model,
      messages,
      temperature: opts.temperature ?? 0,
      max_tokens:  maxTokens,
    },
    {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      timeout: 120_000,
    }
  );
  const choice = response?.data?.choices?.[0];
  const finishReason = choice?.finish_reason ?? null;
  const usage = response?.data?.usage || {};
  logger.info('Gemini call', {
    userId, model, finishReason, maxTokens, ms: Date.now() - started,
    promptTokens:     usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    totalTokens:      usage.total_tokens ?? null,
  });

  const content = choice?.message?.content || '';
  // Checked before emptiness: a thinking model can spend the whole allowance
  // before writing a word, which arrives as an empty reply marked 'length'.
  if (_isTruncated(finishReason)) return { truncated: true, content };
  if (!content) {
    const err = new Error(`Gemini returned empty response (model: ${model}, finish_reason: ${finishReason})`);
    err.code = 'GEMINI_EMPTY';
    throw err;
  }
  return { truncated: false, content };
}

// ── Rotation ────────────────────────────────────────────────────────────────
//
// For the current key, try every model in order; move to the next key only
// when something about THIS key stopped it (quota or refusal). No backoff wait
// between attempts — a different model or key has its own separate quota, so
// waiting on the exhausted one first is pointless.
//
// A reply cut off at max_tokens is asked for once more, on the same model and
// key, with a larger limit. It used to come back as a success, fail to parse,
// and be retried by the caller with the identical request — which was cut off
// at the identical place. If the larger reply is cut off too, the call fails
// with code GEMINI_TRUNCATED (see isTruncation), and callers must not repeat
// it unchanged.
async function callGemini(userId, messages, opts = {}) {
  const keys = _resolveKeys(userId);
  const limiter = _getLimiter(userId);
  const models = geminiModels();

  return limiter.enqueue(async () => {
    let lastErr;
    let maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    let enlarged  = false;
    const retired = new Set();

    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      let keyWasTheProblem = false;

      for (const model of models) {
        if (retired.has(model)) continue;
        try {
          let r = await _callOnce(model, key, messages, opts, maxTokens, userId);
          if (r.truncated) {
            const larger = _largerLimit(maxTokens, opts);
            if (enlarged || larger <= maxTokens) throw _truncatedError(model, maxTokens, r.content);
            logger.warn(`Gemini reply cut off at ${maxTokens} tokens on ${model} — retrying once with ${larger}`, { userId });
            maxTokens = larger;
            enlarged  = true;
            r = await _callOnce(model, key, messages, opts, maxTokens, userId);
            if (r.truncated) throw _truncatedError(model, maxTokens, r.content);
          }
          return r.content;
        } catch (err) {
          lastErr = err;
          const kind = _classify(err);
          const status = err.response?.status;
          if (kind === 'fatal') throw err;
          if (kind === 'key') {
            logger.warn(`Gemini key ${k + 1}/${keys.length} refused (${status}) — trying the next key`, { userId });
            keyWasTheProblem = true;
            break;
          }
          if (kind === 'model') {
            logger.warn(`Gemini model ${model} not found (${status}) — skipped; set GEMINI_MODELS to replace it`, { userId });
            retired.add(model);
            continue;
          }
          if (kind === 'quota') {
            logger.warn(`Gemini quota/rate limit on ${model} (key ${k + 1}/${keys.length}) — rotating`, { userId, status });
            keyWasTheProblem = true;
            continue;
          }
          logger.warn(`Gemini ${model} failed (${status || err.code || err.message}) on key ${k + 1}/${keys.length} — trying the next model`, { userId });
        }
      }

      // Every model failed for reasons another key cannot change — a server
      // fault or a retired name. Walking the remaining keys would only repeat it.
      if (!keyWasTheProblem) break;
      if (k < keys.length - 1) {
        logger.warn(`All models exhausted on key ${k + 1}/${keys.length} — moving to next key`, { userId });
      }
    }
    throw lastErr || new Error('No Gemini model available — check GEMINI_MODELS');
  });
}

// True for the error callGemini throws when a reply was cut off even after its
// larger retry. Callers check this to avoid sending the identical request again.
function isTruncation(err) { return !!err && err.code === 'GEMINI_TRUNCATED'; }

module.exports = { callGemini, GEMINI_MODELS, geminiModels, isTruncation, _classify };
