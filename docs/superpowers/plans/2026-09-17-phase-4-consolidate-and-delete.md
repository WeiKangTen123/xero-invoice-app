# Phase 4 — Consolidate and delete — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One implementation for each thing the audit found written several ways (defaults, ids, base64, line items, claim records, report routes), and the dead routes, scripts, dependencies and folders gone — each step test-first, behaviour preserved unless the audit named it a bug.

**Architecture:** New small modules own what was duplicated: `utils/base64.js`, `utils/ids.js`, `users.getUserDefaults()`, `intake/document.normaliseLineItem()`, `claims/claim-record.js`, and a handler factory inside `routes/xero-reports.js`. The migration runner gains a `user_version` so one-off steps run once. Deletions are pure removals with their tests.

**Tech Stack:** unchanged. Gated runner (`scratchpad/jt.sh`): commit only on jest exit 0.

**Findings:** audit §2 (duplication table), §3 (dead code), data-layer A1–A8, B1–B4, hygiene #18–#21, #25–#27.

**Left out on purpose:** `report/` (client deliverables — owner's call), `parseGenericFormat` (already always reviewed since Phase 1), the three job runners (Phase 5 or later).

---

### Task 1: Shared helpers — base64, ids, user defaults

**Files:** create `main/utils/base64.js`, `main/utils/base64.test.js`, `main/utils/ids.js`, `main/utils/ids.test.js`; modify `main/utils/users.js` (+ `getUserDefaults`), `main/utils/users.test.js`; replace the copies in `main/routes/receipts.js`, `main/routes/claims.js`, `main/routes/invoices.js`, `main/intake/record.js`, `main/utils/invoice-handler.js`, `main/queue/email-queue.js`, `main/claims/claim-queue.js`, `main/email/parser.js` (`_userDefaults`), `main/xero/invoices.js:119,144,190`.

- [ ] **Step 1: Failing tests**

```js
// main/utils/base64.test.js
const { decodeBase64 } = require('./base64');
test('decodes plain and data-URI base64, strictly', () => {
  expect(decodeBase64(Buffer.from('hi').toString('base64')).toString()).toBe('hi');
  expect(decodeBase64('data:image/jpeg;base64,' + Buffer.from('hi').toString('base64')).toString()).toBe('hi');
  expect(decodeBase64('not base64 !!')).toBeNull();
  expect(decodeBase64('')).toBeNull();
  expect(decodeBase64(undefined)).toBeNull();
});
```
```js
// main/utils/ids.test.js
const { newId } = require('./ids');
test('ids are sortable by time, url-safe, and do not collide in a tight loop', () => {
  const ids = Array.from({ length: 20000 }, () => newId());
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids[0]).toMatch(/^\d{13}[a-z0-9]{8}$/);
});
```
users.test.js:
```js
  test('getUserDefaults: the user setting wins, then the environment, then one literal per kind', async () => {
    const u = await users.createUser('defaults@test.com', 'password123', 'user');
    const prev = { c: process.env.DEFAULT_CURRENCY, a: process.env.DEFAULT_ACCOUNT_CODE };
    try {
      delete process.env.DEFAULT_CURRENCY; delete process.env.DEFAULT_ACCOUNT_CODE;
      expect(users.getUserDefaults(u.id)).toMatchObject({ currency: 'SGD', accountCode: { claim: '429', bill: '310', invoice: '200' }, timezone: 'Asia/Singapore' });
      process.env.DEFAULT_ACCOUNT_CODE = '999';
      expect(users.getUserDefaults(u.id).accountCode).toEqual({ claim: '999', bill: '999', invoice: '999' });
      users.saveUserConfig(u.id, { DEFAULT_CURRENCY: 'USD', DEFAULT_ACCOUNT_CODE: '412', TIMEZONE: 'UTC' });
      expect(users.getUserDefaults(u.id)).toMatchObject({ currency: 'USD', accountCode: { claim: '412', bill: '412', invoice: '412' }, timezone: 'UTC' });
      expect(users.getUserDefaults(null).currency).toBe('SGD');   // no user: environment/literals only
    } finally {
      if (prev.c === undefined) delete process.env.DEFAULT_CURRENCY; else process.env.DEFAULT_CURRENCY = prev.c;
      if (prev.a === undefined) delete process.env.DEFAULT_ACCOUNT_CODE; else process.env.DEFAULT_ACCOUNT_CODE = prev.a;
    }
  });
```
- [ ] **Step 2:** RED (modules missing; function missing).
- [ ] **Step 3:** `base64.js` = the function from receipts.js (strict regex, data: prefix). `ids.js`: `newId()` = `${Date.now()}${crypto.randomBytes(6).toString('base64url').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 8).padEnd(8, '0')}`. `users.getUserDefaults(userId)`: reads config (if userId), env, literals `{ currency: 'SGD', accountCode: { claim: '429', bill: '310', invoice: '200' }, zeroTaxRate: 'NONE', timezone: DEFAULT_TIMEZONE }`; one configured/env account code applies to every kind. Replace every copy; `parser._userDefaults` → `{ currency: d.currency, accountCode: d.accountCode.bill }` (ACCREC template path uses `.invoice`), `xero/invoices.js` picks `.bill`/`.invoice` by `invoiceData.invoiceType`; `record.js` currency default → `defaults.currency` (caller passes). Delete the three `decodeBase64` copies and the `_decodeBase64` export; every ``${Date.now()}${Math.random()…}`` → `newId()`.
- [ ] **Step 4:** `jt.sh main` → PASS. Commit: `refactor: one base64 decoder, one id generator, one place for user defaults`.

---

### Task 2: One line-item normaliser

**Files:** `main/intake/document.js` (+ `normaliseLineItem`), `main/intake/intake.test.js`, `main/utils/receipt-parser.js` (use it), `main/email/parser.js` (LLM path uses it; `_withQuantity` goes).

- [ ] **Step 1: Failing test** (intake.test.js)

```js
describe('normaliseLineItem — every vocabulary the readers have used', () => {
  const { normaliseLineItem: n } = doc;
  test('receipt shape: quantity and unit price fold into the text, amount is the line total', () => {
    expect(n({ description: 'Bun', quantity: 6, unitAmount: 1.6, lineTotal: 9.6 })).toEqual({ description: 'Bun — 6 × 1.60', unitAmount: 9.6, discountRate: 0, taxPercent: null });
  });
  test('LLM bill shape: quantity/unitPrice/amount', () => {
    expect(n({ description: 'Work', quantity: 2, unitPrice: '75.00', amount: '150.00' })).toMatchObject({ description: 'Work — 2 × 75.00', unitAmount: 150 });
  });
  test('a quantity of one leaves the text alone; no line total multiplies out', () => {
    expect(n({ description: 'Coffee', quantity: 1, unitAmount: 4.5 })).toMatchObject({ description: 'Coffee', unitAmount: 4.5 });
    expect(n({ description: 'Pens', quantity: 3, unitPrice: 2 })).toMatchObject({ description: 'Pens — 3 × 2.00', unitAmount: 6 });
  });
  test('template shape and strings with separators', () => {
    expect(n({ description: 'Fees', unitAmount: '1,250.00', discountRate: '10', taxPercent: 'GST 9%' })).toEqual({ description: 'Fees', unitAmount: 1250, discountRate: 10, taxPercent: 9 });
  });
  test('nothing usable is null; text alone is an item at zero', () => {
    expect(n(null)).toBeNull();
    expect(n({})).toBeNull();
    expect(n({ description: 'Note' })).toMatchObject({ description: 'Note', unitAmount: 0 });
  });
});
```
- [ ] **Step 2:** RED. **Step 3:** implement in document.js; `normaliseDocument` maps through it; `receipt-parser.normalise` uses it (keep its 200-char description cap by slicing after); parser.js LLM path `lineItems = (llm.lineItems || []).map(normaliseLineItem).filter(Boolean)`; delete `_withQuantity` and its export (update `parser-quantity.test.js` to test `normaliseLineItem` instead).
- [ ] **Step 4:** `jt.sh main/intake main/utils/receipt-parser.test.js main/email` → PASS. Commit: `refactor(intake): one line-item normaliser for receipts, bills and templates`.

---

### Task 3: One claim-record builder

**Files:** create `main/claims/claim-record.js`; modify `main/routes/receipts.js` (storeReceipt, both sibling loops, `_applyFields`, reread), `main/routes/claims.js` (createClaimRecord moves; route keeps `_createClaimRecord` re-export for one release), `main/claims/claim-worker.js:38` (require `../claims/claim-record`), tests `main/routes/receipts.test.js`, `main/routes/claims.test.js`.

- [ ] **Step 1: Failing tests** (receipts.test.js, in "one upload, several records › a photo of two receipts"):

```js
    test('a split sibling is a complete claim: same source, a default currency and account, its own number, a received time', async () => {
      parser.parseReceiptImage.mockResolvedValue({ split: true, receipts: TWO });
      const { body } = await request(server).post('/api/receipts').set('Authorization', auth()).send({ mime: 'image/jpeg', data: jpeg(), source: 'phone' }).expect(201);
      await settle();
      const rows = invoiceStore.forUser(testUser.id).getReceiptGroup(body.receipt.id);
      for (const r of rows) {
        expect(r.source).toBe('phone');
        expect(r.currency).toBeTruthy();
        expect(r.accountCode).toBeTruthy();
        expect(r.invoiceNumber).toMatch(/^EXP-/);
        expect(r.receivedAt).toBeTruthy();
      }
      expect(new Set(rows.map(r => r.invoiceNumber)).size).toBe(rows.length);
    });
```
claims.test.js: `test('claim numbers are unique across imports and claimants', …)` — two `_createClaimRecord` calls with `row.no: '1'` and different `groupId` → different `invoiceNumber`s.
- [ ] **Step 2:** RED. **Step 3:** `claim-record.js` exports `newClaimRow({ userId, id, source, groupId, receipt, row, extras })` (one shape: status from `profileFor('EXPENSE')`, `EXP-${groupId ? groupId.slice(-4) + '-' : ''}${row?.no || id.slice(-6).toUpperCase()}`, defaults from `getUserDefaults`, description composition from createClaimRecord, `receivedAt`), `claimPatch(receipt)` (the `?? undefined` shape incl. `accountCode` when resolved), and `createClaimRecord` (moved verbatim, using `newClaimRow`). receipts.js uses `newClaimRow` for the first row and both sibling loops (siblings inherit `source`), `claimPatch` in `_applyFields` and reread (reread now also resolves the account). claim-worker requires `../claims/claim-record`.
- [ ] **Step 4:** `jt.sh main/routes/receipts.test.js main/routes/claims.test.js main/claims` → PASS. Commit: `refactor(claims): one builder for every claim record — siblings stop losing source, currency, account and number`.

---

### Task 4: Report routes through one handler; dead routes and engine gone

**Files:** `main/routes/xero-reports.js`, `main/xero/reports.js` (delete `_buildPeriod`, `_getPeriodRaw`, `getPeriod`, `_flattenReportRows`, `_findRow`, `_buildProfitAndLoss`, `_getProfitAndLossRaw`, `getProfitAndLoss`; keep `_parseReportNumber` for bank summary; drop the four unused periods imports), `main/xero/periods.js` (delete `computeRange`, `RANGE_PRESETS`, `ALL_TIME_START`), `main/routes/dashboard.js` (delete the tenants route), `main/routes/setup.js` (`/status`), `main/routes/receipts.js` (`DELETE /:id`), `main/routes/admin.js` (`PATCH /users/:id`), tests: `main/routes/xero-reports.test.js` (period/profit-loss/bank-summary blocks), `main/xero/reports.test.js` (computeRange/_buildPeriod/_buildProfitAndLoss/_flattenReportRows blocks), `main/routes/receipts.test.js` (DELETE /:id block), README rows.

- [ ] **Step 1: Failing test** (xero-reports.test.js): `test('the removed report routes are gone', …)` → `GET /api/xero-reports/period|profit-loss|bank-summary` → 404 (with the JSON 404 the router does not have, expect 404 status). And `test('every report handler answers the same envelope', …)` hits `/accounts`, `/bank-accounts`, `/contacts` and expects `{ connected: true, tenants, activeTenantId }` keys.
- [ ] **Step 2:** RED (routes exist → 200/400). **Step 3:** factory:

```js
// One shape for every report route: resolve the tenant, answer connected:false
// without touching Xero when there is none, call the report, spread the result
// with the tenant list, and turn a scope error into a reconnect prompt.
function report(label, fetch, { scopeAware = true, needs = [] } = {}) {
  return async (req, res) => {
    try {
      const { tenants, tenantId } = _resolveTenant(req);
      if (!tenantId) return res.json({ connected: false, tenants: [] });
      for (const q of needs) if (!req.query[q]) return res.status(400).json({ error: `${q} is required` });
      const data = await fetch(req, tenantId);
      res.json({ connected: true, ...data, tenants, activeTenantId: tenantId });
    } catch (err) {
      logger.error(`${label} failed`, { error: xeroErrMsg(err), userId: req.user.id });
      res.status(scopeAware ? _scopeAwareStatus(err) : 500).json({ error: scopeAware ? _scopeAwareMessage(err) : xeroErrMsg(err) });
    }
  };
}
```
and each of summary, accounts, bank-accounts, contacts, bank-transactions (`needs: ['accountId']`), budget-variance, performance, cash-flow becomes `router.get('/x', requireAuth, report('X', (req, tenantId) => reports.getX(req.user.id, tenantId, {...})))`. `/variance-insights` and `/narrative` keep their own shapes (no tenants in the envelope; narrative never 500s).
- [ ] **Step 4:** `jt.sh main/routes/xero-reports.test.js main/xero main/routes/receipts.test.js main/routes/admin.test.js main/scripts` → PASS. Commit: `refactor(reports): one handler shape; three unreachable report routes and their engine removed`.

---

### Task 5: Store and migrations — dead code out, one-off steps run once, phone and project persisted

**Files:** `main/utils/invoice-store.js` (delete `COLUMNS`, `getReported`, dead exports; add `vendorPhone`, `projectName`, `updatedAt` to the record), `main/db/schema.sql` (receipt columns + the two new columns), `main/db/migrate.js` (`user_version` runner; fold the plaintext-encrypt step in), delete `main/db/migrate-from-json.js`, `migrate-invoices-v2.js`, `migrate-encrypt-secrets.js`, `migrate-gemini-keys.js`; `main/email/parser.js` (drop `emailBodyText`); `main/utils/invoice-handler.js` (auto-post submits the stored row); tests: `main/db/migrate.test.js` (new), `main/utils/invoice-store.test.js` (round-trip picks the new fields up automatically).

- [ ] **Step 1: Failing test** (migrate.test.js):

```js
const db = require('./index');
const { run } = require('./migrate');
test('a database built from an older schema gains the columns and records its version', () => {
  run();
  const cols = db.prepare('PRAGMA table_info(invoices)').all().map(c => c.name);
  for (const c of ['receipt_file', 'receipt_hash', 'vendor_phone', 'project_name']) expect(cols).toContain(c);
  expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(1);
});
test('a plaintext credential left from before encryption is encrypted on boot', async () => {
  const users = require('../utils/users');
  const u = await users.createUser('plain@test.com', 'password123', 'user');
  db.prepare('INSERT OR IGNORE INTO user_credentials (user_id) VALUES (?)').run(u.id);
  db.prepare('UPDATE user_credentials SET imap_pass = ? WHERE user_id = ?').run('legacy-plain', u.id);
  run();
  expect(db.prepare('SELECT imap_pass FROM user_credentials WHERE user_id = ?').get(u.id).imap_pass).toMatch(/^enc:v1:/);
  expect(users.getUserConfig(u.id).IMAP_PASS).toBe('legacy-plain');
});
```
- [ ] **Step 2:** RED. **Step 3:** as described; `_step(n, fn)` runs `fn` when `user_version < n` then sets it; steps: 1 receipt_hash backfill, 2 autoprocess default rebuild, 3 encrypt plaintext credentials, 4 drop provider columns; `_ensureColumn` calls stay unconditional (cheap). Parser: remove `emailBodyText`; keep `vendorPhone`/`projectName` and persist them; handler's `scheduleXeroSubmit` receives `{ ...invStore.getById(id), _invoiceStoreId: id }`.
- [ ] **Step 4:** `jt.sh main/db main/utils main/email main/routes` → PASS. Commit: `refactor(db): versioned one-off migrations; dead store code out; phone and project persisted; both submit paths send the stored row`.

---

### Task 6: Repository — dead folders, configs and dependencies; README to match

**Files:** delete `unused/`, `testing/`, `prototype/`, `Procfile`, `railway.json`, `nodemon.json`; `git mv documentation docs/archive/postgres-era` + `docs/archive/README.md` banner; `eslint.config.js` ignores; `npm uninstall express-session pg pino pino-pretty`; `README.md` sections: Deployment (→ `npm run deploy`, runbook), Data isolation/storage (SQLite), LLM (Gemini keys), Claim API rows, File structure, API tables (drop removed routes; add compose/import/llm-keys/monitoring/export), Security (registration), Troubleshooting pointer.

- [ ] **Step 1:** `main/scripts/lint.test.js` still passes after the ignore change; `main/scripts/ui-api-paths.test.js` passes.
- [ ] **Step 2:** Commit: `chore(repo): Postgres/Railway-era folders and configs removed, four unused dependencies dropped, README matches the code`.

---

### Finish

- [ ] `npm test`, `npm run build:ui`, push, `npm run deploy`.
