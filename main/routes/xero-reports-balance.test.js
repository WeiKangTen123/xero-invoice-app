const request = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
const express = require('express');
const jwt     = require('jsonwebtoken');

// GET /balance-sheet, GET /balance-check and the 'balance' export: the routes
// in front of xero/balance-sheet.js and xero/balance-check.js. The report
// layer and the document module are mocked, so these are about the routes
// alone — who may ask, which query is refused before any Xero call, what is
// passed on, the envelope, and what the export link carries.
jest.mock('../xero/reports');
jest.mock('../utils/token-cache');
// The Balance Sheet's document module belongs to the export work and may not
// be present; the route requires it lazily, and here it is whatever this says.
jest.mock('../reports/balance-doc', () => ({
  balanceSheetDefinition: jest.fn(() => ({ content: ['balance sheet'] })),
  balanceSheetWorkbook:   jest.fn(() => ({ xlsx: { write: jest.fn(async res => { res.write('xlsx-bytes'); }) } })),
  balanceFilename:        jest.fn((payload, format) => `Balance Sheet - ${payload.organisation.name} - ${payload.asAt.iso}.${format}`),
}), { virtual: true });
jest.mock('../reports/budget-render', () => ({
  streamPdf: jest.fn((definition, res) => { res.end('pdf-bytes'); }),
  budgetVsActualWorkbook: jest.fn(), budgetVarianceWorkbook: jest.fn(),
}));

describe('routes/xero-reports — the Balance Sheet', () => {
  let app, users, jwtSecret, testUser, reports, tokenCache, balanceDoc, budgetRender;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    reports      = require('../xero/reports');
    tokenCache   = require('../utils/token-cache');
    balanceDoc   = require('../reports/balance-doc');
    budgetRender = require('../reports/budget-render');
    const xeroReportsRoutes = require('./xero-reports');

    testUser = await users.createUser('user@test.com', 'password123', 'user');

    app = express();
    app.use(express.json());
    app.use('/api/xero-reports', xeroReportsRoutes);
  });

  const tokenFor = user => jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret());
  const auth = req => req.set('Authorization', `Bearer ${tokenFor(testUser)}`);
  const get  = (route, qs) => auth(request(serverFor(app)).get(`/api/xero-reports/${route}${qs ? `?${qs}` : ''}`));

  const SHEET = {
    organisation: { name: 'Flovon Pte Ltd', currency: 'SGD' },
    asAt: { iso: '2026-09-30', label: '30 September 2026', preset: 'last-month-end', inProgress: false },
    basis: 'accrual', compare: { type: 'none', periods: 0 },
    columns: [{ iso: '2026-09-30', label: '30 Sep 2026' }],
    groups: [{ key: 'assets', title: 'Assets', subgroups: [{ title: 'Bank', rows: [{ label: 'DBS', accountId: 'a1', code: '090', values: [52000] }], total: { label: 'Total Bank', values: [52000] } }], total: { label: 'Total Assets', values: [52000] } }],
    netAssets: { label: 'Net Assets', values: [52000] }, notes: [], cached: false, fetchedAt: 1,
  };
  const VERDICT = { ok: true, checkedAt: '2026-10-11T02:00:00.000Z', calls: 1, checks: [{ key: 'identity' }, { key: 'subtotals' }, { key: 'bank' }], notes: [], period: { asAtLabel: '30 September 2026', current: null } };

  const INVALID = {
    'an unknown preset':            'preset=last-year',
    'month without a month':        'preset=month',
    'a month that does not exist':  'preset=month&month=2026-13',
    'a full date':                  'preset=month&month=2026-09-30',
    'a year out of bounds':         'preset=month&month=1900-01',
    'an unknown comparison':        'compare=prior-year',
    'zero periods':                 'compare=month&periods=0',
    'twelve periods':               'compare=month&periods=12',
    'periods that is not a number': 'compare=quarter&periods=two',
    'an unknown basis':             'basis=modified',
    'a repeated parameter':         'preset=this-month&preset=last-month-end',
  };

  for (const route of ['balance-sheet', 'balance-check']) {
    describe(`GET /${route}`, () => {
      const fetcher = () => (route === 'balance-sheet' ? reports.getBalanceSheet : reports.getBalanceCheck);
      const answer  = route === 'balance-sheet' ? SHEET : VERDICT;

      test('requires authentication', async () => {
        await request(serverFor(app)).get(`/api/xero-reports/${route}`).expect(401);
      });

      test('answers connected:false without a tenant, and asks for nothing', async () => {
        tokenCache.getPersistedTenants.mockReturnValue([]);
        const res = await get(route).expect(200);
        expect(res.body).toEqual({ connected: false, tenants: [] });
        expect(fetcher()).not.toHaveBeenCalled();
      });

      describe('with a connected organisation', () => {
        beforeEach(() => {
          tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1', tenantName: 'Org One' }, { tenantId: 't2', tenantName: 'Org Two' }]);
          fetcher().mockResolvedValue(answer);
        });

        test('asking for nothing is last month end, no comparison, accrual, not forced', async () => {
          await get(route).expect(200);
          expect(fetcher()).toHaveBeenCalledWith(testUser.id, 't1', {
            timezone: expect.any(String), force: false, preset: 'last-month-end', month: undefined, compare: 'none', periods: undefined, basis: 'accrual',
          });
        });

        test('passes the whole query, the organisation and force through', async () => {
          await get(route, 'preset=month&month=2026-08&compare=quarter&periods=3&basis=cash&tenantId=t2&force=true').expect(200);
          expect(fetcher()).toHaveBeenCalledWith(testUser.id, 't2', {
            timezone: expect.any(String), force: true, preset: 'month', month: '2026-08', compare: 'quarter', periods: 3, basis: 'cash',
          });
        });

        test('answers the payload in the report envelope', async () => {
          const res = await get(route, 'preset=last-fy-end').expect(200);
          expect(res.body).toMatchObject({ connected: true, activeTenantId: 't1', ...answer });
          expect(res.body.tenants).toHaveLength(2);
        });

        test('a query the report cannot be asked for is a 400 before it runs', async () => {
          for (const [why, qs] of Object.entries(INVALID)) {
            const res = await get(route, qs);
            expect({ why, status: res.status }).toEqual({ why, status: 400 });
            expect(typeof res.body.error).toBe('string');
          }
          expect(fetcher()).not.toHaveBeenCalled();
        });

        test('a month after this one, refused by the report itself, is a 400 too', async () => {
          const { PeriodError } = require('../xero/periods');
          fetcher().mockRejectedValue(new PeriodError('November 2026 has not started yet'));
          const res = await get(route, 'preset=month&month=2026-11').expect(400);
          expect(res.body.error).toMatch(/has not started/);
        });

        test('a Xero failure is an error, and a missing scope the reconnect prompt', async () => {
          fetcher().mockRejectedValue(new Error('Xero rate limit exceeded — try again in a minute'));
          expect((await get(route).expect(500)).body.error).toMatch(/rate limit/);
          fetcher().mockRejectedValue(new Error(JSON.stringify({ response: { statusCode: 403 }, body: { Detail: 'Forbidden resource' } })));
          expect((await get(route).expect(403)).body.error).toMatch(/reconnect in Setup/);
        });
      });
    });
  }

  describe('the balance export', () => {
    beforeEach(() => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1', tenantName: 'Org One' }]);
      reports.getBalanceSheet.mockResolvedValue(SHEET);
    });
    const exportUrl = qs => get('budget/export-url', qs);
    const tokenOf   = res => jwt.verify(decodeURIComponent(res.body.url.split('token=')[1]), jwtSecret());

    test('the link carries the sheet asked for, after the report confirmed it can be served', async () => {
      const res = await exportUrl('kind=balance&format=xlsx&preset=month&month=2026-08&compare=month&periods=2&basis=cash').expect(200);
      expect(tokenOf(res)).toMatchObject({
        userId: testUser.id, tenantId: 't1', kind: 'balance', format: 'xlsx', purpose: 'budget-export',
        balance: { preset: 'month', month: '2026-08', compare: 'month', periods: 2, basis: 'cash' },
      });
      expect(tokenOf(res).period).toBeUndefined();
      expect(reports.getBalanceSheet).toHaveBeenCalledWith(testUser.id, 't1',
        { timezone: expect.any(String), preset: 'month', month: '2026-08', compare: 'month', periods: 2, basis: 'cash' });
      expect(res.body.url).toMatch(/^\/api\/xero-reports\/budget\/export\?token=/);
    });

    test('defaults travel too, and the budget period gate is not applied to a balance link', async () => {
      const res = await exportUrl('kind=balance').expect(200);
      expect(tokenOf(res)).toMatchObject({ kind: 'balance', format: 'pdf', balance: { preset: 'last-month-end', compare: 'none', basis: 'accrual' } });
    });

    test('no link is signed for a query the sheet route would refuse, nor for a month the report refuses', async () => {
      for (const [why, qs] of Object.entries(INVALID)) {
        const res = await exportUrl(`kind=balance&format=pdf&${qs}`);
        expect({ why, status: res.status }).toEqual({ why, status: 400 });
        expect(res.body.url).toBeUndefined();
      }
      expect(reports.getBalanceSheet).not.toHaveBeenCalled();

      const { PeriodError } = require('../xero/periods');
      reports.getBalanceSheet.mockRejectedValue(new PeriodError('November 2026 has not started yet'));
      const res = await exportUrl('kind=balance&preset=month&month=2026-11').expect(400);
      expect(res.body.error).toMatch(/has not started/);
    });

    test('an unknown kind is still refused', async () => {
      const res = await exportUrl('kind=ledger&format=pdf').expect(400);
      expect(res.body.error).toMatch(/grid, variance or balance/);
    });

    const signed = spec => jwt.sign({ userId: testUser.id, tenantId: 't1', purpose: 'budget-export', kind: 'balance', ...spec }, jwtSecret(), { expiresIn: '5m' });
    const download = spec => request(serverFor(app)).get(`/api/xero-reports/budget/export?token=${encodeURIComponent(signed(spec))}`);
    const BALANCE = { preset: 'last-month-end', compare: 'none', basis: 'accrual' };

    test('a PDF export reads the sheet the link names and streams the document module\'s definition', async () => {
      const res = await download({ format: 'pdf', balance: BALANCE }).expect(200);
      expect(reports.getBalanceSheet).toHaveBeenCalledWith(testUser.id, 't1', { timezone: expect.any(String), ...BALANCE });
      expect(balanceDoc.balanceSheetDefinition).toHaveBeenCalledWith(SHEET, { timezone: expect.any(String) });
      expect(balanceDoc.balanceFilename).toHaveBeenCalledWith(SHEET, 'pdf');
      expect(budgetRender.streamPdf).toHaveBeenCalledWith({ content: ['balance sheet'] }, expect.anything());
      expect(res.headers['content-type']).toMatch(/application\/pdf/);
      // The module's name is used once, with one extension.
      expect(res.headers['content-disposition']).toContain('filename="Balance Sheet - Flovon Pte Ltd - 2026-09-30.pdf"');
      expect(res.headers['content-disposition']).not.toContain('.pdf.pdf');
    });

    test('an xlsx export writes the document module\'s workbook', async () => {
      const res = await download({ format: 'xlsx', balance: BALANCE }).expect(200);
      expect(balanceDoc.balanceSheetWorkbook).toHaveBeenCalledWith(SHEET, { timezone: expect.any(String) });
      expect(balanceDoc.balanceSheetDefinition).not.toHaveBeenCalled();
      expect(res.headers['content-type']).toMatch(/spreadsheetml/);
      expect(res.headers['content-disposition']).toContain('filename="Balance Sheet - Flovon Pte Ltd - 2026-09-30.xlsx"');
      expect(res.text).toBe('xlsx-bytes');
    });

    test('a link whose sheet the report now refuses is a stale link, not a server fault', async () => {
      const { PeriodError } = require('../xero/periods');
      reports.getBalanceSheet.mockRejectedValue(new PeriodError('November 2026 has not started yet'));
      const res = await download({ format: 'pdf', balance: { preset: 'month', month: '2026-11', compare: 'none', basis: 'accrual' } }).expect(400);
      expect(res.text).toMatch(/cannot be exported.*has not started/);
    });

    test('a document module failure is a 500 for that export, and the budget exports are untouched', async () => {
      balanceDoc.balanceSheetDefinition.mockImplementation(() => { throw new Error('no layout'); });
      const res = await download({ format: 'pdf', balance: BALANCE }).expect(500);
      expect(res.text).toMatch(/Could not build the export/);
      expect(reports.getBudgetVariance).not.toHaveBeenCalled();
    });
  });
});
