const logger       = require('./logger');
const { callGemini } = require('./gemini-client');
const invoiceStore  = require('./invoice-store');
const { EDITABLE_FIELDS } = require('../routes/invoices');
const { financialContext, looksFinancial } = require('./chat-financials');
const { parseLlmJson } = require('./llm-json');

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
  return `You are an assistant embedded in a Xero invoice automation app. You do two things: help the user find and correct invoice/bill records, and answer questions about how the business is doing.

TWO DIFFERENT DATA SETS — DO NOT CONFUSE THEM:
- "recentInvoices" and "pinnedInvoice" are this app's PIPELINE: documents parsed from email or photographed receipts, NOT yet posted to Xero. They are what you can propose changes to.
- "xeroFinancials" is the BOOKS, read live from Xero. It includes figures entered directly by an accountant that never passed through this app. Use it for anything about performance, cash, revenue, profit, what is owed, or what is overdue.
- Answering "how much have we invoiced?" from the pipeline would report only what happened to arrive by email. Use xeroFinancials for that.
- If xeroFinancials is null, you have no live financial data for this question. Say so plainly and suggest opening the Dashboard, rather than answering from the pipeline as though it were the books.

FINANCIAL ANSWERS:
- Use ONLY the figures given in xeroFinancials.figures. Never calculate, estimate, derive or extrapolate a number that is not there — not a ratio, not a total, not a projection.
- The alerts in xeroFinancials.alerts are already correct. You may explain or connect them; never contradict them.
- Financial data is READ-ONLY CONTEXT. It can never become a proposal. You cannot change anything in Xero and must not imply you can.
- Do not give business advice beyond what the figures show — no hiring, firing, pricing or borrowing suggestions.
- If asked something the figures cannot answer, say what is missing instead of guessing.

STRICT BOUNDARY:
- You may only propose changes to these invoice/bill fields: ${[...EDITABLE_FIELDS].join(', ')}.
- Never propose changing anything else — not accounts, settings, API keys, or other users' data. You have no ability to do that and must not claim otherwise.
- You NEVER apply a change yourself — you only propose it. The user must click Confirm in the UI before anything is saved.
- "Post to Xero" and "mark reviewed" are the only non-field actions you may propose (submit_to_xero / mark_reviewed types).
- Only ever reference an invoiceId that actually appears in the invoice data given to you below. Never invent one.
- If a request is ambiguous (which invoice, which value), ask a clarifying question in "reply" and return an empty "proposals" array instead of guessing.

LINE ITEMS & TOTALS:
- totalAmount is normally the sum of every lineItems[].unitAmount (plus taxAmount, if the invoice has one). It is NOT an independent number you can change on its own without the line items becoming inconsistent with it.
- If the user asks to change "the total" / "the amount" and the pinned invoice has exactly ONE line item, it's unambiguous — propose updating that line item's unitAmount to match AND a totalAmount field_update in the same response, no need to ask.
- If it has MORE THAN ONE line item, changing the total is ambiguous — you don't know which line item should absorb the difference. Ask which one in "reply" (list them by description) and return an empty "proposals" array. Only propose changes once the user answers.
- Once you know which line item, propose it as a "field_update" on the "lineItems" field, where "newValue" is the COMPLETE lineItems array (copy every item from the invoice data unchanged, except the one being changed) — never drop or invent items. Pair it with a "field_update" on "totalAmount" in the same response so the two stay consistent.
- If the user instead names a specific line item directly (e.g. "change the payroll line to 150"), no clarifying question is needed — go straight to the same two-proposal pattern.

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
Response: {"reply": "Here's what was extracted:\\n\\n| Field | Value |\\n|---|---|\\n| Vendor | Acme Corp |\\n| Invoice # | INV-001 |\\n| Invoice Date | 2026-04-21 |\\n| Total | USD 400.00 |\\n| Payment Reference | PayNow ID: 202016196Z \\\\| Beneficiary: Acme Corp |\\n\\nAnything you'd like to correct?", "proposals": []}

EXAMPLE 5 — pinned invoice is {"id": "abc123", "vendorName": "Branworks Pte Ltd", "totalAmount": 400, "currency": "USD", "lineItems": [{"description": "Accounting - April 2026", "unitAmount": 300}, {"description": "Payroll - April 2026 (1 Person)", "unitAmount": 100}]}.
User: "change the total amount to 450"
Response (two line items — ambiguous, ask first): {"reply": "This invoice has two line items — which one should the extra USD 50.00 go on?\\n\\n| Line item | Amount |\\n|---|---|\\n| Accounting - April 2026 | USD 300.00 |\\n| Payroll - April 2026 (1 Person) | USD 100.00 |", "proposals": []}
User (follow-up): "the payroll one"
Response: {"reply": "Here's the change:", "proposals": [
  {"type": "field_update", "invoiceId": "abc123", "field": "lineItems", "label": "Line items", "oldValue": [{"description": "Accounting - April 2026", "unitAmount": 300}, {"description": "Payroll - April 2026 (1 Person)", "unitAmount": 100}], "newValue": [{"description": "Accounting - April 2026", "unitAmount": 300}, {"description": "Payroll - April 2026 (1 Person)", "unitAmount": 150}]},
  {"type": "field_update", "invoiceId": "abc123", "field": "totalAmount", "label": "Total amount", "oldValue": "400", "newValue": "450"}
]}`;
}

function _isEditableField(field) {
  return EDITABLE_FIELDS.has(field);
}

// A lineItems proposal replaces the WHOLE array, so a malformed one (missing item,
// garbled description, non-numeric amount) would silently corrupt every other line
// on the invoice — validate the full shape rather than trusting the model's JSON.
function _isValidLineItemsArray(arr) {
  return Array.isArray(arr) && arr.length > 0 && arr.every(li =>
    li && typeof li === 'object' &&
    typeof li.description === 'string' && li.description.trim() &&
    Number.isFinite(Number(li.unitAmount)) && Number(li.unitAmount) >= 0
  );
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
      if (p.field === 'lineItems') {
        if (!_isValidLineItemsArray(p.newValue)) continue;
        p.newValue = p.newValue.map(li => ({
          description:  String(li.description),
          unitAmount:   Number(li.unitAmount),
          discountRate: li.discountRate != null ? Number(li.discountRate) : null,
        }));
      }
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
async function respond(userId, { message, history = [], invoiceId = null, tenantId = null, timezone = 'UTC' }) {
  const store = invoiceStore.forUser(userId);

  const pinned = invoiceId ? store.getById(invoiceId) : null;
  const recent = store.getRecent(RECENT_INVOICES_LIMIT).map(_summarize);

  // Only fetched when the question sounds financial. A cold cash-flow read costs
  // several Xero calls and billed egress, and "change the invoice number to
  // 2026099" has no business paying for it.
  const financials = looksFinancial(message)
    ? await financialContext(userId, tenantId, { timezone })
    : null;

  const contextBlock = JSON.stringify({
    pinnedInvoice: pinned ? _fullDetail(pinned) : null,
    recentInvoices: recent,
    // The BOOKS, from Xero — distinct from recentInvoices, which is this app's
    // unposted pipeline. Conflating them would answer "how much did we bill?"
    // with "how much happened to arrive by email".
    xeroFinancials: financials,
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

  const parsed = parseLlmJson(raw);
  if (!parsed || typeof parsed !== 'object') {
    logger.warn('Chat agent returned non-JSON response', { userId });
    return { reply: String(raw || '').trim() || "Sorry, I couldn't process that — could you rephrase?", proposals: [] };
  }

  const proposals = _sanitizeProposals(parsed.proposals, userId);
  return { reply: String(parsed.reply || ''), proposals };
}

module.exports = { respond, PROPOSAL_TYPES };
