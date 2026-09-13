// The verifier's rules, each pinned. callGemini is mocked so every branch is
// deterministic; the point here is the reconciliation, not the model.
jest.mock('../utils/gemini-client', () => ({ callGemini: jest.fn(), GEMINI_MODELS: [] }));
const { callGemini } = require('../utils/gemini-client');
const { verifyTemplateExtraction, _reconcile } = require('./template-verifier');

const base = () => ({
  contactName: 'PereOcean Demo', vendorName: 'PereOcean Demo',
  contactEmail: 'pereocean_demo@gmail.com',
  contactAddress: '58 Senoko Road, Singapore 758122',
  currency: 'SGD',
  invoiceDate: '2026-08-17', dueDate: '2026-09-16',
  lineItems: [{ description: 'Water Cartons', unitAmount: 1000, discountRate: 0 }],
  subTotal: 1000, taxAmount: 0, totalAmount: 1000,
});

// What a model that agrees with the parser would say.
const agreeing = () => ({
  contactName: 'PereOcean Demo', contactEmail: 'pereocean_demo@gmail.com',
  contactAddress: '58 Senoko Road, Singapore 758122', currency: 'SGD',
  lineItems: [{ description: 'Water Cartons', unitAmount: 1000, discountRate: null, taxPercent: null }],
  statedTotal: null, invoiceDate: null, missingLabels: [],
});

beforeEach(() => callGemini.mockReset());

describe('template-verifier — rule 1: it can never make things worse', () => {
  test('a model failure returns the parser result untouched, and says so', async () => {
    callGemini.mockRejectedValue(new Error('quota'));
    const parsed = base();
    const r = await verifyTemplateExtraction('text', parsed, 'u1');
    expect(r.parsed).toBe(parsed);          // the same object, not a copy with edits
    expect(r.verified).toBe(false);
    expect(r.reviewReason).toBeNull();
  });

  test('a reply that is not JSON is treated the same as a failure', async () => {
    callGemini.mockResolvedValue('Sure! Here is what I found: the customer is…');
    const parsed = base();
    const r = await verifyTemplateExtraction('text', parsed, 'u1');
    expect(r.parsed).toBe(parsed);
    expect(r.verified).toBe(false);
  });

  test('it retries once before giving up', async () => {
    callGemini.mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce(JSON.stringify(agreeing()));
    const r = await verifyTemplateExtraction('text', base(), 'u1');
    expect(callGemini).toHaveBeenCalledTimes(2);
    expect(r.verified).toBe(true);
  });

  test('nothing to verify returns immediately without a model call', async () => {
    await verifyTemplateExtraction('', base(), 'u1');
    await verifyTemplateExtraction('text', null, 'u1');
    expect(callGemini).not.toHaveBeenCalled();
  });
});

describe('template-verifier — agreement leaves everything alone', () => {
  test('identical readings: no disagreements, no review, values unchanged', async () => {
    callGemini.mockResolvedValue(JSON.stringify(agreeing()));
    const r = await verifyTemplateExtraction('text', base(), 'u1');
    expect(r.verified).toBe(true);
    expect(r.disagreements).toEqual([]);
    expect(r.reviewReason).toBeNull();
    expect(r.parsed.totalAmount).toBe(1000);
    expect(r.parsed.contactName).toBe('PereOcean Demo');
  });

  test('whitespace and case differences are not disagreements', () => {
    const reply = { ...agreeing(), contactName: '  pereocean   DEMO ', contactAddress: '58 Senoko Road,  Singapore 758122' };
    const r = _reconcile(base(), reply);
    expect(r.disagreements).toEqual([]);
  });
});

describe('template-verifier — rule 4: header fields are corrected in place', () => {
  test('a different customer name is taken, and vendorName follows it', () => {
    const r = _reconcile(base(), { ...agreeing(), contactName: 'PereOcean Pte Ltd' });
    expect(r.parsed.contactName).toBe('PereOcean Pte Ltd');
    expect(r.parsed.vendorName).toBe('PereOcean Pte Ltd');
    expect(r.disagreements).toEqual([expect.objectContaining({ field: 'contactName', action: 'corrected' })]);
    expect(r.reviewReason).toBeNull();      // a name is not a review matter
  });

  test('the address the parser mangled is replaced by the one in the text', () => {
    const parsed = { ...base(), contactAddress: '58 Senoko Road, Singapore 758122, Currency : SGD, Standard' };
    const r = _reconcile(parsed, agreeing());
    expect(r.parsed.contactAddress).toBe('58 Senoko Road, Singapore 758122');
  });

  test('a currency that is not a 3-letter code is ignored rather than applied', () => {
    const r = _reconcile(base(), { ...agreeing(), currency: 'Singapore dollars' });
    expect(r.parsed.currency).toBe('SGD');
    expect(r.disagreements).toEqual([]);
  });

  test('an empty model value never overwrites a parsed one', () => {
    const r = _reconcile(base(), { ...agreeing(), contactEmail: null, contactAddress: '' });
    expect(r.parsed.contactEmail).toBe('pereocean_demo@gmail.com');
    expect(r.parsed.contactAddress).toBe('58 Senoko Road, Singapore 758122');
  });

  test('a description is corrected in place', () => {
    const reply = agreeing(); reply.lineItems[0].description = 'Provision of PereOcean Water Cartons';
    const r = _reconcile(base(), reply);
    expect(r.parsed.lineItems[0].description).toBe('Provision of PereOcean Water Cartons');
    expect(r.reviewReason).toBeNull();
  });
});

describe('template-verifier — rule 3: money is flagged, never overwritten', () => {
  test('a different line amount keeps the parser figure and asks for review, naming both', () => {
    const reply = agreeing(); reply.lineItems[0].unitAmount = 1500;
    const r = _reconcile(base(), reply);
    expect(r.parsed.lineItems[0].unitAmount).toBe(1000);       // kept
    expect(r.parsed.totalAmount).toBe(1000);                    // kept
    expect(r.reviewReason).toMatch(/parser read 1,000\.00.*document appears to say 1,500\.00/);
    expect(r.disagreements).toEqual([expect.objectContaining({ field: 'lineItems[0].unitAmount', action: 'flagged' })]);
  });

  test('a different number of line items is flagged, and amounts are not touched', () => {
    const reply = agreeing(); reply.lineItems.push({ description: 'Display', unitAmount: 2500 });
    const r = _reconcile(base(), reply);
    expect(r.parsed.lineItems).toHaveLength(1);
    expect(r.reviewReason).toMatch(/found 1 line item.*appears to have 2/);
  });

  test('a stated total the lines do not reach is flagged', () => {
    const r = _reconcile(base(), { ...agreeing(), statedTotal: 3500 });
    expect(r.parsed.totalAmount).toBe(1000);
    expect(r.reviewReason).toMatch(/lines total 1,000\.00.*document states 3,500\.00/);
  });

  test('a stated total that matches is not a disagreement', () => {
    const r = _reconcile(base(), { ...agreeing(), statedTotal: 1000 });
    expect(r.reviewReason).toBeNull();
  });

  test('half a cent of rounding is not a disagreement', () => {
    const reply = agreeing(); reply.lineItems[0].unitAmount = 1000.004;
    expect(_reconcile(base(), reply).reviewReason).toBeNull();
  });

  test('a different discount is flagged, since it changes the total', () => {
    const reply = agreeing(); reply.lineItems[0].discountRate = 10;
    const r = _reconcile(base(), reply);
    expect(r.parsed.lineItems[0].discountRate).toBe(0);
    expect(r.reviewReason).toMatch(/0% discount.*document appears to say 10%/);
  });

  test('several money disagreements are all reported, not just the first', () => {
    const reply = agreeing(); reply.lineItems[0].unitAmount = 1500; reply.statedTotal = 9999;
    const r = _reconcile(base(), reply);
    expect(r.reviewReason).toMatch(/1,500\.00/);
    expect(r.reviewReason).toMatch(/9,999\.00/);
  });
});

describe('template-verifier — the invoice date', () => {
  // The template has no date field, so the parser dates the invoice from the
  // email. A date the document itself states is better.
  test('a date stated in the document replaces the email date, and the due date moves with it', () => {
    const r = _reconcile(base(), { ...agreeing(), invoiceDate: '2026-08-10' });
    expect(r.parsed.invoiceDate).toBe('2026-08-10');
    expect(r.parsed.dueDate).toBe('2026-09-09');     // still 30 days on
    expect(r.reviewReason).toBeNull();
  });

  test('a malformed date is ignored', () => {
    const r = _reconcile(base(), { ...agreeing(), invoiceDate: '10 Aug 2026' });
    expect(r.parsed.invoiceDate).toBe('2026-08-17');
  });

  test('no stated date leaves the email date alone', () => {
    const r = _reconcile(base(), { ...agreeing(), invoiceDate: null });
    expect(r.parsed.invoiceDate).toBe('2026-08-17');
    expect(r.parsed.dueDate).toBe('2026-09-16');
  });
});

describe('template-verifier — missing labels', () => {
  test('a missing REQUIRED label is flagged for review', () => {
    const r = _reconcile(base(), { ...agreeing(), missingLabels: ['Client / Customer'] });
    expect(r.reviewReason).toMatch(/not found in the email: Client \/ Customer/);
  });

  test('a missing optional label is not', () => {
    const r = _reconcile(base(), { ...agreeing(), missingLabels: ['Discount', 'Tax (If applicable)'] });
    expect(r.reviewReason).toBeNull();
  });
});

describe('template-verifier — rule 2: it cannot change what kind of document this is', () => {
  test('there is no invoiceType for it to touch, and it adds none', () => {
    const parsed = base();
    expect('invoiceType' in parsed).toBe(false);
    const r = _reconcile(parsed, { ...agreeing(), invoiceType: 'ACCPAY', source: 'pdf' });
    expect('invoiceType' in r.parsed).toBe(false);
    expect('source' in r.parsed).toBe(false);
  });
});

// ── Drift guard ────────────────────────────────────────────────────────────
// The declaration and the regex parser must describe the same template. This
// builds an email from the declaration's own labels and checks the regexes
// still read every field — so a label edited in one place and not the other
// fails here rather than in a quietly empty invoice.
describe('invoice-template — the declaration matches what the regex parser reads', () => {
  const tpl = require('./invoice-template');
  const { parseTemplateFormat } = require('./parser');

  test('every declared label is recognised by parseTemplateFormat', () => {
    const value = {
      contactName: 'Drift Guard Pte Ltd', contactEmail: 'ops@driftguard.example',
      contactAddress: '1 Test Street, Singapore 000001', currency: 'SGD, Standard',
      paymentTerms: '14 days', lineAmountTypes: 'Exclusive',
      invoiceNumber: 'DG-0001', invoiceDate: '2026-01-10',
    };
    const header = tpl.HEADER_FIELDS.map(f => `${f.label} : ${value[f.key]}`).join('\n');
    const item = [
      `1. ${tpl.LINE_ITEM_FIELDS[0].label} :`, 'Something billable',
      `${tpl.LINE_ITEM_FIELDS[1].label} : SGD1234.50`,
      `${tpl.LINE_ITEM_FIELDS[2].label} :`,
      `${tpl.LINE_ITEM_FIELDS[3].label} :`,
    ].join('\n');
    const text = `${header}\n\n${item}`;

    const p = parseTemplateFormat(text, { subject: 'drift', date: '2026-01-10T00:00:00Z', from: { text: '', value: [] } }, { currency: 'USD', accountCode: '200' });
    expect(p.contactName).toBe('Drift Guard Pte Ltd');
    expect(p.contactEmail).toBe('ops@driftguard.example');
    expect(p.contactAddress).toBe('1 Test Street, Singapore 000001');
    expect(p.currency).toBe('SGD');
    expect(p.brandingThemeName).toBe('Standard');
    expect(p.invoiceNumber).toBe('DG-0001');
    expect(p.invoiceDate).toBe('2026-01-10');
    expect(p.dueDate).toBe('2026-01-24');
    expect(p.lineAmountTypes).toBe('Exclusive');
    expect(p.lineItems).toEqual([{ description: 'Something billable', unitAmount: 1234.5, discountRate: 0 }]);
    expect(p.totalAmount).toBe(1234.5);
  });

  test('the prompt describes every field, so the model is told the same template', () => {
    const text = tpl.describe();
    for (const f of [...tpl.HEADER_FIELDS, ...tpl.LINE_ITEM_FIELDS]) expect(text).toContain(`"${f.label} :"`);
  });
});
