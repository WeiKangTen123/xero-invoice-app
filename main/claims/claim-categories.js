const logger = require('../utils/logger');
const { parseLlmJson, jsonSchemaFormat, nullable } = require('../utils/llm-json');

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

Return ONLY a JSON object with one entry per line above:
{"suggestions": [{"rowNo": "1", "category": "<one of the categories above, exactly>", "confidence": "high"|"low"}]}

Rules:
- Use ONLY a category from the list. Never invent one, never reword one.
- If a line does not clearly belong to any of them, return null for category.
- Judge from the description and the merchant, nothing else. Do not guess at intent.
- "high" only when the description plainly names the kind of expense.`;
}

// The reply's shape for one chunk, held by the endpoint. The rule the prompt
// states — a category from the list or nothing — is now also the schema: the
// category is an enum of the form's own headings and the row an enum of the
// rows asked about, so an invented or reworded category cannot come back at
// all. normaliseSuggestions still filters: a refused schema falls back to
// plain JSON mode, where the prompt is the only thing asking.
//
// Headings are sent with their whitespace folded ("LOCAL TRAVEL COST\n(SGD)"
// wraps on the real form), which is also how normaliseSuggestions matches
// them back to the original text.
const _fold = c => String(c).replace(/\s+/g, ' ').trim();
function responseFormat(lines, categories) {
  const names = [...new Set(categories.map(_fold).filter(Boolean))];
  const rows  = [...new Set(lines.map(l => String(l.rowNo)))];
  return jsonSchemaFormat('claim_categories', {
    type: 'object',
    properties: {
      suggestions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            rowNo:      { type: 'string', enum: rows },
            category:   nullable({ type: 'string', enum: names }),
            confidence: { type: 'string', enum: ['high', 'low'] },
          },
          required: ['rowNo', 'category', 'confidence'],
        },
      },
    },
    required: ['suggestions'],
  });
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

// Lines per model call. Every line went into one call capped at 800 tokens, so
// a long claim form's reply was cut off and every suggestion was lost; 25
// lines' worth of {row, category} fits that cap with room to spare.
const CHUNK_SIZE = 25;

async function suggestCategories(userId, matches, categories, deps = {}) {
  const callGemini = deps.callGemini || require('../utils/gemini-client').callGemini;
  const lines = linesNeedingCategory(matches);
  if (!lines.length || !categories.length) return [];

  const suggestions = [];
  // One call after another: the user's Gemini quota is shared with receipt
  // reading running in the same import.
  for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
    const chunk = lines.slice(i, i + CHUNK_SIZE);
    try {
      const raw = await callGemini(userId, [
        { role: 'system', content: 'You categorise expense claims. Return only JSON.' },
        { role: 'user',   content: _prompt(chunk, categories) },
      ], { temperature: 0, maxTokens: 800, responseFormat: responseFormat(chunk, categories) });
      suggestions.push(...normaliseSuggestions(parseLlmJson(raw), chunk, categories));
    } catch (err) {
      // A missing category is a blank field for a person to fill, not a
      // failure — and one chunk failing does not cost the others theirs.
      logger.warn('Category suggestion failed', { userId, lines: chunk.length, error: err.message });
    }
  }
  logger.info('Claim categories suggested', { userId, asked: lines.length, returned: suggestions.length });
  return suggestions;
}

module.exports = { suggestCategories, normaliseSuggestions, linesNeedingCategory, responseFormat, _prompt, CHUNK_SIZE };
