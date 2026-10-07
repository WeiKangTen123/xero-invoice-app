const logger       = require('./logger');
const { callGemini } = require('./gemini-client');
const invoiceStore  = require('./invoice-store');
const { EDITABLE_FIELDS } = require('../routes/invoices');
const { financialContext, looksFinancial } = require('./chat-financials');
const { parseLlmJson, stripWrapping } = require('./llm-json');
const { _groundMarkdown, _allowedFromText } = require('../xero/ai-insights');

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

// ── What the model is shown ─────────────────────────────────────────────────
//
// Every turn used to send the 60 most recent invoices and the pinned invoice
// in full — its paymentReference included, which is the vendor's bank name,
// account number and SWIFT code — whatever the question was. "Change the
// invoice number to INV-999" shipped someone's bank account to a third party
// for no reason. Now a turn carries what its question can use:
//
//   * the invoices the question names — by number, vendor, date, amount or
//     status — or, when it names none, the 20 most recent;
//   * counts by status, so "how many are pending?" is not answered from a
//     sample;
//   * payment details only when the question asks about them.

// Sent when the question names no invoice in particular.
const RECENT_INVOICES_LIMIT = 20;
// Sent at most when it does: "mark all pending as reviewed" needs every
// pending invoice, not the newest 20 of everything.
const MATCHED_INVOICES_LIMIT = 40;
// Searched for the invoices a question names. Read from the local database;
// only the matches are sent.
const SEARCH_POOL = 500;

// Bank and payment details. Never sent unless asked for: a question about a
// total, a date or a status has no use for an account number.
const PAYMENT_FIELDS = new Set(['paymentReference']);

// A question about how or where to pay, or about the bank details themselves.
// Deliberately not bare "account": "change the account code to 400" is about
// the Xero ledger account, not a bank.
const PAYMENT_QUESTION = new RegExp([
  String.raw`\bpay\s?now\b`, String.raw`\bbank(?:ing)?\b`, String.raw`\bswift\b`, String.raw`\bbic\b`, String.raw`\biban\b`,
  String.raw`\bacct\b`, String.raw`\bbeneficiar(?:y|ies)\b`, String.raw`\brouting\b`, String.raw`\bsort\s?code\b`,
  String.raw`\bremit(?:tance)?\b`, String.raw`\bwire\b`, String.raw`\btransfer\s+(?:details?|to)\b`,
  String.raw`\bpayment\s*(?:ref(?:erence)?|details?|info(?:rmation)?|instructions?|method|terms)\b`,
  String.raw`\baccount\s*(?:no|num(?:ber)?|#|details?)\b`,
  String.raw`\bhow\s+(?:do|can|should|to|would)\s+(?:i|we)?\s*pay\b`, String.raw`\bwhere\s+(?:do|can|should|to)\s+(?:i|we)?\s*pay\b`,
].join('|'), 'i');

function _asksAboutPayment(text) {
  return PAYMENT_QUESTION.test(String(text || ''));
}

function _summarize(inv) {
  return {
    id: inv.id, vendorName: inv.vendorName, invoiceNumber: inv.invoiceNumber,
    status: inv.status, totalAmount: inv.totalAmount, currency: inv.currency,
    invoiceDate: inv.invoiceDate,
  };
}

function _fullDetail(inv, { payment = false } = {}) {
  const out = { id: inv.id, status: inv.status };
  for (const field of EDITABLE_FIELDS) {
    if (!payment && PAYMENT_FIELDS.has(field)) continue;
    out[field] = inv[field];
  }
  return out;
}

// ── Which invoices a question is about ──────────────────────────────────────

const _fold = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
// Words in a company name that say nothing about which company it is.
const NAME_NOISE = new Set(['the', 'and', 'pte', 'ltd', 'llp', 'llc', 'inc', 'corp', 'corporation', 'company',
  'limited', 'group', 'holdings', 'services', 'service', 'solutions', 'trading', 'enterprise', 'enterprises',
  'international', 'sdn', 'bhd', 'singapore', 'asia', 'invoice', 'bill']);
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// "review" alone is usually the verb ("review the details of this invoice"),
// so only phrasings that name the status count.
const STATUS_WORDS = [
  [/\bpending\b/i, 'pending'],
  [/\bneeds?\s+(?:a\s+)?review\b|\breview[-\s]needed\b|\b(?:for|in|under|awaiting)\s+review\b|\bon\s+hold\b|\bheld\b/i, 'review-needed'],
  [/\breviewed\b/i, 'reviewed'],
  [/\bposted\b|\bin\s+xero\b|\bsent\s+to\s+xero\b/i, 'posted'],
  [/\berror|\bfail(?:ed|ure)?\b/i, 'error'],
  [/\bduplicates?\b/i, 'duplicate'],
];

// What a question names, read once: invoice-number-like tokens, words,
// dates and months, amounts, statuses.
function _questionTerms(text) {
  const s = String(text || '');
  const lower = s.toLowerCase();
  const tokens = new Set(lower.split(/[\s,;:()"'?!]+/).map(_fold).filter(t => t.length >= 3));
  const words = new Set(lower.match(/[a-z][a-z&'-]{2,}/g) || []);
  const dates = new Set(s.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []);
  const months = new Set(s.match(/\b\d{4}-\d{2}(?!-\d)\b/g) || []);
  const monthOnly = new Set();
  const monthRe = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?(?:\s+(\d{4}))?/gi;
  let m;
  while ((m = monthRe.exec(s)) !== null) {
    const word = m[1].toLowerCase();
    const idx = MONTHS.findIndex(name => name.startsWith(word.slice(0, 3)));
    if (idx === -1) continue;
    const mm = String(idx + 1).padStart(2, '0');
    if (m[2]) months.add(`${m[2]}-${mm}`);
    // "may" alone is far more often the verb than the month.
    else if (word !== 'may') monthOnly.add(mm);
  }
  const amounts = (s.match(/\d[\d,]*(?:\.\d+)?/g) || [])
    .map(n => Number(n.replace(/,/g, '')))
    .filter(n => Number.isFinite(n) && n > 0);
  const statuses = new Set(STATUS_WORDS.filter(([re]) => re.test(s)).map(([, st]) => st));
  return { folded: _fold(s), tokens, words, dates, months, monthOnly, amounts, statuses };
}

// Named specifically: by number, vendor, date or amount.
function _named(inv, q) {
  const num = _fold(inv.invoiceNumber);
  if (num.length >= 3 && (q.tokens.has(num) || (num.length >= 4 && q.folded.includes(num)))) return true;

  const name = String(inv.vendorName || inv.contactName || '').toLowerCase();
  if (name) {
    const whole = _fold(name);
    if (whole.length >= 4 && q.folded.includes(whole)) return true;
    const distinctive = (name.match(/[a-z][a-z&'-]{2,}/g) || []).filter(w => w.length >= 4 && !NAME_NOISE.has(w));
    if (distinctive.some(w => q.words.has(w))) return true;
  }

  const date = String(inv.invoiceDate || '');
  const due  = String(inv.dueDate || '');
  if (q.dates.has(date) || q.dates.has(due)) return true;
  if (date && (q.months.has(date.slice(0, 7)) || q.monthOnly.has(date.slice(5, 7)))) return true;

  const total = Number(inv.totalAmount);
  return Number.isFinite(total) && total > 0 && q.amounts.some(a => Math.abs(a - total) < 0.005);
}

// Pure; exported for testing. `pool` is newest first. The invoices a question
// names come first; a status ("all pending") is the next-best reading, and
// only when nothing is named — "has the Acme invoice been posted?" is about
// Acme, not about every posted invoice. Neither: the most recent 20.
//
// The caller reads the question together with the user's last two turns, so
// "the payroll one" after "show me the Branworks invoice" still finds Branworks.
function _relevantInvoices(pool, text) {
  const q = _questionTerms(text);
  let picked = pool.filter(inv => _named(inv, q));
  if (!picked.length && q.statuses.size) picked = pool.filter(inv => q.statuses.has(inv.status));
  if (picked.length) return { invoices: picked.slice(0, MATCHED_INVOICES_LIMIT), matched: true };
  return { invoices: pool.slice(0, RECENT_INVOICES_LIMIT), matched: false };
}

function _systemPrompt() {
  return `You are an assistant embedded in a Xero invoice automation app. You do two things: help the user find and correct invoice/bill records, and answer questions about how the business is doing.

TWO DIFFERENT DATA SETS — DO NOT CONFUSE THEM:
- "recentInvoices" and "pinnedInvoice" are this app's PIPELINE: documents parsed from email or photographed receipts, NOT yet posted to Xero. They are what you can propose changes to.
- "xeroFinancials" is the BOOKS, read live from Xero. It includes figures entered directly by an accountant that never passed through this app. Use it for anything about performance, cash, revenue, profit, what is owed, or what is overdue.
- Answering "how much have we invoiced?" from the pipeline would report only what happened to arrive by email. Use xeroFinancials for that.
- If xeroFinancials is null, you have no live financial data for this question. Say so plainly and suggest opening the Dashboard, rather than answering from the pipeline as though it were the books.

WHAT THE INVOICE DATA HOLDS:
- "recentInvoices" is NOT the whole pipeline: it holds only the invoices this question appears to be about, or the ${RECENT_INVOICES_LIMIT} most recent when it names none. "invoiceCounts" gives the true number of invoices in each status — use it for any count. If the invoice the user means is not in the data, ask for its invoice number or vendor rather than guessing.
- Payment details (paymentReference — bank, account number, PayNow, SWIFT, beneficiary) are left out unless the user's message asks about payment details. If they are absent, never guess them; tell the user to ask about the payment details if they need them.

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

// Room for a table and a few proposals. A reply cut off here is asked for once
// more at a larger limit by gemini-client before anything below sees it.
const MAX_REPLY_TOKENS = 1500;

const CUT_SHORT  = 'This answer was cut short. Ask again, or ask for less at once.';
const CUT_ACTIONS = 'Any changes I was about to suggest were cut off. Ask again to see them.';
const INCOMPLETE = "Sorry, that answer came back incomplete — could you ask again, perhaps in smaller parts?";
const UNVERIFIED = '_Some figures in this answer could not be matched to your Xero figures or invoices, so they were left out. The Dashboard shows the exact numbers._';

// A reply that did not parse as the JSON asked for. Plain prose is shown as it
// came, as before. A JSON fragment — what a reply cut off at its token limit
// looks like — used to be shown raw, braces and all; the "reply" text is taken
// out of it when it can be, and otherwise the user is told plainly.
function _replyFromUnparsed(raw, truncated) {
  const text = stripWrapping(raw);
  const jsonish = /^[{[]/.test(text) || /"reply"\s*:/.test(text);
  if (!jsonish) {
    if (!text) return truncated ? INCOMPLETE : "Sorry, I couldn't process that — could you rephrase?";
    return truncated ? `${text}…\n\n_${CUT_SHORT}_` : text;
  }
  const unescape = s => { try { return JSON.parse(`"${s}"`).trim(); } catch { return ''; } };
  const whole = text.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (whole) {
    const reply = unescape(whole[1]);
    if (reply) return truncated && /"proposals"\s*:\s*\[\s*\{/.test(text) ? `${reply}\n\n_${CUT_ACTIONS}_` : reply;
  }
  const partial = text.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (partial) {
    // An escape cut in half ("\" or "\u00") would make the rest unreadable.
    const reply = unescape(partial[1].replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, ''));
    if (reply) return `${reply}…\n\n_${CUT_SHORT}_`;
  }
  return INCOMPLETE;
}

// history: [{ role: 'user'|'assistant', content: string }]
async function respond(userId, { message, history = [], invoiceId = null, tenantId = null, period = null, timezone = 'UTC' }) {
  const store = invoiceStore.forUser(userId);

  const pinned = invoiceId ? store.getById(invoiceId) : null;
  // Bank details only when THIS message asks for them — not because an
  // earlier turn did.
  const payment = _asksAboutPayment(message);
  const lastAsked = history.filter(m => m && m.role !== 'assistant').slice(-2).map(m => String(m.content || ''));
  const { invoices, matched } = _relevantInvoices(store.getRecent(SEARCH_POOL), [...lastAsked, message].join('\n'));
  const recent = invoices.map(_summarize);
  logger.info('Chat context', { userId, invoices: recent.length, matched, pinned: !!pinned, payment });

  // Only fetched when the question sounds financial. A cold cash-flow read costs
  // several Xero calls and billed egress, and "change the invoice number to
  // 2026099" has no business paying for it.
  const fetched = looksFinancial(message)
    ? await financialContext(userId, tenantId, { timezone, period })
    : null;
  // `allowed` is for checking the reply, not for the model to read.
  const { allowed: allowedFigures = [], ...financials } = fetched || {};

  const contextBlock = JSON.stringify({
    pinnedInvoice: pinned ? _fullDetail(pinned, { payment }) : null,
    recentInvoices: recent,
    // Totals, so a count is never read off the sample above.
    invoiceCounts: store.countByStatus(),
    // The BOOKS, from Xero — distinct from recentInvoices, which is this app's
    // unposted pipeline. Conflating them would answer "how much did we bill?"
    // with "how much happened to arrive by email".
    xeroFinancials: fetched ? financials : null,
  });

  // Context first, detailed format instructions + examples last (closest to where
  // generation starts) — this model follows the response schema far more reliably
  // when the instructions are the most recent thing it read, rather than being
  // pushed out of focus by a long context block that comes after them.
  const turns = history.slice(-12).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }));
  const messages = [
    { role: 'system', content: `Invoice data (JSON):\n${contextBlock}\n\n${_systemPrompt()}` },
    ...turns,
    { role: 'user', content: message },
  ];

  // A reply still cut off after gemini-client's larger retry arrives as an
  // error carrying what was written; it is shown for what it is, not retried.
  let raw;
  let truncated = false;
  try {
    raw = await callGemini(userId, messages, { temperature: 0, maxTokens: MAX_REPLY_TOKENS });
  } catch (err) {
    if (!(err && err.code === 'GEMINI_TRUNCATED')) throw err;
    logger.warn('Chat reply cut off at its token limit', { userId });
    truncated = true;
    raw = err.partial || '';
  }

  // A cut-off reply's proposals are never trusted: a half-written lineItems
  // array would replace an invoice's lines with the half that arrived.
  const parsed = truncated ? null : parseLlmJson(raw);
  let reply;
  let proposals = [];
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    reply = String(parsed.reply || '');
    proposals = _sanitizeProposals(parsed.proposals, userId);
  } else {
    logger.warn('Chat agent returned non-JSON response', { userId, truncated });
    reply = _replyFromUnparsed(raw, truncated);
  }

  // The prompt tells the model to use only the figures it was given; this
  // checks that it did, with the same guard the dashboard narrative uses
  // (xero/ai-insights.js). A figure is grounded when it is one of the facts or
  // appears anywhere the model was shown — the invoice data, the conversation,
  // the question. A sentence or table row quoting anything else is removed and
  // the user is told. Only when the books were in the context: a pipeline
  // answer may state a difference the user asked for ("the extra USD 50.00"),
  // and there is no Xero figure there for it to be confused with.
  if (fetched) {
    const allowed = new Set(allowedFigures);
    _allowedFromText([contextBlock, ...turns.map(t => t.content), message].join('\n'), allowed);
    const grounded = _groundMarkdown(reply, allowed);
    if (grounded.dropped) {
      logger.warn('Chat reply quoted figures not in its context — removed', { userId, dropped: grounded.dropped, figures: grounded.unmatched.length });
      reply = grounded.text ? `${grounded.text}\n\n${UNVERIFIED}` : UNVERIFIED;
    }
  }

  return { reply, proposals };
}

module.exports = {
  respond, PROPOSAL_TYPES, _replyFromUnparsed, _relevantInvoices, _asksAboutPayment, _fullDetail,
  RECENT_INVOICES_LIMIT, MATCHED_INVOICES_LIMIT,
};
