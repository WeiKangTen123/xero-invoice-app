// What a chat turn sends to the model. It used to be the 60 most recent
// invoices and the pinned invoice in full — bank details included — whatever
// the question. Now: the invoices the question names (or the 20 most recent),
// counts by status, and payment details only when the message asks for them.
jest.mock('./gemini-client', () => ({ callGemini: jest.fn() }));

describe('chat-agent — what the model is shown', () => {
  let chatAgent, callGemini, store, userId;

  const BANK = 'Bank: OCBC | Acct: 601-493935-001 | Swift: OCBCSGSG | Beneficiary: Acme Corp';
  const context = () => {
    const system = callGemini.mock.calls[0][1][0].content;
    return JSON.parse(system.slice('Invoice data (JSON):\n'.length, system.indexOf('\n\nYou are an assistant')));
  };

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    ({ callGemini } = require('./gemini-client'));
    callGemini.mockResolvedValue(JSON.stringify({ reply: 'ok', proposals: [] }));
    chatAgent = require('./chat-agent');
    const u = await require('./users').createUser(`priv${Date.now()}${Math.random()}@test.com`, 'password123', 'user');
    userId = u.id;
    store = require('./invoice-store').forUser(userId);
    // 30 filler invoices, then the two that questions below name.
    for (let i = 1; i <= 30; i++) {
      store.add({ id: `f${i}`, status: i % 3 === 0 ? 'pending' : 'posted', vendorName: `Filler Vendor ${i}`, invoiceNumber: `F-${1000 + i}`,
        totalAmount: 10 + i, currency: 'SGD', invoiceDate: '2026-01-15', paymentReference: `Acct: 000-${i}` });
    }
    store.add({ id: 'acme', status: 'review-needed', vendorName: 'Acme Corp', invoiceNumber: 'INV-2026-099',
      totalAmount: 400, currency: 'USD', invoiceDate: '2026-04-21', paymentReference: BANK });
    store.add({ id: 'bran', status: 'posted', vendorName: 'Branworks Pte Ltd', invoiceNumber: 'BW-77',
      totalAmount: 1234.5, currency: 'SGD', invoiceDate: '2026-03-02', paymentReference: 'PayNow: 202016196Z' });
  });

  describe('payment details', () => {
    test('the pinned invoice\'s bank details are not sent for an unrelated question', async () => {
      await chatAgent.respond(userId, { message: 'change the invoice number to INV-999', invoiceId: 'acme' });
      const ctx = context();
      expect(ctx.pinnedInvoice.invoiceNumber).toBe('INV-2026-099');
      expect(ctx.pinnedInvoice).not.toHaveProperty('paymentReference');
      expect(callGemini.mock.calls[0][1][0].content).not.toContain('601-493935-001');
    });

    test('they are sent when the message asks about payment details', async () => {
      for (const message of ['what are the bank details for this?', 'show me the payment reference', 'how do I pay this invoice?', 'what is the account number?', 'change the PayNow ID']) {
        callGemini.mockClear();
        await chatAgent.respond(userId, { message, invoiceId: 'acme' });
        expect(context().pinnedInvoice.paymentReference).toBe(BANK);
      }
    });

    test('"account code" is the ledger, not a bank — no payment details for it', async () => {
      await chatAgent.respond(userId, { message: 'change the account code to 400', invoiceId: 'acme' });
      expect(context().pinnedInvoice).not.toHaveProperty('paymentReference');
    });

    test('an earlier turn asking for them does not keep them in every later turn', async () => {
      await chatAgent.respond(userId, {
        message: 'now change the due date to 2026-05-30', invoiceId: 'acme',
        history: [{ role: 'user', content: 'what are the bank details?' }, { role: 'assistant', content: 'Here they are.' }],
      });
      expect(context().pinnedInvoice).not.toHaveProperty('paymentReference');
    });

    test('the invoice list never carries payment details', async () => {
      await chatAgent.respond(userId, { message: 'what are the bank details on the Acme invoice?' });
      const list = context().recentInvoices;
      expect(list.length).toBeGreaterThan(0);
      for (const inv of list) expect(inv).not.toHaveProperty('paymentReference');
    });
  });

  describe('which invoices are sent', () => {
    test('a question naming nothing gets the 20 most recent, not 60', async () => {
      await chatAgent.respond(userId, { message: 'hello, what can you do?' });
      const ctx = context();
      expect(ctx.recentInvoices).toHaveLength(chatAgent.RECENT_INVOICES_LIMIT);
      expect(chatAgent.RECENT_INVOICES_LIMIT).toBe(20);
      expect(ctx.recentInvoices[0].id).toBe('bran');   // newest first
    });

    test('a vendor named in the question: only that vendor\'s invoices', async () => {
      await chatAgent.respond(userId, { message: "what's the status of the Acme invoice?" });
      expect(context().recentInvoices.map(i => i.id)).toEqual(['acme']);
    });

    test('an invoice number named in the question, however it is spaced', async () => {
      await chatAgent.respond(userId, { message: 'is INV 2026 099 posted yet?' });
      expect(context().recentInvoices.map(i => i.id)).toEqual(['acme']);
    });

    test('a date or month named in the question', async () => {
      await chatAgent.respond(userId, { message: 'which bills are dated 2026-03-02?' });
      expect(context().recentInvoices.map(i => i.id)).toEqual(['bran']);
      callGemini.mockClear();
      await chatAgent.respond(userId, { message: 'anything from April 2026?' });
      expect(context().recentInvoices.map(i => i.id)).toEqual(['acme']);
    });

    test('a status, when nothing more specific is named: every invoice in it, beyond the newest 20', async () => {
      await chatAgent.respond(userId, { message: 'mark all pending invoices as reviewed' });
      const ids = context().recentInvoices.map(i => i.id);
      expect(ids).toHaveLength(10);
      expect(context().recentInvoices.every(i => i.status === 'pending')).toBe(true);
      // f3 is far older than the newest 20.
      expect(ids).toContain('f3');
    });

    test('a vendor and a status: the vendor wins — the question is about Acme, not every held invoice', async () => {
      await chatAgent.respond(userId, { message: 'has the Branworks invoice been posted?' });
      expect(context().recentInvoices.map(i => i.id)).toEqual(['bran']);
    });

    test('a follow-up is read with the turns before it', async () => {
      await chatAgent.respond(userId, {
        message: 'the payroll one',
        history: [{ role: 'user', content: 'show me the Branworks invoice' }, { role: 'assistant', content: 'Which line?' }],
      });
      expect(context().recentInvoices.map(i => i.id)).toEqual(['bran']);
    });

    test('counts by status go with every turn, so a count is never read off the sample', async () => {
      await chatAgent.respond(userId, { message: 'how many invoices are pending?' });
      expect(context().invoiceCounts).toEqual({ pending: 10, posted: 21, 'review-needed': 1 });
    });
  });

  describe('_relevantInvoices (pure)', () => {
    const pool = Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, vendorName: `Supplier ${i}`, invoiceNumber: `X-${i}`, status: 'pending', totalAmount: 1 }));

    test('a status match is capped', () => {
      const { invoices, matched } = chatAgent._relevantInvoices(pool, 'all pending ones');
      expect(matched).toBe(true);
      expect(invoices).toHaveLength(chatAgent.MATCHED_INVOICES_LIMIT);
    });

    test('generic company words do not match every company', () => {
      const p = [{ id: 'a', vendorName: 'Acme Pte Ltd' }, { id: 'b', vendorName: 'Beta Pte Ltd' }];
      expect(chatAgent._relevantInvoices(p, 'the Beta invoice').invoices.map(i => i.id)).toEqual(['b']);
    });
  });
});
