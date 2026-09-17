# Xero Invoice Automation

Multi-user app that watches each user's email inbox and automatically creates draft invoices in Xero. Supports PDF attachments, structured email templates, and Xero bills (ACCPAY) or sales invoices (ACCREC).

---

## Architecture overview

```
Per-user IMAP watcher
  └── Detects new/unread emails in real time (keepalive) + 60s poll fallback
  └── Serialises detected emails into a disk-based queue (email-queue/)

Per-user background email worker
  └── Drains the queue job-by-job (survives server restarts)
  └── Extracts PDF attachments — batch-parses up to 5 PDFs concurrently

Per-user LLM parser (Gemini — several API keys, rotated across models on quota errors)
  └── Rate-limited: max 15 RPM per user (Gemini free tier)
  └── Falls back to regex if LLM fails

Per-user Xero Custom Connection
  └── Sequential submission queue (1.5s gap between calls, 10s timeout)
  └── Atomic dedup lock — claimForSubmit prevents concurrent callers from double-posting
  └── Currency-first: tries PDF currency, auto-detects org base currency as fallback
  └── Attaches the original PDF to each Xero invoice

Per-user claims queue & worker (main/claims/)
  └── Disk-backed queue (.que + .bin) for batch claims (.zip receipts + .xlsx claim forms)
  └── Crash-loop & poison guard (max 3 retries), concurrency cap (10 jobs/user)
  └── Automatic recovery across server reboots (recoverPendingJobs)
  └── Tier 1 SHA-256 image dedup + Tier 2 vendor/date/amount suspicion flags
  └── Reconciles form items against receipts; zero writes to Xero (local review only)
  └── Intelligent corporate description synthesis (time-of-day, route, category detection)

Storage
  main/data/app.db                      — one SQLite file: users, credentials (encrypted at rest),
                                          invoices and line items, connected orgs, settings
  main/data/users/{userId}/pdfs/        — PDF files
  main/data/users/{userId}/receipts/    — receipt image files
  main/data/users/{userId}/email-queue/ — disk-based email processing queue
  main/data/users/{userId}/claim-queue/ — disk-based batch job queue (claims, bill and invoice imports)
  main/data/backups/                    — verified daily DB backups (see docs/RUNBOOK.md)
```

Each user is fully isolated — different email accounts, different Xero orgs, different data.  
The server binary and LLM infrastructure are shared; everything else is per-user.

---

## Data isolation

| Resource | Scope |
|---|---|
| Invoice history | Per-user |
| PDF files | Per-user |
| Receipt image files | Per-user |
| Email processing queue | Per-user |
| Claim processing queue | Per-user |
| IMAP account | Per-user |
| Xero org | Per-user |
| LLM API key | Per-user |
| Auto-process toggle | Per-user |
| Account/currency defaults | Per-user |
| JWT secret | Server-wide |
| Slack webhook | Server-wide (optional) |

---

## Deployment

The app runs on a single VM under pm2, behind nginx, with SQLite on the same
disk. Deploys are pushed from your machine:

```bash
npm run deploy              # deploy HEAD
npm run deploy -- --check   # report drift between local, GitHub and the server
npm run backup:pull         # copy the latest backup set to ~/xero-backups/
```

`npm run deploy` refuses uncommitted or unpushed changes, waits for the GitHub
Actions run for that commit to be green, pulls on the server, installs from the
lockfile, runs the tests there, builds the UI, takes a verified database backup,
reloads pm2 through `ecosystem.config.js`, and only reports success once the
running process says it is on the shipped commit (`/dashboard/health` returns
`commit`). Every deploy is tagged `deploy/<timestamp>`. Restore and rollback
steps are in [docs/RUNBOOK.md](docs/RUNBOOK.md).

### Environment variables (`main/.env`)

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | Yes | Signs login tokens — any long random string |
| `ENCRYPTION_KEY` | Yes | 64 hex characters; encrypts stored Xero/IMAP/Gemini credentials. Losing it makes them unreadable |
| `NODE_ENV` | Yes | `production` |
| `PORT` | No | Default `3000` |
| `ALLOW_REGISTRATION` | No | Registration is closed after the first account; `true` reopens it |
| `XERO_OAUTH_REDIRECT_URI` | For OAuth | The HTTPS callback registered on each user's Xero Web app |
| `SLACK_WEBHOOK_URL` | No | Invoice created / error / fatal-exit notifications |

`main/.env.example` lists every key the server reads, with the defaults.

> Xero, IMAP and Gemini credentials are set per user on the **Setup** page and
> stored encrypted in the database — not in `.env`.

---

## First-time setup

### 1. Create the first admin account

Visit `https://yourapp.up.railway.app` → the login page will have a **Register** link on first boot.  
The first registered user is automatically made admin.

### 2. Configure your account (Setup page)

Each user fills in their own:

**Xero (Custom Connection)**
- `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` — from developer.xero.com → your Custom Connection app
- Click **Test Xero** to verify the connection

**Email (IMAP)**
- `IMAP_HOST` — e.g. `imap.gmail.com`
- `IMAP_PORT` — `993`
- `IMAP_USER` — your email address
- `IMAP_PASS` — your Gmail App Password (see below)
- `IMAP_FILTER_FROM` — optional sender filter
- Click **Test IMAP** to verify

**LLM (invoice parser)**
- Add one or more Gemini API keys (free tier: 15 RPM, 500 RPD each)
- Keys are rotated: every model is tried on one key before the next key is used, so a second key is real extra quota

**Defaults**
- `DEFAULT_ACCOUNT_CODE` — your Xero chart-of-accounts code (e.g. `310`)
- `DEFAULT_CURRENCY` — e.g. `SGD` or `USD`

### 3. Start the watcher (Dashboard page)

Click **Start** in the Email Watcher card. The watcher opens an IMAP connection to your inbox and begins monitoring.

---

## Gmail App Password

Gmail blocks plain-password IMAP login. You need an App Password:

1. Go to myaccount.google.com
2. **Security** → **2-Step Verification** (must be enabled)
3. Scroll down → **App passwords**
4. App: **Mail**, Device: **Other** → type `Xero Invoice App`
5. Click **Generate** → copy the 16-character password
6. Paste this as `IMAP_PASS` in Setup

---

## LLM rate limits and batch processing

Parsing runs on Gemini. Each user adds one or more Gemini API keys on the Setup
page; the client tries every model on one key before moving to the next, so a
second key is real extra quota, not just a spare. Usage is rate-limited per
user (15 requests per minute, five in flight — the free tier's limits).

When an email contains multiple PDF attachments (e.g. 10 invoices in one email), the parser processes them in batches of **up to 5 concurrently**. The rate limiter queues any excess and processes them as slots free up — no manual intervention needed.

If the 15 RPM limit is reached, the system waits for the window to slide before processing the next batch. No invoices are dropped.

---

## Xero Custom Connection setup

Each user needs their own Custom Connection on developer.xero.com:

1. Go to developer.xero.com → **My Apps** → **New App**
2. Select **Custom Connection**
3. Grant scopes: `accounting.invoices`, `accounting.contacts`, `accounting.settings.read`
4. Click **Configuration** → copy **Client ID** and **Client Secret**
5. Go to **Connection Management** → add your Xero organisation
6. Enter Client ID and Secret in the app's Setup page → click **Test Xero**

---

## Auto-process toggle

On the Dashboard, each user can toggle **Auto-submit to Xero**:

- **ON** (default): invoices extracted from emails are automatically posted to Xero as drafts
- **OFF**: invoices are stored locally for manual review — nothing is sent to Xero until you enable it

---

## Currency handling

The system always uses the currency extracted from the PDF first. If the Xero organisation is not subscribed to that currency, it automatically detects the **org's base currency** (via `GET /Organisations`) and retries with that — no hardcoded fallback.

Flow:
```
PDF currency (e.g. SGD)
  → Try to post in SGD
  → Xero: "Organisation is not subscribed to currency SGD"
  → Fetch org base currency (e.g. NZD for Demo Company)
  → Retry in NZD — invoice created ✓
```

The org's base currency is cached per tenant for the server lifetime (no extra API call after the first detection). The invoice record's `currency` field is updated to the successful currency so future retries also use the correct value.

To add a currency to your Xero org: **Xero → Settings → Currencies → Add currency**. Once added, new invoices will use the correct extracted currency with no fallback needed.

---

## Background email queue

When the IMAP watcher detects a new email it immediately writes a queue job to disk (`email-queue/*.que`) and returns — the LLM parsing and Xero submission happen asynchronously in a per-user background worker. This means:

- **Server restarts are safe** — unfinished jobs are recovered and retried on next boot.
- **No lost emails** — the email is SEEN in IMAP, stored on disk, and only removed from the queue after successful processing.
- **Queue visibility** — the Dashboard **Pipeline Status** panel (always visible) shows live job counts and job cards.

Jobs that fail 3 times are marked `dead` and shown with the last error. The email queue directory is wiped together with invoices when **Clear all** is clicked.

---

## Xero submission flow

All Xero submissions are **fire-and-forget** — the server starts the submission in the background and returns immediately. Invoice status progresses through:

```
pending → submitting → posted   (success)
                     → error    (Xero rejected or network failure)
```

The `errorMsg` field on a failed invoice contains the actual Xero validation message (e.g. "The contact name is required"). You can correct the invoice fields on the review page and retry.

**No duplicate submissions** — `claimForSubmit` atomically transitions an invoice from any state into `submitting` inside a write-locked file operation. If two callers race (e.g. boot-time retry fires while the user also clicks "Submit All"), the second one sees the invoice already claimed and exits immediately. Each invoice is guaranteed to be sent to Xero at most once per submission attempt.

**Pipeline Status panel** — lives in the sidebar and is always visible regardless of which page you are on. It shows two rows:
- *Email parsing*: active / queued / failed job counts; job cards appear while LLM parsing is running
- *Xero submission*: pending / submitting / posted / failed counts with a segmented progress bar

The panel polls every 15 s at idle, dropping to 3 s whenever the email queue is active. The Dashboard page also shows the full panel with more detail.

**Invoice review page** — clicking **Post to Xero** fires the submission in the background, shows `⟳ Submitting to Xero…` status, and polls every 2 s until the result arrives. No page hang, no timeout errors.

---

## Re-scan inbox

If you mark emails as unread in Gmail, the watcher detects the flag change (within 3 seconds) and re-processes them. You can also click **Scan now** on the Dashboard to trigger an immediate scan.

Duplicate protection: invoices are matched on vendor + invoice number + amount (within 1%). A different amount on the same invoice number is treated as a distinct invoice, not a duplicate.

---

## Pending invoices and bulk Xero submission

If invoices are stuck in **Pending** status (e.g. after a server restart that killed the in-memory submission chain, or a temporary Xero outage), the Invoices page shows a banner with a **Submit all to Xero** button. This fires `POST /api/invoices/submit-all` which submits each pending invoice sequentially (1.5 s gap between calls to stay inside Xero's rate limit). The atomic `claimForSubmit` lock ensures a concurrent boot-time retry cannot double-post the same invoice.

---

## Expense Claims

The app supports a full expense claim workflow — staff submit receipts via ZIP/folder batch import, direct add, or phone camera, and managers review them before posting to Xero.

### Ingestion pathways

| Method | How | Description generated |
|---|---|---|
| **Batch import** (ZIP/folder) | Invoices → Import Claims → drag ZIP | AI reads each receipt + synthesises corporate description |
| **Add Claim** (manual) | Invoices → Add Claim → upload photo | AI reads receipt, applies intelligent description |
| **Phone capture** | Mobile browser → take photo → submit | Same AI pipeline; receipt processed server-side |

All three pathways use the same **intelligent corporate description** logic — see [`docs/CLAIM_INTELLIGENCE_GUIDELINES.md`](docs/CLAIM_INTELLIGENCE_GUIDELINES.md).

### Intelligent corporate descriptions

The AI synthesises a description that meets corporate finance & tax requirements (IRAS/LHDN/HMRC):

```
[Category] <Business Purpose> @ <Merchant> (<Time / Route>)
```

Examples:
- `[Entertainment/Meals] Business working lunch with client @ Dong Seoul (12:01 PM, Johor)`
- `[Local Travel] Business transit to client meeting: Home to Apple (CDG Zig, 08:08)`
- `[Local Travel] Late-night event commute: Esplanade to Home (Gojek, 20:09)`
- `[Staff Overtime Meal] Overtime dinner while working late @ GrabFood (21:15)`

The time-of-day matrix, route extraction, and category rules are defined in [`docs/CLAIM_INTELLIGENCE_GUIDELINES.md`](docs/CLAIM_INTELLIGENCE_GUIDELINES.md).

### Batch fast-review navigation

When you open any claim from a batch import, a **📁 Batch navigation bar** appears at the bottom of the receipt image:

| Control | Action |
|---|---|
| **← Prev / Next →** buttons | Step between claims in the same folder/ZIP — instant SPA navigation, no page reload |
| **← → keyboard arrows** | Same as buttons; works anywhere on the page (disabled in text inputs) |
| **Pill filmstrip** | All claims shown as pills; current = blue, reviewed/posted = green ✓, pending = grey |
| **✓ Approve & Next** | Marks the current claim as reviewed and jumps to the next **unreviewed** claim automatically |
| **Merge button hidden** | Destructive "Merge back into one" is only shown for genuine single-photo splits, never for batch imports |

The batch panel also shows the **folder/ZIP name** so you always know which batch you are reviewing.

### Claim import — how the count works

The import summary counts **receipts actually parsed**, not rows in an Excel form. If you upload a ZIP with 9 receipts and no spreadsheet attached, the system shows "9 claims imported" (not 0). Each receipt with no matching spreadsheet row is created with the AI-generated description as the claim description.

### Expense claim deduplication

Claims are deduplicated on two tiers:

1. **Tier 1 — SHA-256 image hash**: identical files are blocked immediately.
2. **Tier 2 — Suspicion flags**: same vendor + date + amount within 1% triggers a warning (stored as a possible duplicate, not silently dropped).

### Claim API endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/claims/import` | JWT | Start a batch import job (multipart: ZIP + optional XLSX) |
| GET | `/api/claims/active` | JWT | The active import job, if any |
| GET | `/api/claims/import/:jobId` | JWT | Poll a specific import job for progress |
| DELETE | `/api/claims/import/:jobId` | JWT | Cancel / remove an import job |
| DELETE | `/api/claims/group/:groupId` | JWT | Delete every record from one import |
| GET | `/api/receipts/:id/group` | JWT | Returns siblings, `groupType` (`batch`/`split`), `batchLabel`, and `index/total` |
| GET | `/api/receipts/:id/token` | JWT | Short-lived signed URL token for receipt image |
| POST | `/api/receipts/:id/reread` | JWT | Re-run AI on this receipt (costs 1 LLM call) |
| POST | `/api/receipts/:id/merge` | JWT | Undo a genuine photo split (not available for batch imports) |

---

## File structure

```
xero-invoice-app/
├── main/
│   ├── index.js                  Server entry point + middleware + route mounts
│   ├── .env                      Server-wide secrets (see main/.env.example)
│   ├── data/                     Runtime data (gitignored): app.db, users/{id}/, backups/
│   ├── db/                       SQLite schema, versioned migrations, verified backup
│   ├── intake/                   One document shape, dedup, profiles, the row builder
│   ├── email/                    IMAP watcher, template parser + LLM verifier, bill parser
│   ├── claims/                   Expense claims: import job, form/archive readers, matcher,
│   │                             categories → accounts, claim-record builder, job queue/worker
│   ├── jobs/                     The generic background job runner (claims, bill and invoice imports)
│   ├── queue/                    Inbound mail queue + worker; the Xero submitter
│   ├── xero/                     OAuth / Custom Connection, invoices, contacts, reports, insights
│   ├── reports/                  Budget PDF/XLSX exports
│   ├── routes/                   Express routers (one per API area)
│   ├── middleware/               requireAuth / requireAdmin, async-handler
│   ├── utils/                    invoice-store, users (+ defaults), token-cache, receipt/pdf stores,
│   │                             paths, ids, base64, crypto, logger, notify, Gemini client
│   └── scripts/                  deploy.sh, backup-pull.sh, smoke test, jest setup, lint test
├── ui/src/                       React frontend (Vite): pages, components, contexts, api client
├── docs/                         RUNBOOK.md, claim guidelines, implementation plans, archive/
├── ecosystem.config.js           pm2 process definition (restart backoff)
└── .github/workflows/ci.yml      Tests + UI build on Node 22 for every push
```


---

## API endpoints

### Auth
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | — | Login, returns JWT |
| POST | `/api/auth/register` | — | Create the first account (becomes admin); closed after that unless `ALLOW_REGISTRATION=true` |
| POST | `/api/auth/logout` | JWT | Stop this user's watcher and end the session |
| GET | `/api/auth/me` | JWT | Current user |
| GET | `/api/auth/status` | — | Whether any account exists yet |

### Setup
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/setup` | JWT | Get this user's config |
| POST | `/api/setup` | JWT | Save this user's config (a blank secret keeps the stored one) |
| GET | `/api/setup/llm-keys` | JWT | This user's Gemini keys (masked) |
| POST | `/api/setup/llm-keys` | JWT | Add a Gemini key |
| DELETE | `/api/setup/llm-keys/:id` | JWT | Remove a Gemini key |
| POST | `/api/setup/test/xero` | JWT | Test Xero connection |
| POST | `/api/setup/test/imap` | JWT | Test IMAP connection |
| POST | `/api/setup/test/llm` | JWT | Test LLM API key |

### Email watcher & pipeline
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/process/status` | JWT | Watcher status + email queue stats + Xero counts |
| POST | `/api/process/start` | JWT | Start this user's IMAP watcher |
| POST | `/api/process/stop` | JWT | Stop this user's IMAP watcher |
| POST | `/api/process/rescan` | JWT | Trigger immediate inbox scan |
| GET | `/api/process/settings` | JWT | Get autoProcess toggle |
| PATCH | `/api/process/settings` | JWT | Update autoProcess toggle |

### Invoices
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/invoices` | JWT | List this user's invoices |
| POST | `/api/invoices` | JWT | Add a bill by hand (one PDF, or a batch as a background job) |
| POST | `/api/invoices/compose` | JWT | Compose a sales invoice from a form |
| POST | `/api/invoices/import` | JWT | Import invoices from a spreadsheet (background job) |
| GET | `/api/invoices/import/active` | JWT | The active import job, if any |
| GET | `/api/invoices/import/:jobId` | JWT | Poll an import job |
| DELETE | `/api/invoices/import/:jobId` | JWT | Cancel / remove an import job |
| GET | `/api/invoices/:id` | JWT | Invoice detail |
| PATCH | `/api/invoices/:id` | JWT | Edit invoice fields |
| GET | `/api/invoices/:id/pdf` | JWT | Download PDF (token-authenticated) |
| GET | `/api/invoices/:id/pdf-url` | JWT | Get short-lived signed URL for PDF (for iframe embed) |
| POST | `/api/invoices/:id/submit` | JWT | Submit single invoice to Xero |
| POST | `/api/invoices/:id/report` | JWT | Flag an issue on an invoice |
| PATCH | `/api/invoices/:id/status` | JWT | Update invoice status directly |
| POST | `/api/invoices/submit-all` | JWT | Submit all pending invoices to Xero |
| POST | `/api/invoices/batch-status` | JWT | Poll status of multiple invoices in one call |
| DELETE | `/api/invoices/:id` | JWT | Delete invoice + PDF |
| DELETE | `/api/invoices` | JWT | Clear all invoices, PDFs, and email queue |

### Receipts & phone capture
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/receipts` | JWT | Upload a receipt image (Add Claim) |
| POST | `/api/receipts/pair` | JWT | Generate QR pairing token + SVG for phone capture |
| GET | `/api/receipts/pair/:token` | JWT | Poll pairing for newly arrived receipts |
| DELETE | `/api/receipts/pair/:token` | JWT | Revoke a pairing (QR dialog closed) |
| GET | `/api/receipts/capture/:token` | — | Phone checks if the QR link is still valid |
| GET | `/api/receipts/capture/:token/status` | — | Phone polls parsed fields of its uploaded receipts |
| POST | `/api/receipts/capture/:token` | — | Phone uploads a receipt image |
| GET | `/api/receipts/:id/token` | JWT | Get short-lived signed token for receipt image |
| GET | `/api/receipts/:id/image` | token | Serve receipt image (signed token in query param) |
| POST | `/api/receipts/:id/reread` | JWT | Re-run AI on this receipt (costs 1 LLM call) |
| GET | `/api/receipts/:id/group` | JWT | Siblings + `groupType` (`batch`/`split`) + `batchLabel` |
| POST | `/api/receipts/:id/merge` | JWT | Undo a genuine photo split (not for batch imports) |

### Expense claims
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/claims/import` | JWT | Start a batch import job (multipart: ZIP + optional XLSX) |
| GET | `/api/claims/active` | JWT | List active/recent import jobs for this user |
| GET | `/api/claims/import/:jobId` | JWT | Poll a specific import job for progress |
| DELETE | `/api/claims/import/:jobId` | JWT | Cancel / remove an import job |
| DELETE | `/api/claims/group/:groupId` | JWT | Delete all records from a batch import group |

### Xero OAuth
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/xero/oauth/connect` | JWT | Start Xero OAuth2 flow (redirects to Xero) |
| GET | `/api/xero/oauth/callback` | — | OAuth2 callback URL (Xero redirects here) |
| POST | `/api/xero/oauth/complete` | JWT | Exchange code for tokens, store connection |
| DELETE | `/api/xero/oauth/disconnect` | JWT | Revoke Xero connection |
| GET | `/api/xero/tenants` | JWT | List connected Xero orgs |

### Xero Insights
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/xero-reports/summary` | JWT | Outstanding balances snapshot (what's owed now) |
| GET | `/api/xero-reports/accounts` | JWT | Chart of accounts |
| GET | `/api/xero-reports/bank-accounts` | JWT | Bank accounts list |
| GET | `/api/xero-reports/contacts` | JWT | Contacts with outstanding balances |
| GET | `/api/xero-reports/bank-transactions` | JWT | Bank transactions |
| GET | `/api/xero-reports/budget-variance` | JWT | Budget vs actual variance |
| GET | `/api/xero-reports/performance` | JWT | Financial performance metrics |
| GET | `/api/xero-reports/variance-insights` | JWT | AI-generated variance insights (Gemini) |
| GET | `/api/xero-reports/narrative` | JWT | AI-generated P&L narrative (Gemini) |
| GET | `/api/xero-reports/cash-flow` | JWT | Cash flow report |
| GET | `/api/xero-reports/budget/export-url` | JWT | Short-lived signed URL for a budget export |
| GET | `/api/xero-reports/budget/export` | token | The PDF or XLSX export |

### AI Chat assistant
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/chat` | JWT | Send a message; returns AI reply + validated proposals (read-only, 12 RPM limit) |

### Admin
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/admin/users` | Admin | List all users |
| POST | `/api/admin/users` | Admin | Create user |
| DELETE | `/api/admin/users/:id` | Admin | Delete user |
| GET | `/api/admin/reports` | Admin | Flagged invoices across all users |
| PATCH | `/api/admin/reports/:userId/:invoiceId/resolve` | Admin | Mark a flagged invoice reviewed |
| GET | `/api/admin/monitoring` | Admin | Per-user activity + backend health |
| GET | `/api/admin/stats/daily` | Admin | Daily invoice counts |
| GET | `/api/admin/logs` | Admin | Recent log entries |

### Health
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/dashboard/health` | — | Health check: `{ status, commit, timestamp }` — `commit` is what the running process started from |
| GET | `/dashboard/health` | — | Same response (the path deploy.sh and uptime checks use) |


---

## Phone capture (QR pairing)

You can photograph receipts directly from your phone without installing any app:

1. On the **Invoices** page (desktop), click **Add Claim** → **Use Phone** → a QR code appears.
2. Scan the QR code with your phone's camera — it opens the capture page in your mobile browser.
3. Take a photo of the receipt. The AI reads it immediately on the server.
4. The desktop panel refreshes automatically and shows the parsed result (vendor, amount) as the photo arrives.

**How it works:**
- The desktop generates a short-lived token (`POST /api/receipts/pair`) and a QR SVG. The token encodes a URL your phone opens.
- The phone does **not** need to be logged in — the token is the credential. It expires after a fixed time window or after a maximum number of uploads (whichever comes first).
- Once the desktop dialog closes, it revokes the token (`DELETE /api/receipts/pair/:token`) immediately so the QR cannot be reused.
- The phone can only see parsed fields (vendor, amount) of its own uploads via the `/capture/:token/status` endpoint — it cannot access any other user data.

---

## Xero Insights

The **Xero Insights** page (`XeroInsights.jsx`) provides a live analytics dashboard sourced from your connected Xero organisation. All reports are **read-only** — nothing is written to Xero.

| Report | What it shows |
|---|---|
| **Summary** | Outstanding receivables/payables snapshot |
| **Period trend** | Invoice values over day/week/month/year or a custom date range |
| **Profit & Loss** | Revenue, expenses, net profit |
| **Cash flow** | Operating/investing/financing activities |
| **Bank summary** | Account balances at a glance |
| **Budget variance** | Actual vs budget with variance % |
| **Performance** | KPI metrics derived from your Xero data |
| **Contacts** | Contacts with outstanding balances |
| **Bank accounts** | Account list with current balances |
| **Bank transactions** | Recent transactions |
| **Chart of accounts** | Account codes and types |
| **AI variance insights** | Gemini-generated natural-language explanation of budget variances |
| **AI P&L narrative** | Gemini-generated summary of profit & loss trends |

> Xero Insights requires a live Xero OAuth2 connection. If no org is connected, the page shows a "Connect Xero" prompt. Reports are cached in-memory per request to avoid hammering the Xero API.

---

## AI Chat assistant

A Gemini-powered conversational assistant is available in the sidebar. It can:
- Answer questions about your invoice pipeline ("How many claims are pending?", "What did Grab charge last month?")
- Propose field edits to a specific invoice ("Change the account code to 429")
- Explain why a Xero submission failed

**Important constraints:**
- The chat route (`POST /api/chat`) is **strictly read-only** — it cannot write to the database.
- Any edits it proposes are returned as *proposals* and are only applied when the user clicks **Confirm** in the UI (which calls the existing `PATCH /api/invoices/:id` endpoint with the same validation as a manual edit).
- Rate-limited to **12 messages per minute** per user to protect the daily Gemini quota from being exhausted by the chat feature alone.
- Requires a `Gemini_API_KEY` in the user's Setup. If no key is configured, the assistant responds with an error rather than silently failing.

---

## Security

The following hardening measures are active on every deployment:

| Layer | Measure |
|---|---|
| **Global rate limit** | 500 requests per 15 minutes, keyed by JWT user ID (not IP) so a shared office network doesn't penalise all users for one user's traffic |
| **Chat rate limit** | Separate 12 RPM cap on `POST /api/chat` to protect Gemini daily quota |
| **Auth rate limit** | Login and register endpoints are individually rate-limited to prevent brute-force |
| **Registration lock** | After the first account, registration is closed unless `ALLOW_REGISTRATION=true` is set |
| **Role checked per request** | Role and existence are read from the database on every request, so a deleted or demoted user loses access at once |
| **Secrets stay server-side** | Stored client secrets and mailbox passwords are never returned to the browser; a blank field on save keeps the stored value |
| **Credentials encrypted at rest** | Xero/IMAP/Gemini credentials are AES-256-GCM encrypted in the database with `ENCRYPTION_KEY` |
| **JWT authentication** | All API routes (except auth, QR capture, and health check) require a valid signed JWT in the `Authorization: Bearer` header |
| **Path traversal sanitization** | File paths for PDFs and receipt images are sanitized before disk access; `..` sequences are rejected |
| **Helmet** | `helmet` sets standard HTTP security headers (HSTS, X-Frame-Options, etc.) |
| **Data isolation** | Every file read/write is scoped to the authenticated user's directory — no cross-user data access is possible through the API |
| **QR token scoping** | Phone capture tokens carry no identity and expire automatically; the phone can only read back its own upload's parsed fields |

---

## Troubleshooting

**IMAP not connecting** — Make sure you used a Gmail App Password, not your regular password.  
Enable 2-Step Verification first, then generate an App Password under Security settings.

**Xero credentials rejected** — The Custom Connection's `clientId`/`clientSecret` must match exactly.  
Also verify the Xero org is added under Connection Management on developer.xero.com.

**No invoices appearing** — Check that `IMAP_FILTER_FROM` is not set too restrictively.  
Also confirm the email contains a PDF attachment or structured template format.

**LLM quota exceeded** — Gemini free tier allows 500 RPD per key. If you process many emails per day,  
add a second Gemini key (or a paid one) in Setup; keys are rotated automatically.

**Wrong account code** — Get valid codes from Xero → Accounting → Chart of Accounts.  
Set `DEFAULT_ACCOUNT_CODE` to a code that exists in your Xero org.

**Invoices stuck as Pending after restart** — The server automatically retries all `pending` and `submitting` invoices 3 seconds after boot (sequentially, 1.5 s apart). If they are still pending after boot, go to the Invoices page and click **Submit all to Xero**. You can also open any individual invoice and click **Post to Xero** — it fires in the background and updates automatically.

**Invoice appears submitted twice in Xero** — This should not happen. The `claimForSubmit` lock guarantees each invoice transitions to `submitting` exactly once; any concurrent caller sees the lock held and exits. If you do see a duplicate in Xero, it was likely created manually or by a separate Xero org connection — check the `xeroInvoiceId` fields in the server logs.

**"Xero submission failed" with a validation error** — Xero rejected the invoice data. The exact message is stored in the invoice's `errorMsg` field and shown on the review page (e.g. "The contact name is required", "Invoice number already exists"). Correct the relevant field and retry. Common causes: invoice number too short (Xero requires at least 1 non-whitespace character), missing contact, invalid account code.

**"Organisation is not subscribed to currency SGD"** — The system detects the org's base currency and retries automatically. To use SGD directly, enable it in Xero → Settings → Currencies.

**Duplicate invoices blocked unexpectedly** — Dedup matches on vendor + invoice number + amount (within 1%). Two invoices from the same vendor with the same invoice number but different amounts are treated as distinct invoices and both stored. If a legitimate invoice is still being blocked, check the server log for `"Invoice already stored — skipping duplicate"` to see which existing record it matched.

**Email queue jobs stuck as dead** — A job becomes `dead` after 3 failed attempts. Delete the invoice, mark the source email as unread in Gmail, then start the watcher to re-process it. The Dashboard queue panel shows dead jobs with their last error message.

**Watcher not running after server restart** — The IMAP watcher state is in-memory and must be restarted from the Dashboard after each server reboot. The email worker (PDF parsing) recovers automatically on boot; the IMAP listener does not.
