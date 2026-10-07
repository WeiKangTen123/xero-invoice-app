// How a mileage or per diem claim reaches Xero: through the same send as a
// receipt claim (submitInvoiceToXero -> processor -> createDraftInvoice), owed
// to the claimant, coded to the account from Setup, with no tax and nothing
// to attach — and no "the attachment failed" note for the file it never had.
//
// Nothing here reaches Xero or Slack: the SDK class, axios, the token cache
// and the notifier are all replaced, and the first test checks that they are.
const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { serverFor } = require('../scripts/test-server');

const mockApi = {
  createInvoices:        jest.fn(),
  updateInvoice:         jest.fn(),
  getInvoiceAttachments: jest.fn(),
  getTaxRates:           jest.fn(async () => ({ body: { taxRates: [] } })),
  getBrandingThemes:     jest.fn(async () => ({ body: { brandingThemes: [] } })),
  getOrganisations:      jest.fn(async () => ({ body: { organisations: [{ baseCurrency: 'SGD' }] } })),
  getAccounts:           jest.fn(async () => ({ body: { accounts: [] } })),
};
jest.mock('xero-node', () => ({ AccountingApi: jest.fn(() => mockApi) }));
jest.mock('axios', () => ({ put: jest.fn(), post: jest.fn(), get: jest.fn() }));
jest.mock('./contacts', () => ({
  ...jest.requireActual('./contacts'),
  resolveContact: jest.fn(async () => ({ contactID: 'contact-1' })),
}));
jest.mock('./reconnect', () => ({ reconnectXero: jest.fn(async () => { throw new Error('no reconnect in tests'); }) }));
jest.mock('../utils/token-cache', () => ({
  forUser: () => ({
    getValidToken:  async () => 'tok',
    getAllTenants:  async () => [{ tenant_id: 'tenant-1', tenant_name: 'Test Org' }],
  }),
}));
jest.mock('../utils/notify', () => ({
  notifyInvoiceCreated: jest.fn(async () => {}), notifyError: jest.fn(async () => {}), notifyErrorThrottled: jest.fn(async () => {}),
}));

const axios = require('axios');
const { AccountingApi } = require('xero-node');
const { resolveContact } = require('./contacts');
const db           = require('../db');
const users        = require('../utils/users');
const invoiceStore = require('../utils/invoice-store');
const receiptStore = require('../utils/receipt-store');
const { jwtSecret } = require('../middleware/auth-middleware');
const { submitInvoiceToXero } = require('../utils/invoice-handler');
const { createDraftInvoice, updateDraftInvoice, NO_PAYEE_MSG } = require('./invoices');

require('../db/migrate').run();

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 2, 3, 4, 5]);

let user, app;
const auth = () => `Bearer ${jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret())}`;

async function addClaim(body) {
  const res = await request(serverFor(app)).post('/api/claims/allowance').set('Authorization', auth()).send(body).expect(201);
  return res.body.claim;
}
const mileage = { kind: 'mileage', date: '2026-10-03', from: 'Office', to: 'Client A', purpose: 'site visit', distanceKm: 42 };
const perDiem = { kind: 'per_diem', startDate: '2026-10-01', endDate: '2026-10-03', destination: 'Kuala Lumpur', purpose: 'conference' };
const store = () => invoiceStore.forUser(user.id);
const postNote = id => db.prepare('SELECT post_note FROM invoices WHERE id = ?').get(id).post_note;
const sentInvoice = () => mockApi.createInvoices.mock.calls[0][1].invoices[0];

beforeEach(async () => {
  // createDraftInvoice sets accessToken on the instance, so not every value is a mock.
  for (const fn of Object.values(mockApi)) if (jest.isMockFunction(fn)) fn.mockClear();
  mockApi.createInvoices.mockReset().mockResolvedValue({ body: { invoices: [{ invoiceID: 'xero-1', total: 25.2 }] } });
  mockApi.updateInvoice.mockReset().mockResolvedValue({ body: { invoices: [{ invoiceID: 'xero-1', total: 30 }] } });
  mockApi.getInvoiceAttachments.mockReset().mockResolvedValue({ body: { attachments: [] } });
  axios.put.mockReset().mockResolvedValue({ status: 200, data: {} });
  axios.post.mockReset().mockResolvedValue({ status: 200, data: {} });
  resolveContact.mockClear();

  user = await users.createUser(`post${Date.now()}${Math.random().toString(36).slice(2, 6)}@test.com`, 'password123', 'user');
  users.saveUserConfig(user.id, {
    ...users.checkAllowanceSettings({ MILEAGE_RATE: '0.60', PER_DIEM_RATE: '80', MILEAGE_ACCOUNT_CODE: '493', PER_DIEM_ACCOUNT_CODE: '494' }).values,
    CLAIM_PAYEE_NAME: 'Jane Tan', DEFAULT_CURRENCY: 'SGD', ZERO_TAX_RATE: 'NONE',
  });
  app = express();
  app.use(express.json());
  app.use('/api/claims', require('../routes/claims'));
});

test('the Xero SDK, axios and the token cache in use are the test doubles', () => {
  expect(jest.isMockFunction(AccountingApi)).toBe(true);
  expect(new AccountingApi()).toBe(mockApi);
  expect(jest.isMockFunction(axios.put)).toBe(true);
  expect(jest.isMockFunction(axios.post)).toBe(true);
  expect(jest.isMockFunction(require('../utils/notify').notifyInvoiceCreated)).toBe(true);
});

describe('a mileage claim', () => {
  test('goes through the claim send: owed to the payee, on its account, no tax, nothing attached, no note', async () => {
    const claim = await addClaim(mileage);
    const xeroId = await submitInvoiceToXero(user.id, claim.id);
    expect(xeroId).toBe('xero-1');

    expect(mockApi.createInvoices).toHaveBeenCalledTimes(1);
    expect(mockApi.createInvoices.mock.calls[0][0]).toBe('tenant-1');
    const sent = sentInvoice();
    expect(sent).toMatchObject({
      type: 'ACCPAY', status: 'DRAFT', contact: { contactID: 'contact-1' },
      date: '2026-10-03', dueDate: '2026-10-03', invoiceNumber: claim.invoiceNumber,
      currencyCode: 'SGD', lineAmountTypes: 'Exclusive',
      reference: 'Mileage 2026-10-03: Office → Client A (site visit), 42.0 km × 0.60',
    });
    expect(sent.lineItems).toEqual([{
      description: 'Mileage 2026-10-03: Office → Client A (site visit), 42.0 km × 0.60',
      accountCode: '493', taxType: 'NONE', quantity: 1, unitAmount: 25.2,
    }]);
    // The claimant is the contact; there is no shop, and none is made up.
    expect(resolveContact).toHaveBeenCalledWith(user.id, 'tenant-1', { vendorName: 'Jane Tan', invoiceType: 'EXPENSE' });
    // No tax, so the org's tax rates are never asked for.
    expect(mockApi.getTaxRates).not.toHaveBeenCalled();

    // Nothing to attach, nothing tried, nothing noted.
    expect(axios.put).not.toHaveBeenCalled();
    expect(mockApi.getInvoiceAttachments).not.toHaveBeenCalled();
    const after = store().getById(claim.id);
    expect(after).toMatchObject({ status: 'posted', xeroInvoiceId: 'xero-1', xeroTenantId: 'tenant-1', errorMsg: null });
    expect(postNote(claim.id)).toBeNull();
  });

  test('the zero-tax rate is the one in Setup', async () => {
    users.saveUserConfig(user.id, { ZERO_TAX_RATE: 'TAX001' });
    const claim = await addClaim(mileage);
    await createDraftInvoice(user.id, 'tenant-1', { ...store().getById(claim.id), _invoiceStoreId: claim.id });
    expect(sentInvoice().lineItems[0].taxType).toBe('TAX001');
  });

  test('with no payee set it is refused before anything is sent, saying how to fix it', async () => {
    users.saveUserConfig(user.id, { CLAIM_PAYEE_NAME: '' });
    const claim = await addClaim(mileage);
    await expect(submitInvoiceToXero(user.id, claim.id)).rejects.toThrow(NO_PAYEE_MSG);
    expect(mockApi.createInvoices).not.toHaveBeenCalled();
    expect(resolveContact).not.toHaveBeenCalled();
    expect(store().getById(claim.id)).toMatchObject({ status: 'error', errorMsg: NO_PAYEE_MSG });
  });

  test('a correction sent to the same Xero draft does not ask Xero what it holds or note a missing file', async () => {
    const claim = await addClaim(mileage);
    await submitInvoiceToXero(user.id, claim.id);
    await request(serverFor(app)).patch(`/api/claims/allowance/${claim.id}`).set('Authorization', auth())
      .send({ ...mileage, distanceKm: 50 }).expect(200);

    await submitInvoiceToXero(user.id, claim.id);
    expect(mockApi.updateInvoice).toHaveBeenCalledTimes(1);
    const [tenant, xeroId, body] = mockApi.updateInvoice.mock.calls[0];
    expect([tenant, xeroId]).toEqual(['tenant-1', 'xero-1']);
    expect(body.invoices[0].lineItems[0]).toMatchObject({ unitAmount: 30, description: expect.stringMatching(/50\.0 km × 0\.60$/) });
    expect(mockApi.getInvoiceAttachments).not.toHaveBeenCalled();
    expect(axios.put).not.toHaveBeenCalled();
    expect(store().getById(claim.id)).toMatchObject({ status: 'posted', errorMsg: null });
  });

  // A mileage claim has no file. Should one ever carry a file reference (a
  // stale or hand-edited row), it is still skipped: the attachment step is
  // not run for these claims at all, rather than run and found empty.
  test('the attachment step is skipped outright, even for a stray file reference', async () => {
    const claim = await addClaim(mileage);
    const invoiceData = { ...store().getById(claim.id), _invoiceStoreId: claim.id, receiptFile: 'stray.jpg', hasPdf: true };
    await createDraftInvoice(user.id, 'tenant-1', invoiceData);
    expect(axios.put).not.toHaveBeenCalled();
    expect(store().getById(claim.id).errorMsg).toBeNull();
    expect(postNote(claim.id)).toBeNull();

    // The same stray reference on a receipt claim is reported, as it should be.
    const asReceipt = { ...invoiceData, claimKind: 'receipt' };
    await createDraftInvoice(user.id, 'tenant-1', asReceipt);
    expect(store().getById(claim.id).errorMsg).toMatch(/^Sent to Xero, but the attachment failed: /);
  });

  test('updateDraftInvoice called directly attaches nothing and notes nothing', async () => {
    mockApi.updateInvoice.mockResolvedValue({ body: { invoices: [{ invoiceID: 'xero-9', total: 25.2 }] } });
    const claim = await addClaim(mileage);
    await updateDraftInvoice(user.id, 'tenant-1', 'xero-9', { ...store().getById(claim.id), _invoiceStoreId: claim.id });
    expect(mockApi.updateInvoice).toHaveBeenCalledTimes(1);
    expect(mockApi.getInvoiceAttachments).not.toHaveBeenCalled();
    expect(store().getById(claim.id).errorMsg).toBeNull();
  });
});

describe('a per diem claim', () => {
  test('posts on its own account at the days times the rate', async () => {
    mockApi.createInvoices.mockResolvedValue({ body: { invoices: [{ invoiceID: 'xero-2', total: 200 }] } });
    const claim = await addClaim({ ...perDiem, days: 2.5 });
    await submitInvoiceToXero(user.id, claim.id);
    expect(sentInvoice().lineItems).toEqual([{
      description: 'Per diem 2026-10-01 to 2026-10-03, Kuala Lumpur (conference), 2.5 days × 80.00',
      accountCode: '494', taxType: 'NONE', quantity: 1, unitAmount: 200,
    }]);
    expect(axios.put).not.toHaveBeenCalled();
    expect(store().getById(claim.id)).toMatchObject({ status: 'posted', errorMsg: null });
  });
});

describe('a receipt claim, beside them, is unchanged', () => {
  function receiptClaim(extra = {}) {
    const id = `rc${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const file = receiptStore.forUser(user.id).save(id, JPEG, 'image/jpeg');
    return store().add({
      id, status: 'reviewed', invoiceType: 'EXPENSE', source: 'upload', vendorName: 'FairPrice',
      invoiceNumber: `EXP-${id.slice(-6).toUpperCase()}`, invoiceDate: '2026-10-02', dueDate: '2026-10-02',
      totalAmount: 12.5, subTotal: 12.5, taxAmount: 0, currency: 'SGD', accountCode: '429',
      receiptFile: file, receiptMime: 'image/jpeg', ...extra,
    });
  }

  test('its receipt is still attached', async () => {
    mockApi.createInvoices.mockResolvedValue({ body: { invoices: [{ invoiceID: 'xero-3', total: 12.5 }] } });
    const rec = receiptClaim();
    expect(rec.claimKind).toBe('receipt');
    await submitInvoiceToXero(user.id, rec.id);
    expect(axios.put).toHaveBeenCalledTimes(1);
    const [url, body, opts] = axios.put.mock.calls[0];
    expect(url).toMatch(/\/Invoices\/xero-3\/Attachments\//);
    expect(Buffer.from(body).equals(JPEG)).toBe(true);
    expect(opts.headers['Content-Type']).toBe('image/jpeg');
    expect(store().getById(rec.id)).toMatchObject({ status: 'posted', errorMsg: null });
    // Owed to the payee, with the shop named in the line, as before.
    expect(resolveContact).toHaveBeenCalledWith(user.id, 'tenant-1', { vendorName: 'Jane Tan', invoiceType: 'EXPENSE' });
  });

  test('and a receipt that has gone still leaves the note a mileage claim never gets', async () => {
    mockApi.createInvoices.mockResolvedValue({ body: { invoices: [{ invoiceID: 'xero-4', total: 12.5 }] } });
    const rec = receiptClaim({ receiptFile: 'gone.jpg' });
    await submitInvoiceToXero(user.id, rec.id);
    expect(axios.put).not.toHaveBeenCalled();
    expect(store().getById(rec.id).errorMsg).toBe('Sent to Xero, but the attachment failed: the receipt file is no longer on the server.');
  });
});
