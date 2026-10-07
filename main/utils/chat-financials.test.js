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

describe('utils/chat-financials — financialContext', () => {
  let financialContext, getCashFlow;
  const cf = {
    organisation: { name: 'Acme', currency: 'SGD' },
    period: { label: 'Last quarter' },
    reconciliation: { revenueAccrual: 109330, customerReceipts: 26000 },
    workingCapital: { receivable: 109330, overdue: 57330, collectionRate: 0.24 },
    alerts: { alerts: [{ severity: 'warn', title: 'Most receivables are overdue', detail: '52% is past due' }] },
  };

  beforeEach(() => {
    jest.resetModules();
    getCashFlow = jest.fn().mockResolvedValue(cf);
    jest.doMock('../xero/reports', () => ({ getCashFlow }));
    ({ financialContext } = require('./chat-financials'));
  });

  test('reads the company and period it is given', async () => {
    await financialContext('u1', 'tenant-b', { timezone: 'Asia/Singapore', period: { preset: 'last-quarter' } });
    expect(getCashFlow).toHaveBeenCalledWith('u1', 'tenant-b', { timezone: 'Asia/Singapore', period: { preset: 'last-quarter' } });
  });

  test('defaults to financial year to date when no period is named', async () => {
    await financialContext('u1', 'tenant-a');
    expect(getCashFlow.mock.calls[0][2].period).toEqual({ preset: 'fy-ytd' });
  });

  test('returns the figures the reply may quote alongside the block', async () => {
    const out = await financialContext('u1', 'tenant-a');
    expect(out.period).toBe('Last quarter');
    expect(out.figures.join('\n')).toMatch(/109,330/);
    expect(out.allowed).toEqual(expect.arrayContaining([109330, 26000, 57330, 24, 52]));
  });

  test('no company means no context, and a Xero failure is not a chat failure', async () => {
    expect(await financialContext('u1', null)).toBeNull();
    getCashFlow.mockRejectedValue(new Error('xero down'));
    expect(await financialContext('u1', 'tenant-a')).toBeNull();
  });
});
