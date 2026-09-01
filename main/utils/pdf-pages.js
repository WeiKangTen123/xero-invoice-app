const pdfParse = require('pdf-parse');
const logger   = require('./logger');

// Splits a PDF into per-page text.
//
// A PDF of scanned receipts is usually one receipt per page, so each page should
// become its own record. Doing that needs the pages separated, and pdf-parse's
// `pagerender` hook already hands us one page at a time — no PDF renderer and no
// new dependency.
//
// The limit: this reads the TEXT LAYER. A digital receipt (emailed, generated)
// has one. A photographed page scanned into a PDF does not, and comes back
// empty — which is reported honestly rather than guessed at, because rendering
// those pages to images would need a real PDF renderer.

// Below this a "page" is a header or a stray mark, not a receipt.
const MIN_PAGE_CHARS = 40;

async function extractPages(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { pages: [], numPages: 0, hasText: false };

  const pages = [];
  try {
    const data = await pdfParse(buffer, {
      // Called once per page, in order. Returning the text also lets pdf-parse
      // build its usual combined output, which we ignore.
      pagerender: async (pageData) => {
        const content = await pageData.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
        const text = content.items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();
        pages.push(text);
        return text;
      },
    });

    const withText = pages.filter(p => p.length >= MIN_PAGE_CHARS);
    return {
      pages,
      numPages: data.numpages || pages.length,
      // False for a scan: every page is images, so there is nothing to read.
      hasText: withText.length > 0,
      textPageCount: withText.length,
    };
  } catch (err) {
    logger.warn('PDF page extraction failed', { error: err.message });
    return { pages: [], numPages: 0, hasText: false, textPageCount: 0 };
  }
}

// Which pages are worth making a record for. A one-page PDF is never "split" —
// it is just an ordinary single receipt.
function splittablePages({ pages = [], hasText = false } = {}) {
  if (!hasText || pages.length < 2) return { split: false, pageNumbers: [], reason: !hasText ? 'no text layer — the PDF is a scan' : 'single page' };
  const pageNumbers = pages
    .map((text, i) => ({ text, page: i + 1 }))
    .filter(p => p.text.length >= MIN_PAGE_CHARS)
    .map(p => p.page);

  // Every page must carry something, or we would create blank records for the
  // ones that do not.
  if (pageNumbers.length < 2) return { split: false, pageNumbers: [], reason: 'fewer than two pages have readable text' };
  return { split: true, pageNumbers, reason: null };
}

module.exports = { extractPages, splittablePages, MIN_PAGE_CHARS };
