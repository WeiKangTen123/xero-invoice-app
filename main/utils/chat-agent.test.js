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

// ── Numbers from the invoice list on screen ─────────────────────────────────
// On the review page of one invoice a user asked "check the ref 6 and ref 5
// invoice". Nothing in the app was numbered; the model checked the pinned
// invoice and another from the same vendor. The list now numbers its rows and
// the screen sends them; a number is read off that list in code, and one that
// cannot be is asked about without calling the model.
describe('chat-agent — which numbers in a message are list rows (_listRefs, pure)', () => {
  let chatAgent;
  beforeAll(() => {
    jest.resetModules();
    chatAgent = require('./chat-agent');
  });
  const numbers = text => chatAgent._listRefs(text).refs.map(r => r.n);

  test.each([
    ['#5', [5]],
    ['check the ref 6 and ref 5 invoice, everything correct?', [6, 5]],
    ['what is in row 5?', [5]],
    ['no. 5', [5]],
    ['number 5', [5]],
    ['item 5', [5]],
    ['invoice #5', [5]],
    ['invoice 5 and 6', [5, 6]],
    ['invoices 1, 2, and 3', [1, 2, 3]],
    ['#5-#7', [5, 6, 7]],
    ['#5 – 7', [5, 6, 7]],
    ['rows 5 to 7', [5, 6, 7]],
    ['is the 5th correct?', [5]],
    ['the 2nd and 3rd invoices', [2, 3]],
  ])('%s → %j', (text, expected) => {
    expect(numbers(text)).toEqual(expected);
  });

  test.each([
    'invoices from the 5th', 'due on the 5th', 'Oct 5th', '5th October', 'the 5th of May', 'the 1st quarter', 'the 2nd line',
    'change the invoice number to 2026099', 'INV#5', 'that is 5%', 'pay #5,000', '#0042', 'BLR/26-27/2078', 'phone number 5551234',
    'change the total to 450',
  ])('%s is not a row', text => {
    expect(numbers(text)).toEqual([]);
  });

  test('"set #5 to 150" is row 5 and a new value, not rows 5 to 150', () => {
    expect(numbers('set #5 to 150')).toEqual([5]);
  });

  test('"row" and an ordinal can only be rows; "#5" could also be an invoice number', () => {
    expect(chatAgent._listRefs('row 5 and the 6th').refs).toEqual([{ n: 5, row: true }, { n: 6, row: true }]);
    expect(chatAgent._listRefs('#5 and ref 6').refs).toEqual([{ n: 5, row: false }, { n: 6, row: false }]);
    expect(chatAgent._listRefs('#5-#6').refs.every(r => r.row)).toBe(true);
  });

  test('"item 2" on an invoice with two or more lines is its line, not a row', () => {
    expect(chatAgent._listRefs('change item 2 to 150', { lineCount: 3 }).refs).toEqual([]);
    expect(chatAgent._listRefs('change item 2 to 150', { lineCount: 1 }).refs.map(r => r.n)).toEqual([2]);
  });

  test('the phrase is taken out of the text, so "#5" is not also an amount of 5.00', () => {
    expect(chatAgent._listRefs('check ref 6 and ref 5, ok?').text).not.toMatch(/\d/);
  });

  test('tables, lists and code in a reply are left as they are by _hardBreaks', () => {
    const text = 'Here:\n\n| Field | Value |\n|---|---|\n| A | 1 |\n\n- one\n- two\n\n```\na\nb\n```';
    expect(chatAgent._hardBreaks(text)).toBe(text);
  });

  describe('what the model is told', () => {
    test('two or more records are blocks, not a table; never wider than 3 columns; dates and amounts written out', () => {
      const p = chatAgent._systemPrompt();
      expect(p).toContain('TWO OR MORE records: NO table.');
      expect(p).toContain('**#5 · BLR/26-27/2078** · J. Sagar Associates · 5 Oct 2026');
      expect(p).toContain('INR 101,316.00 · Review needed');
      expect(p).toContain('Never a table wider than 3 columns.');
      expect(p).toContain('Dates as "5 Oct 2026", never "2026-10-05".');
      expect(p).toContain('a markdown table with two columns, "Field" and "Value"');
      expect(p).not.toContain('| Invoice Date | 2026-04-21 |');
    });

    test('a review note is the app\'s reading of the document, not the supplier\'s mistake', () => {
      const p = chatAgent._systemPrompt();
      expect(p).toContain('this app\'s own checks on the figures it READ from the document');
      expect(p).toContain('"the figures read from the PDF don\'t add up: <the note in plain words>; open the PDF to see which is right."');
      expect(p).toContain('Never call it the supplier\'s mistake or a math error on the invoice');
      expect(p).toContain('Never propose changing an amount to "fix" a review note until the user has said which figure is right.');
    });

    test('list numbers, and asking when the words do not pick out exactly one invoice', () => {
      const p = chatAgent._systemPrompt();
      expect(p).toContain('"#5", "no. 5", "row 5", "ref 5", "item 5" or "the 5th" mean the invoice whose listNumber is 5');
      expect(p).toContain('a number with no matching listNumber, "the other one", a vendor with several invoices in the data');
      expect(p).toContain('with an empty "proposals" array. Never stand the pinned invoice, or another invoice from the same vendor, in for one you can\'t identify.');
    });
  });
});

describe('chat-agent — numbers from the invoice list on screen', () => {
  let chatAgent, store, userId;

  const VENDORS = ['Acme Corp', 'Beta Co', 'Cobalt Ltd', 'Delta Works', 'Echo Media', 'Foxtrot Legal', 'Golf Print', 'Hotel Stays'];
  // The list's order is the user's sort, not the order the invoices arrived.
  const LIST_ORDER = ['c', 'a', 'h', 'b', 'e', 'g', 'd', 'f'];
  const rows = LIST_ORDER.map((id, i) => ({ n: i + 1, id }));
  const at = n => LIST_ORDER[n - 1];

  const context = () => {
    const system = callGemini.mock.calls[0][1][0].content;
    return JSON.parse(system.slice('Invoice data (JSON):\n'.length, system.indexOf('\n\nYou are an assistant')));
  };
  const sentIds = () => context().recentInvoices.map(i => i.id);
  const ask = (message, extra = {}) => chatAgent.respond(userId, { message, visibleInvoices: rows, ...extra });

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    require('../db/migrate').run();
    ({ callGemini } = require('./gemini-client'));
    callGemini.mockResolvedValue(JSON.stringify({ reply: 'ok', proposals: [] }));
    chatAgent = require('./chat-agent');
    const u = await require('./users').createUser(`rows${Date.now()}${Math.random()}@test.com`, 'password123', 'user');
    userId = u.id;
    store = require('./invoice-store').forUser(userId);
    'abcdefgh'.split('').forEach((id, i) => store.add({
      id, status: 'pending', vendorName: VENDORS[i], invoiceNumber: `INV-${id.toUpperCase()}${id.toUpperCase()}`,
      totalAmount: 1000 + i * 111, currency: 'SGD', invoiceDate: `2026-09-1${i}`,
    }));
  });

  describe('a number on the list', () => {
    test('"ref 5 and ref 6" — those rows lead the data, with their listNumber, and how they were read', async () => {
      await ask('check the ref 5 and ref 6 invoice, everything correct?');
      const ctx = context();
      expect(sentIds()).toEqual([at(5), at(6)]);
      expect(ctx.recentInvoices.map(i => i.listNumber)).toEqual([5, 6]);
      expect(ctx.numberReferences).toEqual([
        { number: 5, invoiceId: at(5), readAs: 'list row' },
        { number: 6, invoiceId: at(6), readAs: 'list row' },
      ]);
    });

    test.each([
      ['#5', [5]],
      ['what is in row 5?', [5]],
      ['is the 5th one right?', [5]],
      ['no. 5 please', [5]],
      ['show number 5', [5]],
      ['item 5', [5]],
      ['invoice 5 and 6', [5, 6]],
      ['mark #5-#7 as reviewed', [5, 6, 7]],
    ])('%s', async (message, ns) => {
      await ask(message);
      expect(sentIds()).toEqual(ns.map(at));
    });

    test('rows come first, then anything else the question names', async () => {
      await ask('compare #5 with the Hotel Stays invoice');
      expect(sentIds()).toEqual([at(5), 'h']);
    });

    test('every invoice on the list carries its listNumber; the pinned one too', async () => {
      await ask('hello', { invoiceId: 'h' });
      const ctx = context();
      expect(ctx.pinnedInvoice.listNumber).toBe(3);
      for (const inv of ctx.recentInvoices) expect(inv.listNumber).toBe(LIST_ORDER.indexOf(inv.id) + 1);
      expect(ctx).not.toHaveProperty('numberReferences');
    });

    test('an invoice not on the list has no listNumber', async () => {
      await ask('hello', { visibleInvoices: [{ n: 1, id: 'a' }] });
      const byId = Object.fromEntries(context().recentInvoices.map(i => [i.id, i]));
      expect(byId.a.listNumber).toBe(1);
      expect(byId.b).not.toHaveProperty('listNumber');
    });

    test('a row picked in one of the last two turns stays in view for the follow-up', async () => {
      await ask('and when is it due?', { history: [{ role: 'user', content: 'check #5' }, { role: 'assistant', content: 'Here it is.' }] });
      expect(sentIds()).toEqual([at(5)]);
    });

    test('the review note goes with each invoice that has one', async () => {
      store.update(at(5), { status: 'review-needed', errorMsg: 'the subtotal SGD 1.00 plus tax SGD 2.00 comes to SGD 3.00, but the total is SGD 1.00' });
      await ask('check #5 and #6');
      const [five, six] = context().recentInvoices;
      expect(five.errorMsg).toMatch(/comes to SGD 3\.00/);
      expect(six).not.toHaveProperty('errorMsg');
    });
  });

  describe('a number the list cannot answer is asked about, without the model', () => {
    test('no list sent: ask which, naming a few invoices by number and vendor, and propose nothing', async () => {
      const r = await chatAgent.respond(userId, { message: 'check the ref 6 and ref 5 invoice, everything correct?', invoiceId: 'b' });
      expect(callGemini).not.toHaveBeenCalled();
      expect(r.proposals).toEqual([]);
      expect(r.reply).toMatch(/can't see the numbers of your invoice list/);
      expect(r.reply).toMatch(/#5 and #6 are/);
      expect(r.reply).toMatch(/Which invoices do you mean\?/);
      // The pinned invoice first, then the newest.
      expect(r.reply).toMatch(/- \*\*INV-BB\*\* · Beta Co\n- \*\*INV-HH\*\* · Hotel Stays/);
    });

    test('a number past the end of the list', async () => {
      const r = await ask('check #15');
      expect(callGemini).not.toHaveBeenCalled();
      expect(r.proposals).toEqual([]);
      expect(r.reply).toMatch(/can't find #15 in your invoice list — it shows #1–#8/);
      expect(r.reply).toMatch(/Which invoice do you mean\?/);
      expect(r.reply).toMatch(/- \*\*#1 · INV-CC\*\* · Cobalt Ltd/);
    });

    test('one number on the list and one past it: still asked, about the missing one', async () => {
      const r = await ask('compare #5 and #9');
      expect(callGemini).not.toHaveBeenCalled();
      const [why] = r.reply.split('\n');
      expect(why).toMatch(/can't find #9 /);
      expect(why).not.toMatch(/#5/);
    });

    test('a row whose invoice the route dropped (not this account\'s) is not on the list', async () => {
      const r = await ask('check #2', { visibleInvoices: [{ n: 1, id: 'a' }, { n: 3, id: 'b' }] });
      expect(callGemini).not.toHaveBeenCalled();
      expect(r.reply).toMatch(/can't find #2 /);
    });

    test('an empty list', async () => {
      const r = await ask('check #1', { visibleInvoices: [] });
      expect(callGemini).not.toHaveBeenCalled();
      expect(r.reply).toMatch(/list is empty/);
    });

    test('more rows than one turn carries', async () => {
      const many = Array.from({ length: 45 }, (_, i) => ({ id: `m${i}`, status: 'pending', vendorName: `Many ${i}`, invoiceNumber: `M-${i}`, totalAmount: 1 }));
      for (const inv of many) store.add(inv);
      const r = await ask('mark #1-#45 as reviewed', { visibleInvoices: many.map((inv, i) => ({ n: i + 1, id: inv.id })) });
      expect(callGemini).not.toHaveBeenCalled();
      expect(r.reply).toMatch(/45 invoices at once/);
      expect(r.proposals).toEqual([]);
    });

    test('a date or a quarter is not a row: no question, the model answers', async () => {
      await chatAgent.respond(userId, { message: 'any invoices from the 5th? and how was the 1st quarter?' });
      expect(callGemini).toHaveBeenCalled();
    });

    test('"item 2" on a pinned invoice with two lines is its line: no question', async () => {
      store.update('a', { lineItems: [{ description: 'One', unitAmount: 1 }, { description: 'Two', unitAmount: 2 }] });
      await chatAgent.respond(userId, { message: 'change item 2 to 150', invoiceId: 'a' });
      expect(callGemini).toHaveBeenCalled();
    });
  });

  describe('an invoice numbered "5" against row 5', () => {
    beforeEach(() => {
      store.add({ id: 'five', status: 'pending', vendorName: 'Small Biz', invoiceNumber: '5', totalAmount: 42, currency: 'SGD' });
    });

    test('"#5", "invoice 5", "ref 5": the invoice numbered 5, whatever row it is on — and the model is told', async () => {
      for (const message of ['check #5', 'check invoice 5', 'check ref 5']) {
        callGemini.mockClear();
        await ask(message, { visibleInvoices: [...rows, { n: 9, id: 'five' }] });
        const ctx = context();
        expect(ctx.recentInvoices.map(i => i.id)).toEqual(['five']);
        expect(ctx.recentInvoices[0].listNumber).toBe(9);
        expect(ctx.numberReferences).toEqual([{ number: 5, invoiceId: 'five', readAs: 'invoice number' }]);
      }
    });

    test('...even with no list sent: no question, since the number names an invoice', async () => {
      await chatAgent.respond(userId, { message: 'is invoice 5 posted?' });
      expect(context().recentInvoices.map(i => i.id)).toEqual(['five']);
    });

    test('"row 5" and "the 5th" can only be the row', async () => {
      await ask('check row 5');
      expect(sentIds()).toEqual([at(5)]);
      callGemini.mockClear();
      await ask('is the 5th right?');
      expect(sentIds()).toEqual([at(5)]);
    });

    test('an invoice numbered "005" is invoice 5 too', async () => {
      store.update('five', { invoiceNumber: '005' });
      await ask('check #5');
      expect(sentIds()).toEqual(['five']);
    });
  });

  describe('line breaks in a reply', () => {
    test('the lines of a record\'s block stay on their own lines when rendered', async () => {
      callGemini.mockResolvedValue(JSON.stringify({
        reply: '**#5 · INV-EE** · Echo Media · 14 Sep 2026\nSGD 1,444.00 · Pending\n\n**#6 · INV-GG** · Golf Print · 16 Sep 2026\nSGD 1,666.00 · Pending',
        proposals: [],
      }));
      const r = await ask('check #5 and #6');
      expect(r.reply).toBe('**#5 · INV-EE** · Echo Media · 14 Sep 2026  \nSGD 1,444.00 · Pending\n\n**#6 · INV-GG** · Golf Print · 16 Sep 2026  \nSGD 1,666.00 · Pending');
    });
  });
});
