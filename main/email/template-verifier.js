const { callGemini }   = require('../utils/gemini-client');
const { parseLlmJson } = require('../utils/llm-json');
const template         = require('./invoice-template');
const logger           = require('../utils/logger');

// A second reading of a template email, after the regex parser has had its go.
//
// The regex parser decides that an email IS an invoice — a template match is
// certain, and nothing here changes that. What it is less good at is reading
// the values: it needs each label spelled exactly, each line in order, and it
// cannot tell when a field is simply missing. This asks the model the narrow
// question the regex cannot answer: given the template and the text, does each
// value the parser extracted actually match what the document says?
//
// Rules, in order of importance:
//
//   1. It can never make things worse. Any failure — a timeout, a quota error,
//      a reply that is not JSON — returns the parser's result untouched. The
//      worst case is exactly today's behaviour.
//   2. It cannot change what kind of document this is. It is handed the parsed
//      fields before invoiceType is decided, so it structurally cannot.
//   3. A disagreement about money is a flag, not an overwrite. If the model
//      reads different amounts, or the document states a total the parser's
//      figures do not add up to, the parser's numbers are kept and the record
//      is marked review-needed with both readings in the message. Silently
//      replacing a figure would hide the very thing a human needs to look at.
//   4. Header fields and descriptions are corrected in place. Getting a
//      customer's name or address slightly wrong is not the kind of error a
//      review queue should exist for.
//   5. Every disagreement is logged, so after a while the log says which fields
//      the regex gets wrong and how often — which is the evidence for whether
//      to keep tuning it or let the model lead.

const SYSTEM_PROMPT = `You verify data extracted from an email that follows a fixed template. Return ONLY valid JSON, no explanation, no markdown.

${template.describe()}

You will be given the email text and the values a parser extracted from it. For each field, report the value AS IT APPEARS IN THE TEXT — do not invent, infer or tidy. If a field is not present in the text, return null for it.

Return this shape:
{
  "contactName": string|null,
  "contactEmail": string|null,
  "contactAddress": string|null,            // lines joined with ", "
  "currency": string|null,                  // 3-letter ISO code only
  "lineItems": [ { "description": string, "unitAmount": number|null, "discountRate": number|null, "taxPercent": number|null } ],
  "statedTotal": number|null,               // ONLY if the text explicitly states a total; never compute one
  "invoiceDate": "YYYY-MM-DD"|null,         // ONLY if the text explicitly states the invoice's date; never use today
  "missingLabels": [string]                 // template labels that do not appear in the text at all
}

Amounts are plain numbers with no currency or thousands separators. A description keeps its full text, bullet points included.

A "Description / Details" block whose text is a payment SCHEDULE — a percentage beside a payment word, e.g. "Payment Terms: 50% upon confirmation, 50% on Event Date", "30% deposit, balance on delivery" — states when the money for the items above it is paid. It is payment terms, not work, and its Amount is an instalment of an item already listed. Never return it as a line item and never count it as one.`;

const MAX_TEXT   = 6000;
const ATTEMPTS   = 2;
const TOLERANCE  = 0.005; // half a cent — rounding, not disagreement

async function _ask(text, parsed, userId) {
  const summary = {
    contactName:    parsed.contactName,
    contactEmail:   parsed.contactEmail,
    contactAddress: parsed.contactAddress,
    currency:       parsed.currency,
    lineItems:      (parsed.lineItems || []).map(li => ({ description: li.description, unitAmount: li.unitAmount, discountRate: li.discountRate })),
    computedTotal:  parsed.totalAmount,
  };
  const content = await callGemini(userId, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: `Email text:\n${text.slice(0, MAX_TEXT)}\n\nWhat the parser extracted:\n${JSON.stringify(summary, null, 2)}` },
  ], { temperature: 0, maxTokens: 1200 });
  const reply = parseLlmJson(content);
  if (!reply || typeof reply !== 'object') throw new Error('Model reply was not valid JSON');
  return reply;
}

const norm = v => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const num  = v => (v === null || v === undefined || v === '' ? null : Number(v));
const same = (a, b) => a !== null && b !== null && Math.abs(a - b) <= TOLERANCE;
const money = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Shifts an ISO date by whole days.
function shift(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

function reconcile(parsed, reply) {
  const out = { ...parsed, lineItems: (parsed.lineItems || []).map(li => ({ ...li })) };
  const disagreements = [];
  const reasons = [];
  const note = (field, ours, theirs, action) => disagreements.push({ field, parser: ours, model: theirs, action });

  // ── Header fields: take the model's reading when it differs and is non-empty.
  for (const key of ['contactName', 'contactEmail', 'contactAddress', 'currency']) {
    const theirs = reply[key];
    if (theirs === null || theirs === undefined || String(theirs).trim() === '') continue;
    if (key === 'currency' && !/^[A-Z]{3}$/.test(String(theirs).trim().toUpperCase())) continue;
    const value = key === 'currency' ? String(theirs).trim().toUpperCase() : String(theirs).trim();
    if (norm(value) !== norm(parsed[key])) {
      note(key, parsed[key], value, 'corrected');
      out[key] = value;
      if (key === 'contactName') out.vendorName = value;   // the parser sets both from one label
    }
  }

  // ── Line items: descriptions are corrected; amounts are only ever flagged.
  //
  //    A block that is a payment schedule is terms for the items above it. The
  //    parser set it aside and attached its text to the last item (parser.js);
  //    the model, asked not to, may still hand it back as a block. It is not a
  //    line item the parser missed, so it is dropped before the counts are
  //    compared — unless it is all the model found, which is a real disagreement.
  const notes  = Array.isArray(parsed.scheduleNotes) ? parsed.scheduleNotes : [];
  const suffix = notes.length ? `\n${notes.join('\n')}` : '';
  let theirs = Array.isArray(reply.lineItems) ? reply.lineItems : null;
  if (theirs) {
    const items = theirs.filter(t => !(t && template.isPaymentSchedule(t.description)));
    if (items.length) theirs = items;
  }
  if (theirs) {
    if (theirs.length !== out.lineItems.length) {
      note('lineItems.count', out.lineItems.length, theirs.length, 'flagged');
      reasons.push(`Parser found ${out.lineItems.length} line item(s); the document appears to have ${theirs.length}.`);
    } else {
      theirs.forEach((t, i) => {
        const ours = out.lineItems[i];
        // The notes ride on the last item. The model's reading is compared
        // with the item's own wording, and a correction keeps the notes.
        const last = i === out.lineItems.length - 1;
        const bare = last && suffix && ours.description.endsWith(suffix) ? ours.description.slice(0, -suffix.length) : ours.description;
        const tAmt = num(t.unitAmount);
        if (tAmt !== null && !same(tAmt, ours.unitAmount)) {
          note(`lineItems[${i}].unitAmount`, ours.unitAmount, tAmt, 'flagged');
          reasons.push(`Line ${i + 1}: parser read ${money(ours.unitAmount)}, the document appears to say ${money(tAmt)}.`);
        }
        const tDisc = num(t.discountRate);
        if (tDisc !== null && !same(tDisc, ours.discountRate || 0)) {
          note(`lineItems[${i}].discountRate`, ours.discountRate, tDisc, 'flagged');
          reasons.push(`Line ${i + 1}: parser read a ${ours.discountRate || 0}% discount, the document appears to say ${tDisc}%.`);
        }
        if (t.description && norm(t.description) !== norm(bare)) {
          note(`lineItems[${i}].description`, ours.description, t.description, 'corrected');
          const corrected = String(t.description).trim();
          const keep = last ? notes.filter(n => !norm(corrected).includes(norm(n))) : [];
          ours.description = [corrected, ...keep].join('\n').slice(0, 4000);
        }
      });
    }
  }

  // ── A stated total the figures do not reach is the strongest signal that a
  //    line item was missed. Never overwrite; always surface.
  const stated = num(reply.statedTotal);
  if (stated !== null && !same(stated, parsed.totalAmount)) {
    note('totalAmount', parsed.totalAmount, stated, 'flagged');
    reasons.push(`Parser's lines total ${money(parsed.totalAmount)}, but the document states ${money(stated)}.`);
  }

  // ── The template has no date field, so the parser dates the invoice from the
  //    email. A date the document itself states is better; the due date moves
  //    with it when it was derived as "N days".
  if (typeof reply.invoiceDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(reply.invoiceDate) && reply.invoiceDate !== parsed.invoiceDate) {
    const terms = daysBetween(parsed.invoiceDate, parsed.dueDate);
    note('invoiceDate', parsed.invoiceDate, reply.invoiceDate, 'corrected');
    out.invoiceDate = reply.invoiceDate;
    if (terms >= 0) out.dueDate = shift(reply.invoiceDate, terms);
  }

  // ── A required label missing altogether is worth a look even if the parser
  //    filled something in from a fallback.
  const missing = Array.isArray(reply.missingLabels) ? reply.missingLabels.map(norm) : [];
  const requiredMissing = [...template.HEADER_FIELDS, ...template.LINE_ITEM_FIELDS]
    .filter(f => f.required && missing.includes(norm(f.label)))
    .map(f => f.label);
  if (requiredMissing.length) {
    note('missingLabels', null, requiredMissing, 'flagged');
    reasons.push(`Template field(s) not found in the email: ${requiredMissing.join(', ')}.`);
  }

  return { parsed: out, disagreements, reviewReason: reasons.length ? reasons.join(' ') : null };
}

// Returns { parsed, disagreements, reviewReason, verified }. Never throws.
async function verifyTemplateExtraction(text, parsed, userId) {
  const untouched = { parsed, disagreements: [], reviewReason: null, verified: false };
  if (!text || !parsed) return untouched;

  let reply;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      reply = await _ask(text, parsed, userId);
      break;
    } catch (err) {
      if (attempt < ATTEMPTS) {
        logger.warn(`Template verification failed — retrying (attempt ${attempt}/${ATTEMPTS})`, { userId, error: err.message });
        await new Promise(r => setTimeout(r, 2000));
      } else {
        // Rule 1: the parser's result stands.
        logger.warn('Template verification skipped — keeping the parser result', { userId, error: err.message });
        return untouched;
      }
    }
  }

  try {
    const result = reconcile(parsed, reply);
    for (const d of result.disagreements) {
      logger.info('Template verification disagreement', { userId, ...d });
    }
    if (result.reviewReason) {
      logger.warn('Template verification flagged for review', { userId, reason: result.reviewReason });
    }
    return { ...result, verified: true };
  } catch (err) {
    logger.warn('Template verification could not be applied — keeping the parser result', { userId, error: err.message });
    return untouched;
  }
}

module.exports = { verifyTemplateExtraction, _reconcile: reconcile, SYSTEM_PROMPT };
