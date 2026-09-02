const { looksFinancial } = require('./chat-financials');

// The gate exists for cost. Xero bills on data egress and a cold cash-flow read
// costs several calls, so a question about an invoice number must not drag the
// whole ledger down with it.
describe('utils/chat-financials — when to pay for Xero context', () => {
  describe('looksFinancial', () => {
    test('fires on questions the pipeline cannot answer', () => {
      for (const q of [
        'how is my cash looking?',
        'what is my revenue this year',
        'am I making a profit',
        'how much do customers owe me',
        'anything overdue?',
        'what is my margin',
        'how are we doing',
        'show me the budget',
        'what is my runway',
        'how long are customers taking to pay',   // "pay" via collect/dso net
      ]) {
        expect({ q, hit: looksFinancial(q) }).toEqual({ q, hit: true });
      }
    });

    test('stays quiet on pipeline work, which must not pay for a ledger read', () => {
      for (const q of [
        'change the invoice number to 2026099',
        'mark this reviewed',
        'show me invoices from Branworks',
        'fix the vendor name',
        'delete this line item',
      ]) {
        expect({ q, hit: looksFinancial(q) }).toEqual({ q, hit: false });
      }
    });

    test('handles empty and non-string input', () => {
      expect(looksFinancial('')).toBe(false);
      expect(looksFinancial(null)).toBe(false);
      expect(looksFinancial(undefined)).toBe(false);
    });

    test('matches whole words, not fragments', () => {
      // "increased" contains "cash" nowhere, but guard against loose patterns:
      expect(looksFinancial('recast the description')).toBe(false);
      expect(looksFinancial('cash')).toBe(true);
    });
  });
});
