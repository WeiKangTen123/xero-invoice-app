const request = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
const express = require('express');
const jwt     = require('jsonwebtoken');

jest.mock('../xero/reports');
jest.mock('../utils/token-cache');

describe('routes/xero-reports', () => {
  let app, users, jwtSecret, testUser, reports, tokenCache;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    reports    = require('../xero/reports');
    tokenCache = require('../utils/token-cache');
    const xeroReportsRoutes = require('./xero-reports');

    testUser = await users.createUser('user@test.com', 'password123', 'user');

    app = express();
    app.use(express.json());
    app.use('/api/xero-reports', xeroReportsRoutes);
  });

  function tokenFor(user) {
    return jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret());
  }

  test('requires authentication', async () => {
    await request(serverFor(app)).get('/api/xero-reports/summary').expect(401);
  });

  test('returns connected:false when the user has no persisted tenant, without calling reports.getSummary', async () => {
    tokenCache.getPersistedTenants.mockReturnValue([]);
    const res = await request(serverFor(app))
      .get('/api/xero-reports/summary')
      .set('Authorization', `Bearer ${tokenFor(testUser)}`)
      .expect(200);
    expect(res.body).toEqual({ connected: false, tenants: [] });
    expect(reports.getSummary).not.toHaveBeenCalled();
  });

  test('defaults to the first persisted tenant when none is requested', async () => {
    tokenCache.getPersistedTenants.mockReturnValue([
      { tenantId: 't1', tenantName: 'Org One' },
      { tenantId: 't2', tenantName: 'Org Two' },
    ]);
    reports.getSummary.mockResolvedValue({ connected: true, organisation: {}, kpis: {}, invoices: [] });

    const res = await request(serverFor(app))
      .get('/api/xero-reports/summary')
      .set('Authorization', `Bearer ${tokenFor(testUser)}`)
      .expect(200);

    expect(reports.getSummary).toHaveBeenCalledWith(testUser.id, 't1', { force: false });
    expect(res.body.activeTenantId).toBe('t1');
    expect(res.body.tenants).toHaveLength(2);
  });

  test('?tenantId picks a specific connected tenant', async () => {
    tokenCache.getPersistedTenants.mockReturnValue([
      { tenantId: 't1', tenantName: 'Org One' },
      { tenantId: 't2', tenantName: 'Org Two' },
    ]);
    reports.getSummary.mockResolvedValue({ connected: true, organisation: {}, kpis: {}, invoices: [] });

    await request(serverFor(app))
      .get('/api/xero-reports/summary?tenantId=t2')
      .set('Authorization', `Bearer ${tokenFor(testUser)}`)
      .expect(200);

    expect(reports.getSummary).toHaveBeenCalledWith(testUser.id, 't2', { force: false });
  });

  test('a ?tenantId the user does not actually have falls back to their first tenant, not an arbitrary org', async () => {
    tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1', tenantName: 'Org One' }]);
    reports.getSummary.mockResolvedValue({ connected: true, organisation: {}, kpis: {}, invoices: [] });

    await request(serverFor(app))
      .get('/api/xero-reports/summary?tenantId=someone-elses-tenant')
      .set('Authorization', `Bearer ${tokenFor(testUser)}`)
      .expect(200);

    expect(reports.getSummary).toHaveBeenCalledWith(testUser.id, 't1', { force: false });
  });

  test('?force=true is threaded through to reports.getSummary', async () => {
    tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
    reports.getSummary.mockResolvedValue({ connected: true, organisation: {}, kpis: {}, invoices: [] });

    await request(serverFor(app))
      .get('/api/xero-reports/summary?force=true')
      .set('Authorization', `Bearer ${tokenFor(testUser)}`)
      .expect(200);

    expect(reports.getSummary).toHaveBeenCalledWith(testUser.id, 't1', { force: true });
  });

  test('surfaces a Xero API failure as 500 with a readable message, not a crash', async () => {
    tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
    reports.getSummary.mockRejectedValue(new Error('Xero rate limit exceeded — try again in a minute'));

    const res = await request(serverFor(app))
      .get('/api/xero-reports/summary')
      .set('Authorization', `Bearer ${tokenFor(testUser)}`)
      .expect(500);
    expect(res.body.error).toMatch(/rate limit/i);
  });

  describe('GET /accounts, /bank-accounts', () => {
    test('both require authentication', async () => {
      await request(serverFor(app)).get('/api/xero-reports/accounts').expect(401);
      await request(serverFor(app)).get('/api/xero-reports/bank-accounts').expect(401);
    });

    test('both return connected:false with no tenant', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([]);
      for (const path of ['accounts', 'bank-accounts']) {
        const res = await request(serverFor(app))
          .get(`/api/xero-reports/${path}`)
          .set('Authorization', `Bearer ${tokenFor(testUser)}`)
          .expect(200);
        expect(res.body).toEqual({ connected: false, tenants: [] });
      }
    });

    test('GET /accounts calls reports.getAccounts for the resolved tenant', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
      reports.getAccounts.mockResolvedValue({ accounts: [{ code: '200', name: 'Sales' }] });

      const res = await request(serverFor(app))
        .get('/api/xero-reports/accounts')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(200);

      expect(reports.getAccounts).toHaveBeenCalledWith(testUser.id, 't1', { force: false });
      expect(res.body.accounts).toHaveLength(1);
    });

    test('GET /bank-accounts calls reports.getBankAccounts for the resolved tenant', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
      reports.getBankAccounts.mockResolvedValue({ bankAccounts: [] });

      await request(serverFor(app))
        .get('/api/xero-reports/bank-accounts?force=true')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(200);

      expect(reports.getBankAccounts).toHaveBeenCalledWith(testUser.id, 't1', { force: true });
    });

    test('a failure surfaces as 500, not a crash', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
      reports.getAccounts.mockRejectedValue(new Error('Xero rate limit exceeded — try again in a minute'));

      const res = await request(serverFor(app))
        .get('/api/xero-reports/accounts')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(500);
      expect(res.body.error).toMatch(/rate limit/i);
    });
  });

  describe('GET /bank-transactions', () => {
    test('all three require authentication', async () => {
      await request(serverFor(app)).get('/api/xero-reports/bank-transactions?accountId=a1').expect(401);
      await request(serverFor(app)).get('/api/xero-reports/bank-transactions?accountId=acc-1').expect(401);
      await request(serverFor(app)).get('/api/xero-reports/bank-transactions?accountId=acc-1').expect(401);
    });

    test('/bank-transactions requires accountId', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
      const res = await request(serverFor(app))
        .get('/api/xero-reports/bank-transactions')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(400);
      expect(res.body.error).toMatch(/accountId/i);
      expect(reports.getBankTransactions).not.toHaveBeenCalled();
    });

    test('/bank-transactions calls reports.getBankTransactions with the account and resolved tenant', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
      reports.getBankTransactions.mockResolvedValue({ transactions: [] });

      await request(serverFor(app))
        .get('/api/xero-reports/bank-transactions?accountId=acct-1')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(200);

      expect(reports.getBankTransactions).toHaveBeenCalledWith(testUser.id, 't1', 'acct-1', { force: false });
    });

    test('a Xero 403 (insufficient scope) surfaces as a clear reconnect prompt, not a generic error', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
      const scopeErr = new Error(JSON.stringify({ response: { statusCode: 403 }, body: { Detail: 'Forbidden resource' } }));
      reports.getBankTransactions.mockRejectedValue(scopeErr);

      const res = await request(serverFor(app))
        .get('/api/xero-reports/bank-transactions?accountId=acc-1')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(403);
      expect(res.body.error).toMatch(/reconnect/i);
    });

    // Xero's actual shape for a missing scope, confirmed live: a 401 with a
    // WWW-Authenticate: insufficient_scope header, not always a 403 — this
    // is the realistic case the 403 test above wouldn't have caught.
    test('a Xero 401 with WWW-Authenticate: insufficient_scope also surfaces as a clear reconnect prompt', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
      const scopeErr = new Error(JSON.stringify({ response: { statusCode: 401, headers: { 'www-authenticate': 'insufficient_scope' } }, body: {} }));
      reports.getBankTransactions.mockRejectedValue(scopeErr);

      const res = await request(serverFor(app))
        .get('/api/xero-reports/bank-transactions?accountId=acc-1')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(403);
      expect(res.body.error).toMatch(/reconnect/i);
    });

    test('a non-scope Xero failure still surfaces as 500', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
      reports.getBankTransactions.mockRejectedValue(new Error('Xero rate limit exceeded — try again in a minute'));

      const res = await request(serverFor(app))
        .get('/api/xero-reports/bank-transactions?accountId=acc-1')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(500);
      expect(res.body.error).toMatch(/rate limit/i);
    });
  });

  describe('one handler shape', () => {
    // /contacts went with the Dashboard's Contacts tab, its only caller.
    test('the report routes nothing calls are gone', async () => {
      for (const path of ['/api/xero-reports/period', '/api/xero-reports/profit-loss?from=2026-01-01&to=2026-01-31', '/api/xero-reports/bank-summary?from=2026-01-01&to=2026-01-31', '/api/xero-reports/contacts']) {
        const res = await request(serverFor(app)).get(path).set('Authorization', `Bearer ${tokenFor(testUser)}`);
        if (res.status !== 404) console.log('UNEXPECTED', path, res.status, res.text.slice(0, 300));
        expect({ status: res.status, body: res.body }).toMatchObject({ status: 404 });   // body shown on failure
      }
    });

    test('every report route answers the same envelope', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1', tenantName: 'Org' }]);
      reports.getAccounts.mockResolvedValue({ accounts: [] });
      reports.getBankAccounts.mockResolvedValue({ bankAccounts: [] });
      for (const path of ['/api/xero-reports/accounts', '/api/xero-reports/bank-accounts']) {
        const res = await request(serverFor(app)).get(path).set('Authorization', `Bearer ${tokenFor(testUser)}`).expect(200);
        expect(res.body).toMatchObject({ connected: true, activeTenantId: 't1' });
        expect(res.body.tenants).toHaveLength(1);
      }
    });
  });

  // The budget tabs had no period: the route passed none, so they were fixed
  // to the current financial year, and the exports with them.
  describe('budget period', () => {
    const auth = req => req.set('Authorization', `Bearer ${tokenFor(testUser)}`);
    beforeEach(() => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1', tenantName: 'Org' }]);
      reports.getBudgetVariance.mockResolvedValue({ months: [], rows: [] });
    });

    test('GET /budget-variance passes a preset or a from/to range through', async () => {
      await auth(request(serverFor(app)).get('/api/xero-reports/budget-variance?preset=prev-fy')).expect(200);
      expect(reports.getBudgetVariance).toHaveBeenLastCalledWith(testUser.id, 't1',
        expect.objectContaining({ period: { preset: 'prev-fy' } }));

      await auth(request(serverFor(app)).get('/api/xero-reports/budget-variance?from=2025-07&to=2026-12')).expect(200);
      expect(reports.getBudgetVariance).toHaveBeenLastCalledWith(testUser.id, 't1',
        expect.objectContaining({ period: { from: '2025-07', to: '2026-12' } }));
    });

    test('GET /budget-variance with no period asks for none, which is the whole financial year — not year to date', async () => {
      await auth(request(serverFor(app)).get('/api/xero-reports/budget-variance')).expect(200);
      const opts = reports.getBudgetVariance.mock.calls.at(-1)[2];
      expect(opts.period).toBeUndefined();
    });

    test('the export link carries the period, and the export reads that period', async () => {
      const res = await auth(request(serverFor(app))
        .get('/api/xero-reports/budget/export-url?kind=grid&format=pdf&from=2025-01&to=2025-12')).expect(200);
      const token = decodeURIComponent(res.body.url.split('token=')[1]);
      expect(jwt.verify(token, jwtSecret()).period).toEqual({ from: '2025-01', to: '2025-12' });

      // Rejected so no file is rendered; only which report was asked for matters here.
      reports.getBudgetVariance.mockRejectedValueOnce(new Error('stop'));
      await request(serverFor(app)).get(`/api/xero-reports/budget/export?token=${encodeURIComponent(token)}`).expect(500);
      expect(reports.getBudgetVariance).toHaveBeenLastCalledWith(testUser.id, 't1',
        expect.objectContaining({ period: { from: '2025-01', to: '2025-12' } }));
    });
  });

  // "Generated" was stamped in the server's timezone, UTC on the VM, beside
  // "as of" dates in the organisation's; and nothing in the file said when its
  // figures had been read from Xero, though an export re-reads them.
  describe('budget export times', () => {
    const FETCHED = Date.UTC(2026, 9, 6, 17, 25);
    const exportUrl = spec => {
      const token = jwt.sign({ userId: testUser.id, tenantId: 't1', purpose: 'budget-export', ...spec }, jwtSecret(), { expiresIn: '5m' });
      return `/api/xero-reports/budget/export?token=${encodeURIComponent(token)}`;
    };
    const binary = (res, cb) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    };
    beforeEach(() => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1', tenantName: 'Org' }]);
      reports.getBudgetVariance.mockResolvedValue({
        organisation: { name: 'Org', currency: 'SGD' }, months: [], rows: [], kpis: { monthsElapsed: 0 }, fetchedAt: FETCHED,
      });
    });

    test('the workbook is stamped in the user\'s own timezone, and says when its figures were read', async () => {
      users.saveUserConfig(testUser.id, { TIMEZONE: 'Asia/Tokyo' });
      const render = require('../reports/budget-render');
      const spy = jest.spyOn(render, 'budgetVarianceWorkbook');

      const res = await request(serverFor(app)).get(exportUrl({ kind: 'variance', format: 'xlsx', month: 'ytd' }))
        .buffer(true).parse(binary).expect(200);

      expect(spy.mock.calls[0][1]).toEqual(expect.objectContaining({ timezone: 'Asia/Tokyo' }));
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.body);
      const ws = wb.getWorksheet('Budget Variance');
      expect(String(ws.getCell(2, 1).value)).toMatch(/· Generated \d{1,2} \w{3} \d{4}, \d{2}:\d{2} GMT\+9$/);
      expect(ws.getCell(3, 1).value).toBe('Figures read from Xero at 7 Oct 2026, 02:25 GMT+9');
    });

    test('a user who never chose a timezone gets the default one, in the PDF too', async () => {
      const budgetDoc = require('../reports/budget-doc');
      const spy = jest.spyOn(budgetDoc, 'budgetVsActualDoc');

      const res = await request(serverFor(app)).get(exportUrl({ kind: 'grid', format: 'pdf' }))
        .buffer(true).parse(binary).expect(200);

      expect(res.headers['content-type']).toBe('application/pdf');
      expect(spy.mock.calls[0][1]).toEqual(expect.objectContaining({ timezone: 'Asia/Singapore' }));
      const header = spy.mock.results[0].value.header.columns[1].stack.map(s => s.text);
      expect(header).toContain('Figures read from Xero at 7 Oct 2026, 01:25 GMT+8');
      expect(header.find(t => t.startsWith('Generated '))).toMatch(/GMT\+8$/);
    });
  });

  // Every 12 months of a period is a pair of Xero calls, and nothing bounded
  // the span: from=1900-01&to=2100-12 cost about 400 calls against a budget of
  // 60 a minute shared with invoice posting. Every route that takes a period
  // now refuses one it should not fetch, before any report runs.
  describe('period validation', () => {
    const auth = req => req.set('Authorization', `Bearer ${tokenFor(testUser)}`);
    const ROUTES = {
      '/budget-variance':   () => reports.getBudgetVariance,
      '/performance':       () => reports.getPerformance,
      '/cash-flow':         () => reports.getCashFlow,
      '/variance-insights': () => reports.getVarianceInsights,
      '/narrative':         () => reports.getFinancialNarrative,
      '/budget/export-url': null,
    };
    const INVALID = {
      'far too long, the reported case':      'from=1900-01&to=2100-12',
      'too long, inside the year bounds':     'from=2000-01&to=2026-12',
      'a year before 1990':                   'from=1989-12&to=1990-06',
      'a year after 2100':                    'from=2100-12&to=2101-01',
      'a month that does not exist':          'from=2026-13&to=2026-12',
      'month zero':                           'from=2026-00&to=2026-12',
      'a one-digit month':                    'from=2026-1&to=2026-12',
      'a full date':                          'from=2026-01-01&to=2026-12-31',
      'not a date at all':                    'from=abc&to=2026-12',
      'half a range':                         'from=2026-01',
      'the other half':                       'to=2026-12',
      'a repeated parameter':                 'from=2026-01&from=2026-02&to=2026-03',
      'an unknown preset':                    'preset=garbage',
      'custom, which is not a preset':        'preset=custom',
      'an unknown legacy window':             'window=nope',
      'a legacy window with no such month':   'preset=2026-13',
      'a legacy window out of the years':     'preset=1900-12',
    };

    beforeEach(() => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1', tenantName: 'Org' }]);
      for (const fn of ['getBudgetVariance', 'getPerformance', 'getCashFlow', 'getVarianceInsights', 'getFinancialNarrative']) {
        reports[fn].mockResolvedValue({ months: [], rows: [] });
      }
    });

    const urlFor = (route, qs) => `/api/xero-reports${route}?${route === '/budget/export-url' ? 'kind=grid&format=pdf&' : ''}${qs}`;

    for (const [route, fetcher] of Object.entries(ROUTES)) {
      test(`${route} answers 400 for every kind of invalid period, without running the report`, async () => {
        for (const [why, qs] of Object.entries(INVALID)) {
          const res = await auth(request(serverFor(app)).get(urlFor(route, qs)));
          expect({ why, status: res.status }).toEqual({ why, status: 400 });
          expect(typeof res.body.error).toBe('string');
        }
        if (fetcher) expect(fetcher()).not.toHaveBeenCalled();
      });
    }

    test('132 months is accepted and 133 refused, in either direction', async () => {
      for (const route of ['/budget-variance', '/performance', '/cash-flow', '/budget/export-url']) {
        await auth(request(serverFor(app)).get(urlFor(route, 'from=2016-01&to=2026-12'))).expect(200);   // 132
        await auth(request(serverFor(app)).get(urlFor(route, 'from=2026-12&to=2016-01'))).expect(200);   // 132, reversed
        const long = await auth(request(serverFor(app)).get(urlFor(route, 'from=2015-12&to=2026-12'))).expect(400);   // 133
        expect(long.body.error).toMatch(/Period too long — at most 132 months/);
        await auth(request(serverFor(app)).get(urlFor(route, 'from=2026-12&to=2015-12'))).expect(400);
      }
      expect(reports.getBudgetVariance).toHaveBeenLastCalledWith(testUser.id, 't1',
        expect.objectContaining({ period: { from: '2026-12', to: '2016-01' } }));   // swapped later, as before
    });

    test('every known preset and the legacy YYYY-MM window are still accepted', async () => {
      const { PERIOD_PRESETS } = require('../xero/periods');
      for (const p of [...PERIOD_PRESETS, '2025-12']) {
        await auth(request(serverFor(app)).get(`/api/xero-reports/performance?preset=${p}`)).expect(200);
        expect(reports.getPerformance).toHaveBeenLastCalledWith(testUser.id, 't1', expect.objectContaining({ period: { preset: p } }));
        await auth(request(serverFor(app)).get(`/api/xero-reports/budget-variance?window=${p}`)).expect(200);
        expect(reports.getBudgetVariance).toHaveBeenLastCalledWith(testUser.id, 't1', expect.objectContaining({ period: { preset: p } }));
      }
    });

    test('no period at all is still financial year to date for the dashboards and the whole year for the budget', async () => {
      await auth(request(serverFor(app)).get('/api/xero-reports/performance')).expect(200);
      expect(reports.getPerformance.mock.calls.at(-1)[2].period).toEqual({ preset: 'fy-ytd' });
      await auth(request(serverFor(app)).get('/api/xero-reports/budget-variance?from=&to=')).expect(200);
      expect(reports.getBudgetVariance.mock.calls.at(-1)[2].period).toBeUndefined();
    });

    test('a refused period never reaches a signed export link', async () => {
      const res = await auth(request(serverFor(app)).get(urlFor('/budget/export-url', 'from=1900-01&to=2100-12'))).expect(400);
      expect(res.body.url).toBeUndefined();
    });

    test('a period the report layer refuses is a 400 too, not a 500', async () => {
      // The check inside periods.js#_resolvePeriod, for anything that reaches a
      // report without passing through the route check first.
      const { PeriodError } = require('../xero/periods');
      reports.getBudgetVariance.mockRejectedValueOnce(new PeriodError('Period too long — at most 132 months (this one is 400)'));
      const res = await auth(request(serverFor(app)).get('/api/xero-reports/budget-variance?preset=fy')).expect(400);
      expect(res.body.error).toMatch(/at most 132 months/);

      const token = jwt.sign({ userId: testUser.id, tenantId: 't1', kind: 'grid', format: 'pdf',
        period: { from: '1900-01', to: '2100-12' }, purpose: 'budget-export' }, jwtSecret(), { expiresIn: '5m' });
      reports.getBudgetVariance.mockRejectedValueOnce(new PeriodError('Period too long'));
      await request(serverFor(app)).get(`/api/xero-reports/budget/export?token=${encodeURIComponent(token)}`).expect(400);
    });
  });
});
