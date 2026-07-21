const axios  = require('axios');
const logger = require('../utils/logger');

// ── Provider config ───────────────────────────────────────────────────────────

const LLM_PROVIDER_CONFIGS = {
  gemini: {
    url:   'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-3.1-flash-lite',
  },
  nvidia: {
    url:   'https://integrate.api.nvidia.com/v1/chat/completions',
    model: 'qwen/qwen3-next-80b-a3b-instruct',
  },
  openrouter: {
    url:   'https://openrouter.ai/api/v1/chat/completions',
    model: 'openai/gpt-oss-120b:free',
  },
};

// Pick provider + key for a given user (falls back to .env globals)
function _resolveConfig(userId) {
  let geminiKey, nvidiaKey, openrouterKey, openrouterModel;

  if (userId) {
    const { getUserConfig } = require('../utils/users');
    const cfg   = getUserConfig(userId);
    geminiKey      = cfg.Gemini_API_KEY;
    nvidiaKey      = cfg.Nvidia_API_KEY;
    openrouterKey  = cfg.OPENROUTER_API_KEY;
    openrouterModel = cfg.OPENROUTER_MODEL;
  }

  // Fall back to .env (shared keys) only if user has none configured
  if (!geminiKey && !nvidiaKey && !openrouterKey) {
    geminiKey      = process.env.Gemini_API_KEY;
    nvidiaKey      = process.env.Nvidia_API_KEY;
    openrouterKey  = process.env.OPENROUTER_API_KEY;
    openrouterModel = process.env.OPENROUTER_MODEL;
  }

  const provider = geminiKey ? 'gemini' : nvidiaKey ? 'nvidia' : openrouterKey ? 'openrouter' : null;
  if (!provider) throw new Error('No LLM API key configured — add Gemini_API_KEY in Setup');

  const base = LLM_PROVIDER_CONFIGS[provider];
  return {
    provider,
    url:   base.url,
    key:   geminiKey || nvidiaKey || openrouterKey,
    model: (provider === 'openrouter' && openrouterModel) ? openrouterModel : base.model,
  };
}

// ── Per-user rate limiter (15 RPM sliding window, 5 concurrent) ───────────────
//
// Gemini free tier: 15 RPM, 500 RPD
// Strategy: sliding 60 s window, max 15 LLM calls can start per window;
//           max 5 run concurrently so responses arrive quickly.

const GEMINI_RPM     = 15;
const RPM_WINDOW_MS  = 60_000;
const MAX_CONCURRENT = 5;

class UserRateLimiter {
  constructor(rpm, windowMs, maxConcurrent) {
    this.rpm          = rpm;
    this.windowMs     = windowMs;
    this.maxConcurrent = maxConcurrent;
    this.timestamps   = []; // start time of each call in the current window
    this.queue        = []; // { fn, resolve, reject }
    this.running      = 0;
    this._drainTimer  = null;
  }

  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    while (this.queue.length > 0 && this.running < this.maxConcurrent) {
      const now    = Date.now();
      const cutoff = now - this.windowMs;

      // Slide the window — drop timestamps older than windowMs
      while (this.timestamps.length && this.timestamps[0] <= cutoff) this.timestamps.shift();

      if (this.timestamps.length >= this.rpm) {
        // Schedule a retry when the oldest slot leaves the window
        if (!this._drainTimer) {
          const waitMs     = this.timestamps[0] + this.windowMs - now + 5;
          this._drainTimer = setTimeout(() => {
            this._drainTimer = null;
            this._drain();
          }, waitMs);
          logger.info(`LLM rate limit reached — next slot in ${Math.ceil(waitMs / 1000)}s`);
        }
        return;
      }

      const { fn, resolve, reject } = this.queue.shift();
      this.timestamps.push(Date.now());
      this.running++;

      fn()
        .then(resolve, reject)
        .finally(() => {
          this.running--;
          this._drain();
        });
    }
  }
}

// One limiter per user — keyed by userId (or 'default' for shared-key path)
const _limiters = new Map();

function _getLimiter(userId) {
  const key = userId || 'default';
  if (!_limiters.has(key)) {
    _limiters.set(key, new UserRateLimiter(GEMINI_RPM, RPM_WINDOW_MS, MAX_CONCURRENT));
  }
  return _limiters.get(key);
}

// ── Prompt ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an invoice data extractor. Return ONLY valid JSON, no explanation, no markdown.

Extract these fields:
- vendorName: seller/service provider name (NOT the buyer/recipient of the invoice)
- vendorAddress: vendor's full street address (null if not found)
- vendorEmail: vendor's email address (null if not found)
- vendorPhone: vendor's phone number (null if not found)
- invoiceNumber: invoice reference number (null if not found)
- invoiceDate: YYYY-MM-DD (null if not found)
- dueDate: YYYY-MM-DD (null if not stated)
- currency: SGD if PayNow or SGD keyword present, otherwise USD
- lineItems: array of { description, amount } — include full multi-line descriptions
- totalAmount: total due as a plain number (no commas, no symbols)
- paymentReference: combine all payment details — PayNow ID, bank name, account number, SWIFT, beneficiary — format: "Bank: OCBC | Acct: 601-493935-001 | Swift: OCBCSGSG | Beneficiary: Denise Teo" — null if none
- projectName: artist or project name this invoice relates to (null if not applicable)`;

// ── Core LLM call ─────────────────────────────────────────────────────────────

async function _callLLM(pdfText, filename, userId) {
  const { url, key, model, provider } = _resolveConfig(userId);

  const response = await axios.post(
    url,
    {
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: `Invoice filename: ${filename}\n\nInvoice text:\n${pdfText.slice(0, 3000)}` },
      ],
      temperature: 0,
      max_tokens:  800,
    },
    {
      headers: {
        Authorization:  `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      timeout: 120_000,
    }
  );

  const choice = response.data.choices?.[0];
  if (!choice?.message?.content) {
    throw new Error(`LLM returned empty response (provider: ${provider}, model: ${model})`);
  }
  const raw       = choice.message.content.trim();
  const noThought = raw.replace(/<thought>[\s\S]*?<\/thought>/g, '').trim();
  const cleaned   = noThought.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  return JSON.parse(cleaned);
}

// ── Public API ────────────────────────────────────────────────────────────────

// extractWithRetry goes through the per-user rate limiter.
// Max 15 LLM calls per minute per user; up to 5 run concurrently.
async function extractWithRetry(pdfText, filename, userId, maxAttempts = 4) {
  const limiter = _getLimiter(userId);

  return limiter.enqueue(async () => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await _callLLM(pdfText, filename, userId);
      } catch (err) {
        if (err.response?.status === 429 && attempt < maxAttempts) {
          const waitMs = attempt * 15_000;
          logger.warn(`LLM rate limited — retrying in ${waitMs / 1000}s`, { attempt, filename });
          await new Promise(r => setTimeout(r, waitMs));
        } else {
          throw err;
        }
      }
    }
  });
}

logger.info('LLM parser initialised (per-user keys + rate limiter)', {
  rpm:         GEMINI_RPM,
  maxConcurrent: MAX_CONCURRENT,
});

module.exports = { extractWithRetry };
