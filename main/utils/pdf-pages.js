const pdfParse = require('pdf-parse');
const logger   = require('./logger');

// Splits a PDF into per-page text, and decides whether those pages are one
// receipt or several.
//
// Reading the pages separately needs no PDF renderer and no new dependency:
// pdf-parse's `pagerender` hook already hands us one page at a time.
//
// The limit: this reads the TEXT LAYER. A digital receipt (emailed, generated)
// has one. A photographed page scanned into a PDF does not, and comes back
// empty — which is reported honestly rather than guessed at, because rendering
// those pages to images would need a real PDF renderer.

// Below this a "page" is a header or a stray mark, not a receipt.
const MIN_PAGE_CHARS = 40;

// Pages read from one PDF. pdf-parse reads every page by default, and a split
// PDF costs a model call per page, so a 300-page statement uploaded by mistake
// was 300 calls. Thirty is more receipts than anyone scans into one file on
// purpose; past it, the caller says which pages were not read.
const MAX_PAGES = 30;

async function extractPages(buffer, { maxPages = MAX_PAGES } = {}) {
  const empty = { pages: [], numPages: 0, hasText: false, textPageCount: 0, truncated: false };
  if (!Buffer.isBuffer(buffer) || !buffer.length) return empty;

  const pages = [];
  try {
    const data = await pdfParse(buffer, {
      max: maxPages,
      // Called once per page, in order. Returning the text also lets pdf-parse
      // build its usual combined output, which we ignore.
      //
      // pdf-parse swallows a page that fails to render and moves on, so text
      // pushed in arrival order would slide every later page up by one and the
      // wrong page would be read for a split record. Placed by the page's own
      // index instead, and a page that fails here is kept as an empty page.
      pagerender: async (pageData) => {
        const at = Number.isInteger(pageData && pageData.pageIndex) ? pageData.pageIndex : pages.length;
        let text = '';
        try {
          const content = await pageData.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
          text = content.items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();
        } catch (err) {
          logger.warn('PDF page could not be read', { page: at + 1, error: err.message });
        }
        pages[at] = text;
        return text;
      },
    });

    const numPages = data.numpages || pages.length;
    const read = Math.min(numPages, maxPages);
    for (let i = 0; i < read; i++) if (typeof pages[i] !== 'string') pages[i] = '';
    pages.length = Math.max(read, pages.length);

    const withText = pages.filter(p => p.length >= MIN_PAGE_CHARS);
    return {
      pages,
      numPages,
      // False for a scan: every page is images, so there is nothing to read.
      hasText: withText.length > 0,
      textPageCount: withText.length,
      // Pages past the cap were never read, and the caller must say so.
      truncated: numPages > pages.length,
    };
  } catch (err) {
    logger.warn('PDF page extraction failed', { error: err.message });
    return empty;
  }
}

// ── What a page says about itself ────────────────────────────────────────────
// Splitting used to be decided by page count alone: two pages with text were
// two receipts. A two-page hotel folio became two claims, each with half the
// stay. Whether pages are separate receipts is a question about what is ON
// them, so these read the few things that answer it.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = n => String(n).padStart(2, '0');
const AMOUNT = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;

// The amount printed after a total. "Subtotal", "Total GST" and "Total items"
// are not totals; the LAST total on the page is taken, because a receipt
// prints its subtotals above the final figure.
const TOTAL_RE = new RegExp(
  String.raw`(?<!sub[\s-]?)\b(?:grand\s+total|total\s+(?:amount|due|paid|payable|charged)|amount\s+(?:due|paid|payable|charged)|balance\s+due|net\s+total|total)\b` +
  String.raw`(?!\s*(?:items?|qty|quantity|pcs|pieces|savings?|discounts?|tax|gst|vat)\b)` +
  String.raw`[^\d]{0,25}?` + AMOUNT, 'gi');

function _toNumber(s) {
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function pageTotal(text) {
  let last = null;
  for (const m of String(text || '').matchAll(TOTAL_RE)) last = _toNumber(m[1]);
  return last;
}

// The first date on the page, as a comparable token. Day-month order is
// ambiguous in 03/04/2026 and is deliberately not resolved: the token only has
// to tell two pages apart, not name the day.
const DATE_RES = [
  [/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/, m => `${m[1]}-${pad(m[2])}-${pad(m[3])}`],
  [/\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[\s,-]+(\d{4})\b/i,
    m => `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`],
  [/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i,
    m => `${m[3]}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(m[2])}`],
  [/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/, m => `${pad(m[1])}/${pad(m[2])}/${m[3].length === 2 ? '20' + m[3] : m[3]}`],
];

function pageDate(text) {
  const t = String(text || '');
  let best = null;
  for (const [re, norm] of DATE_RES) {
    const m = re.exec(t);
    if (m && (!best || m.index < best.index)) best = { index: m.index, value: norm(m) };
  }
  return best ? best.value : null;
}

// Page numbering or a carried balance means the pages continue one document.
const CONTINUED_RE = /\bpage\s*\d+\s*(?:of|\/)\s*\d+\b|\b(?:continued|cont'd|carried\s+forward|brought\s+forward|balance\s+b\/f|balance\s+c\/f)\b/i;

// A folio, invoice or receipt number. The same one on every page means one
// document; two receipts never share one. The digit is required inside the
// pattern, not checked afterwards: "Guest Folio Folio No: 884213" would
// otherwise take the second "Folio" as the number and never reach 884213.
const REF_RE = /\b(?:folio|invoice|receipt|bill|order|booking|confirmation|reference|ref)\s*(?:no\.?|number|num|#)?\s*[:#.]?\s*((?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{3,})\b/gi;

function pageRefs(text) {
  const refs = new Set();
  for (const m of String(text || '').matchAll(REF_RE)) {
    // A date after "Receipt" is a date, not a number: two receipts from the
    // same day would otherwise share a "reference".
    if (!/^\d{1,4}-\d{1,2}-\d{1,4}$/.test(m[1])) refs.add(m[1].toUpperCase());
  }
  return refs;
}

function pageSignals(text) {
  return { total: pageTotal(text), date: pageDate(text), continued: CONTINUED_RE.test(String(text || '')), refs: pageRefs(text) };
}

// Every amount printed on a page, in cents, so a figure the reader returned
// can be traced to the page it came from.
function _amountsOn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(new RegExp(String.raw`(?<![\d.,])` + AMOUNT + String.raw`(?![\d])`, 'g'))) {
    const n = _toNumber(m[1]);
    if (n !== null) out.add(Math.round(n * 100));
  }
  return out;
}

// ── The decision ─────────────────────────────────────────────────────────────
// Returns { split, oneDocument, pageNumbers, blankPages, reason }:
//   split        the pages are plainly separate receipts; read each on its own
//   oneDocument  the pages plainly belong together; never split them
//   pageNumbers  pages with readable text, 1-based as a PDF viewer shows them
//   blankPages   pages that were read and hold no readable text. Never dropped:
//                the caller flags each one, because a scanned receipt inside a
//                text PDF looks exactly like this
// Neither split nor oneDocument means the text alone cannot tell, and the
// caller may let the reader's own grouping decide (attributeToPages).
//
// Anything doubtful stays one record. Inventing a second receipt is worse than
// failing to split a real one, which costs a person one look.
function splittablePages({ pages = [], hasText = false } = {}) {
  const pageNumbers = [], blankPages = [];
  pages.forEach((text, i) => ((text || '').length >= MIN_PAGE_CHARS ? pageNumbers : blankPages).push(i + 1));
  const result = (split, oneDocument, reason) => ({ split, oneDocument, pageNumbers, blankPages, reason });

  if (!hasText) return result(false, false, 'no text layer — the PDF is a scan');
  if (pages.length < 2) return result(false, true, 'single page');
  if (pageNumbers.length < 2) return result(false, true, 'fewer than two pages have readable text');

  const signals = pageNumbers.map(p => pageSignals(pages[p - 1]));
  if (signals.some(s => s.continued)) return result(false, true, 'the pages continue one document (page numbering or a carried balance)');
  const shared = [...signals[0].refs].find(ref => signals.every(s => s.refs.has(ref)));
  if (shared) return result(false, true, `every page carries the same reference (${shared})`);

  if (signals.some(s => s.total === null)) return result(false, false, 'not every page has a total of its own');
  if (signals.some(s => !s.date)) return result(false, false, 'not every page has a date of its own');
  const keys = signals.map(s => `${Math.round(s.total * 100)}|${s.date}`);
  if (new Set(keys).size < keys.length) return result(false, false, 'two pages show the same total and date, so they may be copies of one receipt');

  return result(true, false, null);
}

// The reader's own grouping, used when the text alone could not decide.
//
// One read of the whole PDF already happens for the single-record case, and
// the reader is asked to return one entry per distinct receipt. When it finds
// exactly one per text page, and each receipt's total is printed on exactly
// one page that no other receipt claims, that is the page it came from — and
// the PDF splits with no further model call. Any ambiguity returns null and
// the PDF stays one record.
function attributeToPages(receipts, pages, pageNumbers) {
  if (!Array.isArray(receipts) || !Array.isArray(pageNumbers) || receipts.length < 2 || receipts.length !== pageNumbers.length) return null;
  const amounts = new Map(pageNumbers.map(p => [p, _amountsOn(pages[p - 1])]));
  const used = new Set();
  const out = [];
  for (const receipt of receipts) {
    if (!receipt || receipt.total === null || receipt.total === undefined) return null;
    const cents = Math.round(Number(receipt.total) * 100);
    const hits = pageNumbers.filter(p => amounts.get(p).has(cents));
    if (hits.length !== 1 || used.has(hits[0])) return null;
    used.add(hits[0]);
    out.push({ page: hits[0], receipt });
  }
  return out.sort((a, b) => a.page - b.page);
}

module.exports = {
  extractPages, splittablePages, attributeToPages, pageSignals, pageTotal, pageDate,
  MIN_PAGE_CHARS, MAX_PAGES,
};
