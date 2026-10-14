const request = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
const express = require('express');
const jwt     = require('jsonwebtoken');

// The Monthly view's export (kind=cashmonthly) on /api/xero-reports: the link
// carries the span and the fill, checked as the view's own request checks
// them, and the file is built from the payload the view renders. The forecast
// and the document module are mocked, so nothing here reaches Xero or builds a
// real file.
jest.mock('../utils/token-cache');
jest.mock('../xero/cash-monthly', () => ({
  ...jest.requireActual('../xero/cash-monthly'),
  getCashMonthly: jest.fn(),
}));
jest.mock('../reports/cash-monthly-doc', () => ({
  cashMonthlyDefinition: jest.fn(() => ({ content: ['monthly'] })),
  cashMonthlyWorkbook:   jest.fn(() => ({ xlsx: { write: jest.fn(async res => { res.write('xlsx-bytes'); }) } })),
  cashMonthlyFilename:   jest.fn((payload, format) => `Monthly cash flow - ${payload.organisation.name}.${format}`),
}));
jest.mock('../reports/budget-render', () => ({
  streamPdf: jest.fn((definition, res) => { res.end('pdf-bytes'); }),
  budgetVsActualWorkbook: jest.fn(), budgetVarianceWorkbook: jest.fn(),
}));

describe('the cashmonthly export', () => {
  let app, users, jwtSecret, testUser, tokenCache, monthly, doc, budgetRender;
  const PAYLOAD = { organisation: { name: 'Org One', currency: 'SGD' }, today: '2026-10-14', months: [], rows: [], notes: [] };

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    require('../db/migrate').run();
    users        = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    tokenCache   = require('../utils/token-cache');
    monthly      = require('../xero/cash-monthly');
    doc          = require('../reports/cash-monthly-doc');
    budgetRender = require('../reports/budget-render');
    testUser = await users.createUser(`cmm-${Date.now()}@test.com`, 'password123', 'user');
    tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1', tenantName: 'Org One' }, { tenantId: 't2', tenantName: 'Org Two' }]);
    app = express();
    app.use(express.json());
    app.use('/api/xero-reports', require('./xero-reports'));
  });

  const auth = req => req.set('Authorization', `Bearer ${jwt.sign({ id: testUser.id, email: testUser.email, role: testUser.role }, jwtSecret())}`);
  const exportUrl = qs => auth(request(serverFor(app)).get(`/api/xero-reports/budget/export-url?${qs}`));
  const tokenIn = url => jwt.verify(decodeURIComponent(url.split('token=')[1]), jwtSecret());

  test('the forecast is the mock: nothing here reaches Xero', () => {
    expect(jest.isMockFunction(monthly.getCashMonthly)).toBe(true);
  });

  test('the link carries the organisation, the format, the span and the fill, and is signed without reading the forecast', async () => {
    const res = await exportUrl('kind=cashmonthly&format=xlsx&past=3&future=9&fill=none&tenantId=t2').expect(200);
    expect(tokenIn(res.body.url)).toMatchObject({
      userId: testUser.id, tenantId: 't2', kind: 'cashmonthly', format: 'xlsx',
      monthly: { past: 3, future: 9, fill: 'none' }, purpose: 'budget-export',
    });
    expect(monthly.getCashMonthly).not.toHaveBeenCalled();
    // Nothing given is the view's default.
    expect(tokenIn((await exportUrl('kind=cashmonthly&format=pdf').expect(200)).body.url))
      .toMatchObject({ tenantId: 't1', monthly: { past: monthly.PAST_DEFAULT, future: monthly.FUTURE_DEFAULT, fill: 'budget' } });
  });

  test('a span or fill the view would refuse is refused here too', async () => {
    for (const qs of ['past=13', 'past=-1', 'future=0', 'future=13', 'past=abc', 'fill=guess']) {
      expect((await exportUrl(`kind=cashmonthly&format=pdf&${qs}`).expect(400)).body.error).toMatch(/must be/);
    }
  });

  test('a PDF reads the payload the view shows and streams the document module\'s definition', async () => {
    monthly.getCashMonthly.mockResolvedValue(PAYLOAD);
    const { url } = (await exportUrl('kind=cashmonthly&format=pdf&past=2&future=4').expect(200)).body;
    const res = await request(serverFor(app)).get(url).expect(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toContain('filename="Monthly cash flow - Org One.pdf"');
    expect(monthly.getCashMonthly).toHaveBeenCalledWith(testUser.id, 't1', { timezone: expect.any(String), past: 2, future: 4, fill: 'budget' });
    expect(doc.cashMonthlyDefinition).toHaveBeenCalledWith(PAYLOAD, { timezone: expect.any(String) });
    expect(budgetRender.streamPdf).toHaveBeenCalledWith({ content: ['monthly'] }, expect.anything());
  });

  test('an xlsx writes the document module\'s workbook', async () => {
    monthly.getCashMonthly.mockResolvedValue(PAYLOAD);
    const { url } = (await exportUrl('kind=cashmonthly&format=xlsx').expect(200)).body;
    const res = await request(serverFor(app)).get(url).expect(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    expect(res.headers['content-disposition']).toContain('filename="Monthly cash flow - Org One.xlsx"');
    expect(doc.cashMonthlyWorkbook).toHaveBeenCalledWith(PAYLOAD, { timezone: expect.any(String) });
  });
});
