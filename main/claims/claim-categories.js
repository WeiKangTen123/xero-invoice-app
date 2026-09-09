const logger = require('../utils/logger');
const { parseLlmJson } = require('../utils/llm-json');

// Suggests which category column a claim line belongs to.
//
// This is the one job here a model does better than the current process. On the
// real claim, the claimant filled date, description, currency and amount but
// left five of nine category cells blank — and those categories are the bridge
// to a Xero expense account.
//
// The categories are NOT invented: they come from the headings on the company's
// own form, and anything the model returns that is not one of them is discarded.
// A suggestion is always marked as a suggestion, never presented as the
// claimant's own answer.

function _prompt(lines, categories) {
  return `You are helping a finance team categorise expense claim lines.

THE ONLY CATEGORIES ALLOWED (use the text exactly, or null):
${categories.map(c => `- ${c}`).join('\n')}

CLAIM LINES:
${lines.map(l => `${l.rowNo}. ${l.description || '(no description)'}${l.merchant ? ` — receipt from ${l.merchant}` : ''}`).join('\n')}

Return ONLY a JSON array, one entry per line above:
[{"rowNo": "1", "category": "<one of the categories above, exactly>", "confidence": "high"|"low"}]

Rules:
- Use ONLY a category from the list. Never invent one, never reword one.
- If a line does not clearly belong to any of them, return null for category.
- Judge from the description and the merchant, nothing else. Do not guess at intent.
- "high" only when the description plainly names the kind of expense.`;
}

// Keeps only suggestions naming a real category for a real line.
function normaliseSuggestions(raw, lines, categories) {
  const allowed = new Map(categories.map(c => [c.replace(/\s+/g, ' ').trim().toUpperCase(), c]));
  const wanted = new Set(lines.map(l => String(l.rowNo)));
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.suggestions) ? raw.suggestions : []);

  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const rowNo = String(item.rowNo ?? item.no ?? '').trim();
    if (!wanted.has(rowNo)) continue;                     // a line we did not ask about
    if (out.some(s => s.rowNo === rowNo)) continue;       // one suggestion per line
    const key = String(item.category || '').replace(/\s+/g, ' ').trim().toUpperCase();
    const category = allowed.get(key);
    if (!category) continue;                              // invented or reworded — dropped
    out.push({ rowNo, category, confidence: item.confidence === 'high' ? 'high' : 'low' });
  }
  return out;
}

// Only lines with no category of their own are sent — the claimant's answer is
// never overwritten, and asking about lines already answered wastes a call.
function linesNeedingCategory(matches) {
  return matches
    .filter(m => !m.row.category)
    .map(m => ({ rowNo: String(m.row.no), description: m.row.description, merchant: m.receipt && m.receipt.merchant }));
}

async function suggestCategories(userId, matches, categories, deps = {}) {
  const callGemini = deps.callGemini || require('../utils/gemini-client').callGemini;
  const lines = linesNeedingCategory(matches);
  if (!lines.length || !categories.length) return [];

  try {
    const raw = await callGemini(userId, [
      { role: 'system', content: 'You categorise expense claims. Return only JSON.' },
      { role: 'user',   content: _prompt(lines, categories) },
    ], { temperature: 0, maxTokens: 800 });

    const suggestions = normaliseSuggestions(parseLlmJson(raw), lines, categories);
    logger.info('Claim categories suggested', { userId, asked: lines.length, returned: suggestions.length });
    return suggestions;
  } catch (err) {
    // A missing category is a blank field for a person to fill, not a failure.
    logger.warn('Category suggestion failed', { userId, error: err.message });
    return [];
  }
}

module.exports = { suggestCategories, normaliseSuggestions, linesNeedingCategory, _prompt };
