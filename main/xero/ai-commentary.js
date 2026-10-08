const logger             = require('../utils/logger');
const { _cacheGet, _cacheSet, _dedupe } = require('./report-cache');
const { getPerformance } = require('./performance');
const { getCashFlow }    = require('./cash-flow-report');

// The AI-written commentary on the Insights page as reports: the variance
// reasons and the financial narrative, which figures each is written from, and
// how long an answer is kept.
//
// Kept apart from the figures because it sits on top of all of them — it reads
// getPerformance and getCashFlow, and no report module reads it — and apart
// from ./ai-insights so that stays free of fetching and can be tested without a
// Xero token.

// ── Variance reasons (Gemini-explained, Xero-computed) ──────────────────────
// The FIGURES are computed here from Xero and never leave that path. Gemini is
// given those already-final numbers and asked only to suggest WHY — it is never
// asked to calculate, recall or estimate anything.
//
// Guardrail: any generated sentence containing a large number that wasn't in the
// input is dropped. An LLM inventing a plausible-looking amount inside financial
// commentary is the failure mode that matters, and it's cheap to detect.

const INSIGHT_CACHE_TTL_MS = 30 * 60 * 1000; // reasons only change when the figures do

// Prompts, grounding and the facts the model is allowed to see — see
// ./ai-insights. The two model calls are made there too (requestVarianceInsights,
// requestNarrative): this file fetches and caches, ai-insights asks and checks.
const {
  _buildCategoryVariances,
  _closedMonthCount,
  _groundNarrative,
  _narrativeFacts,
  _varianceCandidates,
  // A reply that could not be read, or no reply at all, is not an answer to
  // keep for half an hour: the next look should ask again.
  INSIGHT_FAILURE_TTL_MS,
  requestVarianceInsights,
  requestNarrative,
} = require('./ai-insights');

async function _getVarianceInsightsRaw(userId, tenantId, { timezone = 'UTC', force = false, reanalyse = false, period } = {}) {
  const perf = await getPerformance(userId, tenantId, { timezone, force, period });
  // Cash flow enriches the commentary with category context; it is not required
  // for it. Losing it must not blank the insights — but it must not vanish
  // silently either, or "why are the category variances empty" has no trail.
  let cf = null;
  try {
    cf = await getCashFlow(userId, tenantId, { timezone, force, period });
  } catch (err) {
    logger.warn('Variance insights: cash-flow context unavailable', { userId, tenantId, error: err.message });
  }

  const categories = _buildCategoryVariances(perf, cf);
  const candidates = _varianceCandidates(perf);
  // The months the figures above were summed over, told to the model as such
  // — the same count the sums used, not a second reading of the markers.
  const closed = _closedMonthCount(perf) ?? perf.months.length;

  if (!categories.length && !candidates.length) {
    return { generated: false, reason: 'Nothing differs from budget yet.', categories: [], lines: [], source: 'none' };
  }

  // Keyed on the figures themselves, so the model is re-asked only when the numbers actually move.
  const sig = categories.map(c => `${c.key}:${Math.round(c.variance)}`).join('|') + '::' + candidates.map(c => `${c.account}:${Math.round(c.variance)}`).join('|');
  const key = `insights:v3:${userId}:${tenantId}:${perf.period?.fromKey}:${perf.period?.toKey}:${sig}`;
  const cached = _cacheGet(key, force || reanalyse, { noGrace: true });
  if (cached) return cached;

  // The call, held to a JSON schema, then parsed and grounded (ai-insights).
  // It never throws: what comes back is the model's answer, or the computed
  // defaults with `failed` saying why ('unparsed', 'truncated' or
  // 'unavailable') and a short cacheTtlMs.
  const out = await requestVarianceInsights(userId, {
    org: perf.organisation.name, fyLabel: perf.fiscalYear.label, closed, categories, candidates,
  });
  const fetchedAt = new Date().toISOString();
  // A fallback used to be labelled source:'gemini' and kept for thirty minutes,
  // so the page presented the computed defaults as the model's analysis and a
  // Re-analyse was the only way past them. It is labelled as figures, and kept
  // for no longer than INSIGHT_FAILURE_TTL_MS whatever the marker asks.
  if (out.failed) {
    return _cacheSet(key, {
      generated: true, categories: out.categories, lines: out.lines, source: 'figures', failed: out.failed, fetchedAt,
    }, Math.min(out.cacheTtlMs || INSIGHT_FAILURE_TTL_MS, INSIGHT_FAILURE_TTL_MS));
  }
  logger.info('Variance insights generated', { userId, tenantId, categories: out.categories.length, lines: out.lines.length });
  return _cacheSet(key, {
    generated: true, categories: out.categories, lines: out.lines, source: 'gemini', fetchedAt,
  }, out.cacheTtlMs || INSIGHT_CACHE_TTL_MS);
}

// ── Financial narrative (AI-written, from figures we computed) ──────────────
//
// The alerts are excellent at DETECTION and silent on INTERPRETATION. A reader
// facing five separate red flags has to work out for themselves that they are
// one story — which is exactly what people are worst at when tired. This joins
// them up in a few sentences.
//
// The safety model is the same one getVarianceInsights already runs without
// trouble, and it is not negotiable:
//   * every figure is computed here; Gemini never calculates anything
//   * the deterministic alerts go in as GROUND TRUTH, so it can only join them
//     up, never contradict them
//   * any sentence containing a large number we did not supply is dropped
//   * it is read-only — it proposes nothing and can act on nothing
//   * if it fails, the card simply does not render; figures never wait on it
const NARRATIVE_CACHE_TTL_MS = 30 * 60 * 1000;

async function _narrateFrom(userId, tenantId, cf, { force = false } = {}) {
  const facts = _narrativeFacts(cf);
  // Keyed on the figures themselves, so it is rewritten only when they change.
  const key = `narrative:${userId}:${tenantId}:${facts.lines.join('|')}`;
  const cached = _cacheGet(key, force, { noGrace: true });
  if (cached) return cached;

  // Two attempts with a pause between them, except after a cut-off reply:
  // gemini-client has already asked again with a larger limit, so the same
  // request would stop in the same place and the second attempt only spent
  // the user's quota (see requestNarrative). Never throws.
  const { raw, reason } = await requestNarrative(userId, facts);
  // The card simply will not render. Figures never wait on this.
  if (raw === null) return { available: false, reason: reason || 'unavailable' };

  const { text, dropped } = _groundNarrative(raw, facts.allowed);
  if (dropped) logger.warn('Narrative sentences dropped as ungrounded', { userId, tenantId, dropped });
  if (!text) return { available: false, reason: 'ungrounded' };

  logger.info('Financial narrative written', { userId, tenantId, alerts: facts.alerts.length, dropped });
  return _cacheSet(key, {
    available: true,
    text,
    source: 'gemini',
    period: cf.period,
    basedOnAlerts: facts.alerts.length,
    fetchedAt: new Date().toISOString(),
  }, NARRATIVE_CACHE_TTL_MS);
}

async function _getFinancialNarrativeRaw(userId, tenantId, { timezone = 'UTC', force = false, reanalyse = false, period } = {}) {
  // Only `force` reaches Xero. `reanalyse` reuses whatever is cached and simply
  // asks the model again.
  const cf = await getCashFlow(userId, tenantId, { timezone, force, period });
  return _narrateFrom(userId, tenantId, cf, { force: force || reanalyse });
}

// Both name their defaults for the reason given at getBudgetVariance. Bound
// after the declarations, through the one in-flight map in ./report-cache, so
// the same commentary asked for twice at once costs one model call, not two.
const getVarianceInsights    = _dedupe('getVarianceInsights', _getVarianceInsightsRaw,
  { timezone: 'UTC', force: false, reanalyse: false });
const getFinancialNarrative  = _dedupe('getFinancialNarrative', _getFinancialNarrativeRaw,
  { timezone: 'UTC', force: false, reanalyse: false });

module.exports = {
  getVarianceInsights, getFinancialNarrative, _narrateFrom,
  INSIGHT_CACHE_TTL_MS, NARRATIVE_CACHE_TTL_MS,
};
