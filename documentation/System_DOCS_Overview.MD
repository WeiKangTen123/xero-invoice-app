# Xero Invoice Automation — System Overview

---

## What This System Does

A Node.js automation that supports **multiple independent users**, each with their own email account and Xero organisation:

- Watches each user's Gmail inbox for new emails (last **100 days**)
- Detects emails with PDF invoice attachments or structured template bodies
- Parses PDFs using an **LLM (Gemini / Nvidia / OpenRouter)** — no hardcoded vendor patterns
- Image-based / scanned PDFs (no extractable text) are saved and marked `review-needed` for manual data entry
- Batch-processes up to **5 PDFs concurrently** per email, respecting Gemini's 15 RPM free-tier limit
- Automatically creates a **Draft Bill (ACCPAY)** or **Sales Invoice (ACCREC)** in Xero per PDF
- **Deduplication** prevents the same invoice from ever appearing twice in Xero
- Exposes a **web UI** for process control, setup, invoice review, and manual Xero submission

---

## Multi-Tenancy — Data Isolation

Every user is completely independent. Nothing is shared between users except the server binary.

| Resource | Scope |
|---|---|
| Invoice history (`invoices.json`) | Per-user |
| PDF files (`pdfs/`) | Per-user |
| IMAP account | Per-user |
| Xero organisation | Per-user |
| LLM API key | Per-user |
| Xero token cache (in-memory) | Per-user |
| Auto-process toggle | Per-user |
| Account code / currency defaults | Per-user |
| IMAP watcher connection | Per-user |
| JWT secret | Server-wide |
| Slack webhook | Server-wide (optional) |

Per-user data lives under:
```
main/data/users/{userId}/
  config.json       IMAP + Xero + LLM credentials (created empty on account creation)
  settings.json     autoProcess toggle (created on first toggle)
  invoices.json     Invoice history — max 500 entries (created on first invoice)
  pdfs/             PDF files attached to Xero invoices (created on first PDF)
```

**Directory provisioning:**
- `createUser` immediately creates `data/users/{id}/` and an empty `config.json` on registration
- On every server startup, `ensureUserDirectories()` is called — it creates any missing directories for users already in `users.json` (safe no-op if already present). This guards against accounts created before directory provisioning was in place.

---

## System Flow

```
User's Gmail inbox
        ↓
Per-user IMAP watcher (watcher-registry.js)
  - Detects UNSEEN emails within 60 s (IMAP IDLE keepalive)
  - Falls back to polling every 60 s
  - 3 s debounce on flag-change events (mark-as-unread rescans)
        ↓
For each email → parser.js
  ┌─ Has PDF attachment(s)?
  │   YES → extract text (pdf-parse) for each PDF
  │          → send to LLM (up to 5 PDFs concurrently, rate-limited)
  │          → LLM returns structured JSON
  │          → one ACCPAY Bill per PDF
  │
  ├─ Has "Client / Customer:" in body? (template format)
  │   YES → regex parse body → one ACCREC Invoice
  │
  └─ Neither → skip silently
        ↓
invoice-handler.js (per-user)
  1. Upfront dedup check (findPosted) — skip if already in Xero
  2. Reject zero-amount + auto-number invoices (LLM parse failure) → status: review-needed
  3. Save PDF to per-user storage
  4. Add record to invoices.json (status: pending)
  5. Sequential Xero submission queue (_xeroChain, 1.5 s gap)
     └─ Race-guard dedup check just before API call
     └─ POST to Xero → mark as posted / duplicate / error

Manual submission path (UI → POST /api/invoices/:id/submit):
  → submitInvoiceToXero(userId, invoiceId)
  → Same Xero path as automated, but bypasses the rate-limiting chain
  → Idempotent: already-posted invoices return existing xeroInvoiceId, no duplicate created
```

---

## Where Invoices Appear in Xero

| Type | Code | Xero Navigation |
|---|---|---|
| Supplier Bill (PDF attachment) | `ACCPAY` | Purchases → **Bills to Pay → Drafts** |
| Sales Invoice (template email) | `ACCREC` | Accounts Receivable → **Invoices → Drafts** |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         BROWSER (React UI)                          │
│                                                                     │
│   Login ──► Dashboard ──► Setup ──► Invoices ──► Admin             │
│              (start/stop)  (per-user keys)  (history) (admin only) │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ HTTP / JWT
┌──────────────────────────────▼──────────────────────────────────────┐
│                       EXPRESS API (main/)                           │
│                                                                     │
│   /api/auth    /api/setup    /api/process    /api/invoices          │
│   login/reg    per-user cfg  start/stop/scan  CRUD + submit        │
│                /api/admin (admin only)                              │
│                                                                     │
│  watcher-registry.js  ──────────────────────────────────────────   │
│    Map<userId, WatcherState>                                        │
│    Per-user IMAP connection + reconnect + debounce + poll           │
│         │                                                           │
│         ▼                                                           │
│    parser.js  (per-user, batch-aware)                               │
│    ┌──────────────────────────┐                                     │
│    │  PDF batch (max 5/email) │                                     │
│    │  llm-parser.js           │                                     │
│    │  UserRateLimiter         │  15 RPM / 500 RPD (Gemini free)    │
│    │  extractWithRetry (×4)   │  Gemini → Nvidia → OpenRouter      │
│    └──────────────────────────┘                                     │
│         │                                                           │
│         ▼                                                           │
│    invoice-handler.js  createHandler(userId)                        │
│    - findPosted() dedup (normalised vendor name)                    │
│    - Per-user _xeroChain (sequential, 1.5 s gaps)                  │
│    - submitInvoiceToXero(userId, id) — reusable standalone submit  │
│         │                                                           │
│         ▼                                                           │
│    contacts.js / invoices.js                                        │
│    new AccountingApi() per call (no shared singleton)               │
│    tokenCache.forUser(userId)                                       │
│                                                                     │
│  Per-user stores (factory pattern):                                 │
│    invoice-store.js   pdf-store.js   settings-store.js             │
│    token-cache.js     process-state.js                              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Full Project Structure

```
xero-invoice-app/
│
├── main/                              Backend (Node.js / Express)
│   ├── index.js                       Entry point — mounts routes, serves UI build
│   │                                  Calls ensureUserDirectories() on startup
│   ├── .env                           Server-wide secrets (JWT_SECRET, SLACK_WEBHOOK_URL)
│   ├── .env.example                   Template
│   │
│   ├── data/
│   │   ├── users.json                 User accounts (hashed passwords, roles)
│   │   └── users/{userId}/
│   │       ├── config.json            Per-user IMAP + Xero + LLM credentials
│   │       ├── settings.json          autoProcess toggle
│   │       ├── invoices.json          Invoice history (max 500)
│   │       └── pdfs/                  PDF files attached to Xero
│   │
│   ├── email/
│   │   ├── watcher-registry.js        Per-user IMAP watcher management
│   │   │                              Map<userId, WatcherState>
│   │   │                              Reconnect: 10 s → 5 min cap, max 20 retries
│   │   │                              3 s debounce on flag-change (mark-as-unread)
│   │   ├── parser.js                  Batch PDF parser — up to 5 PDFs concurrently
│   │   │                              Promise.allSettled per chunk of 5
│   │   └── llm-parser.js              LLM extraction with per-user rate limiter
│   │                                  UserRateLimiter: 15 RPM sliding window, 5 max concurrent
│   │                                  429 back-off: attempt × 15 s wait
│   │                                  Provider priority: Gemini → Nvidia → OpenRouter
│   │
│   ├── xero/
│   │   ├── xero-utils.js              Shared Xero helpers: withRetry (429 back-off), xeroErrMsg
│   │   ├── connect.js                 refreshClientCredentialsToken(userId)
│   │   │                              autoConnect(userId) — per-user only, no .env fallback
│   │   ├── contacts.js                getOrCreateContact(userId, tenantId, ...)
│   │   │                              new AccountingApi() per call (no singleton)
│   │   └── invoices.js                createDraftInvoice(userId, tenantId, invoiceData)
│   │                                  Attaches original PDF + email body to Xero draft
│   │
│   ├── queue/
│   │   └── processor.js               enqueueInvoice(userId, invoiceData)
│   │                                  Bull/Redis if REDIS_URL set, else inline
│   │                                  Updates invoiceStore to 'posted' after Bull job succeeds
│   │
│   ├── routes/
│   │   ├── auth.js                    POST /api/auth/login, /register (open)
│   │   │                              GET /api/auth/status, /api/auth/me
│   │   ├── setup.js                   GET/POST /api/setup (per-user config.json)
│   │   │                              GET /api/setup/status
│   │   │                              POST /api/setup/test/xero|imap|llm
│   │   ├── process.js                 POST /api/process/start|stop|rescan
│   │   │                              GET/PATCH /api/process/status|settings
│   │   ├── invoices.js                Full invoice CRUD + manual submit
│   │   │                              GET /api/invoices/:id/pdf-url (signed URL)
│   │   │                              GET /api/invoices/:id/pdf (Bearer or ?token=)
│   │   │                              PATCH /api/invoices/:id (edit fields)
│   │   │                              POST /api/invoices/:id/submit (manual Xero post)
│   │   ├── admin.js                   GET /api/admin/users|reports
│   │   │                              POST /api/admin/users
│   │   │                              PATCH /api/admin/users/:id (promote/demote role)
│   │   │                              DELETE /api/admin/users/:id
│   │   │                              PATCH /api/admin/reports/:userId/:id/resolve
│   │   └── dashboard.js               GET /api/dashboard (Xero org list),
│   │                                  GET /dashboard/health (legacy alias)
│   │
│   ├── middleware/
│   │   └── auth-middleware.js         requireAuth, requireAdmin, jwtSecret()
│   │
│   └── utils/
│       ├── invoice-store.js           forUser(userId) factory — per-user invoices.json
│       │                              Write mutex (_writeLock promise chain)
│       │                              findPosted(): normalised vendor name dedup
│       │                              getFlagged(): reported + review-needed (admin view)
│       ├── pdf-store.js               forUser(userId) factory — per-user pdfs/
│       ├── settings-store.js          forUser(userId) factory — per-user settings.json
│       ├── token-cache.js             forUser(userId) factory — in-memory Xero tokens
│       ├── process-state.js           forUser(userId) factory — watcher activity state
│       │                              invoiceCount tracked in-memory (no disk reads on poll)
│       ├── invoice-handler.js         createHandler(userId) — orchestrates dedup + queue
│       │                              submitInvoiceToXero(userId, id) — reusable standalone
│       ├── users.js                   User account CRUD (users.json)
│       │                              getUserConfig / saveUserConfig / getSetupStatus
│       │                              updateUserRole(id, role)
│       │                              ensureUserDirectories() — called at startup
│       ├── logger.js                  Winston structured logging
│       └── notify.js                  Slack webhook (optional)
│
├── ui/                                Frontend (React + Vite)
│   ├── index.html
│   ├── vite.config.js
│   ├── package.json
│   └── src/
│       ├── main.jsx
│       ├── App.jsx                    Router + theme provider
│       ├── pages/
│       │   ├── Login.jsx
│       │   ├── Dashboard.jsx          Start/stop watcher, activity feed, Xero org
│       │   ├── Setup.jsx              Per-user config (IMAP, Xero, LLM, defaults)
│       │   ├── Invoices.jsx           Invoice table — status filters, needs-action banner
│       │   ├── InvoiceReview.jsx      PDF viewer + field editor + Post to Xero button
│       │   └── Admin.jsx              User management, cross-user flagged reports
│       ├── components/
│       │   ├── layout/Layout.jsx, Sidebar.jsx, Header.jsx
│       │   ├── ProcessToggle.jsx
│       │   ├── HelpTooltip.jsx
│       │   └── InvoiceTable.jsx
│       ├── api/client.js              fetch wrapper — JWT header injection + 401 auto-logout
│       └── styles/
│           ├── globals.css
│           └── theme.css              CSS variables — dark/light theme
│
├── documentation/
│   └── System_DOCS_Overview.MD       This file
│
├── package.json
├── Procfile                           Railway: node main/index.js
├── railway.json
├── .gitignore
└── .nvmrc
```

---

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | — | Login, returns JWT |
| POST | `/api/auth/register` | — | Self-register (open). First user = admin, rest = user. Returns JWT immediately. |
| GET | `/api/auth/status` | — | Returns `{ hasUsers }` — used by UI to show register vs login on first boot |
| GET | `/api/auth/me` | JWT | Current user info `{ id, email, role }` |
| GET | `/api/setup/status` | JWT | Which sections are configured, `ready` flag |
| GET | `/api/setup` | JWT | Full config for this user — actual values returned (secrets hidden by default in UI, revealed with eye toggle) |
| POST | `/api/setup` | JWT | Save this user's config |
| POST | `/api/setup/test/xero` | JWT | Test Xero connection |
| POST | `/api/setup/test/imap` | JWT | Test IMAP connection |
| POST | `/api/setup/test/llm` | JWT | Test LLM API key |
| GET | `/api/process/status` | JWT | Watcher running + invoice count + `setupRequired` + `missingConfig` |
| POST | `/api/process/start` | JWT | Start this user's IMAP watcher |
| POST | `/api/process/stop` | JWT | Stop this user's IMAP watcher |
| POST | `/api/process/rescan` | JWT | Immediate inbox scan (rate-limited: 1 per 30 s) |
| GET | `/api/process/settings` | JWT | autoProcess toggle value |
| PATCH | `/api/process/settings` | JWT | Update autoProcess toggle |
| GET | `/api/invoices` | JWT | List this user's invoices (includes `submittedAt`, `xeroInvoiceId`, `errorMsg`) |
| GET | `/api/invoices/:id` | JWT | Full invoice detail |
| GET | `/api/invoices/:id/pdf-url` | JWT | Returns a 5-minute signed URL for direct PDF browser access |
| GET | `/api/invoices/:id/pdf` | JWT or `?token=` | Serve PDF binary. Accepts Bearer header (API) or signed `?token=` (browser navigation/iframe) |
| PATCH | `/api/invoices/:id` | JWT | Correct LLM-extracted fields (`vendorName`, `invoiceNumber`, `totalAmount`, `lineItems`, etc.). Blocked on `posted`/`duplicate`. |
| POST | `/api/invoices/:id/submit` | JWT | Manually submit (or re-submit) invoice to Xero. Idempotent — won't duplicate if already posted. |
| PATCH | `/api/invoices/:id/status` | JWT | Manual status transition. `posted` and `duplicate` are locked and cannot be changed. |
| POST | `/api/invoices/:id/report` | JWT | Flag an issue for admin review |
| DELETE | `/api/invoices/:id` | JWT | Delete invoice + PDF |
| DELETE | `/api/invoices` | JWT | Clear all invoices + PDFs for this user |
| GET | `/api/admin/users` | Admin | List all users |
| POST | `/api/admin/users` | Admin | Create user |
| PATCH | `/api/admin/users/:id` | Admin | Promote or demote user role. Cannot demote last admin or self. |
| DELETE | `/api/admin/users/:id` | Admin | Delete user + their data directory |
| GET | `/api/admin/reports` | Admin | All flagged invoices across all users (`reported` + `review-needed`) |
| PATCH | `/api/admin/reports/:userId/:id/resolve` | Admin | Resolve a flagged invoice |
| GET | `/dashboard/health` | — | Health check |

---

## PDF Viewer Authentication

Browsers cannot send custom `Authorization` headers on direct navigation (new tab, `<iframe src>`, `<embed>`). The PDF viewer uses a two-step flow:

```
1. GET /api/invoices/:id/pdf-url   (with Bearer JWT)
   ← { url: "/api/invoices/:id/pdf?token=xxx", expiresIn: "5m" }

2. <iframe src={url}>  or  window.open(url)
   → token verified for scope (purpose=pdf, invoiceId match)
   ← PDF stream
```

The signed token is a standard JWT (same `jwtSecret`) scoped to one `userId + invoiceId`, valid for 5 minutes. The frontend refreshes it every 4 minutes while the review page is open.

The `pdf-url` endpoint also verifies the PDF file physically exists on disk before issuing a token. If the file has been deleted, it returns a clear 404 instead of issuing a token that would silently fail inside an iframe. The frontend shows "PDF could not be loaded" with a Retry button rather than an infinite spinner.

---

## Manual Invoice Submission Workflow

For invoices that the LLM failed to auto-process (`review-needed`), where Xero submission failed (`error`), or that the user has reviewed but not yet posted (`reviewed`):

```
1. Invoices list:
   - "Fix & Post →"    for review-needed / error rows
   - "Post to Xero →"  for reviewed rows (blue tint — clear call to action)
   - "View →"          for already-posted / duplicate rows (read-only)
2. InvoiceReview page → view PDF on the left, extracted fields on the right
3. (Optional) Correct fields — no need to re-parse; PATCH /api/invoices/:id
4. Click "Post to Xero" — calls POST /api/invoices/:id/submit
5. On success: status → posted, Xero Invoice ID shown
6. On failure: error message shown, retry available (idempotent)
```

A blue info banner appears in the invoice list whenever any `reviewed` invoices exist, making it clear they still need posting.

The submit endpoint is reusable — calling it on an already-posted invoice returns the existing Xero ID without creating a duplicate.

---

## Invoice Statuses

| Status | Meaning | UI Label | Color |
|---|---|---|---|
| `pending` | Parsed, waiting for submission | Pending | Yellow |
| `reviewed` | User verified the data — **not yet in Xero** | ● Ready to Post | Blue |
| `posted` | Successfully created as a draft in Xero | ✓ Posted | Green |
| `duplicate` | Already in Xero, skipped | Duplicate | Gray |
| `review-needed` | LLM failed to extract amount/invoice number — not submitted | ⚠ Needs Review | Yellow |
| `error` | Xero API call failed (e.g. auth, network) | ✕ Error | Red |
| `reported` | User flagged an issue — visible to admin | ⚠ Reported | Red |

**Status transition rules:**
- `posted` and `duplicate` are **locked** — cannot be changed via `PATCH /api/invoices/:id/status`
- Only `review-needed`, `error`, `pending`, `reviewed` can be submitted to Xero
- `reviewed` ("Ready to Post") and `posted` are visually distinct (blue vs green) — blue means the user has verified the data but it is not yet in Xero
- A blue info banner in the invoice list alerts the user when any `reviewed` invoices are awaiting posting

---

## PDF Error Handling — Server Never Crashes

The invoice type (`ACCPAY` or `ACCREC`) is determined by **email structure**, not by what is inside the PDF. A corrupt or unreadable PDF cannot change the type or crash the server.

### Type mapping (decided before PDF content is read)

```
Email arrives
    │
    ├─ Has PDF attachment?       ──► invoiceType = ACCPAY (Bill → Xero Purchases)
    │       │
    │       ├─ Text extractable?
    │       │       YES → LLM parses it
    │       │               LLM fails? → fallback to regex parser
    │       │               Amount = 0 AND no invoice number? → status: review-needed
    │       │                                                    (saved in UI, NOT sent to Xero)
    │       │
    │       └─ No text / corrupt PDF
    │               → generic regex parser (extracts what it can from email headers)
    │               → amount = 0 → status: review-needed
    │
    ├─ Email body matches template format?  ──► invoiceType = ACCREC (Invoice → Xero Sales)
    │       YES → regex parse body → one invoice
    │
    └─ Neither PDF nor template  ──► Skipped entirely (no record created)
           e.g. marketing emails, newsletters
```

### What happens on each failure scenario

| Scenario | Outcome | Server crash? |
|---|---|---|
| Corrupt / unreadable PDF | Saved as `review-needed` — user can manually fix and post | No |
| Scanned image PDF (no text) | Generic regex parser, then `review-needed` if amount = 0 | No |
| LLM parse fails (wrong format) | Fallback to regex parser automatically | No |
| LLM rate limited (429) | Retries up to 4× with backoff, then regex fallback | No |
| One PDF fails in a batch | Other PDFs in the same email still process (`Promise.allSettled`) | No |
| Xero API rejects the invoice | Marked `error` in UI — retry available | No |
| Non-invoice email (marketing, receipts) | Logged as "no invoices" — processing continues | No |

**Key rule:** `review-needed` invoices are visible in the Invoices list. You can open them, correct the extracted fields, and click **Post to Xero** manually. Nothing is ever silently lost.

---

## Deduplication Logic

Implemented in `invoice-store.js → findPosted()` and `invoice-handler.js`.

### Two-layer dedup

**Layer 1 — Upfront check** (before storing):
- Calls `findPosted()` immediately. If a matching posted invoice exists, skip entirely.

**Layer 2 — Race guard** (just before Xero API call):
- Re-checks `findPosted()` to catch cases where a concurrent scan posted the same invoice while this one was waiting in the queue.

### Vendor name normalisation

`_normalizeVendor()` strips before comparing:
- Lowercases the full name
- Removes honorifics: `Mr`, `Mrs`, `Miss`, `Ms`, `Dr`, `Prof`
- Removes legal suffixes: `Pte Ltd`, `Pte. Ltd.`, `Pvt Ltd`, `LLC`, `Inc`, `Corp`, `Co`, `Ltd`, `GmbH`, etc.
- Normalises whitespace and punctuation

`"BLCKLB PTE. LTD."` and `"blcklb Pte Ltd"` → same vendor.
`"Miss Thitipat Srikhongnattakul"` and `"Thitipat Srikhongnattakul"` → same vendor.

### Matching rules

| Incoming invoice number | Match condition |
|---|---|
| Real number (e.g. `040526-3`) | Same normalised vendor + same invoice number (case-insensitive) |
| Auto-generated (`INV-<timestamp>`) or missing | Same normalised vendor + same date + amount within $0.01 |
| Cross-match | Real-number invoice arriving after a zero-amount auto-number for the same vendor+date is still caught |

### Zero-amount guard

If an invoice has **no real invoice number AND `totalAmount === 0`**, the LLM failed. Record is saved locally with status `review-needed` but is **never submitted to Xero**.

---

## LLM Invoice Parsing

| Field | Description |
|---|---|
| `vendorName` | Seller / service provider (never the buyer) |
| `vendorAddress`, `vendorEmail`, `vendorPhone` | Contact details |
| `invoiceNumber` | Invoice reference |
| `invoiceDate`, `dueDate` | `YYYY-MM-DD` |
| `currency` | e.g. `SGD`, `USD` — preserved as-is |
| `lineItems` | Array of `{ description, unitAmount, taxType, discountRate }` |
| `totalAmount` | Total due as number |
| `paymentReference` | Bank / PayNow details |
| `projectName` | Artist / project name → Xero Reference field |
| `invoiceType` | `ACCPAY` (bill) or `ACCREC` (sales invoice) |

### Rate limiting (per user)

| Provider | RPM limit |
|---|---|
| Gemini (free tier) | 15 |
| Nvidia / OpenRouter | varies |

- Sliding 60 s window — max 15 starts per window, max 5 concurrent per user
- On 429: waits `attempt × 15 s` before retry (up to 4 attempts)
- Fallback: if all LLM attempts fail, falls back to regex parser

---

## Environment Variables

### Server-wide (set in Railway / `.env`)

```
JWT_SECRET=         # Required — any long random string (min 32 chars)
NODE_ENV=production
PORT=3000           # Optional — defaults to 3000
SLACK_WEBHOOK_URL=  # Optional — error + invoice notifications
REDIS_URL=          # Optional — enables Bull queue; without this, inline processing
```

### Setup page credential display

`GET /api/setup` returns **actual values** for all fields (including secrets such as API keys and passwords). The UI handles display:

- Secret fields (API keys, passwords, client secrets) are rendered as `type="password"` by default
- An **eye icon** (👁) button toggles visibility per field
- A hint at the bottom of each section reads: *"Secrets are hidden by default — click 👁 to reveal"*
- Fields pre-populate with saved values so users can verify or update individual keys without re-entering everything

`config.json` starts as `{}` on account creation. Users must fill in credentials via the Setup page on first use. Old global `.env` credentials are **not** migrated automatically.

---

### Per-user (set in Setup page, stored in `data/users/{id}/config.json`)

```
# Xero Custom Connection
XERO_CLIENT_ID=
XERO_CLIENT_SECRET=

# IMAP
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_USER=
IMAP_PASS=                    # Gmail App Password
IMAP_FILTER_FROM=             # Optional: only process emails from this sender
IMAP_POLL_INTERVAL_MS=60000

# LLM (priority: Gemini → Nvidia → OpenRouter)
Gemini_API_KEY=
Nvidia_API_KEY=
OPENROUTER_API_KEY=
OPENROUTER_MODEL=

# Xero defaults
DEFAULT_ACCOUNT_CODE=200
DEFAULT_CURRENCY=SGD
ZERO_TAX_RATE=NONE
```

---

## Xero App Setup (Custom Connection)

1. `developer.xero.com` → **My Apps** → **New App** → Type: **Custom Connection**
2. Scopes: `accounting.invoices`, `accounting.contacts`, `accounting.settings.read`
3. **Configuration** tab → copy **Client ID** and **Client Secret**
4. **Connection Management** → add your Xero organisation
5. Paste into Setup page → **Test Xero**

---

## Gmail App Password

1. `myaccount.google.com` → **Security** → **2-Step Verification** (must be on)
2. **App passwords** → App: Mail, Device: Other → name: `Xero Invoice App`
3. Copy the 16-character password → paste as `IMAP_PASS`

---

## Xero Token Handling

- **No OAuth browser flow** — uses Xero Custom Connection (client credentials grant)
- Tokens refreshed automatically when expired (`getValidToken` in `token-cache.js`)
- Fresh `AccountingApi()` per Xero call — no token contamination between concurrent users
- Xero credentials are strictly per-user; the server `.env` has no Xero keys

---

## Write Safety

Each `invoice-store.forUser(userId)` has its own `_writeLock` promise chain. All mutations are serialised — concurrent email processing for the same user never corrupts `invoices.json`. Different users' stores never block each other.

`users.json` has its own `_usersWriteLock` — concurrent admin operations (create/delete/promote) are serialised.

---

## Admin Capabilities

| Action | Endpoint |
|---|---|
| List all users | `GET /api/admin/users` |
| Create user | `POST /api/admin/users` |
| Promote/demote role | `PATCH /api/admin/users/:id` — cannot demote last admin or self |
| Delete user | `DELETE /api/admin/users/:id` — removes user from `users.json` and deletes their entire `data/users/{id}/` directory |
| View all flagged invoices | `GET /api/admin/reports` — includes both `reported` and `review-needed` |
| Resolve flagged invoice | `PATCH /api/admin/reports/:userId/:id/resolve` |

---

## Deployment (Railway)

1. Push to a **private** GitHub repo (never commit `.env`)
2. Railway → **New Project** → **Deploy from GitHub repo**
3. Start Command: `node main/index.js`
4. Set environment variables (server-wide only)
5. **Settings → Domains → Generate Domain**
6. Visit URL → **Register** (first user = admin)
7. **Setup** → fill in IMAP, Xero, LLM credentials
8. **Dashboard** → **Start**

---

## How to Run Locally

```bash
# Install backend deps
npm install

# Start both backend + frontend in dev mode (concurrently)
npm run dev

# Frontend only (proxies API to Express on :3000)
cd ui && npm install && npm run dev

# Frontend production build (served by Express from ui/dist/)
cd ui && npm run build

# Backend only (with nodemon auto-restart)
npm run dev:server
```

### Dev server details

`npm run dev` runs three scripts in order:

1. **`predev`** — auto-kills anything on port 3000 before starting (`lsof -ti:3000 | xargs kill -9`). Prevents stale processes from causing startup failures.
2. **`dev:server`** — starts nodemon with `--delay 500ms` (grace period between file change and restart, so the OS releases the port before the new instance binds).
3. **`dev:ui`** — starts the Vite dev server for the React frontend.

### Graceful shutdown

On `SIGTERM` or `SIGINT` (nodemon restart, `Ctrl+C`, Railway deploy), the server calls `server.close()` before `process.exit()`. This releases the port immediately so nodemon can restart without hitting `EADDRINUSE`. A 5-second force-exit timeout is in place as a safety net if connections don't drain.

---

## Roles

| Role | Access |
|---|---|
| `admin` | All pages including `/admin` — manage users, view cross-user flagged reports, resolve issues |
| `user` | Dashboard, Setup, Invoices — fully isolated from other users |

---

## Code Architecture — Key Decisions

| Decision | Why |
|---|---|
| `withRetry` + `xeroErrMsg` in `xero/xero-utils.js` | Shared by `contacts.js` and `invoices.js` — single source of truth for Xero 429 handling and error formatting |
| `watcher-registry.js` collects Buffer chunks, decodes once | Converting each TCP chunk to string individually corrupts multi-byte UTF-8 chars split across packet boundaries |
| `process-state.js` tracks invoiceCount in memory | `getStatus()` is called on every 15 s dashboard poll — avoids a full `invoices.json` read on every tick; synced from disk once per server lifetime |
| `sanitizeFilename` uses `\u` hex escapes in regex | Literal Unicode chars in source files are fragile — escapes survive editor/encoding changes |
| `saveUserConfig` deletes key on empty string | Explicit empty = user wants to clear the field; `undefined`/`null` = field not included in the form, leave unchanged |
| `invoice-store.add()` returns the stored record | Callers no longer need a second `getById()` read to get the saved object |
| `api/client.js` auto-clears session on 401 | Expired JWT must not leave the user stuck on a broken page — hard-navigate to `/login` |
| `xero/client.js` removed | Was never imported by any active code path — dead code that imported global `.env` credentials (the per-user model made it obsolete) |

---

## Data Migration Note

If upgrading from the original single-user version (where `data/invoices.json` and `data/pdfs/` existed at the root of `data/`), move those files into the appropriate user's directory:

```bash
# Identify your userId from data/users.json
mkdir -p data/users/{userId}/pdfs
cp data/invoices.json data/users/{userId}/invoices.json
cp data/pdfs/*.pdf data/users/{userId}/pdfs/
```

The server's startup `ensureUserDirectories()` creates the directory shell automatically — you only need to copy the files.
