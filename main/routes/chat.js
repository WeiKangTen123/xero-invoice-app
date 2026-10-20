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
const db        = require('../db');
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

// The rows of the AR & AP list as the screen shows them, so "#5" or "ref 5"
// in a message can be read as a row of it (utils/chat-agent.js). Only the
// screen knows that order: the user's sort and filter decide it.
//
// [{ n, id }] — n the number in the list's "#" column, a whole number from 1,
// each n once; id the invoice; at most 200 rows. Absent or null means the
// screen sent no list. A malformed one is a 400, as a bad period is: a list
// read wrongly would point "#5" at the wrong invoice.
//
// Rows whose invoice is not this account's are dropped — the rule every
// invoice lookup keeps (invoice-store's forUser: id AND user_id) — so no id
// can put another account's invoice in front of the model. One query for the
// whole list, not a full record read per row.
const VISIBLE_INVOICES_LIMIT = 200;
const BAD_VISIBLE_INVOICES = 'The invoice list sent with this message could not be read. Reload the page and ask again.';

function _visibleInvoicesFromBody(userId, rows) {
  if (rows === undefined || rows === null) return { list: null };
  if (!Array.isArray(rows) || rows.length > VISIBLE_INVOICES_LIMIT) return { error: BAD_VISIBLE_INVOICES };
  const numbers = new Set();
  for (const row of rows) {
    const ok = row && typeof row === 'object'
      && Number.isSafeInteger(row.n) && row.n >= 1 && !numbers.has(row.n)
      && typeof row.id === 'string' && row.id.length >= 1 && row.id.length <= 128;
    if (!ok) return { error: BAD_VISIBLE_INVOICES };
    numbers.add(row.n);
  }
  if (!rows.length) return { list: [] };
  const ids = [...new Set(rows.map(r => r.id))];
  const owned = new Set(db.prepare(`SELECT id FROM invoices WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`)
    .all(userId, ...ids).map(r => r.id));
  return { list: rows.filter(r => owned.has(r.id)).map(r => ({ n: r.n, id: r.id })) };
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
    const visible = _visibleInvoicesFromBody(req.user.id, body.visibleInvoices);
    if (visible.error) return res.status(400).json({ error: visible.error });
    const timezone = getUserConfig(req.user.id).TIMEZONE || DEFAULT_TIMEZONE;

    const result = await chatAgent.respond(req.user.id, {
      message: message.trim(),
      history: Array.isArray(history) ? history : [],
      invoiceId: invoiceId || null,
      tenantId,
      period,
      timezone,
      visibleInvoices: visible.list,
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
