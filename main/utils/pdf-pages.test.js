jest.mock('pdf-parse');
const pdfParse = require('pdf-parse');
const { extractPages, splittablePages, attributeToPages, pageTotal, pageDate, MIN_PAGE_CHARS, MAX_PAGES } = require('./pdf-pages');

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

// Real-shaped pages. Separate receipts each carry a total and a date of their
// own; the two halves of a hotel folio share a folio number and say which page
// they are.
const GRAB  = 'Grab receipt 2026-08-24 Orchard Rd to Changi Airport Fare 16.00 Booking fee 2.40 Total SGD 18.40 Paid by Visa';
const GOJEK = 'Gojek trip 26 Aug 2026 Raffles Place to Novena Fare 10.00 Platform fee 2.50 Total 12.50 Thank you for riding';
const CDG   = 'ComfortDelGro taxi receipt 2026-08-27 Metered fare 19.80 ERP 2.00 Total payable 21.80 Thank you';
const FOLIO_1 = 'GRAND HOTEL SINGAPORE Guest Folio Folio No: 884213 Arrival 12/08/2026 Departure 14/08/2026 12/08/2026 Room charge 320.00 12/08/2026 Breakfast 45.00 Page 1 of 2';
const FOLIO_2 = 'GRAND HOTEL SINGAPORE Guest Folio Folio No: 884213 Arrival 12/08/2026 Departure 14/08/2026 13/08/2026 Room charge 320.00 Total 685.00 Amount paid 685.00 Page 2 of 2';

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
    test('pages that each hold their own receipt split', () => {
      const r = splittablePages({ pages: [GRAB, GOJEK, CDG], hasText: true });
      expect(r.split).toBe(true);
      expect(r.pageNumbers).toEqual([1, 2, 3]);
    });

    test('identical pages are copies of one receipt, not two receipts', () => {
      // Merchant copy and customer copy, or the same page saved twice.
      const r = splittablePages({ pages: [LONG, LONG], hasText: true });
      expect(r.split).toBe(false);
      expect(r.reason).toMatch(/copies/);
    });

    test('a single-page PDF is an ordinary receipt, not a split', () => {
      expect(splittablePages({ pages: [LONG], hasText: true }).split).toBe(false);
    });

    test('a scan does not split, and the reason says why', () => {
      const r = splittablePages({ pages: ['', ''], hasText: false });
      expect(r.split).toBe(false);
      expect(r.reason).toMatch(/scan/i);
    });

    test('a page with no readable text is listed as blank, never dropped', () => {
      // A scanned receipt between two text ones. It cannot be read, but the
      // caller has to be told it is there.
      const r = splittablePages({ pages: [GRAB, 'x', GOJEK], hasText: true });
      expect(r.split).toBe(true);
      expect(r.pageNumbers).toEqual([1, 3]);
      expect(r.blankPages).toEqual([2]);
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

  // Splitting used to follow the page count: two pages with text were two
  // receipts, so a two-page hotel folio became two half-stays.
  describe('splitting is decided by what is on the pages', () => {
    test('a two-page hotel folio is one document', () => {
      const r = splittablePages({ pages: [FOLIO_1, FOLIO_2], hasText: true });
      expect(r.split).toBe(false);
      expect(r.oneDocument).toBe(true);
    });

    test('a folio number on every page holds it together even without page numbering', () => {
      const strip = t => t.replace(/ Page \d of 2$/, '');
      const r = splittablePages({ pages: [strip(FOLIO_1), strip(FOLIO_2)], hasText: true });
      expect(r.split).toBe(false);
      expect(r.oneDocument).toBe(true);
      expect(r.reason).toMatch(/884213/);
    });

    test('a carried balance holds pages together', () => {
      const r = splittablePages({ pages: [
        'Statement of charges 2026-08-01 Item A 40.00 Item B 60.00 Total 100.00 Balance carried forward 100.00',
        'Statement of charges 2026-08-02 Balance brought forward 100.00 Item C 20.00 Total 120.00',
      ], hasText: true });
      expect(r.split).toBe(false);
      expect(r.oneDocument).toBe(true);
    });

    test('pages without a total of their own are not split on the text alone', () => {
      // Line items on page one, the total on page two. The caller may still let
      // the reader's own grouping decide, so this is "cannot tell", not "one".
      const r = splittablePages({ pages: ['Lunch 2026-08-24 Chicken rice 6.50 Kopi 1.80 Laksa 7.00', GRAB], hasText: true });
      expect(r.split).toBe(false);
      expect(r.oneDocument).toBe(false);
      expect(r.reason).toMatch(/total/);
    });

    test('two receipts from the same day still split when their totals differ', () => {
      const back = GRAB.replace('Total SGD 18.40', 'Total SGD 22.10').replace('Orchard Rd to Changi Airport', 'Changi Airport to Orchard Rd');
      expect(splittablePages({ pages: [GRAB, back], hasText: true }).split).toBe(true);
    });

    test('a scanned page inside one document is still listed', () => {
      const r = splittablePages({ pages: [FOLIO_1, '', FOLIO_2], hasText: true });
      expect(r.split).toBe(false);
      expect(r.blankPages).toEqual([2]);
    });

    test('totals and dates are read the way receipts print them', () => {
      expect(pageTotal('Sub Total 10.00 GST 0.90 Total (incl. GST) SGD 10.90 Cash 20.00 Change 9.10')).toBe(10.9);
      expect(pageTotal('Subtotal 5.00 Total items 3 Total GST 0.45')).toBeNull();
      expect(pageTotal('Grand Total 1,234.50')).toBe(1234.5);
      expect(pageDate('Date: 24 Aug 2026 12:01')).toBe('2026-08-24');
      expect(pageDate('Aug 24, 2026')).toBe('2026-08-24');
    });
  });

  describe('attributeToPages — the reader\'s own grouping', () => {
    test('each receipt goes to the one page its total is printed on', () => {
      const r = attributeToPages([{ merchant: 'Gojek', total: 12.5 }, { merchant: 'Grab', total: 18.4 }], [GRAB, GOJEK], [1, 2]);
      expect(r.map(x => [x.page, x.receipt.merchant])).toEqual([[1, 'Grab'], [2, 'Gojek']]);
    });

    test('a total printed on two pages cannot be placed, so nothing is', () => {
      expect(attributeToPages([{ total: 18.4 }, { total: 12.5 }], [GRAB, `${GOJEK} refund of 18.40`], [1, 2])).toBeNull();
    });

    test('a different count of receipts and pages is not guessed at', () => {
      expect(attributeToPages([{ total: 18.4 }], [GRAB, GOJEK], [1, 2])).toBeNull();
      expect(attributeToPages([{ total: 18.4 }, { total: 12.5 }, { total: 21.8 }], [GRAB, GOJEK], [1, 2])).toBeNull();
    });

    test('a receipt with no total cannot be traced to a page', () => {
      expect(attributeToPages([{ total: 18.4 }, { total: null }], [GRAB, GOJEK], [1, 2])).toBeNull();
    });
  });

  describe('extractPages — limits', () => {
    // Honours `max` the way the real pdf-parse does: pages past it are never
    // handed to pagerender, while numpages still counts them.
    const fakeLongPdf = count => async (buffer, options) => {
      const read = options.max > 0 ? Math.min(options.max, count) : count;
      for (let i = 0; i < read; i++) {
        await options.pagerender({ pageIndex: i, getTextContent: async () => ({ items: [{ str: `${GRAB} page ${i + 1}` }] }) });
      }
      return { numpages: count };
    };

    test(`reads at most ${MAX_PAGES} pages and says there were more`, async () => {
      pdfParse.mockImplementation(fakeLongPdf(45));
      const r = await extractPages(Buffer.from('%PDF'));
      expect(pdfParse.mock.calls[0][1].max).toBe(MAX_PAGES);
      expect(r.pages).toHaveLength(MAX_PAGES);
      expect(r.numPages).toBe(45);
      expect(r.truncated).toBe(true);
    });

    test('a PDF within the cap is not marked truncated', async () => {
      pdfParse.mockImplementation(fakeLongPdf(3));
      const r = await extractPages(Buffer.from('%PDF'));
      expect(r.pages).toHaveLength(3);
      expect(r.truncated).toBe(false);
    });

    test('a page that fails to read keeps its place, so later pages are not misnumbered', async () => {
      // pdf-parse swallows a failing page and carries on. Pushed in arrival
      // order, page 3 would have become page 2 and been read for the wrong record.
      pdfParse.mockImplementation(async (buffer, options) => {
        await options.pagerender({ pageIndex: 0, getTextContent: async () => ({ items: [{ str: GRAB }] }) });
        await options.pagerender({ pageIndex: 1, getTextContent: async () => { throw new Error('bad font'); } });
        await options.pagerender({ pageIndex: 2, getTextContent: async () => ({ items: [{ str: GOJEK }] }) });
        return { numpages: 3 };
      });
      const r = await extractPages(Buffer.from('%PDF'));
      expect(r.pages).toEqual([GRAB, '', GOJEK]);
    });
  });
});
