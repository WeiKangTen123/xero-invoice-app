const express   = require('express');
const rateLimit = require('express-rate-limit');
const router    = express.Router();
const { requireAuth } = require('../middleware/auth-middleware');
const asyncHandler = require('../middleware/async-handler');
const chatAgent = require('../utils/chat-agent');
const tokenCache = require('../utils/token-cache');
const settingsStore = require('../utils/settings-store');
const { getUserConfig, DEFAULT_TIMEZONE } = require('../utils/users');
const { _periodFromQueryParams, _isPeriodError } = require('../xero/periods');
const logger    = require('../utils/logger');

// The company a chat request is about. The dashboard switches company with
// ?tenantId=, but this route always took the first connected one, so with two
// companies connected the assistant could answer about the one not on screen.
// The UI now sends the company it is showing. It is checked against this
// account's own connections — a company that is not one of them is refused,
// never silently swapped for another, since an answer about the wrong books
// reads exactly like an answer about the right ones. With none named, the
// account's default company for sending is used, then the first connected.
function _resolveTenant(userId, requested) {
  const tenants = tokenCache.getPersistedTenants(userId);
  const asked = typeof requested === 'string' && requested.trim() ? requested.trim() : null;
  if (asked) {
    return tenants.some(t => t.tenantId === asked) ? { tenantId: asked } : { refused: true };
  }
  if (!tenants.length) return { tenantId: null };
  let preferred = null;
  try { preferred = settingsStore.forUser(userId).get('defaultTenantId'); } catch (_) {}
  return { tenantId: tenants.some(t => t.tenantId === preferred) ? preferred : tenants[0].tenantId };
}

// The period on screen, in the shape the reports take. Checked by the same gate
// as the report routes (xero/periods.js), so a bad one is a 400, not a 500.
// Absent means the default, financial year to date (utils/chat-financials.js).
function _periodFromBody(period) {
  if (period === undefined || period === null || period === '') return undefined;
  const q = typeof period === 'string' ? { preset: period } : (typeof period === 'object' ? period : { preset: String(period) });
  return _periodFromQueryParams({ preset: q.preset, from: q.from, to: q.to }, undefined);
}

// The global app-wide rate limit (500 req/15min) is far looser than Gemini's own
// quota (15 RPM per model, 500/day) — without a tighter limit here, a double-clicked
// send button or a retry loop could burn through the day's LLM quota in minutes and
// break PDF parsing for everyone sharing that key. This caps chat specifically.
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      12,
  keyGenerator: req => `chat:${req.user?.id || req.ip}`,
  message:  { error: 'Too many messages — wait a moment before sending another' },
  standardHeaders: true,
  legacyHeaders:   false,
});

// POST /api/chat — the ONLY route this feature adds. It never mutates anything:
// it reads the user's own invoice data, asks Gemini what to do, and returns a
// reply plus a list of already-validated proposals. Applying a proposal happens
// on the frontend by calling the existing PATCH /api/invoices/:id (or /submit)
// endpoints once the user clicks Confirm — same validation, same code path as
// editing through the UI directly. This route cannot write to the database.
router.post('/', requireAuth, chatLimiter, asyncHandler(async (req, res, next) => {
  try {
    const body = req.body || {};
    const { message, history, invoiceId } = body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // The user's own connected org, so the assistant can answer questions about
    // the BOOKS and not only this app's unposted pipeline — absent when nothing
    // is connected, in which case the assistant says so instead of guessing.
    const { tenantId, refused } = _resolveTenant(req.user.id, body.tenantId);
    if (refused) {
      logger.info('Chat refused a company not connected to this account', { userId: req.user.id });
      return res.status(400).json({ error: 'That Xero company is not connected to this account. Pick a connected company and ask again.' });
    }
    let period;
    try {
      period = _periodFromBody(body.period);
    } catch (err) {
      if (_isPeriodError(err)) return res.status(400).json({ error: err.message });
      throw err;
    }
    const timezone = getUserConfig(req.user.id).TIMEZONE || DEFAULT_TIMEZONE;

    const result = await chatAgent.respond(req.user.id, {
      message: message.trim(),
      history: Array.isArray(history) ? history : [],
      invoiceId: invoiceId || null,
      tenantId,
      period,
      timezone,
    });

    res.json(result);
  } catch (err) {
    logger.error('Chat request failed', { error: err.message, userId: req.user.id });
    res.status(err.message?.includes('No Gemini API key') ? 400 : 500).json({
      error: err.message?.includes('No Gemini API key')
        ? err.message
        : 'Chat assistant is unavailable right now — try again shortly.',
    });
  }
}));

module.exports = router;
