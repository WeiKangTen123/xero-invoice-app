// The one shape every document takes on its way into the system, and the one
// set of helpers that clean values into it.
//
// Three extractors feed this app — a text LLM for emailed PDFs, a vision LLM
// for photographed receipts, and a regex-plus-verifier for the AR template —
// and until this file each had its own vocabulary (vendorName / merchant /
// contactName for the same thing) and its own copies of the date, number and
// currency cleaning. Two of those copies had drifted: one treated an unreadable
// date as "today", the other as null. Everything downstream — dedup, the row
// builder, Xero submission — now reads one shape, and the extractors adapt to
// it rather than the other way round.
//
// A Document is what an extractor returns. It is not yet a row: it carries no
// id, status, or source, and no user. record.js turns it into one.

const CURRENCY_CODES = ['USD', 'SGD', 'AUD', 'GBP', 'EUR', 'MYR', 'NZD', 'CAD', 'JPY', 'CNY', 'HKD', 'INR'];

// ── Numbers ─────────────────────────────────────────────────────────────────

// Never widens. A total is the field a person is least likely to re-check, so
// a value that is not a clean finite number is dropped rather than coerced.
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const digits = String(value).replace(/[^0-9.-]/g, '');
  // Number('') is 0, so a value with no digit in it at all — a name that landed
  // in the amount column — used to come out as a silent zero. It is nothing.
  if (!/\d/.test(digits)) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

function money(value) {
  const n = num(value);
  return n === null ? null : Math.round(n * 100) / 100;
}

// ── Dates ───────────────────────────────────────────────────────────────────

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function today() { return localDateStr(new Date()); }

// Strict: accepts only a real YYYY-MM-DD that is not in the future. A model
// that answers "2026-13-45", or dates a receipt next year, has misread it, and
// null is more honest than a guess.
function isoDate(value) {
  if (!value || typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const parsed = new Date(Date.UTC(y, mo - 1, d));
  if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== mo - 1 || parsed.getUTCDate() !== d) return null;
  if (parsed.getTime() > Date.now() + 86400000) return null;
  return value.trim();
}

// Lenient: reads what a person typed. "10/08/2026" is day-first (Singapore),
// "2026-08-10" is ISO, "10 Aug 2026" is whatever Date() accepts. Returns null
// when nothing usable is there — the caller decides what to fall back to,
// because "today" is right for a due date and wrong for an invoice date.
function parseDate(raw) {
  if (!raw) return null;
  try {
    const trimmed = String(raw).trim();
    if (!trimmed) return null;
    if (!trimmed.includes('/')) {
      const direct = new Date(trimmed);
      if (!isNaN(direct)) return localDateStr(direct);
    }
    const parts = trimmed.split(/[/\-.]/);
    if (parts.length < 3) return null;
    const d = parts[0].length === 4
      ? new Date(`${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`)
      : new Date(`${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`);
    return isNaN(d) ? null : localDateStr(d);
  } catch {
    return null;
  }
}

// Null, not a throw, for input it cannot read: a model that answers
// "14/09/2026" must not take the whole bill down with a RangeError.
function addDays(dateStr, days) {
  const iso = isoDate(String(dateStr || '')) || parseDate(dateStr);
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return localDateStr(d);
}

// ── Currency ────────────────────────────────────────────────────────────────

function currencyCode(value) {
  if (!value || typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

// Reads a document's own currency from its text rather than assuming the
// account's default. Null, not a guess, when the text does not say.
function detectCurrency(text) {
  if (!text) return null;
  const labeled = text.match(/Currency\s*:\s*([A-Z]{3})\b/i);
  if (labeled && CURRENCY_CODES.includes(labeled[1].toUpperCase())) return labeled[1].toUpperCase();
  const nearAmount = text.match(new RegExp(`\\b(${CURRENCY_CODES.join('|')})\\b\\s*\\$?\\s*[\\d,]+\\.?\\d*`));
  if (nearAmount) return nearAmount[1].toUpperCase();
  // Symbols that name a currency. A bare "$" does not — it is used by USD, SGD,
  // AUD, CAD, HKD and NZD — so it is deliberately not handled.
  if (/S\$/.test(text))     return 'SGD';
  if (/A\$/.test(text))     return 'AUD';
  if (/£/.test(text))       return 'GBP';
  if (/€/.test(text))       return 'EUR';
  if (/¥/.test(text))       return 'JPY';
  if (/RM\s?\d/.test(text)) return 'MYR';
  return null;
}

// ── Tax ─────────────────────────────────────────────────────────────────────

// "9%", "GST 9%", "VAT (20%)" → 9 / 9 / 20. Free text with no figure ("GST",
// "-", blank) → null: it carries no computable amount, so no tax is assumed.
function parseTaxPercent(raw) {
  if (!raw) return null;
  const m = String(raw).match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1]) : null;
}

// subTotal + taxAmount must equal total before a figure reaches Xero, which
// looks the org's real tax rate up from those two. Stated values win; missing
// ones are derived from whichever are known.
function ensureSubtotalTax(doc) {
  const total = Number(doc.total ?? doc.totalAmount) || 0;
  let sub = doc.subTotal  != null ? Number(doc.subTotal)  : null;
  let tax = doc.taxAmount != null ? Number(doc.taxAmount) : null;
  if (sub == null && tax == null) { sub = total; tax = 0; }
  else if (sub == null)          { sub = total - tax; }
  else if (tax == null)          { tax = total - sub; }
  if (!(sub > 0)) sub = total;
  if (!(tax >= 0)) tax = 0;
  doc.subTotal  = parseFloat(sub.toFixed(2));
  doc.taxAmount = parseFloat((tax || 0).toFixed(2));
  return doc;
}

// ── The Document ────────────────────────────────────────────────────────────

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

// Accepts any of the vocabularies the extractors have used and returns one
// shape. Unknown keys are dropped; nothing is invented.
function normaliseDocument(raw = {}) {
  const contactName = str(raw.contact?.name ?? raw.contactName ?? raw.vendorName ?? raw.merchant, 255);
  const lineItems = (Array.isArray(raw.lineItems) ? raw.lineItems : [])
    .map(li => {
      if (!li || typeof li !== 'object') return null;
      const description = str(li.description ?? li.name, 4000);
      const unitAmount  = money(li.unitAmount ?? li.price ?? li.amount ?? li.total);
      if (!description && unitAmount === null) return null;
      const discount = num(li.discountRate);
      return {
        description:  description || 'Item',
        unitAmount:   unitAmount !== null && unitAmount >= 0 ? unitAmount : 0,
        discountRate: discount !== null && discount >= 0 ? discount : 0,
        taxPercent:   parseTaxPercent(li.taxPercent ?? li.tax) ?? (num(li.taxPercent) ?? null),
      };
    })
    .filter(Boolean);

  return ensureSubtotalTax({
    contact: {
      name:    contactName,
      email:   str(raw.contact?.email   ?? raw.contactEmail   ?? raw.vendorEmail,   255),
      address: str(raw.contact?.address ?? raw.contactAddress ?? raw.vendorAddress, 500),
      phone:   str(raw.contact?.phone   ?? raw.contactPhone   ?? raw.vendorPhone,   50),
    },
    number:           str(raw.number ?? raw.invoiceNumber, 100),
    date:             isoDate(raw.date ?? raw.invoiceDate) ?? parseDate(raw.date ?? raw.invoiceDate),
    dueDate:          isoDate(raw.dueDate) ?? parseDate(raw.dueDate),
    currency:         currencyCode(raw.currency),
    lineItems,
    subTotal:         money(raw.subTotal),
    taxAmount:        money(raw.taxAmount ?? raw.tax),
    total:            money(raw.total ?? raw.totalAmount),
    paymentReference: str(raw.paymentReference, 500),
    description:      str(raw.description, 500),
    brandingThemeName: str(raw.brandingThemeName, 100),
    lineAmountTypes:  raw.lineAmountTypes === 'Inclusive' ? 'Inclusive' : 'Exclusive',
    confidence:       str(raw.confidence, 20),
  });
}

module.exports = {
  CURRENCY_CODES,
  num, money, isoDate, parseDate, addDays, today, localDateStr,
  currencyCode, detectCurrency, parseTaxPercent, ensureSubtotalTax,
  normaliseDocument,
};
