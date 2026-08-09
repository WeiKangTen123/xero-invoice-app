jest.mock('./gemini-client', () => ({
  callGemini: jest.fn(),
}));

let { callGemini } = require('./gemini-client');

describe('chat-agent', () => {
  let users, invoiceStore, chatAgent, userId, invoiceId;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    require('../db/migrate').run();
    users        = require('./users');
    invoiceStore = require('./invoice-store');
    chatAgent    = require('./chat-agent');
    // chat-agent's mocked gemini-client is a *different* module instance after
    // resetModules — re-require the mock reference each time too.
    ({ callGemini } = require('./gemini-client'));

    const u = await users.createUser('chat@test.com', 'password123', 'user');
    userId = u.id;
    const inv = invoiceStore.forUser(userId).add({
      id: 'inv-1', status: 'pending', vendorName: 'Acme Corp',
      invoiceNumber: 'INV-001', totalAmount: 100, processedAt: new Date().toISOString(),
    });
    invoiceId = inv.id;
  });

  function mockReply(obj) {
    callGemini.mockResolvedValue(JSON.stringify(obj));
  }

  test('passes through a valid field_update proposal', async () => {
    mockReply({
      reply: "Here's the change:",
      proposals: [{ type: 'field_update', invoiceId, field: 'invoiceNumber', label: 'Invoice #', oldValue: 'INV-001', newValue: 'INV-002' }],
    });
    const result = await chatAgent.respond(userId, { message: 'change invoice number to INV-002' });
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].field).toBe('invoiceNumber');
  });

  test('drops a proposal targeting a non-editable field', async () => {
    mockReply({
      reply: 'Sure',
      proposals: [{ type: 'field_update', invoiceId, field: 'xeroInvoiceId', oldValue: 'a', newValue: 'b' }],
    });
    const result = await chatAgent.respond(userId, { message: 'change the xero id' });
    expect(result.proposals).toHaveLength(0);
  });

  test('drops a proposal targeting an invoice the user does not own', async () => {
    mockReply({
      reply: 'Sure',
      proposals: [{ type: 'field_update', invoiceId: 'not-mine', field: 'invoiceNumber', oldValue: 'a', newValue: 'b' }],
    });
    const result = await chatAgent.respond(userId, { message: 'change it' });
    expect(result.proposals).toHaveLength(0);
  });

  test('drops a proposal with an unknown type', async () => {
    mockReply({
      reply: 'Sure',
      proposals: [{ type: 'delete_everything', invoiceId }],
    });
    const result = await chatAgent.respond(userId, { message: 'do something else' });
    expect(result.proposals).toHaveLength(0);
  });

  test('falls back gracefully on a non-JSON response', async () => {
    callGemini.mockResolvedValue('Sorry, I cannot help with that in plain text.');
    const result = await chatAgent.respond(userId, { message: 'hello' });
    expect(result.proposals).toEqual([]);
    expect(result.reply).toContain('Sorry');
  });

  test('bulk_field_update keeps only items that belong to the user', async () => {
    const inv2 = invoiceStore.forUser(userId).add({
      id: 'inv-2', status: 'pending', vendorName: 'Beta Co',
      invoiceNumber: 'INV-999', totalAmount: 50, processedAt: new Date().toISOString(),
    });
    mockReply({
      reply: 'Updating both',
      proposals: [{
        type: 'bulk_field_update', field: 'accountCode', newValue: '250',
        items: [
          { invoiceId: invoiceId, label: 'Acme Corp' },
          { invoiceId: inv2.id, label: 'Beta Co' },
          { invoiceId: 'ghost-invoice', label: 'Should be dropped' },
        ],
      }],
    });
    const result = await chatAgent.respond(userId, { message: 'set account code 250 for all pending' });
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].items).toHaveLength(2);
  });

  test('passes through a valid lineItems field_update, normalizing item shape', async () => {
    mockReply({
      reply: "Here's the change:",
      proposals: [{
        type: 'field_update', invoiceId, field: 'lineItems', label: 'Line items',
        oldValue: [{ description: 'Accounting', unitAmount: 300 }, { description: 'Payroll', unitAmount: 100 }],
        newValue: [{ description: 'Accounting', unitAmount: 300 }, { description: 'Payroll', unitAmount: 150 }],
      }],
    });
    const result = await chatAgent.respond(userId, { message: 'bump the payroll line to 150' });
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].newValue).toEqual([
      { description: 'Accounting', unitAmount: 300, discountRate: null },
      { description: 'Payroll', unitAmount: 150, discountRate: null },
    ]);
  });

  test('drops a lineItems field_update with a non-numeric amount', async () => {
    mockReply({
      reply: 'Sure',
      proposals: [{
        type: 'field_update', invoiceId, field: 'lineItems',
        oldValue: [{ description: 'Accounting', unitAmount: 300 }],
        newValue: [{ description: 'Accounting', unitAmount: 'lots' }],
      }],
    });
    const result = await chatAgent.respond(userId, { message: 'change it' });
    expect(result.proposals).toHaveLength(0);
  });

  test('drops a lineItems field_update that is not an array', async () => {
    mockReply({
      reply: 'Sure',
      proposals: [{ type: 'field_update', invoiceId, field: 'lineItems', oldValue: [], newValue: 'not an array' }],
    });
    const result = await chatAgent.respond(userId, { message: 'change it' });
    expect(result.proposals).toHaveLength(0);
  });

  test('strips markdown code fences before parsing JSON', async () => {
    callGemini.mockResolvedValue('```json\n{"reply": "ok", "proposals": []}\n```');
    const result = await chatAgent.respond(userId, { message: 'hi' });
    expect(result.reply).toBe('ok');
  });
});
