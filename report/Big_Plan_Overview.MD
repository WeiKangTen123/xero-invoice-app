# Big Plan: Xero Invoice Automation — Desktop App

---

## What We Are Building

A **Mac/Windows desktop app** (Electron) that:

1. Opens a **Setup Screen** on first launch — user fills in Xero + Email credentials
2. Runs a **background IMAP watcher** — listens for new invoice emails
3. Automatically **parses and uploads** invoice drafts to Xero
4. Caches invoice data locally for **1 day** (auto-deleted after), with retry on failure
5. Shows a **Status Screen** — what's running, recent invoices processed

No database. No web server. No Redis. No Slack. No external services.

---

## Core Flow

```
[App starts]
      ↓
Setup complete? → No → Show Setup Screen → User fills credentials → Save → Start
      ↓ Yes
Load settings from file
      ↓
autoConnect() → get Xero token → save to cache
      ↓
Start IMAP watcher
      ↓
[New email arrives]
      ↓
parseInvoice() → extract vendor, amount, date, invoice#
      ↓
Save to cache (status: pending)
      ↓
createDraftInvoice() → Xero API
      ↓                    ↓
status: done          status: failed
(kept 1 day,          (retried on
 then deleted)         next startup)
```

---

## App Screens

### Screen 1 — Setup (first launch or when editing settings)

```
┌─────────────────────────────────────────────┐
│         Xero Invoice Automation             │
├─────────────────────────────────────────────┤
│                                             │
│  XERO                    [→ Open Xero Dev]  │
│  Client ID     [ ________________________ ] │
│  Client Secret [ ________________________ ] │
│                                             │
│  EMAIL                   [→ Get App Pass]   │
│  Email Address [ ________________________ ] │
│  App Password  [ ________________________ ] │
│  IMAP Host     [ imap.gmail.com          ] │
│  IMAP Port     [ 993                     ] │
│                                             │
│  INVOICE DEFAULTS                           │
│  Currency      [ SGD ▼                   ] │
│  Account Code  [ 310                     ] │
│                                             │
│  OPTIONAL                                   │
│  Filter From   [ ________________________ ] │
│                                             │
│        [Test Connection]  [Save & Start]    │
└─────────────────────────────────────────────┘
```

### Screen 2 — Status (main running view)

```
┌─────────────────────────────────────────────┐
│         Xero Invoice Automation    [⚙ Setup]│
├─────────────────────────────────────────────┤
│                                             │
│  Status:  ● Running                         │
│  Xero Org: Your Company Name                │
│  Watching: yourmail@gmail.com               │
│                                             │
│  ─── Recent Invoices ───────────────────── │
│                                             │
│  ✓ Acme Corp    INV-001   SGD 1,200.00      │
│  ✓ supplier     INV-002   SGD 450.00        │
│  ✗ Unknown      INV-003   Failed (retry)    │
│                                             │
│              [Stop]  [Open Xero]            │
└─────────────────────────────────────────────┘
```

---

## Setup Fields (9 Total)

### Xero — 2 fields

| Field | How to get it |
|---|---|
| Client ID | developer.xero.com → My Apps → New App → Custom Connection |
| Client Secret | Same page as Client ID |

Link in app opens: `https://developer.xero.com/app/manage`

### Email — 4 fields

| Field | Notes |
|---|---|
| Email address | Your full email (e.g. you@gmail.com) |
| App Password | 16-digit code from Google — NOT your normal password |
| IMAP Host | Auto-filled based on email domain, editable |
| IMAP Port | Auto-filled as 993, editable |

Link in app opens: `https://myaccount.google.com/apppasswords`

**Auto-fill logic for IMAP Host:**

| Email domain | Host auto-filled |
|---|---|
| @gmail.com | `imap.gmail.com` |
| @outlook.com / @hotmail.com | `outlook.office365.com` |
| @yahoo.com | `imap.mail.yahoo.com` |
| @icloud.com / @me.com | `imap.mail.me.com` |
| anything else | blank — user types manually |

### Invoice Defaults — 2 fields

| Field | Notes |
|---|---|
| Default Currency | Dropdown: SGD / USD / AUD / GBP / EUR |
| Default Account Code | Find in Xero → Settings → Chart of Accounts |

### Optional — 1 field

| Field | Notes |
|---|---|
| Filter From Email | Only process emails from this sender. Leave blank = all emails |

---

## File Structure

```
xero-invoice-app/
│
├── main.js                   ← Electron main process (app entry point)
├── preload.js                ← Electron IPC bridge (renderer ↔ main)
├── package.json
│
├── src/
│   ├── renderer/             ← UI (what the user sees)
│   │   ├── index.html        ← Setup screen
│   │   ├── status.html       ← Status screen
│   │   ├── styles.css
│   │   └── app.js            ← UI logic, IPC calls
│   │
│   ├── email/
│   │   ├── listener.js       ← IMAP watcher (unchanged)
│   │   └── parser.js         ← Invoice parser (+ invoiceType detection — FIXED)
│   │
│   ├── xero/
│   │   ├── client.js         ← XeroClient singleton (minor tweak)
│   │   ├── connect.js        ← autoConnect() using client credentials
│   │   ├── contacts.js       ← Get or create Xero contact
│   │   └── invoices.js       ← Create draft invoice in Xero
│   │
│   ├── cache/
│   │   └── index.js          ← NEW: file-based cache with 1-day TTL
│   │
│   └── utils/
│       └── logger.js         ← Winston logging (unchanged)
│
└── userData/                 ← auto-created by Electron, git-ignored
    ├── settings.json         ← user credentials saved here
    ├── token.json            ← Xero access token
    ├── invoices.json         ← invoice cache (1-day TTL)
    └── logs/
        └── app.log
```

---

## How Electron Works (for context)

Electron has two sides that talk to each other:

```
Main Process (main.js)                Renderer Process (index.html / app.js)
─────────────────────                 ──────────────────────────────────────
Node.js — full access to              Browser JS — what the user sees
file system, network, IMAP            No direct file/network access
                                      Talks to main via IPC messages
         ←──────── IPC ────────→
         ipcMain.on(...)              ipcRenderer.invoke(...)
```

Examples of IPC calls:

| Renderer asks | Main does |
|---|---|
| `save-settings` | Write credentials to `settings.json` |
| `test-connection` | Try connecting to Xero + IMAP, return result |
| `start-watcher` | Start IMAP listener loop |
| `stop-watcher` | Stop IMAP listener |
| `get-status` | Return running state + recent invoice list |

---

## What Happens to Every Existing File

### Deleted entirely (8 items)

| File | Reason |
|---|---|
| `db/pool.js` | No database |
| `db/tokens.js` | No database — tokens stored in file |
| `db/migrate.js` | No database |
| `routes/dashboard.js` | No web server |
| `middleware/auth.js` | No web server (was unused dead code anyway) |
| `queue/processor.js` | No Redis/Bull — processing goes inline |
| `utils/notify.js` | No Slack |
| `xero/auth.js` | No browser OAuth — using client credentials |

### Kept unchanged (2 files)

| File | Role |
|---|---|
| `email/listener.js` | IMAP watcher — no changes needed |
| `email/parser.js` | Invoice parser — no changes needed |

### Modified (4 files)

| File | What changes |
|---|---|
| `index.js` → becomes `main.js` | Electron entry point, creates app window, no Express |
| `xero/connect.js` | Token saved to file instead of PostgreSQL |
| `xero/invoices.js` | Remove DB logging, update to use file cache |
| `xero/contacts.js` | Read token from file instead of DB |
| `xero/client.js` | Minor: ensure token loaded from file cache |
| `utils/logger.js` | Minor: log to `userData/logs/app.log` |

### New files (3 items)

| File | Role |
|---|---|
| `main.js` | Electron main process — creates window, handles IPC, starts watcher |
| `preload.js` | Exposes safe IPC channels to renderer |
| `src/renderer/` | Setup screen + Status screen (HTML/CSS/JS) |
| `cache/index.js` | File cache with 1-day TTL |

---

## Dependencies — Before vs After

| Package | Before | After |
|---|---|---|
| `pg` | used | **removed** |
| `bull` | used | **removed** |
| `express` | used | **removed** |
| `express-session` | used | **removed** |
| `express-rate-limit` | used | **removed** |
| `helmet` | used | **removed** |
| `compression` | used | **removed** |
| `morgan` | used | **removed** |
| `xero-node` | used | kept |
| `imap` | used | kept |
| `mailparser` | used | kept |
| `pdf-parse` | used | kept |
| `axios` | used | kept |
| `dotenv` | used | kept |
| `winston` | used | kept |
| `electron` | — | **added** |
| `electron-builder` | — | **added** (for packaging .dmg / .exe) |

Removes 8 packages, adds 2.

---

## Settings Storage (replaces .env)

User credentials are saved inside Electron's standard app data folder:

| OS | Path |
|---|---|
| Mac | `~/Library/Application Support/XeroInvoiceApp/settings.json` |
| Windows | `C:\Users\<you>\AppData\Roaming\XeroInvoiceApp\settings.json` |

```json
{
  "xero": {
    "clientId": "...",
    "clientSecret": "..."
  },
  "email": {
    "host": "imap.gmail.com",
    "port": 993,
    "user": "you@gmail.com",
    "pass": "xxxx xxxx xxxx xxxx",
    "filterFrom": ""
  },
  "defaults": {
    "currency": "SGD",
    "accountCode": "310"
  }
}
```

No `.env` file needed. Settings managed through the app UI.

---

## How to Build & Distribute

```bash
# Development
npm run dev          ← opens app in dev mode with DevTools

# Package for your OS
npm run build        ← creates dist/XeroInvoiceApp.dmg (Mac)
                        or dist/XeroInvoiceApp Setup.exe (Windows)
```

Install it once, runs like any normal desktop app.

---

## Summary

| | Before (original) | After (desktop app) |
|---|---|---|
| External services | PostgreSQL + Redis + Slack | **None** |
| Runs as | Web server (port 3000) | Desktop app |
| Credentials stored | `.env` file | App settings UI |
| Token storage | PostgreSQL | `userData/token.json` |
| Invoice record | PostgreSQL | `userData/invoices.json` (1-day TTL) |
| Retry on failure | Bull queue | Retry from cache on next startup |
| Setup steps | 7 complex steps | Fill 9 fields in UI, click Start |
| Distributable | No | Yes — `.dmg` / `.exe` |

---

## Bug Fix — Invoice Routing (RESOLVED)

### What was happening

Every invoice was landing in **Bills (Accounts Payable)** — including ones that should be Sales Invoices — because `type` was hardcoded to `'ACCPAY'` in `xero/invoices.js` line 41.

### Xero invoice types

| Code | Type | Where it appears in Xero |
|---|---|---|
| `ACCPAY` | Bill — money you OWE a supplier | Accounts → Purchases → Bills → Drafts |
| `ACCREC` | Sales Invoice — money OWED TO YOU | Accounts → Sales → Invoices → Drafts |

### How routing is determined (FINAL logic)

The signal is the **email source**, not keywords. The parser already returns `source: 'email'` or `source: 'pdf'` from `extractText()` — that maps directly to the invoice direction:

| Source | Real-world meaning | Xero type |
|---|---|---|
| `email` (body text) | Someone requesting to issue an invoice TO a client — money owed to you | `ACCREC` — Sales Invoice |
| `pdf` (attachment) | A supplier sent you their invoice as a PDF — money you owe them | `ACCPAY` — Bill |

**Example that confirmed this logic:**

> *"Hi Ben, can you kindly issue an invoice of SGD 3592.12 to Astellar for the work done by blacklab..."*
> → source: email → ACCREC → Accounts → Sales → Invoices → Drafts ✓

> Mediacorp fees PDF attachment → source: pdf → ACCPAY → Accounts → Purchases → Bills → Drafts ✓

### Files changed

| File | Change |
|---|---|
| `email/parser.js` | Replaced keyword detection with `source === 'pdf' ? 'ACCPAY' : 'ACCREC'` |
| `xero/invoices.js` line 41 | Changed hardcoded `'ACCPAY'` → `invoiceData.invoiceType \|\| 'ACCPAY'` |

### Status

**FIXED and tested** — both invoices routed correctly on 2026-06-12.

---

## Scripts Involved — Core Flow Only

Your flow is: **email → process → xero**. No database. Temp cache clears after 1 day.

### Quick Reference

| # | Script | Role |
|---|---|---|
| 1 | `email/listener.js` | Watch Gmail inbox via IMAP |
| 2 | `email/parser.js` | Extract invoice info from email/PDF |
| 3 | `cache/index.js` | Temp store — 1-day TTL, auto-delete (**new file**) |
| 4 | `xero/connect.js` | Get Xero access token on startup |
| 5 | `xero/contacts.js` | Find or create vendor contact in Xero |
| 6 | `xero/invoices.js` | Create draft invoice in Xero (bug fix applied) |

Support: `xero/client.js` (Xero SDK) + `utils/logger.js` (logging)

---

### Detailed Breakdown

```
email/listener.js
      ↓
email/parser.js
      ↓
cache/index.js  (temp store, 1-day TTL)
      ↓
xero/connect.js  (get access token on startup)
      ↓
xero/contacts.js  (find or create contact in Xero)
      ↓
xero/invoices.js  (create draft invoice in Xero)
```

| Script | What it does | Status |
|---|---|---|
| `email/listener.js` | Watches Gmail inbox via IMAP, fires on every new email | Keep — no changes |
| `email/parser.js` | Reads email/PDF, extracts vendor, amount, date, invoice#, type | Keep — bug fix applied |
| `cache/index.js` | Saves invoice temporarily, retries failed ones, purges after 24h | **New file** |
| `xero/connect.js` | Gets Xero access token using Client ID + Secret on app start | Keep — minor tweak (save token to file not DB) |
| `xero/contacts.js` | Searches Xero for vendor, creates contact if not found | Keep — minor tweak (read token from file not DB) |
| `xero/invoices.js` | Creates the draft invoice in Xero under correct type (Bills or Sales) | Keep — bug fix applied |

### Supporting scripts (not part of the flow, but needed)

| Script | What it does |
|---|---|
| `xero/client.js` | XeroClient SDK singleton — used by contacts.js and invoices.js |
| `utils/logger.js` | Writes logs to file — used by all scripts above |

### Scripts that are being deleted (not needed for your flow)

| Script | Why deleted |
|---|---|
| `db/pool.js` | PostgreSQL — replaced by local file cache |
| `db/tokens.js` | PostgreSQL token storage — replaced by `cache/token.json` |
| `db/migrate.js` | PostgreSQL schema setup — not needed |
| `queue/processor.js` | Redis/Bull queue — replaced by inline processing |
| `routes/dashboard.js` | Web dashboard — no web interface needed |
| `middleware/auth.js` | Session auth — no web interface, was unused anyway |
| `xero/auth.js` | Browser OAuth flow — not needed, app uses client credentials |
| `utils/notify.js` | Slack alerts — not needed |

### What replaces the database

| Old (PostgreSQL) | New (local file) | Location |
|---|---|---|
| `xero_tenants` table — stores Xero token | `token.json` | `userData/token.json` |
| `invoice_log` table — records processed invoices | `invoices.json` | `userData/invoices.json` |
| `dead_letter_queue` table — failed invoices | Same `invoices.json` with `status: failed` | `userData/invoices.json` |

All entries in `invoices.json` are automatically deleted after **24 hours**.

---

## Invoice Template — New Format & Full Flow

### The Template (what the email body must contain)

```
Client / Customer (Full name/entities name) : (Contact)
Email : (Email)
Address : (Address)

Create New Contact if not inside System database

Date : (Issue date)
Payment Terms / Payment Date : (Due Date)
Currency : (Branding Theme), (Currency)
Tax inclusive / exclusive : (Amounts Are)

Description / Details : (Description)
Amount : (Price)
Discount : (Disc)
Tax (If applicable) : (Tax rate)

Description / Details : (Description)
Amount : (Price)
Discount : (Disc)
Tax (If applicable) : (Tax rate)

Email & Attachment to attach in Attach files
```

---

### Template Field → Xero Field Mapping

#### Contact Section

| Template Field | Xero Field | Notes |
|---|---|---|
| Client / Customer | `contact.name` | Search first — create if not found |
| Email | `contact.emailAddress` | Saved to contact in Xero |
| Address | `contact.addresses` | Saved to contact billing address |
| Create New Contact if not inside System | Logic flag | Auto-handled: search → not found → create |

#### Invoice Header

| Template Field | Xero Field | Notes |
|---|---|---|
| Email sent date (header) | `date` | **Issue date** — taken from email metadata, NOT from template body |
| `Payment Terms / Payment Date :` | `dueDate` | **Due date** — accepts "30 Jun 2026" or "15 days"; falls back to `Date :` field |
| `Date :` field | `dueDate` fallback | Only used if Payment Terms field is missing |
| Currency | `currencyCode` | Taken from `DEFAULT_CURRENCY` env var (template currency field is ignored for code) |
| Branding Theme | `brandingThemeID` | First part of `Currency :` line e.g. "Standard, SGD" → theme = "Standard" |
| Tax inclusive / exclusive | `lineAmountTypes` | xero-node v7 requires Title Case: `Exclusive`, `Inclusive`, `NoTax` |

> **LineAmountTypes rule**: if all line items have `taxType: NONE`, `lineAmountTypes` is forced to `'NoTax'` regardless of template setting — Xero rejects `Exclusive` when no tax applies.

#### Line Items (repeatable — 1 or more)

| Template Field | Xero Field | Notes |
|---|---|---|
| Description / Details | `lineItems[n].description` | **Multi-line supported** — content can span multiple lines below the header; `•` bullets → `*` |
| Amount | `lineItems[n].unitAmount` | **Blank allowed** = 0 (descriptive-only rows are valid) |
| Discount | `lineItems[n].discountRate` | Percentage; only sent to Xero if > 0 (avoids validation issues) |
| Tax (If applicable) | `lineItems[n].taxType` | GST/VAT → `TAX001`; None / No Tax → `NONE` |

Account code: `DEFAULT_ACCOUNT_CODE` from `.env` (current: `200` — Sales).

#### Attachments

| Template Field | Xero Field | Notes |
|---|---|---|
| Email & Attachment | Xero Files API | Attach the original email body + any PDF as a file on the invoice |

---

### Full Flow (Updated)

```
Email arrives at finance@blacklab.space
        ↓
email/listener.js — picks up unseen email
        ↓
email/parser.js — reads body text
        ↓
  Extracts:
  ┌─────────────────────────────────────────┐
  │ Contact:  name, email, address          │
  │ Invoice:  date, due date, currency,     │
  │           branding theme,               │
  │           tax inclusive/exclusive       │
  │ Line items (loop, 1 or more):           │
  │   description, amount, discount, tax    │
  │ Source: email or pdf                    │
  └─────────────────────────────────────────┘
        ↓
  invoiceType assigned:
  email body → ACCREC (Sales Invoice)
  pdf attachment → ACCPAY (Bill)
        ↓
cache/index.js — saved as status: pending
        ↓
xero/contacts.js
  ├── Search Xero for contact by name
  ├── Found → use existing contactID
  └── Not found → Create new contact
        (name + email + address saved to Xero)
        ↓
xero/invoices.js
  ├── Build invoice with all header fields
  ├── Build line items array (with discount + tax per line)
  ├── Set lineAmountTypes (inclusive/exclusive)
  ├── Set brandingThemeID
  ├── POST to Xero API → Draft invoice created
  └── Attach original email + PDF to the invoice (Files API)
        ↓
cache/index.js — marked as status: done
        ↓
After 24 hours → cache entry auto-deleted
```

---

### What Is New vs Current Implementation

| Feature | Current | New Template |
|---|---|---|
| Contact name | ✓ extracted | ✓ same |
| Contact email | ✓ extracted | ✓ same |
| Contact address | ✗ not captured | **✓ new — saved to Xero contact** |
| Create new contact | ✓ auto | ✓ same |
| Invoice date | ✓ extracted | ✓ same |
| Due date | ✓ extracted | ✓ same |
| Currency | ✓ single default | **✓ new — per-invoice from email** |
| Branding theme | ✗ not set | **✓ new — per-invoice from email** |
| Tax inclusive/exclusive | ✗ not set | **✓ new — per-invoice from email** |
| Line items | Single item only | **✓ new — multiple items supported** |
| Discount per line | ✗ not supported | **✓ new — discountRate per line** |
| Tax per line | Single tax type | **✓ new — per-line tax type** |
| Attach original email | ✗ not done | **✓ new — attached to Xero invoice** |
| Invoice routing | ✓ email→ACCREC, pdf→ACCPAY | ✓ same |

---

### Files Changed (DONE)

| File | What changed |
|---|---|
| `email/parser.js` | Template detection, address, currency, branding theme, tax inclusive/exclusive, multiple line items with discount per line |
| `xero/contacts.js` | Passes address when creating a new contact in Xero |
| `xero/invoices.js` | Multiple line items, `lineAmountTypes`, `brandingThemeID` lookup, email + PDF file attachments |

No changes needed to: `email/listener.js`, `xero/connect.js`, `xero/client.js`, `utils/logger.js`

---

## Template Detection — How It Works

### The Template Format (confirmed)

```
Client / Customer (Full name/entities name) : (Contact)
Email : (Email)
Address : (Address)
Create New Contact if not inside System database

Date : (Issue date)
Payment Terms / Payment Date : (Due Date)
Currency : (Branding Theme), (Currency)
Tax inclusive / exclusive : (Amounts Are)

   1. Description / Details : (Description)
Amount : (Price)
Discount : (Disc)
Tax (If applicable) : (Tax rate)

   2. Description / Details : (Description)
Amount : (Price)
Discount : (Disc)
Tax (If applicable) : (Tax rate)

Email & Attachment to attach in Attach files
```

### Key structural rules

| Rule | Detail |
|---|---|
| Line items are **numbered** | `1. Description / Details :`, `2. Description / Details :` ... |
| "Description / Details" line is **indented** | Leading whitespace before the number |
| `Amount`, `Discount`, `Tax` are **consecutive** | No blank lines within a block |
| Blank line **between blocks** | Separates line item 1 from line item 2 |
| `Create New Contact...` | Static instruction — ignored by parser, auto-handled in code |
| `Email & Attachment...` | Static instruction — triggers attaching original email + PDF to Xero invoice |

### How detection works (no MD file needed)

The parser scans every incoming email body for these two patterns:

```
1. "Client / Customer" keyword present?   → contact section found
2. "N. Description / Details" keyword present? → line item section found

Both present → Template detected → parse all fields → send to Xero
PDF only     → Generic invoice → parse as Bill (ACCPAY) → send to Xero
Neither      → Skip email entirely
```

No configuration file needed. The detection is purely content-based — the template is a writing guide for humans sending the email.

### Regex that handles numbered + indented multi-line line items

```js
// Handles:
//   "   1. Description / Details :"  (number + indent)
//   Multi-line description below the header
//   Blank Amount / Discount fields
/[ \t]*(?:\d+\.\s*)?Description\s*\/\s*Details\s*:([\s\S]+?)[ \t]*\n
Amount\s*:\s*([\d,]*\.?\d*)[ \t]*\n
Discount\s*:\s*([\d.]*)[ \t]*%?[ \t]*\n
Tax\s*\(If\s*applicable\)\s*:\s*([^\n]*)/gi
```

Key changes from original:
- `[\s\S]+?` (lazy, multi-line) instead of `[^\n]+` — captures full multi-line description
- `[\d,]*` instead of `[\d,]+` — allows blank Amount (= 0)
- Each matched block → one entry in `lineItems[]`

### Status

**DONE** — confirmed working 2026-06-23:
- Multi-line descriptions ✓
- Blank amounts (descriptive rows) ✓
- Bullets `•` → `*` ✓
- 4 line items from real email ✓
