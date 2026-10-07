// Per-supplier memory: a new bill or sales invoice from a contact the user has
// dealt with before starts from what the user settled last time. These run
// the real store, handler and intake against the test database; nothing here
// reaches Xero (the send itself is stubbed at xero/invoices, and the token
// cache is replaced so "connected" is whatever a test says).
jest.mock('../xero/invoices', () => ({ createDraftInvoice: jest.fn(), updateDraftInvoice: jest.fn() }));
jest.mock('./token-cache', () => {
  const mockState = { tenants: [], persisted: [] };
  return {
    forUser: () => ({ getAllTenants: () => mockState.tenants, getValidToken: async () => 'tok' }),
    getPersistedTenants: () => mockState.persisted,
    _state: mockState,
  };
});
jest.mock('../xero/reconnect', () => ({ reconnectXero: jest.fn(async () => {}) }));
jest.mock('./notify', () => ({ notifyError: jest.fn(async () => {}), notifyInvoiceCreated: jest.fn(async () => {}) }));

// Setup with nothing configured: the literal defaults per kind.
const SETUP = { currency: 'SGD', accountCode: { claim: '429', bill: '310', invoice: '200' } };

let memory, invoiceStore, users, tokenCache, store, userId, n = 0;

beforeEach(async () => {
  jest.resetModules();
  require('../db/migrate').run();
  memory       = require('./supplier-memory');
  invoiceStore = require('./invoice-store');
  users        = require('./users');
  tokenCache   = require('./token-cache');
  tokenCache._state.tenants = [];
  tokenCache._state.persisted = [];
  const u = await users.createUser(`memory${Date.now()}-${n++}@test.com`, 'password123', 'user');
  userId = u.id;
  store  = invoiceStore.forUser(userId);
  expect(jest.isMockFunction(require('../xero/invoices').createDraftInvoice)).toBe(true);
});

let seq = 0;
// A stored row. Settled ones are posted (with a Xero ID) or reviewed.
function stored(extra = {}) {
  const id = extra.id || `row-${++seq}`;
  return store.add({
    id, status: 'posted', xeroInvoiceId: `xero-${id}`, invoiceType: 'ACCPAY',
    vendorName: 'Acme Supplies Pte Ltd', contactName: 'Acme Supplies Pte Ltd',
    invoiceNumber: `A-${seq}`, invoiceDate: '2026-09-03', totalAmount: 100, currency: 'SGD',
    accountCode: '469', processedAt: new Date().toISOString(), ...extra,
  });
}
// A new record as intake builds it, before it is stored.
const fresh = (extra = {}) => ({
  id: `new-${++seq}`, invoiceType: 'ACCPAY', vendorName: 'ACME SUPPLIES PTE. LTD.', contactName: 'ACME SUPPLIES PTE. LTD.',
  accountCode: '', currency: 'SGD', lineItems: [], ...extra,
});
const prefill = (rec, opts = {}) => memory.prefill(userId, rec, { store, defaults: SETUP, ...opts });

// ── Which record is remembered ─────────────────────────────────────────────

describe('the source: the newest settled record from the same contact and type', () => {
  test('the newest settled one wins, and the contact is matched as the duplicate checks match it', () => {
    stored({ id: 'older', accountCode: '420' });
    stored({ id: 'newer', accountCode: '469', vendorName: 'acme supplies pte ltd' });
    expect(store.lastSettledFrom('ACME SUPPLIES PTE. LTD.', 'ACCPAY').id).toBe('newer');
  });

  test('a reviewed row counts as settled; pending, review-needed and reported do not', () => {
    stored({ id: 'reviewed', status: 'reviewed', xeroInvoiceId: null });
    stored({ id: 'pending', status: 'pending', xeroInvoiceId: null });
    stored({ id: 'needs', status: 'review-needed', xeroInvoiceId: null });
    stored({ id: 'reported', status: 'reported', xeroInvoiceId: null });
    expect(store.lastSettledFrom('Acme Supplies', 'ACCPAY').id).toBe('reviewed');
  });

  test('duplicates, errors, and documents Xero voided or deleted are skipped', () => {
    stored({ id: 'good' });
    stored({ id: 'dup', status: 'duplicate', xeroInvoiceId: null });
    stored({ id: 'err', status: 'error', xeroInvoiceId: null });
    stored({ id: 'voided' });
    stored({ id: 'deleted' });
    store.recordXeroStatus('voided', 'xero-voided', { status: 'VOIDED' });
    store.recordXeroStatus('deleted', 'xero-deleted', { status: 'DELETED' });
    expect(store.lastSettledFrom('Acme Supplies', 'ACCPAY').id).toBe('good');
  });

  test('a paid or approved document in Xero still counts', () => {
    stored({ id: 'paid' });
    store.recordXeroStatus('paid', 'xero-paid', { status: 'PAID', amountDue: 0, amountPaid: 100 });
    expect(store.lastSettledFrom('Acme Supplies', 'ACCPAY').id).toBe('paid');
  });

  test('only the same type: a sales invoice to the same name is not a bill from it', () => {
    stored({ id: 'sale', invoiceType: 'ACCREC' });
    expect(store.lastSettledFrom('Acme Supplies', 'ACCPAY')).toBeNull();
    expect(store.lastSettledFrom('Acme Supplies', 'ACCREC').id).toBe('sale');
  });

  test('claims never take part: receipt claims, mileage and per diem', () => {
    stored({ id: 'receipt-claim', invoiceType: 'EXPENSE' });
    stored({ id: 'mileage', invoiceType: 'EXPENSE', claimKind: 'mileage', claimQuantity: 10 });
    expect(store.lastSettledFrom('Acme Supplies', 'EXPENSE')).toBeNull();
    const claim = fresh({ invoiceType: 'EXPENSE' });
    expect(prefill(claim)).toEqual(fresh({ invoiceType: 'EXPENSE', id: claim.id }));
  });

  test('a different supplier, or a reader that found no name, is remembered for nothing', () => {
    stored({ vendorName: 'Unknown Vendor', contactName: 'Unknown Vendor' });
    stored({ vendorName: 'Other Trading' });
    expect(prefill(fresh({ vendorName: 'Unknown Vendor', contactName: '' })).prefilledFrom).toBeUndefined();
    expect(prefill(fresh({ vendorName: 'Brand New Co', contactName: '' })).prefilledFrom).toBeUndefined();
  });

  test('the record being built is never its own source', () => {
    stored({ id: 'self' });
    expect(store.lastSettledFrom('Acme Supplies', 'ACCPAY', 'self')).toBeNull();
  });
});

// ── What is remembered, and what wins ─────────────────────────────────────

describe('precedence', () => {
  test('memory fills an account the document did not name, and says where it came from', () => {
    stored({ id: 'last', invoiceNumber: 'INV-123', invoiceDate: '2026-09-03', accountCode: '469' });
    const r = prefill(fresh());
    expect(r.accountCode).toBe('469');
    expect(r.prefilledFrom).toEqual({ accountCode: { fromId: 'last', fromNumber: 'INV-123', fromDate: '2026-09-03' } });
  });

  test('an account the document or a person set wins over memory', () => {
    stored({ accountCode: '469' });
    const r = prefill(fresh({ accountCode: '500' }));
    expect(r.accountCode).toBe('500');
    expect(r.prefilledFrom).toBeUndefined();
  });

  test('a remembered account that is only a Setup default is not carried forward, so the contact default can apply', () => {
    stored({ accountCode: '310' });   // what intake used to write on every bill
    const r = prefill(fresh());
    expect(r.accountCode).toBe('');
    expect(r.prefilledFrom).toBeUndefined();
  });

  test('a last bill with no account of its own leaves the account to posting', () => {
    stored({ accountCode: '' });
    expect(prefill(fresh()).accountCode).toBe('');
  });

  test('tax is not remembered: no tax field is ever written', () => {
    stored({ accountCode: '469' });
    const r = prefill(fresh());
    expect(Object.keys(r).filter(k => /tax/i.test(k))).toEqual([]);
  });
});

describe('line accounts', () => {
  test('one account across every line is used for the whole new document', () => {
    expect(memory.rememberedAccount({ accountCode: '310', lineItems: [{ accountCode: '469' }, { accountCode: '469' }] })).toBe('469');
  });
  test('mixed lines are not guessed: the document\'s own account, else the first line\'s', () => {
    expect(memory.rememberedAccount({ accountCode: '420', lineItems: [{ accountCode: '469' }, { accountCode: '500' }] })).toBe('420');
    expect(memory.rememberedAccount({ accountCode: '', lineItems: [{ accountCode: '469' }, { accountCode: '500' }] })).toBe('469');
  });
  test('lines with no account of their own (every stored line today) use the document account', () => {
    expect(memory.rememberedAccount({ accountCode: '469', lineItems: [{ description: 'a' }, { description: 'b' }] })).toBe('469');
  });
  test('end to end, stored lines carry no account, so the header account is what is remembered', () => {
    stored({ accountCode: '469', lineItems: [{ description: 'Paper', unitAmount: 40 }, { description: 'Ink', unitAmount: 60 }] });
    expect(prefill(fresh({ lineItems: [{ description: 'Toner', unitAmount: 80 }] })).accountCode).toBe('469');
  });
});

describe('currency, only when the document did not state one', () => {
  test('not stated: the last settled currency is used', () => {
    stored({ id: 'usd', currency: 'USD' });
    const r = prefill(fresh(), { currencyStated: false });
    expect(r.currency).toBe('USD');
    expect(r.prefilledFrom.currency.fromId).toBe('usd');
  });

  test('stated: the document\'s currency stands', () => {
    stored({ currency: 'USD' });
    const r = prefill(fresh({ currency: 'EUR' }), { currencyStated: true });
    expect(r.currency).toBe('EUR');
    expect(r.prefilledFrom?.currency).toBeUndefined();
  });

  test('from the bill reader, which fills an unstated currency with the Setup default: only that value is read as unstated', () => {
    stored({ currency: 'USD' });
    expect(prefill(fresh({ currency: 'SGD' })).currency).toBe('USD');
    expect(prefill(fresh({ currency: 'EUR' })).currency).toBe('EUR');
  });

  test('the same currency as last time is not a note', () => {
    stored({ currency: 'SGD', accountCode: '' });
    expect(prefill(fresh(), { currencyStated: false }).prefilledFrom).toBeUndefined();
  });
});

describe('the Xero company', () => {
  test('remembered while it is still connected', () => {
    tokenCache._state.persisted = [{ tenantId: 't-2', tenantName: 'Two' }];
    stored({ id: 'sent', xeroTenantId: 't-2' });
    const r = prefill(fresh());
    expect(r.xeroTenantId).toBe('t-2');
    expect(r.prefilledFrom.xeroTenantId.fromId).toBe('sent');
  });

  test('the live connection counts as connected too (the persisted list may lag a reconnect)', () => {
    tokenCache._state.tenants = [{ tenant_id: 't-2', tenant_name: 'Two' }];
    stored({ xeroTenantId: 't-2' });
    expect(prefill(fresh()).xeroTenantId).toBe('t-2');
  });

  test('not once that company has been disconnected', () => {
    tokenCache._state.persisted = [{ tenantId: 't-1', tenantName: 'One' }];
    stored({ xeroTenantId: 't-gone' });
    const r = prefill(fresh());
    expect(r.xeroTenantId).toBeUndefined();
    expect(r.prefilledFrom?.xeroTenantId).toBeUndefined();
  });

  test('never over a company the document or its route already set', () => {
    tokenCache._state.persisted = [{ tenantId: 't-1' }, { tenantId: 't-2' }];
    stored({ xeroTenantId: 't-2' });
    const r = prefill(fresh({ xeroTenantId: 't-1' }));
    expect(r.xeroTenantId).toBe('t-1');
    expect(r.prefilledFrom?.xeroTenantId).toBeUndefined();
  });
});

describe('a failed lookup', () => {
  test('costs the suggestion, never the record', () => {
    const broken = { lastSettledFrom: () => { throw new Error('database is locked'); } };
    const rec = fresh();
    expect(() => memory.prefill(userId, rec, { store: broken, defaults: SETUP })).not.toThrow();
    expect(rec.accountCode).toBe('');
    expect(rec.prefilledFrom).toBeUndefined();
  });
});

// ── Provenance on the stored record ────────────────────────────────────────

describe('provenance', () => {
  const PROV = { accountCode: { fromId: 'last', fromNumber: 'INV-123', fromDate: '2026-09-03' },
                 currency:    { fromId: 'last', fromNumber: 'INV-123', fromDate: '2026-09-03' } };

  test('is stored and comes back on the record the review page reads', () => {
    store.add({ id: 'p1', status: 'pending', vendorName: 'Acme', invoiceType: 'ACCPAY', accountCode: '469', currency: 'USD',
      prefilledFrom: PROV, processedAt: new Date().toISOString() });
    expect(store.getById('p1').prefilledFrom).toEqual(PROV);
  });

  test('a record with nothing prefilled has none', () => {
    store.add({ id: 'p0', status: 'pending', vendorName: 'Acme', processedAt: new Date().toISOString() });
    expect(store.getById('p0').prefilledFrom).toBeNull();
  });

  test('editing a prefilled field drops its note and keeps the others', () => {
    store.add({ id: 'p2', status: 'pending', vendorName: 'Acme', accountCode: '469', currency: 'USD',
      prefilledFrom: PROV, processedAt: new Date().toISOString() });
    store.update('p2', { accountCode: '500' });
    expect(store.getById('p2').prefilledFrom).toEqual({ currency: PROV.currency });
    store.update('p2', { currency: 'EUR' });
    expect(store.getById('p2').prefilledFrom).toBeNull();
  });

  test('saving the whole form with the remembered value unchanged keeps the note', () => {
    store.add({ id: 'p3', status: 'pending', vendorName: 'Acme', accountCode: '469', currency: 'USD',
      prefilledFrom: PROV, processedAt: new Date().toISOString() });
    store.update('p3', { accountCode: '469', currency: 'USD', vendorName: 'Acme Pte Ltd', totalAmount: 12 });
    expect(store.getById('p3').prefilledFrom).toEqual(PROV);
  });

  test('a send that stores the company it actually went to drops a remembered company that was not used', () => {
    const company = { xeroTenantId: { fromId: 'last', fromNumber: null, fromDate: null } };
    store.add({ id: 'p4', status: 'pending', vendorName: 'Acme', xeroTenantId: 't-gone',
      prefilledFrom: company, processedAt: new Date().toISOString() });
    store.update('p4', { status: 'posted', xeroInvoiceId: 'x-p4', xeroTenantId: 't-1' });
    expect(store.getById('p4').prefilledFrom).toBeNull();
    store.add({ id: 'p5', status: 'pending', vendorName: 'Acme', xeroTenantId: 't-2',
      prefilledFrom: company, processedAt: new Date().toISOString() });
    store.update('p5', { status: 'posted', xeroInvoiceId: 'x-p5', xeroTenantId: 't-2' });
    expect(store.getById('p5').prefilledFrom).toEqual(company);
  });

  test('the record says which Setup account posting falls back to, per kind', () => {
    store.add({ id: 'b', status: 'pending', invoiceType: 'ACCPAY', processedAt: new Date().toISOString() });
    store.add({ id: 'i', status: 'pending', invoiceType: 'ACCREC', processedAt: new Date().toISOString() });
    expect(store.getById('b').setupAccountCode).toBe('310');
    expect(store.getById('i').setupAccountCode).toBe('200');
    users.saveUserConfig(userId, { DEFAULT_ACCOUNT_CODE: '429' });
    expect(store.getById('b').setupAccountCode).toBe('429');
  });
});

// ── Through the intake paths ───────────────────────────────────────────────

describe('the emailed and uploaded bill path (invoice-handler)', () => {
  // What the bill reader hands over: it reads no account from the page and
  // puts the bill default on every document, and an unstated currency is the
  // Setup default.
  const parsed = (extra = {}) => ({
    vendorName: 'Acme Supplies Pte Ltd', contactName: 'Acme Supplies Pte Ltd', invoiceNumber: `B-${++seq}`,
    invoiceDate: '2026-09-20', totalAmount: 218, subTotal: 200, taxAmount: 18, currency: 'SGD',
    accountCode: '310', source: 'upload', invoiceType: 'ACCPAY',
    lineItems: [{ description: 'Paper', unitAmount: 200, discountRate: 0 }], ...extra,
  });
  const intake = data => require('./invoice-handler').createHandler(userId, { submitDelayMs: 1 }).onInvoiceEmail(data);

  test('a first bill from a supplier stores no account: Setup\'s default is no longer written onto it', async () => {
    const r = await intake(parsed());
    const row = store.getById(r.id);
    expect(row.accountCode).toBe('');
    expect(row.prefilledFrom).toBeNull();
    expect(row.setupAccountCode).toBe('310');
  });

  test('an account the reader did name (not a Setup default) is kept as the document\'s', async () => {
    stored({ accountCode: '469' });
    const r = await intake(parsed({ accountCode: '611' }));
    expect(store.getById(r.id)).toMatchObject({ accountCode: '611', prefilledFrom: null });
  });

  test('a returning supplier gets last time\'s account and currency, with where they came from', async () => {
    stored({ id: 'last-usd', invoiceNumber: 'INV-123', invoiceDate: '2026-09-03', accountCode: '469', currency: 'USD' });
    const r = await intake(parsed());
    const row = store.getById(r.id);
    expect(row).toMatchObject({ accountCode: '469', currency: 'USD' });
    expect(row.prefilledFrom).toEqual({
      accountCode: { fromId: 'last-usd', fromNumber: 'INV-123', fromDate: '2026-09-03' },
      currency:    { fromId: 'last-usd', fromNumber: 'INV-123', fromDate: '2026-09-03' },
    });
  });

  test('the bank-details hold works exactly as before alongside memory', async () => {
    stored({ id: 'last-bank', accountCode: '469', paymentReference: 'Acct: 601-493935-001' });
    const r = await intake(parsed({ paymentReference: 'Acct: 777-000111-222' }));
    const row = store.getById(r.id);
    expect(r.status).toBe('review-needed');
    expect(row.errorMsg).toMatch(/Bank details differ from this supplier's last bill/);
    expect(row.accountCode).toBe('469');
  });

  test('the duplicate check still answers before anything is remembered', async () => {
    stored({ id: 'same', invoiceNumber: 'DUP-1', invoiceDate: '2026-09-20', totalAmount: 218, accountCode: '469' });
    const r = await intake(parsed({ invoiceNumber: 'DUP-1' }));
    expect(r).toMatchObject({ duplicate: true, id: 'same' });
  });
});

describe('the composed and imported sales invoice path (invoice-intake)', () => {
  const compose = input => require('../intake/invoice-intake').intakeInvoice(userId, {
    contactName: 'Bright Customer Pte Ltd', invoiceNumber: `S-${++seq}`, invoiceDate: '2026-09-21',
    lineItems: [{ description: 'Consulting', unitAmount: 500 }], ...input,
  });

  test('nothing typed and no history: no account stored, posting decides', () => {
    const r = compose({});
    expect(store.getById(r.id)).toMatchObject({ accountCode: '', prefilledFrom: null, setupAccountCode: '200' });
  });

  test('history fills the account and, with none typed, the currency', () => {
    stored({ id: 'sale', invoiceType: 'ACCREC', vendorName: 'Bright Customer', contactName: 'Bright Customer',
      accountCode: '201', currency: 'USD' });
    const row = store.getById(compose({}).id);
    expect(row).toMatchObject({ accountCode: '201', currency: 'USD' });
    expect(Object.keys(row.prefilledFrom).sort()).toEqual(['accountCode', 'currency']);
  });

  test('a typed account and currency win over history', () => {
    stored({ invoiceType: 'ACCREC', vendorName: 'Bright Customer', accountCode: '201', currency: 'USD' });
    const row = store.getById(compose({ accountCode: '260', currency: 'EUR' }).id);
    expect(row).toMatchObject({ accountCode: '260', currency: 'EUR', prefilledFrom: null });
  });
});

// ── Posting to a remembered company ────────────────────────────────────────

describe('chooseTenant with a remembered company', () => {
  // Required per test, after the migration: a describe-scope require binds to
  // a database no migration has touched.
  const chooseTenant = (...args) => require('../queue/processor').chooseTenant(...args);
  const TWO = [{ tenant_id: 't-1' }, { tenant_id: 't-2' }];
  const remembered = { prefilledFrom: { xeroTenantId: { fromId: 'last' } } };

  test('used while connected', () => {
    expect(chooseTenant(userId, { xeroTenantId: 't-2', ...remembered }, TWO).tenant_id).toBe('t-2');
  });

  test('gone since: the usual choice is made instead of refusing', () => {
    expect(chooseTenant(userId, { xeroTenantId: 't-gone', ...remembered }, [{ tenant_id: 't-1' }]).tenant_id).toBe('t-1');
    expect(() => chooseTenant(userId, { xeroTenantId: 't-gone', ...remembered }, TWO)).toThrow(/Choose a default Xero company/);
  });

  test('a document already in Xero still goes only to its own company', () => {
    expect(() => chooseTenant(userId, { xeroTenantId: 't-gone', xeroInvoiceId: 'x-1', ...remembered }, TWO)).toThrow(/no longer connected/);
    expect(() => chooseTenant(userId, { xeroTenantId: 't-gone' }, TWO)).toThrow(/no longer connected/);
  });
});
