const logger       = require('./logger');
const { callGemini } = require('./gemini-client');
const invoiceStore  = require('./invoice-store');
const { EDITABLE_FIELDS } = require('../routes/invoices');

// Same set the PATCH /api/invoices/:id route accepts — the chat assistant can only
// ever propose changes to these fields. Nothing else (status, user data, settings,
// other users' invoices) is reachable through chat, by construction: the model is
// told this boundary in the prompt, AND every proposal is re-checked against this
// exact list server-side before it's ever sent to the frontend. The model's word
// alone is never trusted — an out-of-bounds or hallucinated proposal is dropped
// silently rather than shown as something the user could confirm.
const PROPOSAL_TYPES = new Set([
  'field_update', 'submit_to_xero', 'mark_reviewed',
  'bulk_field_update', 'bulk_submit_to_xero',
]);

const RECENT_INVOICES_LIMIT = 60; // cap prompt size for users with a long history

function _summarize(inv) {
  return {
    id: inv.id, vendorName: inv.vendorName, invoiceNumber: inv.invoiceNumber,
    status: inv.status, totalAmount: inv.totalAmount, currency: inv.currency,
    invoiceDate: inv.invoiceDate,
  };
}

function _fullDetail(inv) {
  const out = { id: inv.id, status: inv.status };
  for (const field of EDITABLE_FIELDS) out[field] = inv[field];
  return out;
}

function _systemPrompt() {
  return `You are an invoice assistant embedded in a Xero invoice automation app. You help the user find and correct invoice/bill records.

STRICT BOUNDARY:
- You may only propose changes to these invoice/bill fields: ${[...EDITABLE_FIELDS].join(', ')}.
- Never propose changing anything else — not accounts, settings, API keys, or other users' data. You have no ability to do that and must not claim otherwise.
- You NEVER apply a change yourself — you only propose it. The user must click Confirm in the UI before anything is saved.
- "Post to Xero" and "mark reviewed" are the only non-field actions you may propose (submit_to_xero / mark_reviewed types).
- Only ever reference an invoiceId that actually appears in the invoice data given to you below. Never invent one.
- If a request is ambiguous (which invoice, which value), ask a clarifying question in "reply" and return an empty "proposals" array instead of guessing.

FORMATTING: the "reply" text is rendered as markdown (GitHub-flavored, tables included). When you're presenting several fields of ONE record — e.g. summarizing an invoice's details, reviewing what was extracted — use a markdown table with "Field" and "Value" columns instead of a bulleted list; it's far easier to scan. Keep a short sentence before or after the table, not inside it. For simple short answers (one fact, a status, a yes/no) plain text is fine — don't force a table where there's nothing to compare.
IMPORTANT: a table cell is delimited by "|" — if a value itself contains a "|" character (this happens with paymentReference, which often looks like "PayNow ID: X | Beneficiary: Y"), you MUST escape every "|" inside that cell as "\\|", or the table's columns will misalign when rendered.

You must respond with ONLY one JSON object — no markdown fences, no text outside the JSON:
{"reply": "<text shown to the user>", "proposals": [<zero or more proposal objects>]}

Each proposal is exactly one of these five shapes:
{"type": "field_update", "invoiceId": "<id>", "field": "<allowed field>", "label": "<short field label>", "oldValue": "<current value>", "newValue": "<requested value>"}
{"type": "submit_to_xero", "invoiceId": "<id>", "label": "<vendor — amount>"}
{"type": "mark_reviewed", "invoiceId": "<id>", "label": "<vendor — amount>"}
{"type": "bulk_field_update", "field": "<field>", "newValue": "<value>", "items": [{"invoiceId": "<id>", "label": "<vendor — amount>", "oldValue": "<current value>"}]}
{"type": "bulk_submit_to_xero", "items": [{"invoiceId": "<id>", "label": "<vendor — amount>"}]}
For an action affecting several invoices individually (e.g. marking each as reviewed), it's fine to return multiple separate proposal objects in the array rather than a bulk one — bulk types exist for a single field change or Xero submission applied identically across many invoices.

EXAMPLE 1 — pinned invoice is {"id": "abc123", "vendorName": "Acme Corp", "invoiceNumber": "INV-001", "totalAmount": 400, "currency": "USD"}.
User: "change the invoice number to INV-999"
Response: {"reply": "Here's the change:", "proposals": [{"type": "field_update", "invoiceId": "abc123", "field": "invoiceNumber", "label": "Invoice #", "oldValue": "INV-001", "newValue": "INV-999"}]}

EXAMPLE 2 — no invoice pinned; recentInvoices includes {"id": "abc123", "vendorName": "Acme Corp", "invoiceNumber": "INV-001", "status": "posted", ...}.
User: "what's the status of the Acme invoice?"
Response: {"reply": "The Acme Corp invoice (INV-001) is currently marked Posted to Xero.", "proposals": []}

EXAMPLE 3 — recentInvoices includes two invoices with status "pending": {"id": "id1", "vendorName": "Acme Corp", "totalAmount": 100, "currency": "USD"} and {"id": "id2", "vendorName": "Beta Co", "totalAmount": 50, "currency": "USD"}.
User: "mark all pending invoices as reviewed"
Response: {"reply": "This will mark 2 invoices as reviewed:", "proposals": [{"type": "mark_reviewed", "invoiceId": "id1", "label": "Acme Corp — USD 100.00"}, {"type": "mark_reviewed", "invoiceId": "id2", "label": "Beta Co — USD 50.00"}]}

EXAMPLE 4 — pinned invoice is {"id": "abc123", "vendorName": "Acme Corp", "invoiceNumber": "INV-001", "invoiceDate": "2026-04-21", "totalAmount": 400, "currency": "USD", "paymentReference": "PayNow ID: 202016196Z | Beneficiary: Acme Corp"}.
User: "review the details of this invoice"
Response: {"reply": "Here's what was extracted:\\n\\n| Field | Value |\\n|---|---|\\n| Vendor | Acme Corp |\\n| Invoice # | INV-001 |\\n| Invoice Date | 2026-04-21 |\\n| Total | USD 400.00 |\\n| Payment Reference | PayNow ID: 202016196Z \\\\| Beneficiary: Acme Corp |\\n\\nAnything you'd like to correct?", "proposals": []}`;
}

function _isEditableField(field) {
  return EDITABLE_FIELDS.has(field);
}

// Drops any proposal that doesn't survive validation — wrong shape, an invoice
// the user doesn't own, a field outside the whitelist, or an unknown type.
function _sanitizeProposals(raw, userId) {
  if (!Array.isArray(raw)) return [];
  const store = invoiceStore.forUser(userId);
  const out = [];

  for (const p of raw) {
    if (!p || typeof p !== 'object' || !PROPOSAL_TYPES.has(p.type)) continue;

    if (p.type === 'field_update') {
      if (!_isEditableField(p.field)) continue;
      if (!store.getById(p.invoiceId)) continue;
      out.push({ type: p.type, invoiceId: p.invoiceId, field: p.field, label: String(p.label || p.field), oldValue: p.oldValue, newValue: p.newValue });
    } else if (p.type === 'submit_to_xero' || p.type === 'mark_reviewed') {
      if (!store.getById(p.invoiceId)) continue;
      out.push({ type: p.type, invoiceId: p.invoiceId, label: String(p.label || '') });
    } else if (p.type === 'bulk_field_update') {
      if (!_isEditableField(p.field) || !Array.isArray(p.items)) continue;
      const items = p.items
        .filter(i => i && store.getById(i.invoiceId))
        .map(i => ({ invoiceId: i.invoiceId, label: String(i.label || ''), oldValue: i.oldValue }));
      if (items.length) out.push({ type: p.type, field: p.field, newValue: p.newValue, items });
    } else if (p.type === 'bulk_submit_to_xero') {
      if (!Array.isArray(p.items)) continue;
      const items = p.items
        .filter(i => i && store.getById(i.invoiceId))
        .map(i => ({ invoiceId: i.invoiceId, label: String(i.label || '') }));
      if (items.length) out.push({ type: p.type, items });
    }
  }
  return out;
}

// history: [{ role: 'user'|'assistant', content: string }]
async function respond(userId, { message, history = [], invoiceId = null }) {
  const store = invoiceStore.forUser(userId);

  const pinned = invoiceId ? store.getById(invoiceId) : null;
  const recent = store.getAll().slice(0, RECENT_INVOICES_LIMIT).map(_summarize);

  const contextBlock = JSON.stringify({
    pinnedInvoice: pinned ? _fullDetail(pinned) : null,
    recentInvoices: recent,
  });

  // Context first, detailed format instructions + examples last (closest to where
  // generation starts) — this model follows the response schema far more reliably
  // when the instructions are the most recent thing it read, rather than being
  // pushed out of focus by a long context block that comes after them.
  const messages = [
    { role: 'system', content: `Invoice data (JSON):\n${contextBlock}\n\n${_systemPrompt()}` },
    ...history.slice(-12).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') })),
    { role: 'user', content: message },
  ];

  const raw = await callGemini(userId, messages, { temperature: 0, maxTokens: 1000 });

  let parsed;
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.warn('Chat agent returned non-JSON response', { error: err.message, userId });
    return { reply: raw.trim() || "Sorry, I couldn't process that — could you rephrase?", proposals: [] };
  }

  const proposals = _sanitizeProposals(parsed.proposals, userId);
  return { reply: String(parsed.reply || ''), proposals };
}

module.exports = { respond, PROPOSAL_TYPES };
