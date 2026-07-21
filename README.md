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

Per-user LLM parser (Gemini / Nvidia / OpenRouter)
  └── Rate-limited: max 15 RPM per user (Gemini free tier)
  └── Falls back to regex if LLM fails

Per-user Xero Custom Connection
  └── Sequential submission queue (1.5s gap between calls, 10s timeout)
  └── Atomic dedup lock — claimForSubmit prevents concurrent callers from double-posting
  └── Currency-first: tries PDF currency, auto-detects org base currency as fallback
  └── Attaches original PDF and email body to each Xero invoice

Per-user file storage
  data/users/{userId}/invoices.json      — invoice history
  data/users/{userId}/pdfs/             — PDF files
  data/users/{userId}/email-queue/      — disk-based email processing queue
  data/users/{userId}/settings.json     — autoProcess toggle
  data/users/{userId}/config.json       — IMAP + Xero + LLM credentials
```

Each user is fully isolated — different email accounts, different Xero orgs, different data.  
The server binary and LLM infrastructure are shared; everything else is per-user.

---

## Data isolation

| Resource | Scope |
|---|---|
| Invoice history | Per-user |
| PDF files | Per-user |
| Email processing queue | Per-user |
| IMAP account | Per-user |
| Xero org | Per-user |
| LLM API key | Per-user |
| Auto-process toggle | Per-user |
| Account/currency defaults | Per-user |
| JWT secret | Server-wide |
| Slack webhook | Server-wide (optional) |

---

## Deployment (Railway)

### Step 1 — Upload to GitHub

1. Go to github.com → create a free account
2. Click **+** → **New repository** → name it `xero-invoice-app` → **Private** → **Create**
3. Click **uploading an existing file** and drag all project files in
4. Click **Commit changes**

> Do NOT upload `.env`. It is excluded by `.gitignore`.

### Step 2 — Deploy on Railway

1. Go to railway.app → sign up with GitHub
2. **New Project** → **Deploy from GitHub repo** → select your repo
3. Click your service → **Settings** → set **Start Command**: `node main/index.js`
4. Click **Settings** → **Domains** → **Generate Domain** → copy your URL

### Step 3 — Set environment variables

Click your service → **Variables** tab:

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | Yes | Any long random string (min 32 chars) |
| `NODE_ENV` | Yes | `production` |
| `PORT` | No | Default: `3000` |
| `SLACK_WEBHOOK_URL` | No | Slack notifications for errors |
| `REDIS_URL` | No | Enables Bull queue (optional — works without Redis) |

> Xero, IMAP, and LLM credentials are set per-user in the **Setup** page after logging in.  
> No global Xero or IMAP env vars needed.

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
- `Gemini_API_KEY` — recommended (free tier: 15 RPM, 500 RPD)
- `Nvidia_API_KEY` — fallback if Gemini not set
- `OPENROUTER_API_KEY` — second fallback
- Priority: Gemini → Nvidia → OpenRouter

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

Each user's LLM usage is independently rate-limited:

| Provider | RPM | RPD | Notes |
|---|---|---|---|
| Gemini (free) | 15 | 500 | Default recommendation |
| Nvidia | varies | varies | |
| OpenRouter | varies | varies | |

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

## File structure

```
xero-invoice-app/
├── main/
│   ├── index.js                  Server entry point
│   ├── .env                      Server-wide secrets (JWT_SECRET, SLACK_WEBHOOK_URL)
│   ├── data/
│   │   ├── users.json            User accounts
│   │   └── users/{id}/           Per-user data directory
│   │       ├── config.json       IMAP + Xero + LLM credentials
│   │       ├── settings.json     autoProcess toggle
│   │       ├── invoices.json     Invoice history (max 500)
│   │       ├── pdfs/             PDF files (one per invoice)
│   │       └── email-queue/      Background job queue (.que + .pdf files)
│   ├── email/
│   │   ├── watcher-registry.js   Per-user IMAP watcher management
│   │   ├── parser.js             Email and PDF field extraction (batch-aware)
│   │   └── llm-parser.js         LLM API calls with per-user rate limiter
│   ├── xero/
│   │   ├── connect.js            Per-user Xero auth (client credentials)
│   │   ├── contacts.js           Contact lookup and creation
│   │   └── invoices.js           Draft invoice creation with PDF/email attachment
│   ├── queue/
│   │   ├── email-queue.js        Disk-based email job store (.que files)
│   │   ├── email-worker.js       Per-user background worker (start/stop/recover)
│   │   └── processor.js          Xero submission (inline or Bull queue)
│   ├── routes/
│   │   ├── auth.js               Login, register, JWT
│   │   ├── setup.js              Per-user config save/load + connection tests
│   │   ├── process.js            Watcher start/stop/rescan/settings per user
│   │   ├── invoices.js           Invoice CRUD (per-user scoped)
│   │   ├── admin.js              User management, cross-user reports
│   │   └── dashboard.js          Xero org list, health check
│   └── utils/
│       ├── invoice-store.js      Per-user invoice store with write mutex + claimForSubmit
│       ├── pdf-store.js          Per-user PDF file store
│       ├── settings-store.js     Per-user settings store
│       ├── token-cache.js        Per-user Xero token cache (in-memory)
│       ├── process-state.js      Per-user watcher activity tracking
│       ├── invoice-handler.js    Orchestrates dedup, PDF save, Xero queue
│       ├── users.js              User accounts + per-user config
│       └── logger.js             Winston structured logging
└── ui/                           React frontend (Vite)
    └── src/
        ├── context/
        │   ├── AuthContext.jsx        Authentication state
        │   ├── ThemeContext.jsx       Dark/light theme toggle
        │   └── PipelineContext.jsx    Shared pipeline status (polls /process/status app-wide)
        ├── components/layout/
        │   ├── Layout.jsx            App shell (sidebar + header + outlet)
        │   ├── Sidebar.jsx           Navigation + compact pipeline widget (always visible)
        │   └── Header.jsx            Top bar
        └── pages/
            ├── Dashboard.jsx         Full pipeline panel, watcher controls, recent invoices
            ├── Invoices.jsx          Invoice list + bulk submit banner
            └── InvoiceReview.jsx     Invoice detail + post to Xero + polling
```

---

## API endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | — | Login, returns JWT |
| POST | `/api/auth/register` | — | Register (first user only, or admin) |
| GET | `/api/auth/status` | JWT | Current user info |
| GET | `/api/setup` | JWT | Get this user's config |
| POST | `/api/setup` | JWT | Save this user's config |
| POST | `/api/setup/test/xero` | JWT | Test Xero connection |
| POST | `/api/setup/test/imap` | JWT | Test IMAP connection |
| POST | `/api/setup/test/llm` | JWT | Test LLM API |
| GET | `/api/process/status` | JWT | Watcher status + email queue stats + Xero counts |
| POST | `/api/process/start` | JWT | Start this user's IMAP watcher |
| POST | `/api/process/stop` | JWT | Stop this user's IMAP watcher |
| POST | `/api/process/rescan` | JWT | Trigger immediate inbox scan |
| GET | `/api/process/settings` | JWT | Get autoProcess toggle |
| PATCH | `/api/process/settings` | JWT | Update autoProcess toggle |
| GET | `/api/invoices` | JWT | List this user's invoices |
| GET | `/api/invoices/:id` | JWT | Invoice detail |
| GET | `/api/invoices/:id/pdf` | JWT | Download PDF |
| DELETE | `/api/invoices/:id` | JWT | Delete invoice + PDF |
| DELETE | `/api/invoices` | JWT | Clear all invoices, PDFs, and email queue |
| POST | `/api/invoices/submit-all` | JWT | Submit all pending invoices to Xero |
| PATCH | `/api/invoices/:id/status` | JWT | Update status |
| POST | `/api/invoices/:id/report` | JWT | Flag an issue |
| GET | `/api/admin/users` | Admin | List all users |
| POST | `/api/admin/users` | Admin | Create user |
| DELETE | `/api/admin/users/:id` | Admin | Delete user |
| GET | `/api/admin/reports` | Admin | Flagged invoices across all users |
| GET | `/dashboard/health` | — | Health check |

---

## Troubleshooting

**IMAP not connecting** — Make sure you used a Gmail App Password, not your regular password.  
Enable 2-Step Verification first, then generate an App Password under Security settings.

**Xero credentials rejected** — The Custom Connection's `clientId`/`clientSecret` must match exactly.  
Also verify the Xero org is added under Connection Management on developer.xero.com.

**No invoices appearing** — Check that `IMAP_FILTER_FROM` is not set too restrictively.  
Also confirm the email contains a PDF attachment or structured template format.

**LLM quota exceeded** — Gemini free tier allows 500 RPD. If you process many emails per day,  
add a paid Gemini key or configure a Nvidia/OpenRouter fallback key in Setup.

**Wrong account code** — Get valid codes from Xero → Accounting → Chart of Accounts.  
Set `DEFAULT_ACCOUNT_CODE` to a code that exists in your Xero org.

**Invoices stuck as Pending after restart** — The server automatically retries all `pending` and `submitting` invoices 3 seconds after boot (sequentially, 1.5 s apart). If they are still pending after boot, go to the Invoices page and click **Submit all to Xero**. You can also open any individual invoice and click **Post to Xero** — it fires in the background and updates automatically.

**Invoice appears submitted twice in Xero** — This should not happen. The `claimForSubmit` lock guarantees each invoice transitions to `submitting` exactly once; any concurrent caller sees the lock held and exits. If you do see a duplicate in Xero, it was likely created manually or by a separate Xero org connection — check the `xeroInvoiceId` fields in the server logs.

**"Xero submission failed" with a validation error** — Xero rejected the invoice data. The exact message is stored in the invoice's `errorMsg` field and shown on the review page (e.g. "The contact name is required", "Invoice number already exists"). Correct the relevant field and retry. Common causes: invoice number too short (Xero requires at least 1 non-whitespace character), missing contact, invalid account code.

**"Organisation is not subscribed to currency SGD"** — The system detects the org's base currency and retries automatically. To use SGD directly, enable it in Xero → Settings → Currencies.

**Duplicate invoices blocked unexpectedly** — Dedup matches on vendor + invoice number + amount (within 1%). Two invoices from the same vendor with the same invoice number but different amounts are treated as distinct invoices and both stored. If a legitimate invoice is still being blocked, check the server log for `"Invoice already stored — skipping duplicate"` to see which existing record it matched.

**Email queue jobs stuck as dead** — A job becomes `dead` after 3 failed attempts. Delete the invoice, mark the source email as unread in Gmail, then start the watcher to re-process it. The Dashboard queue panel shows dead jobs with their last error message.

**Watcher not running after server restart** — The IMAP watcher state is in-memory and must be restarted from the Dashboard after each server reboot. The email worker (PDF parsing) recovers automatically on boot; the IMAP listener does not.
