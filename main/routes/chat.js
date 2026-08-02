const express   = require('express');
const rateLimit = require('express-rate-limit');
const router    = express.Router();
const { requireAuth } = require('../middleware/auth-middleware');
const chatAgent = require('../utils/chat-agent');
const logger    = require('../utils/logger');

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
router.post('/', requireAuth, chatLimiter, async (req, res, next) => {
  try {
    const { message, history, invoiceId } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const result = await chatAgent.respond(req.user.id, {
      message: message.trim(),
      history: Array.isArray(history) ? history : [],
      invoiceId: invoiceId || null,
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
});

module.exports = router;
