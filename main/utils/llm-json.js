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

// ── Structured output ───────────────────────────────────────────────────────
//
// Every caller here used to ask for JSON in the prompt and then clean up what
// came back — fences stripped, the widest {...} span tried, the whole request
// retried blind when that failed. Google's OpenAI-compatible endpoint can hold
// the reply to a JSON Schema instead, so the model cannot answer in prose or
// drop a field. The request shape is OpenAI's:
//
//   response_format: { type: 'json_schema', json_schema: { name, schema } }
//
// (accepted in real-time requests, not in batch; see
// https://ai.google.dev/gemini-api/docs/openai and
// https://ai.google.dev/gemini-api/docs/structured-output for the schema
// subset — anyOf, 'null', enum, minItems/maxItems are in it). parseLlmJson
// above stays the reader: a schema the endpoint refuses falls back to plain
// JSON mode (gemini-client), and that reply is only as tidy as the model makes it.
//
// OpenAI's `strict` flag is left out on purpose: it is not documented for
// Gemini, and an unknown field is one more reason for a 400.
function jsonSchemaFormat(name, schema) {
  return { type: 'json_schema', json_schema: { name, schema } };
}

// A value the model may leave empty. anyOf with a 'null' branch is the form
// Google lists as supported (it is what Pydantic's Optional produces), where a
// type array is not documented.
function nullable(schema) {
  return { anyOf: [schema, { type: 'null' }] };
}

module.exports = { parseLlmJson, stripWrapping, jsonSchemaFormat, nullable };
