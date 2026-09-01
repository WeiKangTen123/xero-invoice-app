jest.mock('pdf-parse');
const pdfParse = require('pdf-parse');
const { extractPages, splittablePages, MIN_PAGE_CHARS } = require('./pdf-pages');

// Builds a fake pdf-parse that feeds the given page texts through pagerender,
// which is how the real library hands pages over one at a time.
function fakePdf(pageTexts) {
  return async (buffer, options) => {
    for (const text of pageTexts) {
      await options.pagerender({
        getTextContent: async () => ({ items: text.split(' ').map(str => ({ str })) }),
      });
    }
    return { numpages: pageTexts.length, text: pageTexts.join('\n') };
  };
}

const LONG = 'Receipt total 18.40 SGD merchant Grab date 2026-08-24 thank you for riding';

beforeEach(() => jest.clearAllMocks());

describe('utils/pdf-pages', () => {
  describe('extractPages', () => {
    test('returns one entry per page, in order', async () => {
      pdfParse.mockImplementation(fakePdf([`${LONG} one`, `${LONG} two`, `${LONG} three`]));
      const r = await extractPages(Buffer.from('%PDF'));
      expect(r.pages).toHaveLength(3);
      expect(r.pages[0]).toMatch(/one$/);
      expect(r.pages[2]).toMatch(/three$/);
      expect(r.hasText).toBe(true);
    });

    test('a scan has no text layer and says so rather than guessing', async () => {
      // Every page is images, so there is nothing to read. Rendering those pages
      // would need a real PDF renderer, which is a deliberate non-goal.
      pdfParse.mockImplementation(fakePdf(['', '', '']));
      const r = await extractPages(Buffer.from('%PDF'));
      expect(r.hasText).toBe(false);
      expect(r.textPageCount).toBe(0);
    });

    test('an empty or non-buffer input is handled, not thrown on', async () => {
      expect((await extractPages(Buffer.alloc(0))).numPages).toBe(0);
      expect((await extractPages(null)).numPages).toBe(0);
      expect(pdfParse).not.toHaveBeenCalled();
    });

    test('a corrupt PDF degrades to no pages instead of throwing', async () => {
      pdfParse.mockRejectedValue(new Error('bad xref'));
      const r = await extractPages(Buffer.from('not a pdf'));
      expect(r.pages).toEqual([]);
      expect(r.hasText).toBe(false);
    });
  });

  describe('splittablePages', () => {
    test('a multi-page PDF with text on each page splits', () => {
      const r = splittablePages({ pages: [LONG, LONG, LONG], hasText: true });
      expect(r.split).toBe(true);
      expect(r.pageNumbers).toEqual([1, 2, 3]);
    });

    test('a single-page PDF is an ordinary receipt, not a split', () => {
      expect(splittablePages({ pages: [LONG], hasText: true }).split).toBe(false);
    });

    test('a scan does not split, and the reason says why', () => {
      const r = splittablePages({ pages: ['', ''], hasText: false });
      expect(r.split).toBe(false);
      expect(r.reason).toMatch(/scan/i);
    });

    test('near-empty pages are excluded so no blank records are created', () => {
      const r = splittablePages({ pages: [LONG, 'x', LONG], hasText: true });
      expect(r.pageNumbers).toEqual([1, 3]);   // page 2 skipped
      expect(r.split).toBe(true);
    });

    test('if only one page has readable text there is nothing to split', () => {
      const r = splittablePages({ pages: [LONG, 'x', ''], hasText: true });
      expect(r.split).toBe(false);
    });

    test('page numbers are 1-based, matching what a PDF viewer shows', () => {
      const r = splittablePages({ pages: [LONG, LONG], hasText: true });
      expect(r.pageNumbers[0]).toBe(1);
    });

    test('nothing at all is handled', () => {
      expect(splittablePages().split).toBe(false);
      expect(splittablePages({}).split).toBe(false);
    });
  });
});
