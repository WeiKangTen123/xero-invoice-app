# Xero Invoice Automation — Full System Documentation

---

## Table of Contents

1. [What This System Does](#1-what-this-system-does)
2. [Architecture Overview](#2-architecture-overview)
3. [How to Run the System](#3-how-to-run-the-system)
4. [Environment Variables Reference](#4-environment-variables-reference)
5. [Full Email-to-Invoice Flow](#5-full-email-to-invoice-flow)
6. [Module Breakdown](#6-module-breakdown)
7. [Database Schema](#7-database-schema)
8. [API Endpoints](#8-api-endpoints)
9. [Input vs Output](#9-input-vs-output)
10. [Failure Handling & Retries](#10-failure-handling--retries)
11. [Invoice Type Detection](#11-invoice-type-detection)
12. [Regex Field Extraction Rules](#12-regex-field-extraction-rules)
13. [External API Integrations — What You Need](#13-external-api-integrations--what-you-need)
14. [Xero API — Setup & Linking](#14-xero-api--setup--linking)
15. [Gmail IMAP — Setup & Linking](#15-gmail-imap--setup--linking)
16. [Slack — Setup & Linking](#16-slack--setup--linking)
17. [PostgreSQL — Setup & Linking](#17-postgresql--setup--linking)
18. [Redis — Setup & Linking](#18-redis--setup--linking)
19. [Common Linking Problems & Fixes](#19-common-linking-problems--fixes)
20. [Where Invoices Appear in Xero — ACCPAY vs ACCREC](#20-where-invoices-appear-in-xero--accpay-vs-accrec)

---

## 1. What This System Does

This is a **Node.js backend automation server** that:

- Watches a Gmail (or any IMAP) inbox for new emails
- Parses the email body or any attached PDF to extract invoice details
- Automatically creates a **DRAFT invoice** in Xero (accounting software) via their API
- Logs every result to a PostgreSQL database
- Sends a Slack notification with a direct link to the created invoice

There is **no frontend UI**. Everything is driven by incoming emails and REST API endpoints for monitoring.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        EXTERNAL WORLD                           │
│                                                                 │
│   Gmail / IMAP Inbox          Xero (accounting software)        │
│         │                              ▲                        │
│         │ new email                    │ create invoice         │
└─────────┼──────────────────────────────┼────────────────────────┘
          │                              │
┌─────────▼──────────────────────────────┼────────────────────────┐
│                    NODE.JS SERVER (Express)                      │
│                                        │                        │
│  ┌──────────────┐   ┌───────────────┐  │  ┌──────────────────┐  │
│  │ IMAP Watcher │──▶│ Email Parser  │  │  │   Xero OAuth     │  │
│  │ (listener.js)│   │ (parser.js)   │  │  │   (auth.js)      │  │
│  └──────────────┘   └──────┬────────┘  │  └──────────────────┘  │
│                            │           │                        │
│                    ┌───────▼────────┐  │                        │
│                    │  Bull Queue    │  │                        │
│                    │  (Redis)       │  │                        │
│                    │ processor.js   │  │                        │
│                    └───────┬────────┘  │                        │
│                            │           │                        │
│                    ┌───────▼────────┐  │                        │
│                    │ Xero Invoices  │──┘                        │
│                    │ + Contacts     │                           │
│                    └───────┬────────┘                           │
│                            │                                    │
│              ┌─────────────┴──────────────┐                     │
│              ▼                            ▼                     │
│       ┌─────────────┐            ┌──────────────┐               │
│       │  PostgreSQL  │            │    Slack     │               │
│       │  (logs/tokens│            │  Webhook     │               │
│       └─────────────┘            └──────────────┘               │
└─────────────────────────────────────────────────────────────────┘
```

### Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 |
| Web server | Express 4 |
| Email | `imap` + `mailparser` |
| PDF parsing | `pdf-parse` |
| Job queue | Bull (backed by Redis) |
| Database | PostgreSQL (`pg` pool) |
| Xero API | `xero-node` SDK v7 |
| Logging | Winston |
| Notifications | Slack webhook via `axios` |
| Deployment | Railway (PaaS) |

---

## 3. How to Run the System

### Prerequisites

- Node.js >= 20
- npm >= 9
- PostgreSQL (local or hosted)
- Redis (local or hosted — optional but recommended)
- A Xero Developer account with an OAuth2 app
- Gmail with IMAP enabled + an App Password

### Step 1 — Install dependencies

```bash
npm install
```

### Step 2 — Configure environment variables

```bash
cp .env.example .env
# Open .env and fill in all values (see Section 4)
```

### Step 3 — Create database tables (run once)

```bash
node db/migrate.js
```

This creates three tables: `xero_tenants`, `invoice_log`, `dead_letter_queue`.

### Step 4 — Start the server

```bash
# Production
node index.js

# Development (auto-restart on file changes)
npm run dev

# Or run migration + server in one command (same as Railway)
npm start
```

### Step 5 — Connect your Xero organisation

Open in your browser:

```
http://localhost:3000/xero/connect
```

Log in with Xero → Approve access → You are redirected to `/dashboard`.
Your OAuth tokens are now saved in PostgreSQL and will auto-refresh.

### Step 6 — Test with a sample email

Send an email to your configured inbox (`IMAP_USER`) with this body:

```
Subject: Invoice from Acme Corp - Please Pay

Invoice No: INV-2026-001
Date: 27/05/2026
Due Date: 27/06/2026
Subtotal: $1,000.00
GST: $90.00
Total: $1,090.00
```

Within 60 seconds a DRAFT bill should appear in Xero under:
**Accounts → Purchases → Drafts**

---

## 4. Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `XERO_CLIENT_ID` | Yes | From Xero Developer portal → Configuration tab |
| `XERO_CLIENT_SECRET` | Yes | From Xero Developer portal → Configuration tab |
| `XERO_REDIRECT_URI` | Yes | Must exactly match Xero portal. E.g. `https://yourapp.railway.app/xero/callback` |
| `SESSION_SECRET` | Yes | Any random string, minimum 32 characters |
| `DATABASE_URL` | Yes | PostgreSQL connection string. Railway sets this automatically |
| `REDIS_URL` | No | Redis connection string. If absent, queue runs inline |
| `NODE_ENV` | No | Set to `production` on server |
| `PORT` | No | Defaults to `3000` |
| `APP_URL` | No | Public URL of your app (no trailing slash) |
| `DB_SSL` | No | Set to `true` for hosted PostgreSQL (Railway) |
| `IMAP_HOST` | No* | e.g. `imap.gmail.com` — required for email watching |
| `IMAP_PORT` | No* | e.g. `993` |
| `IMAP_USER` | No* | Your inbox email address |
| `IMAP_PASS` | No* | Gmail App Password (not your login password) |
| `IMAP_POLL_INTERVAL_MS` | No | How often to poll for email. Default `60000` (1 minute) |
| `SLACK_WEBHOOK_URL` | No | Slack incoming webhook URL. Leave blank to disable |
| `DEFAULT_ACCOUNT_CODE` | No | Xero chart of accounts code for expense line items. Default `310` |
| `DEFAULT_CURRENCY` | No | ISO currency code. Default `SGD` |

> *All four `IMAP_*` variables must be set together, or email watching is skipped entirely.

---

## 5. Full Email-to-Invoice Flow

This is the exact sequence of what happens from the moment an email lands in the inbox.

```
═══════════════════════════════════════════════════════════════
STEP 1 — IMAP LISTENER DETECTS NEW EMAIL
═══════════════════════════════════════════════════════════════

  listener.js connects to your Gmail inbox via TLS on port 993.

  Trigger conditions (whichever fires first):
    a) Server PUSH — Gmail notifies of new mail immediately
    b) POLL — runs every IMAP_POLL_INTERVAL_MS (default 60s)
    c) On startup — checks all UNSEEN emails immediately

  Action:
    - Searches inbox for all UNSEEN messages
    - Fetches their full raw content (headers + body + attachments)
    - Marks each email as SEEN so it is never processed twice


═══════════════════════════════════════════════════════════════
STEP 2 — EMAIL IS PARSED (parser.js)
═══════════════════════════════════════════════════════════════

  The raw email bytes are decoded by `mailparser` into a
  structured object with: subject, from, text, html, attachments.

  Then the parser runs in this order:

  ┌─ Is there a PDF attachment?
  │    YES → extract text from the PDF using pdf-parse
  │           (if PDF text is >50 chars, use it)
  │    NO  → use email.text (plain text body)
  │           if no plain text → strip HTML tags from email.html
  └─ Now we have a raw text string to work with

  Regex patterns are then applied to extract:

    vendorName    → matches "from:", "supplier:", "vendor:", "billed by:"
                    falls back to the sender's display name
    invoiceNumber → matches "Invoice No:", "Invoice #:", "Invoice Number:"
                    falls back to "INV-<timestamp>"
    invoiceDate   → matches "Date: DD/MM/YYYY" or "Date: YYYY-MM-DD"
                    falls back to today's date
    dueDate       → matches "Due Date: DD/MM/YYYY"
                    falls back to invoiceDate + 30 days
    subtotal      → matches "Subtotal:", "Net Amount:", "Sub Total:"
    taxAmount     → matches "GST:", "VAT:", "Tax:", "Tax Amount:"
    totalAmount   → matches "Total:", "Amount Due:", "Total Amount Due:"

  Final structured object produced:
  {
    vendorName:    "Acme Corp",
    invoiceNumber: "INV-2026-001",
    invoiceDate:   "2026-05-27",
    dueDate:       "2026-06-27",
    subTotal:      1000.00,
    taxAmount:     90.00,
    totalAmount:   1090.00,
    description:   "Invoice from Acme Corp - Please Pay",  ← email subject
    sourceEmail:   "billing@acmecorp.com",
    accountCode:   "310",
    taxType:       "TAX001"   ← "NONE" if taxAmount is 0
  }

  If no usable text is found at all → email is SKIPPED, warning logged.


═══════════════════════════════════════════════════════════════
STEP 3 — INVOICE IS ENQUEUED (processor.js)
═══════════════════════════════════════════════════════════════

  The structured invoice object is passed to enqueueInvoice().

  It queries the database:
    "Give me all connected Xero organisations"

  For EACH connected Xero org:
    → Pushes a job onto the Bull/Redis queue

  Job options:
    - Max 5 attempts
    - Exponential backoff starting at 2 seconds
    - Up to 3 jobs processed in parallel

  If Redis is not configured:
    → Falls back to processing the invoice inline (no queue)


═══════════════════════════════════════════════════════════════
STEP 4 — QUEUE WORKER PROCESSES THE JOB (processor.js)
═══════════════════════════════════════════════════════════════

  The Bull worker picks up the job and calls createDraftInvoice().


═══════════════════════════════════════════════════════════════
STEP 5 — CONTACT LOOKUP OR CREATION (contacts.js)
═══════════════════════════════════════════════════════════════

  First: get a valid Xero access token from the database.
         If the token is expired → silently refresh it using
         the stored refresh token → save the new token to DB.

  Then: search Xero contacts for an exact name match:
    Name == "Acme Corp"

  Found?   → use the existing contactID
  Not found? → create a new Supplier contact in Xero:
    {
      name:         "Acme Corp",
      emailAddress: "billing@acmecorp.com",
      isSupplier:   true,
      isCustomer:   false
    }


═══════════════════════════════════════════════════════════════
STEP 6 — DRAFT INVOICE CREATED IN XERO (invoices.js)
═══════════════════════════════════════════════════════════════

  Calls the Xero Accounting API to create:
  {
    type:            "ACCPAY"   ← bill (money you owe)
    status:          "DRAFT"
    contact:         { contactID: "..." }
    date:            "2026-05-27"
    dueDate:         "2026-06-27"
    invoiceNumber:   "INV-2026-001"
    reference:       "Invoice from Acme Corp - Please Pay"
    currencyCode:    "SGD"
    lineAmountTypes: "EXCLUSIVE"  ← amounts are tax-exclusive
    lineItems: [{
      description: "Invoice from Acme Corp - Please Pay",
      quantity:    1,
      unitAmount:  1000.00,
      accountCode: "310",
      taxType:     "TAX001"
    }]
  }

  Rate limit handling:
    If Xero returns HTTP 429 (too many requests):
    - Check the Retry-After header
    - Wait that many seconds (or exponential backoff)
    - Retry up to 3 times


═══════════════════════════════════════════════════════════════
STEP 7 — LOG TO DATABASE
═══════════════════════════════════════════════════════════════

  Inserts a row into invoice_log:
    tenant_id, xero_invoice_id, invoice_number, vendor_name,
    total_amount, currency, source_email, status="created",
    raw_email_subject


═══════════════════════════════════════════════════════════════
STEP 8 — SLACK NOTIFICATION SENT
═══════════════════════════════════════════════════════════════

  Posts to your Slack webhook:

    *New Draft Invoice Created in Xero*
    Org: My Company Ltd
    Vendor: Acme Corp
    Invoice #: INV-2026-001
    Amount: SGD 1090.00
    <link to review in Xero>

  If SLACK_WEBHOOK_URL is not set → this step is silently skipped.

═══════════════════════════════════════════════════════════════
DONE — Draft invoice is live in Xero awaiting your review
═══════════════════════════════════════════════════════════════
```

---

## 6. Module Breakdown

### `index.js` — Entry point

- Validates all required environment variables on startup (crashes early if missing)
- Bootstraps Express with: Helmet (security headers), compression, rate limiting (100 req/15min), Morgan HTTP logging, session cookies
- Mounts routes: `/xero/*` and `/dashboard/*`
- Starts the IMAP watcher if all four `IMAP_*` vars are set
- Handles graceful shutdown on `SIGTERM` / `SIGINT`

---

### `email/listener.js` — IMAP Watcher

- Opens a persistent TLS connection to the IMAP server
- Listens for push `mail` events AND polls on a configurable interval
- On disconnect or error: auto-reconnects (30s on error, 10s on clean end)
- Fetches all `UNSEEN` emails and marks them `SEEN` atomically so no email is ever processed twice

---

### `email/parser.js` — Invoice Extractor

- Tries PDF attachment text first (if ≥ 50 chars usable)
- Falls back to plain text body, then HTML body (tags stripped)
- All field extraction is done with regex — no AI/ML
- Date handling supports: `DD/MM/YYYY`, `MM/DD/YYYY`, `YYYY-MM-DD`
- If a value cannot be parsed, safe defaults are used (today's date, 0 amounts, fallback invoice number)

---

### `queue/processor.js` — Bull Queue Manager

- Lazily initialises the Bull queue on first use (so the server starts even without Redis)
- Processes up to 3 jobs concurrently
- On final failure (5 attempts exhausted): saves to `dead_letter_queue` and fires Slack error alert
- Without Redis: falls back to inline synchronous processing

---

### `xero/client.js` — Xero SDK Singleton

- Exports a single shared `XeroClient` instance
- Configured with OAuth2 scopes: `openid profile email accounting.transactions accounting.contacts`

---

### `xero/auth.js` — OAuth2 Routes

| Route | What it does |
|---|---|
| `GET /xero/connect` | Builds the Xero consent URL and redirects the browser |
| `GET /xero/callback` | Exchanges the auth code for tokens, saves to DB, redirects to `/dashboard` |
| `DELETE /xero/disconnect/:tenantId` | Removes a tenant's tokens from the DB |

---

### `xero/contacts.js` — Contact Management

- Searches Xero for an exact name match before creating
- If found: reuses existing contactID (no duplicate contacts)
- If not found: creates a new Supplier contact using vendor name + source email

---

### `xero/invoices.js` — Invoice Creation

- Gets (and auto-refreshes if needed) the access token before every API call
- Always creates invoices as `ACCPAY` (Accounts Payable = bills) + `DRAFT` status
- Includes exponential backoff retry for Xero 429 rate-limit errors
- Logs every created invoice to PostgreSQL

---

### `db/migrate.js` — Schema Migration

- Run once before starting the server
- Creates all three tables if they don't already exist (idempotent — safe to re-run)

---

### `db/tokens.js` — Token Storage

- `saveTokens` — upserts OAuth tokens for a tenant (insert or update on conflict)
- `getValidToken` — returns access token; if expired within 60s, refreshes automatically
- `getAllTenants` — returns all connected Xero orgs (used to fan out invoice jobs)
- `deleteTenant` — removes a tenant's record

---

### `db/pool.js` — Database Connection

- Creates a single `pg.Pool` shared across the app
- Reads `DATABASE_URL` and optionally enables SSL (`DB_SSL=true`)

---

### `routes/dashboard.js` — Monitoring API

| Endpoint | Returns |
|---|---|
| `GET /dashboard` | List of all connected Xero orgs |
| `GET /dashboard/invoices/:tenantId` | Last 100 invoice log entries for a tenant |
| `GET /dashboard/dead-letter` | Last 50 failed invoices |
| `GET /dashboard/health` | `{ status: "healthy" }` if DB is reachable |

---

### `utils/notify.js` — Slack Alerts

- `notifyInvoiceCreated` — success alert with Xero deep link
- `notifyError` — failure alert with context and source email
- Both silently no-op if `SLACK_WEBHOOK_URL` is not set

---

### `utils/logger.js` — Structured Logging

- Winston logger writing to console and `/logs/` directory
- All log entries include timestamp and log level

---

## 7. Database Schema

### `xero_tenants`
Stores OAuth credentials per connected Xero organisation.

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL | Primary key |
| `user_id` | VARCHAR(255) | Session user ID |
| `tenant_id` | UUID UNIQUE | Xero organisation ID |
| `tenant_name` | VARCHAR(255) | Xero organisation display name |
| `access_token` | TEXT | Short-lived Xero access token |
| `refresh_token` | TEXT | Long-lived token used to get new access tokens |
| `token_expires_at` | TIMESTAMPTZ | When the access token expires |
| `id_token` | TEXT | OpenID Connect ID token |
| `scopes` | TEXT | Space-separated OAuth scopes granted |
| `connected_at` | TIMESTAMPTZ | When the org was first connected |
| `updated_at` | TIMESTAMPTZ | Last token refresh time |

---

### `invoice_log`
Audit trail of every invoice created.

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL | Primary key |
| `tenant_id` | UUID | Which Xero org the invoice was created in |
| `xero_invoice_id` | UUID | Invoice ID in Xero |
| `invoice_number` | VARCHAR(100) | Extracted from email |
| `vendor_name` | VARCHAR(255) | Extracted from email |
| `total_amount` | NUMERIC(12,2) | Extracted from email |
| `currency` | VARCHAR(10) | From `DEFAULT_CURRENCY` env var |
| `source_email` | TEXT | Sender's email address |
| `status` | VARCHAR(50) | Always `created` on success |
| `error_message` | TEXT | Populated if creation failed |
| `raw_email_subject` | TEXT | Original email subject line |
| `created_at` | TIMESTAMPTZ | When the row was inserted |

---

### `dead_letter_queue`
Invoices that failed all retry attempts.

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL | Primary key |
| `raw_email` | TEXT | Raw email or job data (truncated to 10,000 chars) |
| `error_message` | TEXT | Last error message |
| `attempts` | INT | Number of attempts made |
| `created_at` | TIMESTAMPTZ | When first failed |
| `last_attempted` | TIMESTAMPTZ | When last retried |

---

## 8. API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | App info and links |
| `GET` | `/xero/connect` | Start Xero OAuth flow (open in browser) |
| `GET` | `/xero/callback` | OAuth redirect handler (set this in Xero portal) |
| `DELETE` | `/xero/disconnect/:tenantId` | Disconnect a Xero org |
| `GET` | `/dashboard` | List all connected Xero orgs |
| `GET` | `/dashboard/invoices/:tenantId` | Invoice log for a specific org |
| `GET` | `/dashboard/dead-letter` | Failed invoices that exhausted all retries |
| `GET` | `/dashboard/health` | Health check — returns 200 if DB is reachable |

---

## 9. Input vs Output

### Input — an email in your inbox

```
From:    billing@acmecorp.com (Acme Corp)
Subject: Invoice from Acme Corp - Please Pay

Invoice No: INV-2026-001
Date: 27/05/2026
Due Date: 27/06/2026
Subtotal: $1,000.00
GST: $90.00
Total: $1,090.00
```

OR: an email with a PDF attachment containing the same fields.

---

### Output — a DRAFT bill in Xero

```
Type:          Bill (ACCPAY)
Status:        DRAFT
Contact:       Acme Corp
Invoice No:    INV-2026-001
Date:          27 May 2026
Due Date:      27 June 2026
Currency:      SGD
Line Item:     Invoice from Acme Corp - Please Pay   x1   $1,000.00
Tax:           TAX001 (GST)                                  $90.00
Total:                                                    $1,090.00
Account Code:  310
```

---

### Side Outputs

| Output | Where |
|---|---|
| Audit row | `invoice_log` table in PostgreSQL |
| Slack message | Your Slack channel with a direct link to the invoice in Xero |
| App log | Console + `/logs/` directory (Winston) |

---

## 10. Failure Handling & Retries

```
Email cannot be parsed
  → Logged as warning, email skipped, no invoice created

No Xero orgs connected
  → Logged as warning, invoice not queued

Xero API rate-limit (HTTP 429)
  → Wait Retry-After seconds (or exponential backoff)
  → Retry up to 3 times within the job

Job fails (any other error)
  → Bull retries up to 5 times with exponential backoff
     Attempt 1: immediate
     Attempt 2: 2s delay
     Attempt 3: 4s delay
     Attempt 4: 8s delay
     Attempt 5: 16s delay

All 5 attempts exhausted
  → Row inserted into dead_letter_queue
  → Slack error alert sent

Token expired when job runs
  → Auto-refreshed silently using refresh_token
  → New tokens saved to DB
  → Job continues

IMAP connection drops
  → Reconnects automatically after 10s (clean end) or 30s (error)

Enqueue itself fails (e.g. Redis down)
  → Error logged
  → Slack error alert sent
  → Raw email saved to dead_letter_queue
```

---

## 11. Invoice Type Detection

The parser detects whether to create a **bill** (ACCPAY) or **sales invoice** (ACCREC) based on keywords in the email subject line.

> **Note:** The current implementation in `invoices.js` always creates `ACCPAY`. The type detection logic described in the README is in `parser.js` and would need to be wired into `invoices.js` to use `ACCREC`.

| Keywords in subject | Invoice type | Meaning |
|---|---|---|
| `please pay`, `payment due`, `bill from`, `invoice from` | ACCPAY | Money **you owe** (a bill) |
| `your invoice`, `invoice to`, `sales invoice` | ACCREC | Money **owed to you** (a sales invoice) |
| *(no match)* | ACCPAY | Default — safest assumption |

---

## 12. Regex Field Extraction Rules

These are the exact patterns used in `email/parser.js`:

| Field | Pattern | Example match |
|---|---|---|
| Vendor name | `(?:from\|supplier\|vendor\|billed by)[:\s]+([^\n\r,]{2,60})` | `From: Acme Corp` |
| Invoice number | `invoice\s*(?:no\|number\|#\|num)[.:\s]*([A-Z0-9][A-Z0-9\-\/]{1,30})` | `Invoice No: INV-2026-001` |
| Invoice date | `(?:invoice\s*)?date[:\s]*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})` | `Date: 27/05/2026` |
| Due date | `due\s*(?:date\|by)[:\s]*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})` | `Due Date: 27/06/2026` |
| Total | `(?:total\s*(?:amount\s*due\|due\|payable)?\|amount\s*due)[:\s]*(?:SGD\|USD\|...)?\$?([\d,]+\.?\d{0,2})` | `Total: $1,090.00` |
| Subtotal | `(?:sub\s*total\|subtotal\|net\s*amount)[:\s]*...\$?([\d,]+\.?\d{0,2})` | `Subtotal: $1,000.00` |
| Tax | `(?:gst\|vat\|tax\s*amount\|tax)[:\s]*...\$?([\d,]+\.?\d{0,2})` | `GST: $90.00` |

**Date format support:**
- `DD/MM/YYYY` — detected when day > 12
- `MM/DD/YYYY` — detected when day ≤ 12 (ambiguous, treated as MM first)
- `YYYY-MM-DD` — detected when first segment is 4 digits

**Tax type logic:**
- `taxAmount > 0` → `taxType = "TAX001"` (GST/VAT)
- `taxAmount == 0` → `taxType = "NONE"`

**Amount fallback:**
- If subtotal is missing: `subTotal = totalAmount - taxAmount`
- If both are zero: `subTotal = totalAmount` (avoids negative line items)

---

## 13. External API Integrations — What You Need

This system depends on **5 external services**. All of them must be set up and linked via environment variables before the system works end-to-end.

```
┌──────────────────────────────────────────────────────────────┐
│               EXTERNAL SERVICES REQUIRED                     │
│                                                              │
│  ┌─────────────┐   OAuth2 tokens    ┌──────────────────┐    │
│  │   XERO API  │◀──────────────────▶│  This App        │    │
│  │ (Required)  │                    │  (Node.js)       │    │
│  └─────────────┘                    │                  │    │
│                                     │                  │    │
│  ┌─────────────┐   IMAP/TLS         │                  │    │
│  │    GMAIL    │◀──────────────────▶│                  │    │
│  │ (Required)  │                    │                  │    │
│  └─────────────┘                    │                  │    │
│                                     │                  │    │
│  ┌─────────────┐   connection URL   │                  │    │
│  │ POSTGRESQL  │◀──────────────────▶│                  │    │
│  │ (Required)  │                    │                  │    │
│  └─────────────┘                    │                  │    │
│                                     │                  │    │
│  ┌─────────────┐   connection URL   │                  │    │
│  │    REDIS    │◀──────────────────▶│                  │    │
│  │ (Optional)  │                    │                  │    │
│  └─────────────┘                    │                  │    │
│                                     │                  │    │
│  ┌─────────────┐   webhook POST     │                  │    │
│  │    SLACK    │◀──────────────────▶│                  │    │
│  │ (Optional)  │                    └──────────────────┘    │
│  └─────────────┘                                            │
└──────────────────────────────────────────────────────────────┘
```

| Service | Purpose | Required? | What breaks without it |
|---|---|---|---|
| **Xero API** | Create draft invoices in your accounting software | Yes | App has no output — no invoices created |
| **Gmail / IMAP inbox** | Watch for incoming invoice emails | Yes | App has no input — never sees any emails |
| **PostgreSQL** | Store OAuth tokens + invoice logs | Yes | App crashes on startup |
| **Redis** | Queue and retry invoice jobs | No | Falls back to inline processing (no retries) |
| **Slack** | Send alerts when invoice is created or fails | No | Silent — no notifications, but invoices still created |

---

## 14. Xero API — Setup & Linking

### What it does in this app
- Receives OAuth2 tokens after the user logs in via `/xero/connect`
- Looks up or creates **Contacts** (suppliers/vendors) in Xero
- Creates **DRAFT invoices** (bills) in Xero Accounts Payable
- Reads tenant/organisation info after login

### OAuth Scopes requested

These are hardcoded in `xero/client.js`:

| Scope | Why it's needed |
|---|---|
| `openid` | Required for OAuth2 login |
| `profile` | Read user profile |
| `email` | Read user email |
| `offline_access` | Get a refresh token (so tokens auto-renew without re-login) |
| `accounting.transactions` | **Create invoices** — the core function |
| `accounting.contacts` | **Look up and create contacts** (vendors) |
| `accounting.settings` | Read org settings (currency, tax codes) |
| `accounting.reports.read` | Read reports (available but not currently used) |

### Step-by-step setup

**Step 1 — Create a Xero Developer App**

1. Go to [developer.xero.com](https://developer.xero.com)
2. Sign in with your Xero account
3. Click **My Apps** → **New App**
4. Fill in:
   - App name: anything (e.g. `Invoice Automation`)
   - Integration type: **Web app**
   - Company URL: your website or placeholder
   - Redirect URI: `https://yourapp.up.railway.app/xero/callback`
     - For local dev: `http://localhost:3000/xero/callback`
5. Click **Create App**

**Step 2 — Get your credentials**

On the **Configuration** tab of your app:
- Copy **Client ID** → paste as `XERO_CLIENT_ID` in `.env`
- Click **Generate a secret** → copy it → paste as `XERO_CLIENT_SECRET`
- These are shown once — save them immediately

**Step 3 — Set the Redirect URI**

The `XERO_REDIRECT_URI` in your `.env` must exactly match what is in the Xero portal:

```
# .env
XERO_REDIRECT_URI=https://yourapp.up.railway.app/xero/callback

# Xero Developer Portal → Configuration → Redirect URIs
https://yourapp.up.railway.app/xero/callback   ← must be identical
```

> Common mistake: trailing slash, `http` vs `https`, wrong domain. Any mismatch = `redirect_uri_mismatch` error.

**Step 4 — Connect your Xero org**

Once the app is running, visit:
```
https://yourapp.up.railway.app/xero/connect
```
Log in with Xero → Approve → tokens are saved to PostgreSQL automatically.

### Token lifecycle

```
User visits /xero/connect
  → App builds Xero consent URL
  → User logs in on Xero's site
  → Xero redirects to /xero/callback with auth code
  → App exchanges code for access_token + refresh_token
  → Tokens saved to xero_tenants table in PostgreSQL

When a job runs and needs the token:
  → db/tokens.js checks token_expires_at
  → If expiring within 60 seconds → auto-refresh using refresh_token
  → New tokens saved to DB
  → Old tokens discarded
```

Access tokens last **30 minutes**. Refresh tokens last **60 days** but are rotated on every refresh (each refresh gives a new refresh token).

### Xero API rate limits

- **60 API calls per minute** per connected Xero org
- The Bull queue limits concurrent workers to 3 to stay within this
- HTTP 429 responses trigger exponential backoff + retry (up to 3x per job)

---

## 15. Gmail IMAP — Setup & Linking

### What it does in this app
- The app connects to Gmail as an IMAP client (like an email app would)
- It reads all UNSEEN emails, marks them seen, and passes them to the parser

### Why you cannot use your normal Gmail password

Google blocks plain password IMAP access for security. You must use a **Gmail App Password** — a 16-character code generated specifically for this app.

### Step-by-step setup

**Step 1 — Enable 2-Step Verification on your Google account**

1. Go to [myaccount.google.com](https://myaccount.google.com)
2. Click **Security**
3. Under "How you sign in to Google" → **2-Step Verification** → Turn it ON

> You must have 2-Step Verification enabled before App Passwords will appear.

**Step 2 — Enable IMAP in Gmail settings**

1. Open Gmail
2. Click the gear icon → **See all settings**
3. Go to the **Forwarding and POP/IMAP** tab
4. Under "IMAP access" → **Enable IMAP**
5. Click **Save Changes**

**Step 3 — Generate an App Password**

1. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
2. Under "App name" type: `Xero Invoice App`
3. Click **Create**
4. Copy the 16-character password shown (e.g. `abcd efgh ijkl mnop`)
5. Remove the spaces when pasting into `.env`

**Step 4 — Set environment variables**

```
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_USER=your_invoice_inbox@gmail.com
IMAP_PASS=abcdefghijklmnop        ← 16 chars, no spaces
IMAP_POLL_INTERVAL_MS=60000       ← poll every 60 seconds
```

### Inbox recommendation

Use a **dedicated Gmail account** just for invoices (e.g. `invoices@yourcompany.com`), not your main inbox. The app marks every unread email as read and tries to parse it as an invoice.

### How the IMAP connection works

```
App starts
  → Creates TLS connection to imap.gmail.com:993
  → Authenticates with IMAP_USER + IMAP_PASS
  → Opens INBOX folder (read-write mode)
  → Immediately fetches all UNSEEN messages
  → Listens for server PUSH events (new mail arrives → triggers immediately)
  → Also polls every IMAP_POLL_INTERVAL_MS as a fallback

On IMAP error → reconnects after 30 seconds
On IMAP disconnect → reconnects after 10 seconds
```

### For Outlook / Office 365 instead of Gmail

```
IMAP_HOST=outlook.office365.com
IMAP_PORT=993
IMAP_USER=your_invoice_inbox@yourdomain.com
IMAP_PASS=your_outlook_password_or_app_password
```

---

## 16. Slack — Setup & Linking

### What it does in this app
- Sends a message to a Slack channel when a draft invoice is successfully created
- Sends an error alert when a job fails all retries

### This is optional — the app works without it

If `SLACK_WEBHOOK_URL` is not set, Slack notifications are silently skipped. No errors.

### Step-by-step setup

**Step 1 — Create a Slack App and Incoming Webhook**

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** → **From scratch**
3. Name it (e.g. `Xero Invoice Bot`) → select your workspace → **Create App**
4. In the left sidebar click **Incoming Webhooks**
5. Toggle **Activate Incoming Webhooks** → ON
6. Click **Add New Webhook to Workspace**
7. Select the channel to post to (e.g. `#invoices`) → **Allow**
8. Copy the webhook URL — it looks like:
   ```
   https://hooks.slack.com/services/<TEAM_ID>/<BOT_ID>/<TOKEN>
   ```

**Step 2 — Set environment variable**

```
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/<TEAM_ID>/<BOT_ID>/<TOKEN>
```

### What the Slack messages look like

**Success:**
```
*New Draft Invoice Created in Xero*
Org: My Company Ltd
Vendor: Acme Corp
Invoice #: INV-2026-001
Amount: SGD 1090.00
<link: Review in Xero>
```

**Failure:**
```
*Xero Invoice App Error*
Context: Job 42 failed after 5 attempts
Error: Request failed with status code 503
Source email: billing@acmecorp.com
```

---

## 17. PostgreSQL — Setup & Linking

### What it does in this app
- Stores Xero OAuth tokens (`xero_tenants` table)
- Logs every created invoice (`invoice_log` table)
- Stores failed invoices for manual review (`dead_letter_queue` table)

### Required — app crashes without it

The server checks the DB connection on startup and on every request.

### Connection pool settings (hardcoded in `db/pool.js`)

| Setting | Value | Meaning |
|---|---|---|
| `max` | 20 | Maximum simultaneous connections |
| `idleTimeoutMillis` | 30,000 | Close idle connections after 30s |
| `connectionTimeoutMillis` | 2,000 | Fail if can't connect within 2s |
| `ssl` | depends on `DB_SSL` env | Set `DB_SSL=true` for hosted databases |

### On Railway (recommended)

Railway automatically provisions PostgreSQL and sets `DATABASE_URL`. You do not need to configure anything manually — just add the PostgreSQL service to your project.

Set `DB_SSL=true` because Railway's PostgreSQL requires SSL.

### Local development

```bash
# Install PostgreSQL locally (macOS)
brew install postgresql@16
brew services start postgresql@16

# Create the database
createdb xero_invoices

# Set in .env
DATABASE_URL=postgresql://postgres:password@localhost:5432/xero_invoices
DB_SSL=false    ← no SSL needed locally
```

Then run the migration:
```bash
node db/migrate.js
```

---

## 18. Redis — Setup & Linking

### What it does in this app
- Backs the Bull job queue
- Stores job state (pending, active, completed, failed)
- Enables automatic retries with exponential backoff

### Optional — but strongly recommended for production

Without Redis, invoices are processed inline (synchronously) with no retry on failure. One network blip = lost invoice.

With Redis, every failed attempt is retried up to 5 times automatically.

### Queue configuration (in `queue/processor.js`)

| Setting | Value | Meaning |
|---|---|---|
| Concurrent workers | 3 | Max 3 invoices processed at the same time |
| Max attempts | 5 | Retry up to 5 times before dead-letter |
| Backoff type | Exponential | Delay doubles each retry: 2s, 4s, 8s, 16s |
| Completed job retention | 100 | Keep last 100 completed jobs in Redis |
| Failed job retention | 200 | Keep last 200 failed jobs in Redis |

### On Railway (recommended)

Add the Redis service to your Railway project. Railway sets `REDIS_URL` automatically.

### Local development

```bash
# Install Redis locally (macOS)
brew install redis
brew services start redis

# Set in .env
REDIS_URL=redis://localhost:6379
```

### Fallback behaviour (no Redis)

If `REDIS_URL` is not set, the app logs a warning and processes invoices synchronously:
```
REDIS_URL not set — Bull queue disabled, processing inline
```
This still works but:
- No automatic retries on failure
- No concurrency limiting (could hit Xero rate limits if many emails arrive at once)
- No dead-letter queue

---

## 19. Common Linking Problems & Fixes

### Xero OAuth problems

| Error | Cause | Fix |
|---|---|---|
| `redirect_uri_mismatch` | `XERO_REDIRECT_URI` in `.env` doesn't exactly match the URI in the Xero Developer portal | Copy-paste exactly — check for trailing slash, `http` vs `https`, wrong subdomain |
| `invalid_client` | `XERO_CLIENT_ID` or `XERO_CLIENT_SECRET` is wrong | Regenerate the secret in Xero Developer portal, copy again |
| `Token refresh failed` | Refresh token is more than 60 days old (expired) | Visit `/xero/connect` again to re-authorise |
| `No token for tenant` | The tenant was disconnected from the DB | Visit `/xero/connect` again |
| No invoice appears in Xero | `DEFAULT_ACCOUNT_CODE` (default `310`) doesn't exist in your Xero chart of accounts | In Xero → Accounting → Chart of Accounts → find a valid expense code and set it as `DEFAULT_ACCOUNT_CODE` |

---

### Gmail IMAP problems

| Error | Cause | Fix |
|---|---|---|
| `Invalid credentials` | Using regular Gmail password instead of App Password | Generate an App Password at myaccount.google.com → Security → App Passwords |
| `App passwords` option not visible | 2-Step Verification is not enabled | Enable 2-Step Verification first, then App Passwords appears |
| `IMAP not enabled` | Gmail's IMAP access is disabled | Gmail → Settings → Forwarding and POP/IMAP → Enable IMAP |
| Emails not being picked up | All emails are already SEEN | In Gmail, mark all inbox emails as Unread, or the app only processes emails arriving after startup |
| `ECONNREFUSED` on IMAP | Wrong host/port | Confirm `IMAP_HOST=imap.gmail.com` and `IMAP_PORT=993` |

---

### Database problems

| Error | Cause | Fix |
|---|---|---|
| `ECONNREFUSED` on database | PostgreSQL not running or wrong `DATABASE_URL` | Check DB service is running; verify connection string |
| `SSL SYSCALL error` | Connecting to hosted DB without SSL | Set `DB_SSL=true` |
| `relation "xero_tenants" does not exist` | Migration hasn't been run | Run `node db/migrate.js` |
| `too many connections` | Pool exhausted (max is 20) | Check for connection leaks; reduce load |

---

### Queue / Redis problems

| Error | Cause | Fix |
|---|---|---|
| `Failed to init Bull queue` | Redis not reachable | Check `REDIS_URL` is correct and Redis is running |
| Jobs stuck in `active` state | Worker crashed mid-job | Restart the server; Bull will requeue stalled jobs automatically |
| Dead-letter queue growing | Xero API consistently failing | Check `/dashboard/dead-letter` for the error message; fix the root cause then re-process manually |

---

### Startup checklist — verify all links are working

```bash
# 1. Check DB is reachable
curl http://localhost:3000/dashboard/health
# → { "status": "healthy" }

# 2. Check Xero is connected
curl http://localhost:3000/dashboard
# → { "tenants": [{ "tenantId": "...", "tenantName": "My Company" }] }

# 3. Check IMAP is connecting
# → Look for this in the server logs:
#   IMAP connected, opening INBOX

# 4. Send a test email and watch the logs for:
#   Invoice parsed   { vendor: "...", number: "...", total: ... }
#   Invoice queued   { tenant: "...", vendor: "..." }
#   Draft invoice created { tenantId, invoiceID, vendor, amount }
#   Invoice created notification sent
```

---

## 20. Where Invoices Appear in Xero — ACCPAY vs ACCREC

### The two invoice types and where to find them

| Type | Code | Meaning | Where it appears in Xero |
|---|---|---|---|
| Bill | `ACCPAY` | Money **you owe** to a supplier | Accounts → Purchases → Bills → Drafts |
| Sales Invoice | `ACCREC` | Money **owed to you** by a customer | Accounts → Sales → Invoices → Drafts |

---

### ACCPAY — Bills (current default in this app)

**Navigation path in Xero:**
```
Accounts
  └── Purchases
        └── Bills
              └── Drafts   ← invoices created by this app appear here
```

**Use this when:**
- You received an invoice from a supplier/vendor
- The email says "please pay", "invoice from", "payment due"
- You owe someone money

**Hardcoded in** [xero/invoices.js:40](xero/invoices.js#L40):
```js
type: Invoice.TypeEnum.ACCPAY
```

---

### ACCREC — Sales Invoices

**Navigation path in Xero:**
```
Accounts
  └── Sales
        └── Invoices
              └── Drafts   ← invoices appear here if type is changed to ACCREC
```

**Use this when:**
- You issued an invoice to a customer
- The email says "your invoice", "invoice to", "sales invoice"
- Someone owes YOU money

---

### How the account linking works (OAuth → your specific org)

```
You visit /xero/connect
        ↓
You log into Xero and approve the app for your org
        ↓
Xero returns a tenant_id (UUID) that identifies your org
        ↓
Every API call passes that tenant_id:
  accountingApi.createInvoices(tenantId, invoiceBody)
        ↓
Invoice lands inside YOUR Xero org only — not anyone else's
```

The `tenant_id` is stored in the `xero_tenants` table in PostgreSQL and used on every API call. It is the lock that ensures invoices go to your org specifically.

---

### Known issue — Slack notification uses legacy URL format

The Slack link generated in [utils/notify.js:14](utils/notify.js#L14) uses the old Xero URL format:

```js
// Current (legacy format — still works via redirect)
https://go.xero.com/AccountsPayable/Edit.aspx?InvoiceID=${invoiceID}

// New Xero URL format (what your browser shows today)
https://go.xero.com/app/!XXXXXX/bills/draft
```

The app cannot build the new-style URL because it never stores the org short code (e.g. `!3J8tx`) — it only stores the full UUID `tenant_id`, which is a different identifier. The legacy link still opens the correct invoice via Xero's redirect.

---

### To switch from ACCPAY to ACCREC (one-line change)

If you want the app to create **sales invoices** instead of bills, edit [xero/invoices.js:40](xero/invoices.js#L40):

```js
// Change this:
type: Invoice.TypeEnum.ACCPAY

// To this:
type: Invoice.TypeEnum.ACCREC
```

After this change, invoices will appear under **Accounts → Sales → Invoices → Drafts** instead of Purchases → Bills → Drafts.

---

*Generated from codebase analysis — reflects the code as of May 2026.*
