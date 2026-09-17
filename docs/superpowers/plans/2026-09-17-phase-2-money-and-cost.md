# Phase 2 — Money and cost — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop paying Xero for the same report several times over, make the KPIs right past 100 invoices, convert foreign-currency figures the way Xero defines the rate, and make token refresh and tenant bookkeeping safe — one test-first commit per task.

**Architecture:** The report layer (`main/xero/reports.js`) keeps its shape. Two small mechanisms are added at the cache: a short grace window so a "force" arriving seconds after a fresh fetch reuses it (which stops the force cascade), and an in-flight map so identical concurrent calls share one execution (which stops the Insights page's triple fetch from becoming three Xero fetch chains). Invoice fetches page until a short page. Currency conversion follows Xero's documented convention (CurrencyRate = document units per 1 base unit → divide). Token refresh is deduped per user and written to every tenant; persisted tenants are pruned against Xero's connection list.

**Tech Stack:** Node 22, xero-node 7, jest. Contract tests in `main/xero/reports-contract.test.js` mock `xero-node` and assert the calls made. Full suite `npm test`.

**Findings:** `scratchpad/system-audit-2026-09-16.md` §1.4, 1.5, 1.6.

**Unverifiable today:** the org has no foreign-currency document, so the rate direction (Task 4) cannot be checked live; it follows Xero's documentation and the first foreign document should be compared against Xero's own base-currency figure.

---

### Task 1: Force grace and in-flight dedupe in the report cache (audit 1.4)

**Files:**
- Modify: `main/xero/reports.js` (cache helpers; wrap the fetchers)
- Test: `main/xero/reports-contract.test.js`

- [x] **Step 1: Failing tests** (append a describe to the contract test file)

```js
describe('Xero call budget — identical work is fetched once', () => {
  test('three concurrent summary requests make one invoice fetch', async () => {
    await Promise.all([reports.getSummary(U, T), reports.getSummary(U, T), reports.getSummary(U, T)]);
    expect(api.getInvoices).toHaveBeenCalledTimes(1);
  });

  test('three concurrent budget-variance requests fetch the budget report once', async () => {
    const opts = { period: { preset: 'fy' } };
    await Promise.all([reports.getBudgetVariance(U, T, opts), reports.getBudgetVariance(U, T, opts), reports.getBudgetVariance(U, T, opts)]);
    expect(api.getReportBudgetSummary).toHaveBeenCalledTimes(1);
  });

  test('a forced request seconds after a fresh fetch reuses it; one older than the grace refetches', async () => {
    await reports.getSummary(U, T, { force: true });
    await reports.getSummary(U, T, { force: true });          // within the grace window
    expect(api.getInvoices).toHaveBeenCalledTimes(1);
    reports._cache.get(`summary:${U}:${T}`).fetchedAt -= reports.FORCE_GRACE_MS + 1;
    await reports.getSummary(U, T, { force: true });
    expect(api.getInvoices).toHaveBeenCalledTimes(2);
  });

  test('a forced insights request fetches Budget-vs-Actual once, not once per dependent report', async () => {
    api.getInvoices.mockResolvedValue({ body: { invoices: [] } });
    await reports.getVarianceInsights(U, T, { period: { preset: 'fy' }, force: true });
    expect(api.getReportBudgetSummary).toHaveBeenCalledTimes(1);
  });
});
```

- [x] **Step 2: Run** `npx jest main/xero/reports-contract.test.js -t "call budget"` → FAIL (3 fetches; BudgetSummary fetched more than once).

- [x] **Step 3: Implement** — in `reports.js`, after `_cacheSet`:

```js
// A "force" is a person clicking Refresh. Several reports built on the same
// base fetch (performance → cash flow → performance again) each forwarded it,
// so one click refetched Budget-vs-Actual up to five times. A forced request
// that arrives within this window of a fresh fetch reuses it.
const FORCE_GRACE_MS = 10_000;

// Identical work in flight is shared, not repeated. The Insights page fires
// /performance, /variance-insights and /narrative together on first load;
// without this each miss became its own chain of Xero GETs.
const _inflight = new Map();
function _dedupe(name, fn) {
  return function deduped(...args) {
    const key = `${name}:${JSON.stringify(args)}`;
    let p = _inflight.get(key);
    if (!p) {
      p = Promise.resolve().then(() => fn.apply(this, args)).finally(() => _inflight.delete(key));
      _inflight.set(key, p);
    }
    return p;
  };
}
```

In `_cacheGet` replace `if (force) return null;` with `if (force && Date.now() - cached.fetchedAt > FORCE_GRACE_MS) return null;`.

Wrap each cached fetcher at its definition (rename the declaration, bind the name to the wrapper so internal callers go through it):

```js
async function _getSummaryRaw(userId, tenantId, { force = false } = {}) { …unchanged body… }
const getSummary = _dedupe('summary', _getSummaryRaw);
```
Apply to: `getSummary`, `_getOrganisation`, `getPeriod`, `getAccounts`, `getBankAccounts`, `getContacts`, `getBankTransactions`, `getProfitAndLoss`, `getBankSummary`, `getBudgetVariance`, `getPerformance`, `getVarianceInsights`, `getCashFlow`, `getFinancialNarrative`. Export `FORCE_GRACE_MS` and keep `_cache` exported.

- [x] **Step 4: Run** `npx jest main/xero` → PASS. Commit: `perf(reports): identical work is fetched once; a Refresh no longer cascades into five fetches`.

---

### Task 2: Invoice fetches page until a short page (audit 1.4)

**Files:** `main/xero/reports.js` (four `api.getInvoices` sites), test `main/xero/reports-contract.test.js`

- [x] **Step 1: Failing test**

```js
  test('invoice fetches page until a short page, so KPIs are not silently capped at 100', async () => {
    const inv = i => ({ type: 'ACCREC', status: 'AUTHORISED', amountDue: 1, total: 1, invoiceNumber: `I-${i}`, dueDate: '2099-01-01' });
    api.getInvoices
      .mockResolvedValueOnce({ body: { invoices: Array.from({ length: 100 }, (_, i) => inv(i)) } })
      .mockResolvedValueOnce({ body: { invoices: Array.from({ length: 30 }, (_, i) => inv(100 + i)) } });
    const s = await reports.getSummary(U, `${T}-paged`, { force: true });
    expect(api.getInvoices).toHaveBeenCalledTimes(2);
    expect(api.getInvoices.mock.calls[0][8]).toBe(1);
    expect(api.getInvoices.mock.calls[1][8]).toBe(2);
    expect(s.kpis.receivablesCount).toBe(130);
  });
```
- [x] **Step 2:** FAIL (one call, count 100).
- [x] **Step 3:** helper in reports.js:

```js
// Xero returns at most 100 invoices per page and `page=1` was never followed
// up, so every KPI built on invoices was computed on the 100 most recent.
// Pages until a short page; the cap is a safety net that logs when hit.
const INVOICE_PAGE_SIZE = 100;
const INVOICE_MAX_PAGES = 20;
async function _allInvoices(api, tenantId, { where, order, statuses }) {
  const out = [];
  for (let page = 1; page <= INVOICE_MAX_PAGES; page++) {
    const res = await withRetry(() => api.getInvoices(
      tenantId, undefined, where, order, undefined, undefined, undefined,
      statuses, page, undefined, undefined, undefined, true,   // summaryOnly
    ));
    const batch = res.body.invoices || [];
    out.push(...batch);
    if (batch.length < INVOICE_PAGE_SIZE) return out;
  }
  logger.warn('Invoice fetch hit the page cap; figures may be incomplete', { tenantId, pages: INVOICE_MAX_PAGES });
  return out;
}
```
Replace the four call sites (`:202`, `:288`, `:1254`, `:1447`) with `_allInvoices(api, tenantId, { where, order, statuses: ['AUTHORISED', 'PAID'] })` keeping each site's `where`/`order`. In `getSummary` the `Promise.all` becomes `[orgRes, invoices] = await Promise.all([withRetry(() => api.getOrganisations(tenantId)), _allInvoices(...)])`.
- [x] **Step 4:** `npx jest main/xero` → PASS (existing contract tests read `mock.calls[0]` positions; unchanged). Commit: `fix(reports): invoice fetches page past 100 — receivables, overdue and DSO were computed on the newest 100 only`.

---

### Task 3: Long TTLs for directory data; bounded statement fetch (audit 1.4)

**Files:** `main/xero/reports.js`, test `main/xero/reports-contract.test.js`

- [x] **Step 1: Failing tests**

```js
  test('chart of accounts, bank accounts, contacts and organisation live in cache for hours, not minutes', async () => {
    api.getAccounts = jest.fn().mockResolvedValue({ body: { accounts: [] } });
    api.getContacts = jest.fn().mockResolvedValue({ body: { contacts: [] } });
    await reports.getAccounts(U, T, { force: true });
    await reports.getBankAccounts(U, T, { force: true });
    await reports.getContacts(U, T, { force: true });
    for (const k of [`accounts:${U}:${T}`, `bank:${U}:${T}`, `contacts:${U}:${T}`]) {
      expect(reports._cache.get(k).ttl).toBe(reports.DIRECTORY_TTL_MS);
    }
    expect(reports.DIRECTORY_TTL_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });

  test('a bank statement asks for the last twelve months, not the account\'s whole history', async () => {
    await reports.getBankTransactions(U, T, 'acc-1', { force: true });
    expect(api.getBankTransactions.mock.calls[0][2]).toMatch(/Date >= DateTime\(\d{4},\d{1,2},\d{1,2}\)/);
    expect(api.getPayments.mock.calls[0][2]).toMatch(/Date >= DateTime\(/);
  });
```
(Check the actual cache key prefixes used by `getBankAccounts`/`getContacts` in the file and adjust the keys in the test.)
- [x] **Step 2:** FAIL.
- [x] **Step 3:** `const DIRECTORY_TTL_MS = 6 * 60 * 60 * 1000;` pass as third arg in `_cacheSet` for accounts, bank accounts, contacts, and `_getOrganisation`; in `getBankTransactions` compute `const since = _fmtXeroDate(_addDays(new Date(), -365))` (use the file's existing date helpers) and append `&& Date >= ${since}` to both `where` clauses. Export `DIRECTORY_TTL_MS`.
- [x] **Step 4:** `npx jest main/xero` → PASS. Commit: `perf(reports): directory data cached for hours; statements bounded to a year`.

---

### Task 4: Currency — divide by Xero's rate; convert summary KPIs; refuse to relabel (audit 1.5)

**Files:** `main/xero/currency.js`, `main/xero/reports.js` (`_buildSummary`), `main/xero/invoices.js` (`_submitWithCurrencyRetry`), tests `main/xero/reports.test.js`, `main/xero/invoices.test.js`

- [x] **Step 1: Failing tests** — in reports.test.js replace the four `_toBase` expectations at lines ~1846-1856 and the fixtures at ~1888, ~1901, ~2538 with Xero's convention (a USD invoice in an SGD org carries a rate near 0.74, meaning 1 SGD = 0.74 USD):

```js
    expect(_toBase({ currencyCode: 'USD', currencyRate: 0.74 }, 100, 'SGD')).toBeCloseTo(135.14, 1);
    expect(_toBase({ currencyRate: 0.74 }, 100, 'SGD')).toBeCloseTo(135.14, 1);
```
and the customer-revenue / working-capital / supplier fixtures: `currencyRate: 1.35` → `currencyRate: 0.74` with expected base values ≈ amount / 0.74 (recompute each expected number: 1000 / 0.74 = 1351.35).

New `_buildSummary` test:
```js
  test('KPIs are in the base currency; a USD invoice is converted, and the note says so', () => {
    const future = new Date(Date.now() + 30 * 86400000).toISOString();
    const { kpis, currency } = _buildSummary(ORG, [
      { type: 'ACCREC', status: 'AUTHORISED', amountDue: 74, total: 74, currencyCode: 'USD', currencyRate: 0.74, dueDate: future },
      { type: 'ACCREC', status: 'AUTHORISED', amountDue: 100, total: 100, currencyCode: 'SGD', dueDate: future },
    ]);
    expect(kpis.totalReceivables).toBeCloseTo(200, 2);
    expect(currency).toMatchObject({ mixed: true, currencies: ['USD'], baseCurrency: 'SGD' });
  });
```
invoices.test.js:
```js
describe('_submitWithCurrencyRetry', () => {
  test('an unsubscribed currency is refused with a clear message, never relabelled as base', async () => {
    const { _submitWithCurrencyRetry } = require('./invoices');
    const submitFn = jest.fn().mockRejectedValue(Object.assign(new Error('x'), { response: { body: { Elements: [{ ValidationErrors: [{ Message: 'Organisation is not subscribed to currency USD' }] }] } } }));
    const api = { getOrganisations: jest.fn().mockResolvedValue({ body: { organisations: [{ baseCurrency: 'SGD' }] } }) };
    await expect(_submitWithCurrencyRetry(submitFn, api, 't-x', { invoices: [{ currencyCode: 'USD' }] }, 'USD', 'u1', {}))
      .rejects.toThrow(/not subscribed to USD/);
    expect(submitFn).toHaveBeenCalledTimes(1);
  });
});
```
(Read `xeroErrMsg` and `getOrgBaseCurrency` in invoices.js to build a rejection the message matcher recognises; export `_submitWithCurrencyRetry`.)
- [x] **Step 2:** FAIL.
- [x] **Step 3:** currency.js: `if (rate > 0 && rate !== 1) return v / rate;` with the convention in the comment (Xero: "CurrencyRate … e.g. 0.7500" — document units per one base unit). `_buildSummary`: accumulate `totalReceivables += _toBase(inv, inv.amountDue, base)` etc. (import `_toBase, _foreignCurrency` from './currency' if not already), add `currency: _foreignCurrency(invoices, base)` to the result. invoices.js: replace the relabel branch with `throw new Error(\`Xero org is not subscribed to ${currencyCode} — add the currency in Xero or change the invoice currency\`)`.
- [x] **Step 4:** `npx jest main/xero` → PASS. Commit: `fix(currency): convert with Xero's rate the way Xero defines it; summary KPIs in base; never relabel an unsubscribed currency`.

---

### Task 5: Token refresh deduped and written to every tenant; persisted tenants pruned (audit 1.6)

**Files:** `main/utils/token-cache.js`, `main/xero/oauth.js` (`_listAndCacheTenants`), `main/xero/connect.js` (`autoConnect`), tests `main/utils/token-cache.test.js`

- [x] **Step 1: Failing tests**

```js
  test('concurrent calls on an expired token share ONE refresh (rotation would break the second)', async () => {
    const cache = tokenCache.forUser('user-r');
    cache.cacheToken('t1', 'Org', 'stale', new Date(Date.now() - 1000), 'oauth');
    refreshAuthCodeToken.mockImplementation(() => new Promise(r => setTimeout(() => r({ access_token: 'fresh', expires_at: new Date(Date.now() + 60_000) }), 20)));
    const [a, b] = await Promise.all([cache.getValidToken('t1'), cache.getValidToken('t1')]);
    expect(a).toBe('fresh'); expect(b).toBe('fresh');
    expect(refreshAuthCodeToken).toHaveBeenCalledTimes(1);
  });

  test('a refresh updates every tenant on the same connection, not only the one that asked', async () => {
    const cache = tokenCache.forUser('user-m');
    cache.cacheToken('t1', 'Org A', 'stale', new Date(Date.now() - 1000), 'oauth');
    cache.cacheToken('t2', 'Org B', 'stale', new Date(Date.now() - 1000), 'oauth');
    refreshAuthCodeToken.mockResolvedValue({ access_token: 'fresh', expires_at: new Date(Date.now() + 60_000) });
    await cache.getValidToken('t1');
    expect(await cache.getValidToken('t2')).toBe('fresh');
    expect(refreshAuthCodeToken).toHaveBeenCalledTimes(1);
  });

  test('pruneTenants drops orgs Xero no longer lists, in memory and on disk', () => {
    const cache = tokenCache.forUser('user-p');
    cache.cacheToken('t1', 'Keep', 'tok', new Date(Date.now() + 60_000));
    cache.cacheToken('t2', 'Gone', 'tok', new Date(Date.now() + 60_000));
    cache.pruneTenants(['t1']);
    expect(cache.getAllTenants().map(t => t.tenant_id)).toEqual(['t1']);
    expect(tokenCache.getPersistedTenants('user-p').map(t => t.tenantId)).toEqual(['t1']);
  });
```
- [x] **Step 2:** FAIL.
- [x] **Step 3:** token-cache.js — module-level `const _refreshing = new Map();` in `getValidToken` expiry branch:

```js
    let inFlight = _refreshing.get(userId);
    if (!inFlight) {
      inFlight = refresh(userId).then(({ access_token, expires_at }) => {
        // One connection, one token: every tenant on it gets the new one.
        for (const [tid, m] of Object.entries(cache.tokens)) {
          if (m.connection_type === mem.connection_type) cacheToken(tid, null, access_token, expires_at, m.connection_type);
        }
        return access_token;
      }).finally(() => _refreshing.delete(userId));
      _refreshing.set(userId, inFlight);
    }
    return inFlight;
```
Add `pruneTenants(keepIds)`: remove from `cache.tokens`/`cache.tenants` and `DELETE FROM xero_tenants WHERE user_id = ? AND tenant_id NOT IN (...)`. `getPersistedTenants` gets `ORDER BY connected_at`. In `oauth._listAndCacheTenants` and `connect.autoConnect`, after the cache loop: `tokenCache.pruneTenants(tenants.map(t => t.tenantId));`.
- [x] **Step 4:** `npx jest main/utils/token-cache.test.js main/xero main/routes/xero-oauth.test.js` → PASS. Commit: `fix(xero): one refresh per user, written to every tenant; persisted orgs pruned against Xero's list`.

---

### Task 6: The Insights page loads each report once (audit 1.4, UI)

**Files:** `ui/src/pages/XeroInsights.jsx:455-464`

- [x] **Step 1:** Replace the tenant effect:

```jsx
  // A tenant is "loaded" once its summary is on screen. The first summary
  // resolves the default tenant and used to re-trigger this effect, which
  // fetched the summary again and the performance report a third time.
  const loadedTenantRef = useRef(null);
  useEffect(() => {
    if (!activeTenantId || loadedTenantRef.current === activeTenantId) return;
    loadedTenantRef.current = activeTenantId;
    fetchSummary();
    if (tab === 'budget' || tab === 'variance') fetchBudget();
    else setBudget({ status: 'idle', data: null, error: '' });
    if (['overview', 'revenue', 'banking', 'profit', 'analysis'].includes(tab)) fetchPerf();
    else setPerf({ status: 'idle', data: null, error: '' });
  }, [activeTenantId]); // eslint-disable-line react-hooks/exhaustive-deps
```
and in `fetchSummary`, after `setData(d)`: `if (d.activeTenantId && loadedTenantRef.current === null) loadedTenantRef.current = d.activeTenantId;` (the mount summary already loaded it; the tab effect fetched perf once).
- [x] **Step 2:** `npm run build:ui`, `npx eslint ui/src/pages/XeroInsights.jsx` (import `useRef`). Commit: `perf(insights): each report is requested once on first load`.

---

### Finish

- [x] `npm test`, `npm run build:ui`, push, `npm run deploy`.
- [x] Note for the owner: the first foreign-currency document that appears should be compared with Xero's own base-currency figure to confirm Task 4's direction.
