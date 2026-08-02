const { buildLineItems, resolveTaxType, getOrgTaxRates } = require('./invoices');

// Each test uses its own tenantId so the module-level per-tenant cache in
// invoices.js never leaks a result from one test into another.
let _tenantSeq = 0;
function newTenantId() { return `tenant-${++_tenantSeq}`; }

function fakeAccountingApi(taxRates) {
  return {
    getTaxRates: jest.fn().mockResolvedValue({ body: { taxRates } }),
  };
}

const SG_GST_RATE = {
  name: 'GST on Expenses', taxType: 'INPUT2', status: 'ACTIVE',
  displayTaxRate: 9.0, canApplyToExpenses: true, canApplyToRevenue: false,
};
const SG_GST_OUTPUT_RATE = {
  name: 'GST on Income', taxType: 'OUTPUT2', status: 'ACTIVE',
  displayTaxRate: 9.0, canApplyToExpenses: false, canApplyToRevenue: true,
};
const DELETED_RATE = {
  name: 'Old GST', taxType: 'OLDGST', status: 'DELETED',
  displayTaxRate: 7.0, canApplyToExpenses: true, canApplyToRevenue: false,
};

describe('resolveTaxType', () => {
  test('no tax detected — returns zeroRate without calling the Xero API', async () => {
    const api = fakeAccountingApi([SG_GST_RATE]);
    const result = await resolveTaxType(api, newTenantId(), { subTotal: 1000, taxAmount: 0 }, 'NONE');
    expect(result).toEqual({ taxType: 'NONE', applied: true, unmatchedTaxAmount: 0 });
    expect(api.getTaxRates).not.toHaveBeenCalled();
  });

  test('missing subTotal/taxAmount — treated as no tax', async () => {
    const api = fakeAccountingApi([SG_GST_RATE]);
    const result = await resolveTaxType(api, newTenantId(), {}, 'NONE');
    expect(result.applied).toBe(true);
    expect(result.taxType).toBe('NONE');
  });

  test('effective rate matches an org tax rate within tolerance — resolves to its real taxType', async () => {
    const api = fakeAccountingApi([SG_GST_RATE]);
    // 90 / 1000 = 9.00% — exact match to SG_GST_RATE's 9.0%
    const result = await resolveTaxType(api, newTenantId(), { subTotal: 1000, taxAmount: 90, invoiceType: 'ACCPAY' }, 'NONE');
    expect(result).toEqual({ taxType: 'INPUT2', applied: true, unmatchedTaxAmount: 0 });
  });

  test('matches within the rounding tolerance, not just an exact percentage', async () => {
    const api = fakeAccountingApi([SG_GST_RATE]);
    // 89.6 / 1000 = 8.96% — within 0.75 of 9.0%
    const result = await resolveTaxType(api, newTenantId(), { subTotal: 1000, taxAmount: 89.6, invoiceType: 'ACCPAY' }, 'NONE');
    expect(result.applied).toBe(true);
    expect(result.taxType).toBe('INPUT2');
  });

  test('no rate within tolerance — falls back to a flat unmatched amount instead of guessing', async () => {
    const api = fakeAccountingApi([SG_GST_RATE]); // only has a 9% rate
    // 200 / 1000 = 20% — nowhere near 9%
    const result = await resolveTaxType(api, newTenantId(), { subTotal: 1000, taxAmount: 200, invoiceType: 'ACCPAY' }, 'NONE');
    expect(result).toEqual({ taxType: 'NONE', applied: false, unmatchedTaxAmount: 200 });
  });

  test('filters candidate rates by canApplyToExpenses for an ACCPAY bill', async () => {
    // Only a revenue-side rate exists — no expense-side rate for a bill to match against.
    const api = fakeAccountingApi([SG_GST_OUTPUT_RATE]);
    const result = await resolveTaxType(api, newTenantId(), { subTotal: 1000, taxAmount: 90, invoiceType: 'ACCPAY' }, 'NONE');
    expect(result.applied).toBe(false);
  });

  test('filters candidate rates by canApplyToRevenue for an ACCREC sales invoice', async () => {
    const api = fakeAccountingApi([SG_GST_OUTPUT_RATE]);
    const result = await resolveTaxType(api, newTenantId(), { subTotal: 1000, taxAmount: 90, invoiceType: 'ACCREC' }, 'NONE');
    expect(result.applied).toBe(true);
    expect(result.taxType).toBe('OUTPUT2');
  });

  test('ignores DELETED/inactive rates from getOrgTaxRates', async () => {
    const api = fakeAccountingApi([DELETED_RATE]);
    const result = await resolveTaxType(api, newTenantId(), { subTotal: 1000, taxAmount: 70, invoiceType: 'ACCPAY' }, 'NONE');
    expect(result.applied).toBe(false); // the only matching-rate 7% is deleted, so nothing to match
  });

  test('Xero API failure to fetch tax rates degrades to the flat-fallback path, not a crash', async () => {
    const api = { getTaxRates: jest.fn().mockRejectedValue(new Error('Xero unavailable')) };
    const result = await resolveTaxType(api, newTenantId(), { subTotal: 1000, taxAmount: 90, invoiceType: 'ACCPAY' }, 'NONE');
    expect(result).toEqual({ taxType: 'NONE', applied: false, unmatchedTaxAmount: 90 });
  });

  test('getOrgTaxRates is only called once per tenant across repeated resolutions (cached)', async () => {
    const api = fakeAccountingApi([SG_GST_RATE]);
    const tenantId = newTenantId();
    await resolveTaxType(api, tenantId, { subTotal: 1000, taxAmount: 90, invoiceType: 'ACCPAY' }, 'NONE');
    await resolveTaxType(api, tenantId, { subTotal: 500, taxAmount: 45, invoiceType: 'ACCPAY' }, 'NONE');
    expect(api.getTaxRates).toHaveBeenCalledTimes(1);
  });
});

describe('buildLineItems', () => {
  const userConfig = {};

  test('no tax — every non-zero line item gets the zero-rate taxType, no extra line added', async () => {
    const api = fakeAccountingApi([SG_GST_RATE]);
    const invoiceData = {
      lineItems: [{ description: 'Service A', unitAmount: 500 }],
      subTotal: 500, taxAmount: 0, accountCode: '400',
    };
    const items = await buildLineItems(invoiceData, userConfig, api, newTenantId());
    expect(items).toEqual([
      { description: 'Service A', accountCode: '400', taxType: 'NONE', quantity: 1.0, unitAmount: 500 },
    ]);
  });

  test('matched org tax rate is applied uniformly to every non-zero line item', async () => {
    const api = fakeAccountingApi([SG_GST_RATE]);
    const invoiceData = {
      lineItems: [
        { description: 'Service A', unitAmount: 600 },
        { description: 'Service B', unitAmount: 400 },
      ],
      subTotal: 1000, taxAmount: 90, invoiceType: 'ACCPAY', accountCode: '400',
    };
    const items = await buildLineItems(invoiceData, userConfig, api, newTenantId());
    expect(items).toHaveLength(2);
    expect(items[0].taxType).toBe('INPUT2');
    expect(items[1].taxType).toBe('INPUT2');
    // The total posted to Xero (line amounts; Xero itself computes tax from taxType)
    // reconciles: 600 + 400 = subTotal, and Xero will add ~9% on top = ~90 = taxAmount.
    expect(items[0].unitAmount + items[1].unitAmount).toBe(1000);
  });

  test('unmatched tax rate falls back to a flat "Tax / GST" line so the total still reconciles', async () => {
    const api = fakeAccountingApi([SG_GST_RATE]); // only 9% available
    const invoiceData = {
      lineItems: [{ description: 'Service A', unitAmount: 1000 }],
      subTotal: 1000, taxAmount: 200, invoiceType: 'ACCPAY', accountCode: '400', // 20% — no match
    };
    const items = await buildLineItems(invoiceData, userConfig, api, newTenantId());
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ description: 'Service A', taxType: 'NONE', unitAmount: 1000 });
    expect(items[1]).toMatchObject({ description: 'Tax / GST', taxType: 'NONE', unitAmount: 200 });
    // Reconciles to the full invoice total: 1000 (subtotal) + 200 (tax) = 1200.
    const total = items.reduce((sum, i) => sum + (i.unitAmount || 0), 0);
    expect(total).toBe(1200);
  });

  test('fallback single-line-item path (no itemized lineItems) still gets a resolved taxType', async () => {
    const api = fakeAccountingApi([SG_GST_RATE]);
    const invoiceData = {
      lineItems: null, description: 'Invoice from Acme',
      subTotal: 1000, taxAmount: 90, invoiceType: 'ACCPAY', accountCode: '400',
    };
    const items = await buildLineItems(invoiceData, userConfig, api, newTenantId());
    expect(items).toEqual([
      { description: 'Invoice from Acme', quantity: 1.0, unitAmount: 1000, accountCode: '400', taxType: 'INPUT2' },
    ]);
  });

  test('$0 payment-reference line item still passes through description-only, untouched by tax resolution', async () => {
    const api = fakeAccountingApi([SG_GST_RATE]);
    const invoiceData = {
      lineItems: [{ description: 'Service A', unitAmount: 1000 }],
      paymentReference: 'Bank: OCBC | Acct: 123',
      subTotal: 1000, taxAmount: 90, invoiceType: 'ACCPAY', accountCode: '400',
    };
    const items = await buildLineItems(invoiceData, userConfig, api, newTenantId());
    expect(items).toHaveLength(2);
    expect(items[1]).toEqual({ description: 'Payment details:\nBank: OCBC\nAcct: 123' });
  });

  test('a discountRate on a line item is preserved alongside the resolved taxType', async () => {
    const api = fakeAccountingApi([]);
    const invoiceData = {
      lineItems: [{ description: 'Service A', unitAmount: 1000, discountRate: 10 }],
      subTotal: 1000, taxAmount: 0, accountCode: '400',
    };
    const items = await buildLineItems(invoiceData, userConfig, api, newTenantId());
    expect(items[0]).toMatchObject({ discountRate: 10, taxType: 'NONE' });
  });
});
