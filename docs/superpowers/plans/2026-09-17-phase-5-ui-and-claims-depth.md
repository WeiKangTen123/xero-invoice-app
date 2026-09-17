# Phase 5 — Claims depth and UI consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the claim intake tell the truth (PDF receipts are actually read, the phone knows when a read finished or failed, the reader stops inventing business purposes) and pull the UI's duplicated pieces into shared ones.

**Architecture:** Server half first because it is testable end to end with supertest: a text-reading twin of the vision parser, a `parsed_at` column the phone status reads, one exported category list that the prompt, the account hints and the normaliser all consume. UI half second: one API client contract (throw on non-OK, including 401), one badge map, one money/date formatter, one polling hook, one modal, then the mobile breaks. Every task is one test-first commit through the gated runner `scratchpad/jt.sh` (never `;` between the gate and `git commit`).

**Tech Stack:** Node 22 / Express 4, better-sqlite3, jest + supertest (co-located `*.test.js`), React 18 + Vite, eslint.

---

## Server half

### Task 1: PDF receipts are read from their text

Today the PDF branch of `readAndMaybeSplit` only extracts page text to decide whether to split. No field is ever read, and the review page still says "were read from this PDF automatically".

**Files:**
- Modify: `main/utils/receipt-parser.js` (add `parseReceiptText`, share the retry loop)
- Modify: `main/routes/receipts.js` (PDF branch of `readAndMaybeSplit`; `/:id/reread`)
- Test: `main/utils/receipt-parser.test.js`, `main/routes/receipts.test.js`

- [ ] **Step 1: Failing parser tests** — in `receipt-parser.test.js`, a new describe:

```js
describe('receipt-parser — reading a PDF from its text', () => {
  const gemini = require('./gemini-client');
  beforeEach(() => { gemini.callGemini.mockReset(); });

  test('sends the system prompt and the text, with no image part', async () => {
    gemini.callGemini.mockResolvedValue(JSON.stringify({ receipts: [{ merchant: 'Agoda', total: 120, currency: 'SGD', date: '2026-08-17', confidence: 'high' }] }));
    const res = await parser.parseReceiptText('u1', 'AGODA Booking 12345 Total SGD 120.00');
    expect(res.receipts[0]).toMatchObject({ merchant: 'Agoda', total: 120, currency: 'SGD' });
    const [, messages] = gemini.callGemini.mock.calls[0];
    expect(messages[0]).toEqual({ role: 'system', content: parser.SYSTEM_PROMPT });
    expect(messages[1].content).toMatch(/AGODA Booking 12345/);
    expect(JSON.stringify(messages)).not.toMatch(/image_url/);
  });

  test('an unusable reply answers null rather than a half record', async () => {
    gemini.callGemini.mockResolvedValue('not json');
    expect(await parser.parseReceiptText('u1', 'x'.repeat(80))).toBeNull();
  });

  test('blank text is never sent', async () => {
    expect(await parser.parseReceiptText('u1', '   ')).toBeNull();
    expect(gemini.callGemini).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run** `scratchpad/jt.sh main/utils/receipt-parser.test.js` → FAIL: `parser.parseReceiptText is not a function`.

- [ ] **Step 3: Implement** in `receipt-parser.js`: extract the attempt loop of `parseReceiptImage` into `_readWith(userId, userContent, maxAttempts)` and add:

```js
// A PDF with a text layer is read from that text. Same prompt, same
// normaliser, no image: the model cannot place a box on text, so box_2d is
// simply absent and a text PDF is never split by region (pages do that).
async function parseReceiptText(userId, text, { maxAttempts = 2 } = {}) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) return null;
  return _readWith(userId, `Read this receipt text (extracted from a PDF, so there is no image and no box_2d) and return the JSON described.\n\n${body.slice(0, 20000)}`, maxAttempts);
}
```

- [ ] **Step 4: Run** parser tests → PASS.

- [ ] **Step 5: Failing route tests** — `receipts.test.js`: the module mock becomes `{ parseReceiptImage: jest.fn().mockResolvedValue(null), parseReceiptText: jest.fn().mockResolvedValue(null) }`. In the PDF describe add:

```js
    test('a text PDF has its fields read from the text', async () => {
      jest.spyOn(pdfPages, 'extractPages').mockResolvedValue({ pages: ['AGODA total 120'], numPages: 1, hasText: true, textPageCount: 1 });
      parser.parseReceiptText.mockResolvedValueOnce({ receipts: [{ merchant: 'Agoda', total: 120, currency: 'SGD', date: '2026-08-17', lineItems: [], confidence: 'high' }], split: false });
      await upload(PDF_B64, 'application/pdf').expect(201);
      await settle();
      expect(parser.parseReceiptText).toHaveBeenCalledWith(testUser.id, expect.stringContaining('AGODA total 120'));
      expect(rows()[0]).toMatchObject({ vendorName: 'Agoda', totalAmount: 120, currency: 'SGD' });
      pdfPages.extractPages.mockRestore();
    });

    test('each page of a split PDF is read on its own', async () => {
      jest.spyOn(pdfPages, 'extractPages').mockResolvedValue({ pages: ['GRAB '.repeat(20), 'GOJEK '.repeat(20)], numPages: 2, hasText: true, textPageCount: 2 });
      parser.parseReceiptText
        .mockResolvedValueOnce({ receipts: [{ merchant: 'Grab',  total: 10, confidence: 'high', lineItems: [] }], split: false })
        .mockResolvedValueOnce({ receipts: [{ merchant: 'Gojek', total: 20, confidence: 'high', lineItems: [] }], split: false });
      await upload(PDF_B64, 'application/pdf').expect(201);
      await settle();
      const byPage = Object.fromEntries(rows().map(r => [r.receiptPage, r.vendorName]));
      expect(byPage).toEqual({ 1: 'Grab', 2: 'Gojek' });
      pdfPages.extractPages.mockRestore();
    });

    test('a scanned PDF is sent to neither parser', async () => {
      jest.spyOn(pdfPages, 'extractPages').mockResolvedValue({ pages: ['', ''], numPages: 2, hasText: false, textPageCount: 0 });
      await upload(PDF_B64, 'application/pdf').expect(201);
      await settle();
      expect(parser.parseReceiptText).not.toHaveBeenCalled();
      expect(parser.parseReceiptImage).not.toHaveBeenCalled();
      pdfPages.extractPages.mockRestore();
    });
```

  and in the reread describe replace the 400 pin with:

```js
  test('re-reads a PDF from its text', async () => {
    jest.spyOn(pdfPages, 'extractPages').mockResolvedValue({ pages: ['AGODA total 120'], numPages: 1, hasText: true, textPageCount: 1 });
    const { body } = await upload('application/pdf').expect(201);
    await settle();
    parser.parseReceiptText.mockResolvedValueOnce({ receipts: [{ merchant: 'Agoda', total: 120, confidence: 'high', lineItems: [] }], split: false });
    const res = await reread(body.receipt.id).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.receipt.vendorName).toBe('Agoda');
    pdfPages.extractPages.mockRestore();
  });

  test('a scanned PDF reports unreadable instead of pretending', async () => {
    jest.spyOn(pdfPages, 'extractPages').mockResolvedValue({ pages: [''], numPages: 1, hasText: false, textPageCount: 0 });
    const { body } = await upload('application/pdf').expect(201);
    await settle();
    const res = await reread(body.receipt.id).expect(200);
    expect(res.body).toMatchObject({ ok: false, reason: 'unreadable' });
    pdfPages.extractPages.mockRestore();
  });
```

- [ ] **Step 6: Run** `scratchpad/jt.sh main/routes/receipts.test.js` → the three new PDF tests and the two reread tests FAIL.

- [ ] **Step 7: Implement** the PDF branch:

```js
  if (mime === 'application/pdf') {
    const extracted = await pdfPages.extractPages(buffer);
    if (!extracted.hasText) {            // a scan: nothing to read, no renderer to draw it
      logger.info('PDF has no text layer; left for the user', { userId, id });
      return;
    }
    const decision = pdfPages.splittablePages(extracted);
    if (!decision.split) {
      const parsed = await parseReceiptText(userId, extracted.pages.join('\n\n'));
      if (parsed) { await _applyFields(userId, id, parsed.receipts[0]); _flagIfSuspected(userId, id); }
      logger.info('PDF read as one receipt', { userId, id, read: !!parsed, reason: decision.reason });
      return;
    }
    const group  = id;
    const parent = store.getById(id);
    const [first, ...rest] = decision.pageNumbers;
    store.update(id, { receiptPage: first, receiptGroup: group });
    const targets = [[id, first]];
    for (const page of rest) {
      const sib = store.add(newClaimRow({ userId, source: parent.source, groupId: group, extras: {
        receiptFile: storedName, receiptMime: mime, receiptHash: hash, receiptPage: page,
      } }));
      targets.push([sib.id, page]);
    }
    for (const [rowId, page] of targets) {
      const parsed = await parseReceiptText(userId, extracted.pages[page - 1]);
      if (parsed) { await _applyFields(userId, rowId, parsed.receipts[0]); _flagIfSuspected(userId, rowId); }
    }
    logger.info('PDF split by page', { userId, id, pages: decision.pageNumbers.length });
    return;
  }
```

  and the reread route: drop the 400; when `record.receiptMime === 'application/pdf'` extract pages, take `pages[record.receiptPage - 1]` if the record is a page sibling else all pages joined, `parseReceiptText`, and fall into the same "unreadable / apply first receipt" tail (no box choice for a PDF).

- [ ] **Step 8: Run** both files → PASS. Then `scratchpad/jt.sh main/routes main/utils` for the wider net.

- [ ] **Step 9: Commit** `feat(receipts): PDF receipts are read from their text, page by page`.

### Task 2: Honest phone capture

**Files:**
- Modify: `main/db/migrate.js:45-49` (add `['parsed_at', 'parsed_at TEXT']`), `main/db/schema.sql` (`parsed_at TEXT` after `receipt_hash`), `main/utils/invoice-store.js` (`parsedAt: 'parsed_at'` in FIELD_TO_COLUMN; `parsedAt: row.parsed_at` in `_rowToRecord`)
- Modify: `main/routes/receipts.js` (`storeReceipt`'s `.finally`; `/capture/:token/status`)
- Create: `main/middleware/rate-limit-key.js` + test; Modify: `main/index.js` limiter to use it
- Modify: `ui/src/pages/Capture.jsx` (5 s poll, stop on 401, show unreadable)
- Test: `main/routes/receipts.test.js` (status describe), `main/middleware/rate-limit-key.test.js`

- [ ] **Step 1: Failing status tests** — replace the test at `receipts.test.js:592` with:

```js
  test('before the read finishes, parsed is false', async () => {
    const { body } = await pair().expect(201);
    await capture(body.token).expect(201);          // do NOT settle
    const res = await request(server).get(`/api/receipts/capture/${body.token}/status`).expect(200);
    expect(res.body.receipts[0]).toMatchObject({ parsed: false, unreadable: false });
    await settle();
  });

  test('an unreadable receipt reports parsed with unreadable, so the phone stops spinning', async () => {
    parser.parseReceiptImage.mockResolvedValueOnce(null);
    const { body } = await pair().expect(201);
    await capture(body.token).expect(201);
    await settle();
    const res = await request(server).get(`/api/receipts/capture/${body.token}/status`).expect(200);
    expect(res.body.receipts[0]).toMatchObject({ parsed: true, unreadable: true, vendorName: null });
  });
```

  (use the describe's existing pair/capture helpers by their real names.)

- [ ] **Step 2: Run** → FAIL (`parsed` true before settle is impossible today; `unreadable` undefined).

- [ ] **Step 3: Implement**: column + store mapping; in `storeReceipt`:

```js
      .finally(() => {
        // Whatever happened, the read is over. Every row from this upload
        // (the parent and any page/region siblings) is stamped so the phone
        // can tell "still reading" from "read, nothing found".
        const at = new Date().toISOString();
        const s = invoiceStore.forUser(userId);
        for (const r of s.getAll()) if (r.id === id || r.receiptGroup === id) s.update(r.id, { parsedAt: at });
        resolve();
      });
```

  status route: `parsed: !!r.parsedAt, unreadable: !!r.parsedAt && !r.vendorName && !r.totalAmount`.

- [ ] **Step 4: Run** → PASS. Commit `feat(capture): the phone is told when a read finished and whether it found anything`.

- [ ] **Step 5: Failing limiter-key test** — `main/middleware/rate-limit-key.test.js`:

```js
const jwt = require('jsonwebtoken');
const { rateLimitKey } = require('./rate-limit-key');
const { jwtSecret } = require('./auth-middleware');

const req = (over = {}) => ({ headers: {}, path: '/api/invoices', ip: '10.0.0.1', ...over });

test('a signed-in request is keyed by user, not by the office IP', () => {
  const token = jwt.sign({ id: 'u1' }, jwtSecret());
  expect(rateLimitKey(req({ headers: { authorization: `Bearer ${token}` } }))).toBe('user:u1');
});
test('a bad token falls back to the IP', () => {
  expect(rateLimitKey(req({ headers: { authorization: 'Bearer nope' } }))).toBe('ip:10.0.0.1');
});
test('a phone capture link is keyed by its token so one phone cannot drain the office', () => {
  expect(rateLimitKey(req({ path: '/api/receipts/capture/abc123/status' }))).toBe('capture:abc123');
  expect(rateLimitKey(req({ path: '/api/receipts/capture/abc123' }))).toBe('capture:abc123');
});
```

- [ ] **Step 6: Run** → FAIL (module missing). **Implement** `rate-limit-key.js`:

```js
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('./auth-middleware');
// One bucket per signed-in user; one per phone-capture link (its token is the
// only identity it has); the IP for everything else.
function rateLimitKey(req) {
  const m = /^\/api\/receipts\/capture\/([^/]+)/.exec(req.path || '');
  if (m) return `capture:${m[1]}`;
  const auth = req.headers?.authorization || '';
  if (auth.startsWith('Bearer ')) {
    try { return `user:${jwt.verify(auth.slice(7), jwtSecret()).id}`; } catch { /* fall through */ }
  }
  return `ip:${req.ip}`;
}
module.exports = { rateLimitKey };
```

  `index.js`: `keyGenerator: rateLimitKey`.

- [ ] **Step 7: Run** → PASS. Capture.jsx: interval 5000; on `res.status === 401` set state `expired` and return; render `s.unreadable ? "Couldn't read this one — check it on your computer" : "◍ Reading…"`. `npm --prefix ui run lint`. Commit `fix(capture): phone polls by its own bucket, stops on an expired link, and says when a read found nothing`.

### Task 3: One category list; the reader stops inventing purposes

**Files:**
- Create: `main/claims/categories.js` + `categories.test.js`
- Modify: `main/utils/receipt-parser.js` (SYSTEM_PROMPT built from the list; `normalise` canonicalises category), `main/claims/category-account.js` (hint keys checked against the list), `docs/CLAIM_INTELLIGENCE_GUIDELINES.md` §1–3
- Test: `main/utils/receipt-parser.test.js`, `main/claims/category-account.test.js`

- [ ] **Step 1: Failing tests**

```js
// categories.test.js
const { CATEGORIES, CATEGORY_NAMES, canonicalCategory } = require('./categories');
test('ten named categories, each with a scope line for the prompt', () => {
  expect(CATEGORY_NAMES).toHaveLength(10);
  for (const c of CATEGORIES) expect(c.scope.length).toBeGreaterThan(10);
});
test('canonicalCategory forgives case and spacing, and rejects anything else', () => {
  expect(canonicalCategory(' staff  welfare ')).toBe('Staff Welfare');
  expect(canonicalCategory('Entertainment / Meals')).toBe('Entertainment/Meals');
  expect(canonicalCategory('Bribes')).toBeNull();
  expect(canonicalCategory(null)).toBeNull();
});
```

```js
// receipt-parser.test.js additions
test('the prompt names every category and forbids inventing a business purpose', () => {
  for (const name of CATEGORY_NAMES) expect(parser.SYSTEM_PROMPT).toContain(`"${name}"`);
  expect(parser.SYSTEM_PROMPT).toMatch(/do not invent a business purpose/i);
  expect(parser.SYSTEM_PROMPT).not.toMatch(/with client/i);
});
test('a category the model reworded is canonicalised; an invented one is dropped', () => {
  expect(parser.normalise({ ...good, category: 'staff welfare', description: 'Snacks' }).description).toBe('[Staff Welfare] Snacks');
  const r = parser.normalise({ ...good, category: 'Bribes', description: 'Snacks' });
  expect(r.category).toBeNull();
  expect(r.description).toBe('Snacks');
});
```

```js
// category-account.test.js addition
test('the hint table covers exactly the categories the reader can return', () => {
  expect(Object.keys(CATEGORY_HINTS).sort()).toEqual([...CATEGORY_NAMES].sort());
});
```

- [ ] **Step 2: Run** the three files → FAIL. **Implement** `categories.js` (names as today; scope text from the guideline §2 "Description & Scope" column), rewrite the prompt's category and description sections:

```
- category: one of these exact names, judged from what was bought and when:
    "Entertainment/Meals": <scope>
    ... (one line per category, generated)
  Meals paid at or after 21:00 are "Staff Overtime Meal". Rides paid at or after 21:30 are "Overtime Transport".
- description: WHAT was bought and WHERE, from what is printed, max 200 characters.
  Format: "[Category] <what was bought> @ <Merchant> (<HH:MM>)" — for a ride, "<pickup> to <dropoff>" in place of what was bought when both are printed.
  Do not invent a business purpose, a client, a meeting or a reason: the claimant adds that when they review. "Lunch for 2 @ Dong Seoul Supply (12:01)" is right; "Business working lunch with client" is not, because the receipt does not say so.
```

  `normalise`: `const category = canonicalCategory(parsed.category);`. `category-account.js`: `const { CATEGORY_NAMES } = require('./categories');` and after the table `for (const n of Object.keys(CATEGORY_HINTS)) if (!CATEGORY_NAMES.includes(n)) throw new Error(...)` (a load-time guard; the test is the real check).

- [ ] **Step 3: Run** → PASS; `scratchpad/jt.sh main/utils main/claims`. Guideline doc: §1 says the claimant supplies the purpose; §2 account column becomes "matched by name against the org's chart — see `main/claims/category-account.js`; no code is fixed"; §3 becomes "time decides the category only"; add a "PDF receipts" note. Commit `feat(claims): one category list; the reader describes what was bought and no longer invents a purpose`.

### Task 4: Import pacing lives in one place

`claim-import.js` sleeps 4 s between reads "for the free tier". If `gemini-client.js` already paces calls, that sleep is a second, blind throttle; if not, it is the only one and stays. Decide from the client's code (recorded in the commit message). If it goes: `READ_INTERVAL_MS = 0`, comment updated, and `claim-import.test.js` gets `test('reads are not paced here — the model client paces every caller')` asserting `READ_INTERVAL_MS === 0`.

## UI half

(Appended after the UI survey — each task lists file:line targets, the failing check (`npm --prefix ui run lint`, `npm --prefix ui test`, or a build), and the code.)
