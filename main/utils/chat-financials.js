const logger = require('./logger');

// Financial context for the chat assistant.
//
// The assistant reads the local invoice PIPELINE — records this app parsed,
// none of them posted. That answers "fix this bill" and cannot answer "how is
// the business doing", because the pipeline only ever sees what came through
// here. The books live in Xero, and this fetches a compact, already-computed
// view of them.
//
// Everything is READ. Nothing here can write to Xero, and financial figures are
// context only: they can never become an actionable proposal.

// Xero bills on data egress and a cold cash-flow read costs several calls, so a
// question about an invoice number must not drag the whole ledger down with it.
//
// The net is deliberately generous, because the two failure modes are not
// symmetric. A false positive usually costs nothing — the dashboard has almost
// certainly warmed the cache. A false negative means the assistant lacks the
// figures; it then says so and points at the Dashboard rather than answering
// from the pipeline as though that were the books, so it degrades to "I don't
// have that" instead of a wrong number. Safe, but still a worse answer than the
// one we could have given.
const FINANCIAL_HINTS = /\b(cash|bank|balance|revenue|sales|income|profit|margin|loss|expense|spend|cost|budget|forecast|runway|burn|owe|owed|owing|receivable|payable|overdue|collect|collection|debtor|creditor|dso|invoiced|turnover|financial|performance|doing|health|trend|month|quarter|year|alert|pay|paid|paying|payment|payments|customer|customers|supplier|suppliers)\b/i;

function looksFinancial(message) {
  return FINANCIAL_HINTS.test(String(message || ''));
}

// Returns a compact block for the prompt, or null when there is nothing to add.
// Never throws: the assistant must keep working on pipeline questions even if
// Xero is unreachable.
async function financialContext(userId, tenantId, { timezone = 'UTC' } = {}) {
  if (!tenantId) return null;
  try {
    const reports = require('../xero/reports');
    // No force: this rides whatever the dashboard already fetched. A warm cache
    // costs nothing, which is the normal case for someone with the app open.
    const cf = await reports.getCashFlow(userId, tenantId, { timezone, period: { preset: 'fy-ytd' } });
    const facts = reports._narrativeFacts(cf);

    return {
      organisation: cf.organisation?.name || null,
      currency: cf.organisation?.currency || null,
      period: cf.period?.label || null,
      figures: facts.lines,
      alerts: (cf.alerts?.alerts || []).map(a => ({ severity: a.severity, title: a.title })),
    };
  } catch (err) {
    logger.warn('Chat financial context unavailable', { userId, error: err.message });
    return null;
  }
}

module.exports = { financialContext, looksFinancial, FINANCIAL_HINTS };
