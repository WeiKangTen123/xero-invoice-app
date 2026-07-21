# Step 7 — Install, Run & Test

---

## Overview

This is the final step. By now you should have:
- [x] Xero Developer app created with credentials ([Step 2](Step_2_Xero_Setup.MD))
- [x] Gmail IMAP enabled + App Password generated ([Step 3](Step_3_Gmail_Setup.MD))
- [x] PostgreSQL and Redis running ([Step 4](Step_4_Database_Redis_Setup.MD))
- [x] `.env` file filled in ([Step 6](Step_6_Configure_ENV.MD))

---

## Part A — Install Dependencies

```bash
npm install
```

---

## Part B — Create Database Tables (run once)

```bash
node db/migrate.js
```

You should see: `Database migration complete`

This creates the `xero_tenants`, `invoice_log`, and `dead_letter_queue` tables.
Safe to re-run — it will not overwrite existing data.

---

## Part C — Start the Server

```bash
# Standard start
node index.js

# Development mode (auto-restarts when you edit files)
npm run dev

# Combined: migrate then start (same as Railway uses)
npm start
```

**Expected startup output:**
```
Starting up...
NODE_ENV: production
DATABASE_URL set: true
REDIS_URL set: true
XERO_CLIENT_ID set: true
All required env vars present.
Core modules loaded.
DB pool created.
Routes loaded.
Email listener loaded.
Queue processor loaded.
===========================================
Server running on port 3000
===========================================
Bull queue initialised with Redis
IMAP connected, opening INBOX
```

If you see `IMAP not configured — skipping email watcher`, check that all four `IMAP_*` variables are set in `.env`.

---

## Part D — Connect Your Xero Organisation

Open this URL in your browser (one-time setup):

```
http://localhost:3000/xero/connect          ← local
https://yourapp.up.railway.app/xero/connect ← Railway
```

1. You are redirected to the Xero login page
2. Log in with your Xero account
3. Select your organisation → click **Allow access**
4. You are redirected to `/dashboard`

Verify it worked:
```bash
curl http://localhost:3000/dashboard
```
Expected response:
```json
{
  "status": "ok",
  "tenants": [
    { "tenantId": "xxxxxxxx-...", "tenantName": "My Company Ltd" }
  ]
}
```

---

## Part E — Verify Everything is Working

Run these checks in order:

**1. Database health check**
```bash
curl http://localhost:3000/dashboard/health
```
Expected: `{ "status": "healthy", "timestamp": "..." }`

**2. Xero connection**
```bash
curl http://localhost:3000/dashboard
```
Expected: your Xero org listed in `tenants`

**3. IMAP connection**
Check your server logs for:
```
IMAP connected, opening INBOX
```

---

## Part F — Send a Test Email

Send an email to your configured inbox (`IMAP_USER`) with this format:

```
Subject: Invoice from Acme Corp - Please Pay

Invoice No: INV-2026-001
Date: 27/05/2026
Due Date: 27/06/2026
Subtotal: $1,000.00
GST: $90.00
Total: $1,090.00
```

Within 60 seconds (or immediately if Gmail pushes the event), watch your server logs:

```
New mail received, processing...
Extracted text from PDF attachment   ← if PDF, or skips this line
Invoice parsed { vendor: 'Acme Corp', number: 'INV-2026-001', total: 1090 }
Invoice queued { tenant: 'My Company Ltd', vendor: 'Acme Corp' }
Contact found / Contact created { tenantId: ..., vendorName: 'Acme Corp' }
Draft invoice created { tenantId: ..., invoiceID: '...', vendor: 'Acme Corp', amount: 1090 }
Invoice created notification sent
```

---

## Part G — Find the Invoice in Xero

Navigate in your Xero account:

```
Accounts → Purchases → Bills → Drafts
```

The draft bill should appear with:
- Vendor: Acme Corp
- Invoice #: INV-2026-001
- Amount: SGD 1,090.00
- Status: Draft

If you configured Slack, a notification with a link to the invoice appears in your channel.

---

## Part H — View Invoice Logs

Check all invoices created so far:
```bash
curl http://localhost:3000/dashboard/invoices/YOUR_TENANT_ID
```

Replace `YOUR_TENANT_ID` with the UUID from the `/dashboard` response.

Check any failed invoices:
```bash
curl http://localhost:3000/dashboard/dead-letter
```

---

## What the Fields Map To

When the test email is processed, here is how each line maps to the Xero invoice:

| Email line | Extracted as | Xero field |
|---|---|---|
| `Invoice No: INV-2026-001` | `invoiceNumber` | Invoice Number |
| `Date: 27/05/2026` | `invoiceDate` | Date |
| `Due Date: 27/06/2026` | `dueDate` | Due Date |
| `Subtotal: $1,000.00` | `subTotal` | Line item unit amount |
| `GST: $90.00` | `taxAmount` | Tax (TAX001) |
| `Total: $1,090.00` | `totalAmount` | Total |
| Email subject | `description` | Reference + line item description |
| Sender name | `vendorName` | Contact name |
| `DEFAULT_CURRENCY=SGD` | `currencyCode` | Currency |
| `DEFAULT_ACCOUNT_CODE=310` | `accountCode` | Account code |

---

## Invoice Type — Where it Appears

| Type | Xero path |
|---|---|
| ACCPAY (bill) — **current default** | Accounts → Purchases → **Bills → Drafts** |
| ACCREC (sales invoice) | Accounts → Sales → **Invoices → Drafts** |

To switch to ACCREC, change line 40 of `xero/invoices.js`:
```js
type: Invoice.TypeEnum.ACCREC
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Server won't start | Missing required env var | Check startup output for `MISSING ENV VARS:` |
| `IMAP not configured — skipping email watcher` | Missing one of the IMAP vars | Check `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASS` are all set |
| Email processed but no invoice in Xero | Wrong account code | Set `DEFAULT_ACCOUNT_CODE` to a valid code from Xero → Accounting → Chart of Accounts |
| `redirect_uri_mismatch` when connecting Xero | URI mismatch | Copy-paste URI exactly between `.env` and Xero Developer portal |
| `Invalid credentials` IMAP error | Wrong Gmail password type | Use App Password, not Gmail login password |
| Invoice appears in wrong Xero section | Invoice type mismatch | Check ACCPAY vs ACCREC — see table above |
| No Slack messages | Webhook URL not set or wrong | Check `SLACK_WEBHOOK_URL` in `.env` |
| Jobs keep failing → dead letter | Xero API issue | Check `/dashboard/dead-letter` for error message |

---

## Ongoing Monitoring

| Task | How |
|---|---|
| Check if server is healthy | `GET /dashboard/health` |
| See connected Xero orgs | `GET /dashboard` |
| See invoice history | `GET /dashboard/invoices/:tenantId` |
| See failed invoices | `GET /dashboard/dead-letter` |
| Watch real-time activity | Server console logs |
| Re-connect Xero (token expired) | Visit `/xero/connect` again |
| Disconnect a Xero org | `DELETE /xero/disconnect/:tenantId` |
