# Step 5 — Slack Notifications Setup (Optional)

---

## What This Step Does

Configures the app to post a message to a Slack channel whenever:
- A draft invoice is successfully created in Xero
- A job permanently fails after all retries are exhausted

**This step is optional.** If you skip it, invoices are still created — you just won't get notifications.

---

## What the Slack Messages Look Like

**Success notification:**
```
*New Draft Invoice Created in Xero*
Org: My Company Ltd
Vendor: Acme Corp
Invoice #: INV-2026-001
Amount: SGD 1090.00
<Review in Xero>   ← clickable link to the invoice
```

**Error notification:**
```
*Xero Invoice App Error*
Context: Job 42 failed after 5 attempts
Error: Request failed with status code 503
Source email: billing@acmecorp.com
```

---

## Part A — Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** → **From scratch**
3. Enter a name (e.g. `Xero Invoice Bot`)
4. Select your Slack workspace
5. Click **Create App**

---

## Part B — Enable Incoming Webhooks

1. In the left sidebar of your app settings, click **Incoming Webhooks**
2. Toggle **Activate Incoming Webhooks** → **ON**
3. Click **Add New Webhook to Workspace** (at the bottom)
4. Select the channel to post to (e.g. `#invoices` or `#accounting`)
5. Click **Allow**
6. Copy the webhook URL — it looks like:
   ```
   https://hooks.slack.com/services/<TEAM_ID>/<BOT_ID>/<TOKEN>
   ```

---

## Part C — Set in Your .env

```
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/<TEAM_ID>/<BOT_ID>/<TOKEN>
```

Leave it blank to disable:
```
SLACK_WEBHOOK_URL=
```

---

## How It Works in the Code

In `utils/notify.js`, the app posts a JSON payload to your webhook URL using `axios`:

```
Invoice created in Xero
        ↓
notifyInvoiceCreated() called
        ↓
POST https://hooks.slack.com/services/...
{ text: "New Draft Invoice Created..." }
        ↓
Message appears in your Slack channel
```

If the webhook POST fails (Slack is down, wrong URL), it logs a warning but **does not crash** and does not affect invoice creation.

---

## Note on the Invoice Link

The Slack message includes a link to the invoice:
```
https://go.xero.com/AccountsPayable/Edit.aspx?InvoiceID=<uuid>
```

This is the legacy Xero URL format. It still works and redirects you to the correct invoice when you are logged into Xero. The app cannot generate the new-style URL (`/app/!XXXXX/bills/draft`) because it does not store your Xero org's short code — only the full UUID tenant ID.

---

## Next Step

→ [Step_6_Configure_ENV.MD](Step_6_Configure_ENV.MD)
