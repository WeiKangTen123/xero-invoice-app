# Phase 1 — Stop the bleeding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the seventeen small, verified defects from the 16 Sep system audit that affect money, data, access or availability today, one test-first commit each.

**Architecture:** No new subsystems. Each task is a local correction inside an existing module plus a test that fails before and passes after. Shared helpers (`intake/document.js`) are reused where a parser did its own number or date handling. Nothing here changes the record shape, the DB schema (except nulling three dead credential columns), or the UI layout.

**Tech Stack:** Node 22, Express 4, better-sqlite3, jest + supertest, React/Vite. Tests: `npx jest <file>`; full suite: `npm test` (runs lint too). Commit style: `type(scope): reason`, body says why, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

**Source of findings:** `scratchpad/system-audit-2026-09-16.md` §1 (numbering below refers to it).

---

### Task 1: Remove the Bull/Redis submit path (audit 1.1)

**Files:**
- Modify: `main/queue/processor.js` (delete `getQueue`, the queue branch, `invoiceQueue`)
- Modify: `main/utils/invoice-handler.js:219-225` (comment + patch)
- Modify: `main/routes/admin.js:197`, `main/routes/setup.js:33`, `ui/src/pages/Setup.jsx:23`, `main/.env.example:36`, `README.md:98`, `package.json` (drop `bull`, `ioredis`)
- Test: `main/queue/processor.test.js` (new)

- [ ] **Step 1: Write the failing test**

```js
// main/queue/processor.test.js
// The Xero submitter posts inline. It used to build a Bull queue whenever
// REDIS_URL was set; with no Redis on the box every submit sat in ioredis'
// offline queue and failed, and the reconnect loop wrote ~4,900 empty
// "Queue error" lines in 14 hours (14–15 Sep 2026).
jest.mock('../xero/invoices', () => ({
  createDraftInvoice: jest.fn(async () => ({ invoiceID: 'xero-1' })),
  updateDraftInvoice: jest.fn(async () => ({ invoiceID: 'xero-2' })),
}));
jest.mock('../utils/notify', () => ({ notifyInvoiceCreated: jest.fn(async () => {}), notifyError: jest.fn(async () => {}) }));
jest.mock('../utils/token-cache', () => ({
  forUser: () => ({ getAllTenants: async () => [{ tenant_id: 't-1', tenant_name: 'Demo' }] }),
}));

const { createDraftInvoice, updateDraftInvoice } = require('../xero/invoices');
const { enqueueInvoice } = require('./processor');

beforeEach(() => { createDraftInvoice.mockClear(); updateDraftInvoice.mockClear(); });

test('posts inline and returns the Xero id even when REDIS_URL is set', async () => {
  process.env.REDIS_URL = 'redis://localhost:1';
  const id = await enqueueInvoice('u1', { invoiceNumber: 'INV-1', vendorName: 'Acme', totalAmount: 10 });
  expect(id).toBe('xero-1');
  expect(createDraftInvoice).toHaveBeenCalledWith('u1', 't-1', expect.objectContaining({ invoiceNumber: 'INV-1' }));
  delete process.env.REDIS_URL;
});

test('an invoice that already has a Xero id is updated, not created again', async () => {
  const id = await enqueueInvoice('u1', { invoiceNumber: 'INV-1', xeroInvoiceId: 'xero-2' });
  expect(id).toBe('xero-2');
  expect(updateDraftInvoice).toHaveBeenCalledTimes(1);
  expect(createDraftInvoice).not.toHaveBeenCalled();
});

test('a Xero failure is thrown to the caller so the row can be marked error', async () => {
  createDraftInvoice.mockRejectedValueOnce(new Error('validation'));
  await expect(enqueueInvoice('u1', { invoiceNumber: 'INV-9' })).rejects.toThrow('validation');
});

test('bull is no longer a dependency', () => {
  const pkg = require('../../package.json');
  expect(pkg.dependencies.bull).toBeUndefined();
  expect(pkg.dependencies.ioredis).toBeUndefined();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest main/queue/processor.test.js`
Expected: first test FAILS (returns null / hangs on Bull), last test FAILS (bull present).

- [ ] **Step 3: Implement**

Replace `main/queue/processor.js` entirely:

```js
const { createDraftInvoice, updateDraftInvoice } = require('../xero/invoices');
const { notifyInvoiceCreated } = require('../utils/notify');
const logger = require('../utils/logger');

// Posts a draft to Xero, inline, for every connected org.
//
// There used to be a second path here: a Bull queue built whenever REDIS_URL
// was set. No Redis ever ran on the deployment box, so every submit sat in
// ioredis' offline queue for minutes and then failed, while the reconnect
// loop wrote thousands of empty "Queue error" lines. The inline path was the
// only one whose status bookkeeping was right, so it is now the only path.

// Routes to an update when the invoice already has a Xero ID (re-posting a
// correction), otherwise creates a new draft — keeps re-posts from ever creating
// a duplicate bill in the connected Xero org.
function submitDraftInvoice(userId, tenantId, invoiceData) {
  return invoiceData.xeroInvoiceId
    ? updateDraftInvoice(userId, tenantId, invoiceData.xeroInvoiceId, invoiceData)
    : createDraftInvoice(userId, tenantId, invoiceData);
}

async function enqueueInvoice(userId, invoiceData) {
  const tokenCache = require('../utils/token-cache').forUser(userId);
  const tenants    = await tokenCache.getAllTenants();

  if (!tenants.length) {
    logger.warn('No connected Xero tenants — invoice not submitted', { vendor: invoiceData.vendorName, userId });
    return null;
  }

  let firstInvoiceId = null;
  let lastErr        = null;

  for (const tenant of tenants) {
    const tenantId   = tenant.tenant_id;
    const tenantName = tenant.tenant_name;
    try {
      const mode = invoiceData.xeroInvoiceId ? 'update' : 'create';
      logger.info('Submitting invoice to Xero', { tenant: tenantName, userId, mode });
      const xeroInvoice = await submitDraftInvoice(userId, tenantId, invoiceData);
      await notifyInvoiceCreated({
        tenantName,
        vendorName:    invoiceData.vendorName,
        invoiceNumber: invoiceData.invoiceNumber,
        totalAmount:   invoiceData.totalAmount,
        currency:      invoiceData.currency || 'SGD',
        invoiceID:     xeroInvoice.invoiceID,
      });
      logger.info(`Invoice ${mode === 'update' ? 'updated' : 'created'}`, { invoiceID: xeroInvoice.invoiceID, userId });
      firstInvoiceId = firstInvoiceId || xeroInvoice.invoiceID;
    } catch (err) {
      const detail = err?.response?.body || err?.response?.data || err?.body || err?.message || String(err);
      logger.error('Invoice submission failed', { tenant: tenantName, error: err.message, detail: JSON.stringify(detail), userId });
      lastErr = err;
    }
  }

  if (lastErr && !firstInvoiceId) throw lastErr;
  return firstInvoiceId || null;
}

module.exports = { enqueueInvoice };
```

In `main/utils/invoice-handler.js` replace lines 219-225 with:

```js
    const xeroInvoiceId = await enqueueInvoice(userId, invoiceData);

    // null means no connected org: nothing was sent, so the row waits as
    // pending rather than being marked posted.
    const patch = xeroInvoiceId
      ? { status: 'posted', xeroInvoiceId, submittedAt: new Date().toISOString(), errorMsg: null }
      : { status: 'pending', errorMsg: null };
```

`main/routes/admin.js:197`: delete the `redisConfigured` line. `main/routes/setup.js:33`: `optional: ['SLACK_WEBHOOK_URL'],`. `ui/src/pages/Setup.jsx:23`: delete the `REDIS_URL` hint line. `main/.env.example`: delete the `REDIS_URL` line and its comment. `README.md:98`: delete the row. Then:

```bash
npm uninstall bull ioredis
```

- [ ] **Step 4: Run tests**

Run: `npx jest main/queue main/routes/admin.test.js main/routes/setup` then `npm test`
Expected: PASS; lint clean.

- [ ] **Step 5: Commit**

```bash
git add main/queue/processor.js main/queue/processor.test.js main/utils/invoice-handler.js main/routes/admin.js main/routes/setup.js ui/src/pages/Setup.jsx main/.env.example README.md package.json package-lock.json
git commit -F - <<'MSG'
fix(xero): submit inline — the Bull queue never had a Redis to talk to

REDIS_URL was set, so the first submit of the day built a Bull queue; no
Redis runs on the box, so every submit waited in ioredis' offline queue and
failed, and the reconnect loop wrote ~4,900 empty "Queue error" lines on
14–15 Sep (an AggregateError with an empty message). The inline path was the
only one with correct status bookkeeping and is now the only path. bull and
ioredis are gone from package.json.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 2: LLM bill numbers and dates go through the shared cleaners (audit 1.2)

**Files:**
- Modify: `main/email/parser.js:441-460` (`parsePDFWithLLM`), export it
- Modify: `main/intake/document.js:84-88` (`addDays` returns null on bad input)
- Test: `main/email/parser-llm.test.js` (new), `main/intake/intake.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// main/email/parser-llm.test.js
// What the model returns is text. "1,250.00" and "14/09/2026" are normal
// answers; parseFloat read the first as 1 and addDays threw on the second,
// which lost the bill after the mail was already marked read.
jest.mock('./llm-parser', () => ({ extractWithRetry: jest.fn() }));
jest.mock('./template-verifier', () => ({ verifyTemplateExtraction: jest.fn(async (t, p) => ({ parsed: p, reviewReason: null })) }));
const { extractWithRetry } = require('./llm-parser');
const { parsePDFWithLLM } = require('./parser');

const EMAIL = { subject: 'Invoice', date: '2026-09-10T02:00:00Z', from: { text: 'x@y.com', value: [{ address: 'x@y.com' }] } };
const DEFAULTS = { currency: 'SGD', accountCode: '310' };

test('amounts with thousands separators are read as numbers, not truncated', async () => {
  extractWithRetry.mockResolvedValue({ vendorName: 'Acme', invoiceNumber: 'A-1', totalAmount: '1,250.00', subTotal: '1,250.00', taxAmount: '0',
    lineItems: [{ description: 'Work', quantity: 1, unitPrice: '1,250.00', amount: '1,250.00' }] });
  const r = await parsePDFWithLLM('text', EMAIL, 'a.pdf', 'u1', DEFAULTS);
  expect(r.totalAmount).toBe(1250);
  expect(r.lineItems[0].unitAmount).toBe(1250);
});

test('a day-first date is read; a non-ISO date never throws', async () => {
  extractWithRetry.mockResolvedValue({ vendorName: 'Acme', invoiceNumber: 'A-2', totalAmount: 10, invoiceDate: '14/09/2026', dueDate: null, lineItems: [] });
  const r = await parsePDFWithLLM('text', EMAIL, 'a.pdf', 'u1', DEFAULTS);
  expect(r.invoiceDate).toBe('2026-09-14');
  expect(r.dueDate).toBe('2026-10-14');
});

test('no readable invoice date falls back to the email date, never today', async () => {
  extractWithRetry.mockResolvedValue({ vendorName: 'Acme', invoiceNumber: 'A-3', totalAmount: 10, invoiceDate: 'TBC', lineItems: [] });
  const r = await parsePDFWithLLM('text', EMAIL, 'a.pdf', 'u1', DEFAULTS);
  expect(r.invoiceDate).toBe('2026-09-10');
});
```

Add to `main/intake/intake.test.js` inside the dates describe:

```js
  test('addDays answers null for a date it cannot read instead of throwing', () => {
    expect(doc.addDays('14/09/2026', 30)).toBeNull();
    expect(doc.addDays(null, 30)).toBeNull();
    expect(doc.addDays('2026-09-14', 30)).toBe('2026-10-14');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest main/email/parser-llm.test.js main/intake/intake.test.js`
Expected: FAIL — `parsePDFWithLLM` not exported; `addDays` throws RangeError; totalAmount 1.

- [ ] **Step 3: Implement**

`main/intake/document.js` `addDays`:

```js
// Null, not a throw, for input it cannot read: a model that answers
// "14/09/2026" must not take the whole bill down with a RangeError.
function addDays(dateStr, days) {
  const iso = isoDate(String(dateStr || '')) || parseDate(dateStr);
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return localDateStr(d);
}
```

`main/email/parser.js` in `parsePDFWithLLM` — add near the top of the file `const intake = require('../intake/document');` if not already imported under that name (check existing `_intake`/`require('../intake/document')` lines and reuse), then replace lines 441-460:

```js
  // Model answers are text. The shared cleaners read "1,250.00" as 1250 and
  // "14/09/2026" as a date; parseFloat read the first as 1 and the second
  // threw. An unreadable invoice date falls back to the email's date — never
  // today, which is the drift intake/document.js exists to stop.
  const emailDate   = email.date ? intake.localDateStr(new Date(email.date)) : intake.today();
  const invoiceDate = intake.isoDate(llm.invoiceDate) || intake.parseDate(llm.invoiceDate) || emailDate;
  const dueDate     = intake.isoDate(llm.dueDate) || intake.parseDate(llm.dueDate) || intake.addDays(invoiceDate, 30);

  // Quantity has no column of its own, so "2 × 75.00" rides in the description
  // and unitAmount stays the line total — the figure Xero must receive.
  const lineItems = (llm.lineItems || []).map(li => ({
    description:  _withQuantity(li.description, li.quantity, li.unitPrice),
    unitAmount:   intake.money(li.amount ?? li.unitAmount) ?? 0,
    discountRate: 0,
  }));

  if (!lineItems.length) {
    lineItems.push({
      description:  cleanSubject(email.subject) || `Invoice from ${llm.vendorName}`,
      unitAmount:   intake.money(llm.totalAmount) ?? 0,
      discountRate: 0,
    });
  }
```

and further down in the returned object: `totalAmount: intake.money(llm.totalAmount) ?? 0`, `subTotal: intake.money(llm.subTotal)`, `taxAmount: intake.money(llm.taxAmount)` (keep the null semantics the comment describes). In `_withQuantity` use `intake.num(quantity)` and `intake.num(unitPrice)` instead of `parseFloat`. Add `parsePDFWithLLM` to `module.exports`.

- [ ] **Step 4: Run tests**

Run: `npx jest main/email main/intake` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add main/email/parser.js main/email/parser-llm.test.js main/intake/document.js main/intake/intake.test.js
git commit -F - <<'MSG'
fix(llm-parser): read model amounts and dates with the shared cleaners

parseFloat("1,250.00") is 1, so a comma in the model's answer posted a wrong
total. A date like "14/09/2026" reached addDays, which threw RangeError; the
job then finished with no invoices and the mail was already marked read.
intake.money()/isoDate()/parseDate() already handle both; an unreadable
invoice date now falls back to the email's date, never today.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 3: The auto-post guard refuses a zero total, and a regex fallback is always reviewed (audit 1.2)

**Files:**
- Modify: `main/utils/invoice-handler.js:145-157` (extract `holdReason`)
- Modify: `main/email/parser.js` (`parsePDFWithLLM` catch → `reviewReason`; `_parseOne` keeps `parsed.reviewReason`; drop filename number fallback)
- Test: `main/utils/invoice-handler.test.js` (new), `main/email/parser-llm.test.js`

- [ ] **Step 1: Failing tests**

```js
// main/utils/invoice-handler.test.js
const { holdReason } = require('./invoice-handler');

test('a zero total is held for review whatever the invoice number says', () => {
  expect(holdReason({ invoiceNumber: 'Scan_0001', totalAmount: 0 })).toMatch(/amount/);
  expect(holdReason({ invoiceNumber: 'INV-1789367692013', totalAmount: 0 })).toMatch(/amount/);
});

test('an auto-generated number with a real total is held too', () => {
  expect(holdReason({ invoiceNumber: 'INV-1789367692013', totalAmount: 120 })).toMatch(/number/);
});

test('a real number and a real total pass', () => {
  expect(holdReason({ invoiceNumber: 'A-1', totalAmount: 120 })).toBeNull();
});
```

Append to `main/email/parser-llm.test.js`:

```js
test('when the model fails, the regex guess is flagged for review and never numbered from the filename', async () => {
  extractWithRetry.mockRejectedValue(new Error('quota'));
  const r = await parsePDFWithLLM('Total: 500', EMAIL, 'Scan_0001.pdf', 'u1', DEFAULTS);
  expect(r.reviewReason).toMatch(/could not be read/);
  expect(r.invoiceNumber).not.toBe('Scan_0001');
});
```

- [ ] **Step 2: Verify failure** — `npx jest main/utils/invoice-handler.test.js main/email/parser-llm.test.js` → FAIL (`holdReason` undefined; `reviewReason` undefined).

- [ ] **Step 3: Implement**

`main/utils/invoice-handler.js` — add above `createHandler`:

```js
// Why a stored bill must wait for a person instead of going to Xero. Null
// means nothing here objects. A zero total is held whatever the number says:
// the old guard only held "no number AND no amount", so a misread PDF whose
// number came from its filename could post a blank draft.
function holdReason(record) {
  const total = Number(record.totalAmount) || 0;
  if (total <= 0) return 'Could not read an amount from the PDF';
  const auto = !record.invoiceNumber || record.invoiceNumber === '—' || /^INV-\d{12,}$/.test(record.invoiceNumber);
  if (auto) return 'Could not read an invoice number from the PDF';
  return null;
}
```

Replace lines 145-157 with:

```js
    const hold = holdReason(record);
    if (hold) {
      logger.warn('Invoice held for review — skipping Xero submit', { id, vendor: record.vendorName, userId, reason: hold });
      await invStore.update(id, { status: 'review-needed', errorMsg: hold });
      return { id, status: 'review-needed' };
    }
```

Export: `module.exports = { createHandler, submitInvoiceToXero, holdReason };`

`main/email/parser.js` `parsePDFWithLLM` catch:

```js
  } catch (err) {
    logger.warn('LLM parse failed, falling back to regex', { error: err.message, userId });
    const guess = parseGenericFormat(text, email, defaults);
    // A regex guess at a PDF is never sent on unreviewed.
    guess.reviewReason = 'the PDF could not be read by the model; the figures below are a rough guess from the text';
    return guess;
  }
```

Drop `fallbackInvoiceNumber`; use `invoiceNumber: (llm.invoiceNumber || `INV-${Date.now()}`).slice(0, 100)` so a missing number is auto-shaped and held. In `_parseOne` (line ~536) change `reviewReason,` to `reviewReason: reviewReason || parsed.reviewReason || null,` and in the `noText` branch set `parsed.reviewReason = 'the PDF has no readable text; nothing below was read from it'`.

- [ ] **Step 4: Run** — `npx jest main/utils main/email main/routes/bill-intake.test.js main/routes/invoice-intake.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add main/utils/invoice-handler.js main/utils/invoice-handler.test.js main/email/parser.js main/email/parser-llm.test.js
git commit -F - <<'MSG'
fix(intake): hold a zero total for review; a regex guess is never auto-posted

The guard only held a bill with no number AND no amount. The model's number
fallback was the PDF filename's first token, which is not auto-shaped, so a
misread PDF with total 0 could post a blank draft. Any zero total is now
held, and when the model fails the regex fallback carries a review reason
instead of going out unread.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 4: Contact lookup sends `summaryOnly`, not a search term (audit 1.3)

**Files:**
- Modify: `main/xero/contacts.js:21-31`
- Test: `main/xero/contacts.test.js` (new)

- [ ] **Step 1: Failing test**

```js
// main/xero/contacts.test.js
// getContacts(tenant, ifModifiedSince, where, order, iDs, page, includeArchived, summaryOnly, searchTerm).
// The call passed eight undefineds then true, which landed in searchTerm.
const getContacts    = jest.fn();
const createContacts = jest.fn();
jest.mock('xero-node', () => ({ AccountingApi: jest.fn(() => ({ getContacts, createContacts })) }));
jest.mock('../utils/token-cache', () => ({ forUser: () => ({ getValidToken: async () => 'tok' }) }));
jest.mock('./xero-utils', () => ({ withRetry: fn => fn() }));
const { getOrCreateContact } = require('./contacts');

beforeEach(() => { getContacts.mockReset(); createContacts.mockReset(); });

test('searches by exact name with summaryOnly, no search term', async () => {
  getContacts.mockResolvedValue({ body: { contacts: [{ contactID: 'c-1' }] } });
  const id = await getOrCreateContact('u1', 't-1', { vendorName: 'Acme', invoiceType: 'ACCPAY' });
  expect(id).toBe('c-1');
  const args = getContacts.mock.calls[0];
  expect(args[2]).toBe('Name=="Acme"');
  expect(args[7]).toBe(true);        // summaryOnly
  expect(args[8]).toBeUndefined();   // searchTerm
  expect(createContacts).not.toHaveBeenCalled();
});

test('a failed search is not an excuse to create a duplicate', async () => {
  getContacts.mockRejectedValue(new Error('rate limited'));
  await expect(getOrCreateContact('u1', 't-1', { vendorName: 'Acme', invoiceType: 'ACCPAY' })).rejects.toThrow('rate limited');
  expect(createContacts).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Verify failure** — `npx jest main/xero/contacts.test.js` → FAIL on `args[7]` and on the rethrow.

- [ ] **Step 3: Implement** — replace lines 18-31:

```js
  // Search for an existing contact by exact name. Positional SDK call: the
  // eighth argument is summaryOnly; a `true` one slot later was a search term.
  const where    = `Name=="${cleanName.replace(/"/g, '')}"`;
  const response = await withRetry(() =>
    accountingApi.getContacts(tenantId, undefined, where, undefined, undefined, undefined, undefined, true)
  );
  const contacts = response.body.contacts || [];
  if (contacts.length > 0) {
    logger.info('Contact found', { tenantId, vendorName, contactID: contacts[0].contactID });
    return contacts[0].contactID;
  }
```

(no try/catch: a failed search propagates; the queue retries.)

- [ ] **Step 4: Run** — `npx jest main/xero/contacts.test.js main/xero/invoices.test.js` → PASS.
- [ ] **Step 5: Commit** — `fix(xero): contact lookup passes summaryOnly, and a failed search no longer creates a duplicate`.

---

### Task 5: One Xero scope list (audit 1.6)

**Files:**
- Modify: `main/xero/xero-utils.js` (add `SCOPES`), `main/xero/connect.js:4-8`, `main/xero/oauth.js:15-23`
- Test: `main/xero/scopes.test.js` (new)

- [ ] **Step 1: Failing test**

```js
// main/xero/scopes.test.js
const { SCOPES } = require('./xero-utils');
const connect = require('./connect');
const oauth   = require('./oauth');

test('both connection types ask for the same accounting scopes, budgets included', () => {
  expect(connect.SCOPES).toBe(SCOPES);
  expect(oauth.SCOPES).toBe(`offline_access ${SCOPES}`);
  for (const s of ['accounting.reports.budgetsummary.read', 'accounting.budgets.read']) expect(SCOPES.split(' ')).toContain(s);
});
```

- [ ] **Step 2: Verify failure** — FAIL: `connect.SCOPES` undefined.
- [ ] **Step 3: Implement** — in `xero-utils.js`: 

```js
// Every accounting scope the app uses, in one place. OAuth adds offline_access
// (refresh tokens); a Custom Connection has no refresh token to ask for. The
// two lists had drifted: budgets were added to OAuth only, so Custom
// Connection users got insufficient_scope on the whole dashboard.
const SCOPES = 'accounting.invoices accounting.contacts accounting.settings.read '
  + 'accounting.banktransactions.read accounting.reports.profitandloss.read accounting.reports.banksummary.read '
  + 'accounting.payments.read accounting.reports.budgetsummary.read accounting.budgets.read';
```
export it; `connect.js`: `const { SCOPES } = require('./xero-utils');` and export `SCOPES`; `oauth.js`: `const SCOPES = \`offline_access ${require('./xero-utils').SCOPES}\`;` and export it.

- [ ] **Step 4: Run** — `npx jest main/xero` → PASS (oauth.test.js:72 still matches).
- [ ] **Step 5: Commit** — `fix(xero): one scope list — Custom Connection gets the budget scopes too`.

---

### Task 6: Admin Resolve reaches its route; the invoice list carries what the page reads (audit 1.7)

**Files:**
- Modify: `ui/src/pages/Admin.jsx:296-302`, `main/routes/invoices.js:172-192`
- Test: `main/routes/admin.test.js`, `main/routes/invoices-workflow.test.js`

- [ ] **Step 1: Failing tests** — admin.test.js:

```js
  test('PATCH /reports/:userId/:invoiceId/resolve marks the invoice reviewed and records who did it', async () => {
    const invoiceStore = require('../utils/invoice-store');
    const u = await users.createUser('owner@test.com', 'password123', 'user');
    invoiceStore.forUser(u.id).add({ id: 'r1', status: 'reported', vendorName: 'A', invoiceNumber: '1', invoiceDate: '2026-09-01', totalAmount: 5, processedAt: new Date().toISOString() });
    await request(serverFor(app)).patch(`/api/admin/reports/${u.id}/r1/resolve`).set('Authorization', `Bearer ${tokenFor(adminUser)}`).expect(200);
    const row = invoiceStore.forUser(u.id).getById('r1');
    expect(row.status).toBe('reviewed');
    expect(row.resolvedBy).toBe('admin@test.com');
  });
```

invoices-workflow.test.js (inside its describe, using its own helpers):

```js
  test('the list carries the claim and duplicate fields the Invoices page reads', async () => {
    const res = await request(serverFor(app)).get('/api/invoices').set('Authorization', auth()).expect(200);
    const row = res.body.invoices[0];
    for (const k of ['receivedAt', 'receiptFile', 'receiptGroup', 'receiptPage', 'duplicateOf', 'description']) expect(row).toHaveProperty(k);
  });
```

- [ ] **Step 2: Verify failure** — the list test FAILS (keys missing); the admin test passes already (route is correct; the UI was wrong) — keep it as the pin.
- [ ] **Step 3: Implement** — invoices.js map: add `receivedAt: inv.receivedAt, receiptFile: inv.receiptFile, receiptGroup: inv.receiptGroup, receiptPage: inv.receiptPage, duplicateOf: inv.duplicateOf, description: inv.description,`. Admin.jsx:

```js
  async function resolve(inv) {
    setResolving(inv.id);
    try {
      await api.patch(`/admin/reports/${inv._ownerId}/${inv.id}/resolve`, {});
      await fetchReports();
    } catch (err) { setError(err.message); }
    setResolving(null);
  }
```
and the call site `onClick={() => resolve(inv)}`; add `const [error, setError] = useState('')` and render it as an `.alert alert-error` above the list if not already present.

- [ ] **Step 4: Run** — `npx jest main/routes/admin.test.js main/routes/invoices-workflow.test.js` and `npm run build:ui`.
- [ ] **Step 5: Commit** — `fix(admin,invoices): Resolve calls the route that exists; the list carries the fields the page reads`.

---

### Task 7: Review page remounts per record (audit 1.8)

**Files:** `ui/src/App.jsx:61`, `ui/src/pages/InvoiceReview.jsx` (export a keyed wrapper)

- [ ] **Step 1:** At the bottom of `InvoiceReview.jsx` add:

```jsx
// Every piece of state on this page belongs to ONE record. Prev/Next and the
// filmstrip change :id without unmounting, so edit mode, the submit poll and
// the rotation survived into the next record — Save could patch the wrong
// one. Keying on the id remounts with fresh state.
export function InvoiceReviewKeyed() {
  const { id } = useParams();
  return <InvoiceReview key={id} />;
}
```
- [ ] **Step 2:** `App.jsx`: `import InvoiceReview, { InvoiceReviewKeyed } from …` (or adjust the lazy import: `const InvoiceReviewKeyed = lazy(() => import('./pages/InvoiceReview').then(m => ({ default: m.InvoiceReviewKeyed })));`) and use `<InvoiceReviewKeyed />` for `invoices/:id`.
- [ ] **Step 3:** `npm run build:ui` and `npx eslint ui/src` → clean. Commit: `fix(review): remount per record so edit state and the submit poll never leak into the next one`.

---

### Task 8: An async route throw is a 500, not a restart; unknown `/api/*` is a JSON 404 (audit 1.9)

**Files:**
- Create: `main/middleware/async-handler.js`
- Modify: `main/routes/receipts.js:452`, `main/routes/invoices.js:446`, `main/index.js` (before the SPA catch-all)
- Test: `main/routes/receipts.test.js`

- [ ] **Step 1: Failing test** — in the `GET /:id/image` describe:

```js
    test('a failure while scaling answers 500 instead of crashing the process', async () => {
      const thumbnailer = require('../utils/thumbnailer');
      jest.spyOn(thumbnailer, 'thumbnailPath').mockRejectedValueOnce(new Error('sharp exploded'));
      const { body } = await upload().expect(201);
      await request(server).get(`/api/receipts/${body.receipt.id}/image?w=76&token=${body.imageToken}`).expect(500);
    });
```
- [ ] **Step 2:** Run → FAIL (the request hangs or jest reports an unhandled rejection).
- [ ] **Step 3:** `async-handler.js`:

```js
// Express 4 does not catch a rejected async handler; index.js turns every
// unhandled rejection into process.exit(1), so one bad request restarted the
// server for everyone. Wrap async routes so a throw reaches the error handler.
module.exports = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
```
Wrap the two routes: `router.get('/:id/image', asyncHandler(async (req, res) => { … }))` and `router.post('/submit-all', requireAuth, asyncHandler(async (req, res) => { … }))`. In `index.js` just before `app.get('*', …)` inside the PROD block, and also in the non-PROD branch: `app.all('/api/*', (_req, res) => res.status(404).json({ error: 'Not found' }));`.
- [ ] **Step 4:** `npx jest main/routes/receipts.test.js` → PASS. Commit: `fix(routes): an async route failure is a 500, not a process restart; /api/* 404s as JSON`.

---

### Task 9: Registration closes once an account exists (audit 1.10)

**Files:** `main/routes/auth.js:24-41`, `main/.env.example`, `README.md` (the two registration sentences), test `main/routes/auth.test.js:81`

- [ ] **Step 1: Failing test** — replace the `ALLOW_REGISTRATION=false` test with:

```js
    test('once a user exists, registration is closed unless ALLOW_REGISTRATION=true', async () => {
      await users.createUser('first@test.com', 'password123', 'auto');
      delete process.env.ALLOW_REGISTRATION;
      await request(serverFor(app)).post('/api/auth/register').send({ email: 'second@test.com', password: 'password123' }).expect(403);
      process.env.ALLOW_REGISTRATION = 'true';
      await request(serverFor(app)).post('/api/auth/register').send({ email: 'second@test.com', password: 'password123' }).expect(201);
      delete process.env.ALLOW_REGISTRATION;
    });

    test('the very first account can always be created', async () => {
      await request(serverFor(app)).post('/api/auth/register').send({ email: 'first@test.com', password: 'password123' }).expect(201);
    });
```
- [ ] **Step 2:** FAIL (second registration returns 201).
- [ ] **Step 3:** auth.js: comment + `if (hasUsers() && process.env.ALLOW_REGISTRATION !== 'true') return 403 …`. `.env.example`: add `# ALLOW_REGISTRATION=true   # off by default: after the first account, admins add users on the Admin page`. README: fix lines 428 and 605.
- [ ] **Step 4:** `npx jest main/routes/auth.test.js` → PASS. Commit: `fix(auth): registration is opt-in after the first account — the public URL accepted anyone`.

---

### Task 10: Role and existence are read from the database, not the token (audit 1.10)

**Files:** `main/middleware/auth-middleware.js`, tests `main/routes/auth.test.js`, `main/routes/admin.test.js`

- [ ] **Step 1: Failing tests**

auth.test.js:
```js
  test('a deleted user\'s token is refused', async () => {
    const u = await users.createUser('gone@test.com', 'password123', 'user');
    const token = tokenFor(u);
    users.deleteUser(u.id);
    await request(serverFor(app)).get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(401);
  });
```
admin.test.js:
```js
  test('a demoted admin\'s old token no longer opens admin routes', async () => {
    const second = await users.createUser('two@test.com', 'password123', 'admin');
    const token = tokenFor(second);
    users.updateUserRole(second.id, 'user');
    await request(serverFor(app)).get('/api/admin/users').set('Authorization', `Bearer ${token}`).expect(403);
  });
```
- [ ] **Step 2:** FAIL (200 in both).
- [ ] **Step 3:** `requireAuth`:

```js
    const claims = jwt.verify(token, jwtSecret());
    // The token says who; the database says whether they still exist and
    // what they may do. A 7-day token must not outlive a deletion or demotion.
    const users = require('../utils/users');
    const live  = users.findById(claims.id);
    if (!live) return res.status(401).json({ error: 'Account no longer exists' });
    req.user = { ...claims, role: live.role, email: live.email };
    try { users.touchLastSeen(req.user.id); } catch {}
    next();
```
(`findById` at users.js:98 — confirm it returns `{id, email, role, …}`.)
- [ ] **Step 4:** `npx jest main/routes main/middleware` → PASS. Commit: `fix(auth): role and existence come from the database on every request`.

---

### Task 11: The Setup page never receives a stored secret (audit 1.10)

**Files:** `main/routes/setup.js` (GET/POST), `ui/src/pages/Setup.jsx` (placeholder when set), test `main/routes/setup.test.js` (new)

- [ ] **Step 1: Failing test**

```js
// main/routes/setup.test.js
const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');

describe('routes/setup — secrets', () => {
  let app, users, jwtSecret, user;
  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    app = express(); app.use(express.json()); app.use('/api/setup', require('./setup'));
    user = await users.createUser('s@test.com', 'password123', 'auto');
  });
  const auth = () => `Bearer ${jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret())}`;

  test('a stored secret is reported as set but its value is never returned', async () => {
    users.saveUserConfig(user.id, { IMAP_PASS: 'hunter2', IMAP_HOST: 'imap.test' });
    const { body } = await request(serverFor(app)).get('/api/setup').set('Authorization', auth()).expect(200);
    const all = Object.assign({}, ...Object.values(body));
    expect(all.IMAP_PASS).toEqual({ value: '', isSet: true });
    expect(all.IMAP_HOST.value).toBe('imap.test');
  });

  test('saving with a blank secret keeps the stored one; a new value replaces it', async () => {
    users.saveUserConfig(user.id, { IMAP_PASS: 'hunter2' });
    await request(serverFor(app)).post('/api/setup').set('Authorization', auth()).send({ IMAP_PASS: '', IMAP_HOST: 'imap.new' }).expect(200);
    expect(users.getUserConfig(user.id).IMAP_PASS).toBe('hunter2');
    await request(serverFor(app)).post('/api/setup').set('Authorization', auth()).send({ IMAP_PASS: 'new-pass' }).expect(200);
    expect(users.getUserConfig(user.id).IMAP_PASS).toBe('new-pass');
  });
});
```
- [ ] **Step 2:** FAIL (value 'hunter2' returned; blank clears it).
- [ ] **Step 3:** setup.js: `const SECRET_KEYS = new Set(['XERO_CLIENT_SECRET', 'XERO_OAUTH_CLIENT_SECRET', 'IMAP_PASS', 'Gemini_API_KEY']);` GET: `value: SECRET_KEYS.has(key) ? '' : val, isSet: val.length > 0` (both user and global loops; check the global key names too). POST: `if (SECRET_KEYS.has(k) && (v === '' || v == null)) continue;`. Setup.jsx: where a field input is rendered, pass `placeholder={config?.[section]?.[key]?.isSet && isSecret(key) ? 'Saved — leave blank to keep' : undefined}` (find the field render in Setup.jsx; keep it to that one prop).
- [ ] **Step 4:** `npx jest main/routes/setup.test.js` and `npm run build:ui`. Commit: `fix(setup): stored secrets are never sent to the browser; a blank field keeps the saved one`.

---

### Task 12: Dead credential columns are emptied (audit 1.10)

**Files:** `main/db/migrate.js` (new step), `main/utils/users.js:18-20` (drop mappings), test `main/utils/users.test.js`

- [ ] **Step 1: Failing test**

```js
  test('provider keys the app no longer uses are wiped on migrate, and every secret column is encrypted', async () => {
    const db = require('../db');
    const u = await users.createUser('old@test.com', 'password123', 'user');
    db.prepare('UPDATE user_credentials SET nvidia_api_key = ?, openrouter_api_key = ?, openrouter_model = ? WHERE user_id = ?').run('nv-key', 'or-key', 'm', u.id);
    require('../db/migrate').run();
    const row = db.prepare('SELECT nvidia_api_key, openrouter_api_key, openrouter_model FROM user_credentials WHERE user_id = ?').get(u.id);
    expect(row).toEqual({ nvidia_api_key: null, openrouter_api_key: null, openrouter_model: null });
    for (const col of Object.values(users.CONFIG_KEY_TO_COLUMN)) {
      if (/key|secret|pass|token/.test(col)) expect(users.ENCRYPTED_COLUMNS.has(col)).toBe(true);
    }
  });
```
(`createUser` may not insert a `user_credentials` row — if the UPDATE affects 0 rows, insert one first with `INSERT OR IGNORE INTO user_credentials (user_id) VALUES (?)`.)
- [ ] **Step 2:** FAIL (values remain; `Nvidia_API_KEY` maps to an unencrypted column).
- [ ] **Step 3:** migrate.js, before the autoprocess step:

```js
  // Nvidia/OpenRouter were removed from the LLM client; their columns still
  // held live keys in plaintext (never in ENCRYPTED_COLUMNS). Nothing reads
  // them, so they are emptied here rather than left lying in the database.
  try {
    db.prepare("UPDATE user_credentials SET nvidia_api_key = NULL, openrouter_api_key = NULL, openrouter_model = NULL WHERE nvidia_api_key IS NOT NULL OR openrouter_api_key IS NOT NULL OR openrouter_model IS NOT NULL").run();
  } catch (err) { require('../utils/logger').warn('dead provider key wipe skipped', { error: err.message }); }
```
users.js: delete the three mappings; export `CONFIG_KEY_TO_COLUMN` and `ENCRYPTED_COLUMNS` if not already.
- [ ] **Step 4:** `npx jest main/utils/users.test.js main/db` → PASS. Commit: `fix(users): wipe the dead Nvidia/OpenRouter key columns — they held plaintext credentials`.

---

### Task 13: Mail queue: an unreadable date never throws; an exhausted job is kept as dead (audit 1.12)

**Files:** `main/queue/email-queue.js:45,140-160`, test `main/queue/email-queue.test.js` (new)

- [ ] **Step 1: Failing tests**

```js
// main/queue/email-queue.test.js
const fs = require('fs'), path = require('path');
const q = require('./email-queue');
const USER = `eq-${Date.now()}`;
afterAll(() => { try { fs.rmSync(path.join(__dirname, '../data/users', USER), { recursive: true, force: true }); } catch {} });

const parsed = over => ({ from: { text: 'a@b.c' }, subject: 's', text: 'body', attachments: [], ...over });

test('an email whose Date header is unreadable still queues', () => {
  const job = q.enqueue(USER, parsed({ date: new Date('garbage') }));
  expect(job.email.date).toBeNull();
});

test('a job that fails MAX_ATTEMPTS times is kept as dead, not deleted', () => {
  const job = q.enqueue(USER, parsed({ date: new Date('2026-09-10T00:00:00Z') }));
  for (let i = 0; i < q.MAX_ATTEMPTS; i++) { q.markProcessing(USER, job.id); q.markFailed(USER, job.id, 'boom'); }
  const stats = q.getStats(USER);
  expect(stats.dead).toBe(1);
  expect(stats.jobs.find(j => j.id === job.id).status).toBe('dead');
});
```
(Check the real names: `MAX_ATTEMPTS`, `markProcessing`, `getStats` — read `email-queue.js` exports and adjust before running.)
- [ ] **Step 2:** FAIL (throws on date; dead 0).
- [ ] **Step 3:** `date: parsedEmail.date && !Number.isNaN(+parsedEmail.date) ? parsedEmail.date.toISOString() : null`; in `markFailed`: when exhausted, `job.status = 'dead'; fs.writeFileSync(file, …)` and keep the attachments; make sure `getPending` ignores `dead` (it filters on `status === 'pending'` already) and the sweeper/recovery never re-queues dead.
- [ ] **Step 4:** `npx jest main/queue` → PASS. Commit: `fix(email-queue): a bad Date header does not lose the mail; exhausted jobs stay visible as dead`.

---

### Task 14: Mail is marked read only after its job is on disk (audit 1.12)

**Files:** `main/email/watcher-registry.js:89-113`, test `main/email/watcher-registry.test.js` (extend `FakeImap`)

- [ ] **Step 1: Failing test** — extend the fake: `fetch(uids, opts) { this.fetchOpts = opts; const f = new EventEmitter(); this._fetch = f; return f; }` and `addFlags(uid, flags, cb) { this.flagged.push({ uid, flags }); cb && cb(null); }` with `this.flagged = []` in the constructor. Test:

```js
  test('an email is flagged \\Seen only after enqueue succeeds', async () => {
    const { simpleParser } = require('mailparser');
    const emailQueue = require('../queue/email-queue');
    simpleParser.mockResolvedValue({ subject: 'x' });
    watcherRegistry.start('u9', CREDS);
    const fake = lastImapInstance();
    fake.search = (c, cb) => cb(null, [41]);
    fake.emit('ready'); fake.resolveOpenBox();
    expect(fake.fetchOpts.markSeen).toBe(false);
    const msg = new EventEmitter(); const body = new EventEmitter();
    fake._fetch.emit('message', msg);
    msg.emit('attributes', { uid: 41 });
    msg.emit('body', body); body.emit('data', Buffer.from('raw')); body.emit('end');
    fake._fetch.emit('end');
    await new Promise(r => setImmediate(r));
    expect(emailQueue.enqueue).toHaveBeenCalled();
    expect(fake.flagged).toEqual([{ uid: 41, flags: ['\\Seen'] }]);
  });
```
(Adjust to the registry's real `start` signature and how existing tests drive a fetch; the existing tests at lines 85-96 show the ready → openBox sequence.)
- [ ] **Step 2:** FAIL (`markSeen` true; `flagged` empty).
- [ ] **Step 3:** In `_fetchUnseen`: `s.imap.fetch(uids, { bodies: '', markSeen: false })`; per message capture `let uid = null; msg.once('attributes', a => { uid = a.uid; });` and after `emailQueue.enqueue` succeeds: `if (uid != null) s.imap.addFlags(uid, ['\\Seen'], err => { if (err) logger.warn(…) })`. On enqueue failure the mail stays unseen and is picked up next poll (the queue's hash dedup handles a repeat).
- [ ] **Step 4:** `npx jest main/email/watcher-registry.test.js` → PASS. Commit: `fix(imap): mark a mail read only once its job is on disk`.

---

### Task 15: Watcher: reconnect when the inbox will not open; stop on a bad password (audit 1.12)

**Files:** `main/email/watcher-registry.js:163-190, 240-244`, test `main/email/watcher-registry.test.js`

- [ ] **Step 1: Failing tests**

```js
  test('a failure to open INBOX schedules a reconnect instead of leaving a zombie', () => {
    jest.useFakeTimers();
    watcherRegistry.start('u10', CREDS);
    const first = lastImapInstance();
    first.emit('ready'); first.resolveOpenBox(new Error('Mailbox does not exist'));
    jest.advanceTimersByTime(60_000);
    expect(Imap.mock.results.length).toBeGreaterThan(1);   // a new connection was built
    jest.useRealTimers();
  });

  test('an authentication failure stops the watcher rather than retrying for an hour', () => {
    watcherRegistry.start('u11', CREDS);
    const fake = lastImapInstance();
    fake.emit('error', Object.assign(new Error('Invalid credentials'), { source: 'authentication' }));
    expect(watcherRegistry.isRunning('u11')).toBe(false);
    expect(watcherRegistry.lastError && watcherRegistry.lastError('u11')).toMatch(/credentials/);
  });
```
(Use the registry's real API names for running/last-error; read `module.exports` first and adapt.)
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** openBox callback: `if (err) { _scheduleReconnect(s, imap, 'openBox failed', err); return; }`. In the `'error'` handler: `if (err.source === 'authentication') { logger.error(…); s.lastError = err.message; stop(s.userId) /* or the internal teardown that sets running false */; return; }` before scheduling a reconnect.
- [ ] **Step 4:** `npx jest main/email/watcher-registry.test.js` → PASS. Commit: `fix(imap): reconnect when INBOX will not open; stop on a bad password`.

---

### Task 16: A claim's account resolves from whichever category the chart knows (audit 1.13)

**Files:** `main/routes/claims.js:109-113`, test `main/routes/claims.test.js`

- [ ] **Step 1: Failing test** (uses the exported `_createClaimRecord`):

```js
  describe('account from category', () => {
    test("the form's own heading loses to the reader's category when only the latter matches the chart", async () => {
      const accounts = require('../claims/category-account');
      accounts.resolveAccountCode.mockImplementation(async (uid, c) => c === 'Local Travel' ? '493' : null);
      const rec = await require('./claims')._createClaimRecord({
        userId: testUser.id, groupId: 'g1', row: { no: '1', description: 'Grab to client', amount: 18.4, currency: 'SGD' },
        receipt: { merchant: 'Grab', category: 'Local Travel', total: 18.4 }, match: null,
        category: 'LOCAL TRAVEL COST', store: async () => null,
      });
      expect(rec.accountCode).toBe('493');
      expect(rec.description).toMatch(/^\[LOCAL TRAVEL COST\]/);   // the claimant's wording still leads the description
    });
  });
```
- [ ] **Step 2:** FAIL (accountCode is the default).
- [ ] **Step 3:**

```js
  // The form's heading leads the description, but the chart may only know the
  // reader's wording ("Local Travel" vs "LOCAL TRAVEL COST"): try both.
  const cat = category || (receipt && receipt.category) || null;
  const alt = receipt && receipt.category && receipt.category !== cat ? receipt.category : null;
  const accountCode = (await resolveAccountCode(userId, cat)) || (alt && await resolveAccountCode(userId, alt)) || defaultAccount;
```
- [ ] **Step 4:** `npx jest main/routes/claims.test.js` → PASS. Commit: `fix(claims): resolve the account from the reader's category when the form heading is not in the chart`.

---

### Task 17: `add()` treats undefined like `update()` does (audit 1.11)

**Files:** `main/utils/invoice-store.js:196-207`, test `main/utils/invoice-store.test.js`

- [ ] **Step 1: Failing test**

```js
  test('add ignores undefined fields, so a parser that read nothing does not null a NOT NULL column', () => {
    const store = invoiceStore.forUser(userId);
    const inv = baseInvoice({ hasPdf: undefined, processedAt: undefined });
    expect(() => store.add(inv)).not.toThrow();
    const row = store.getById(inv.id);
    expect(row.hasPdf).toBe(false);
    expect(row.processedAt).toBeTruthy();
  });
```
- [ ] **Step 2:** FAIL (NOT NULL constraint on has_pdf).
- [ ] **Step 3:** in the loop: `if (field === 'id' || field === 'userId' || invoice[field] === undefined) continue;` (replaces the `!(field in invoice)` check).
- [ ] **Step 4:** `npx jest main/utils/invoice-store.test.js` → PASS. Commit: `fix(store): add() skips undefined fields, the same rule update() has`.

---

### Finish

- [ ] `npm test` green (lint included), `npm run build:ui` green.
- [ ] `git push origin master`, then `npm run deploy` (needs `gcloud auth login` first if the token has expired).
- [ ] After deploy: confirm the server's `.env` no longer needs `REDIS_URL` (harmless if present — nothing reads it now), and submit one invoice by hand to see it post inline.
