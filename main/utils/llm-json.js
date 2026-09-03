// Parsing JSON out of a model reply.
//
// This existed in four places — the chat agent, the receipt parser, the email
// invoice parser and the reports narrative — and the four copies had already
// drifted apart. One stripped a newline after the opening fence and three did
// not; one matched ```JSON case-insensitively and three did not. Same job, four
// behaviours, so a reply that parsed in one path failed in another.
//
// Models wrap JSON in markdown fences, sometimes prefix it with reasoning, and
// occasionally add a sentence either side. All of that is handled here, once.

// Some models emit a visible reasoning block before the answer.
const THOUGHT = /<thought>[\s\S]*?<\/thought>/gi;
// ```json ... ``` or ``` ... ```, with or without the newline after the fence.
const OPEN_FENCE  = /^\s*```(?:json)?\s*\n?/i;
const CLOSE_FENCE = /\n?\s*```\s*$/;

// Strips the wrapping a model puts around JSON. Exported for testing.
function stripWrapping(raw) {
  return String(raw || '')
    .replace(THOUGHT, '')
    .trim()
    .replace(OPEN_FENCE, '')
    .replace(CLOSE_FENCE, '')
    .trim();
}

// Returns the parsed value, or null. Never throws: every caller here is dealing
// with an unreliable model, and a parse failure is an expected outcome to be
// handled rather than an exception to propagate.
function parseLlmJson(raw) {
  const cleaned = stripWrapping(raw);
  if (!cleaned) return null;

  try {
    return JSON.parse(cleaned);
  } catch {
    // Last resort: a model that wrapped the JSON in a sentence. Take the widest
    // {...} or [...] span and try that. Deliberately after a clean parse, so a
    // well-formed reply is never put through this.
    const start = cleaned.search(/[{[]/);
    if (start === -1) return null;
    const lastObj = cleaned.lastIndexOf('}');
    const lastArr = cleaned.lastIndexOf(']');
    const end = Math.max(lastObj, lastArr);
    if (end <= start) return null;
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
  }
}

module.exports = { parseLlmJson, stripWrapping };
