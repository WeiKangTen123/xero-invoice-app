// What the chat assistant may say about money, and what it shows when a reply
// is cut off. The financial context is mocked here so the figures are known;
// the guard itself is xero/ai-insights.js, the same one the dashboard
// narrative uses.
jest.mock('./gemini-client', () => ({ callGemini: jest.fn() }));
jest.mock('./chat-financials', () => ({
  looksFinancial: jest.fn(() => true),
  financialContext: jest.fn(),
}));

describe('chat-agent — figures in a financial answer', () => {
  let chatAgent, callGemini, fin, userId;

  const facts = {
    organisation: 'Acme Pte Ltd', currency: 'SGD', period: 'Financial year to date',
    figures: ['- Revenue invoiced (accrual): SGD 109,330', '- Cash actually received from customers: SGD 26,000', '- Share of invoiced work collected: 24%'],
    alerts: [],
    allowed: [109330, 26000, 24],
  };
  const answer = reply => callGemini.mockResolvedValue(JSON.stringify({ reply, proposals: [] }));

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    ({ callGemini } = require('./gemini-client'));
    fin = require('./chat-financials');
    chatAgent = require('./chat-agent');
    fin.looksFinancial.mockReturnValue(true);
    fin.financialContext.mockResolvedValue({ ...facts });
    const u = await require('./users').createUser(`ground${Date.now()}@test.com`, 'password123', 'user');
    userId = u.id;
  });

  test('the company and period asked about reach the financial context', async () => {
    answer('ok');
    await chatAgent.respond(userId, { message: 'how is revenue?', tenantId: 'tenant-b', period: { preset: 'last-quarter' }, timezone: 'Asia/Singapore' });
    expect(fin.financialContext).toHaveBeenCalledWith(userId, 'tenant-b', { timezone: 'Asia/Singapore', period: { preset: 'last-quarter' } });
  });

  test('the allowed set is used to check the reply, and never sent to the model', async () => {
    answer('ok');
    await chatAgent.respond(userId, { message: 'how is revenue?', tenantId: 't' });
    const system = callGemini.mock.calls[0][1][0].content;
    expect(system).toContain('SGD 109,330');
    expect(system).not.toContain('"allowed"');
  });

  test('figures taken from the books pass untouched', async () => {
    answer('You invoiced SGD 109,330 and collected SGD 26,000 — 24% of it.');
    const r = await chatAgent.respond(userId, { message: 'how is revenue?', tenantId: 't' });
    expect(r.reply).toBe('You invoiced SGD 109,330 and collected SGD 26,000 — 24% of it.');
  });

  test('an invented figure is removed and the user is told', async () => {
    answer('You invoiced SGD 109,330. Your margin is SGD 48.2k, up 18%.');
    const r = await chatAgent.respond(userId, { message: 'how is revenue?', tenantId: 't' });
    expect(r.reply).toMatch(/^You invoiced SGD 109,330\./);
    expect(r.reply).not.toMatch(/48\.2k|18%/);
    expect(r.reply).toMatch(/could not be matched to your Xero figures/);
  });

  test('a table keeps its shape; only the invented row goes', async () => {
    answer('| Figure | Value |\n|---|---|\n| Invoiced | SGD 109,330 |\n| Profit | SGD 61,000 |');
    const r = await chatAgent.respond(userId, { message: 'summarise my revenue', tenantId: 't' });
    expect(r.reply).toMatch(/^\| Figure \| Value \|\n\|---\|---\|\n\| Invoiced \| SGD 109,330 \|/);
    expect(r.reply).not.toMatch(/61,000/);
  });

  test('a figure the user or the invoice data supplied may be repeated', async () => {
    require('./invoice-store').forUser(userId).add({
      id: 'inv-9', status: 'pending', vendorName: 'Branworks', invoiceNumber: 'BW-7', totalAmount: 4350.5, currency: 'SGD', processedAt: new Date().toISOString(),
    });
    answer('Branworks billed SGD 4,350.50. Against your target of SGD 120,000 you have invoiced SGD 109,330.');
    const r = await chatAgent.respond(userId, { message: 'my target is SGD 120,000 — how am I doing?', tenantId: 't' });
    expect(r.reply).not.toMatch(/could not be matched/);
  });

  test('a pipeline answer with no books in context is not policed', async () => {
    fin.looksFinancial.mockReturnValue(false);
    answer('This invoice has two lines — which should the extra USD 50.00 go on?');
    const r = await chatAgent.respond(userId, { message: 'change the total to 450' });
    expect(fin.financialContext).not.toHaveBeenCalled();
    expect(r.reply).toMatch(/extra USD 50\.00/);
  });
});

describe('chat-agent — a reply cut off at its token limit', () => {
  let chatAgent, callGemini, fin, userId;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    ({ callGemini } = require('./gemini-client'));
    fin = require('./chat-financials');
    fin.looksFinancial.mockReturnValue(false);
    chatAgent = require('./chat-agent');
    const u = await require('./users').createUser(`cut${Date.now()}@test.com`, 'password123', 'user');
    userId = u.id;
  });

  const cutOff = partial => callGemini.mockRejectedValue(Object.assign(new Error('cut off'), { code: 'GEMINI_TRUNCATED', partial }));

  test('the raw JSON fragment is never shown; the reply text is taken out of it', async () => {
    cutOff('{"reply": "Here are your pending invoices:\\n\\n| Vendor | Total |\\n|---|---|\\n| Acme | SGD 1');
    const r = await chatAgent.respond(userId, { message: 'list pending' });
    expect(r.reply).not.toMatch(/^\{|"reply"/);
    expect(r.reply).toMatch(/^Here are your pending invoices:/);
    expect(r.reply).toMatch(/cut short/);
    expect(r.proposals).toEqual([]);
  });

  test('a complete reply whose proposals were cut off says the changes were lost, and proposes nothing', async () => {
    cutOff('{"reply": "Here is the change:", "proposals": [{"type": "field_update", "invoiceId": "inv-1", "field": "lineItems", "newValue": [{"description": "A", "unitAmount": 1');
    const r = await chatAgent.respond(userId, { message: 'fix the lines' });
    expect(r.reply).toMatch(/^Here is the change:/);
    expect(r.reply).toMatch(/changes I was about to suggest were cut off/);
    expect(r.proposals).toEqual([]);
  });

  test('nothing usable in the fragment gives a plain apology, not braces', async () => {
    cutOff('{"pro');
    const r = await chatAgent.respond(userId, { message: 'hello' });
    expect(r.reply).toMatch(/came back incomplete/);
  });

  test('a JSON reply that fails to parse for another reason is not shown raw either', async () => {
    callGemini.mockResolvedValue('{"reply": "All 3 invoices are posted.", "proposals": [}');
    const r = await chatAgent.respond(userId, { message: 'status?' });
    expect(r.reply).toBe('All 3 invoices are posted.');
  });

  test('other model failures still reach the route as errors', async () => {
    callGemini.mockRejectedValue(new Error('quota'));
    await expect(chatAgent.respond(userId, { message: 'hi' })).rejects.toThrow('quota');
  });
});
