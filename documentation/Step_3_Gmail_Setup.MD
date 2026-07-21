# Step 3 — Gmail IMAP Setup

---

## What This Step Does

Allows the app to connect to your Gmail inbox as an email client (via IMAP) so it can watch for new emails and automatically process them as invoices.

---

## Why You Cannot Use Your Normal Gmail Password

Google blocks plain password IMAP access for security. You must generate a **Gmail App Password** — a 16-character code created specifically for this app. Your normal Gmail password will not work and will return `Invalid credentials`.

---

## Inbox Recommendation

Use a **dedicated Gmail account** just for invoices — for example `invoices@yourcompany.com` or `billing-inbox@gmail.com`.

Do not use your main personal Gmail because:
- The app marks **every unread email as read** and tries to parse it as an invoice
- Non-invoice emails will be marked read and skipped (wasted processing)
- Invoice emails mixed with personal emails creates noise

---

## Part A — Enable 2-Step Verification

You must have 2-Step Verification turned on before App Passwords become available.

1. Go to [myaccount.google.com](https://myaccount.google.com)
2. Click **Security** in the left sidebar
3. Under "How you sign in to Google" → click **2-Step Verification**
4. Follow the steps to turn it ON

---

## Part B — Enable IMAP in Gmail

1. Open Gmail (the inbox you want to use)
2. Click the **gear icon** (top right) → **See all settings**
3. Go to the **Forwarding and POP/IMAP** tab
4. Under "IMAP access" → select **Enable IMAP**
5. Click **Save Changes**

---

## Part C — Generate an App Password

1. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
   - If you don't see this page, 2-Step Verification is not enabled — go back to Part A
2. In the "App name" field type: `Xero Invoice App`
3. Click **Create**
4. Google shows a **16-character password** like: `abcd efgh ijkl mnop`
5. Copy it immediately — it is only shown once

---

## Part D — What to Put in Your .env

```
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_USER=your_invoice_inbox@gmail.com
IMAP_PASS=abcdefghijklmnop
IMAP_POLL_INTERVAL_MS=60000
```

- `IMAP_USER` → the Gmail address of your invoice inbox
- `IMAP_PASS` → the 16-character App Password (remove any spaces)
- `IMAP_HOST` and `IMAP_PORT` are already correct for Gmail — do not change them
- `IMAP_POLL_INTERVAL_MS` → how often to check for new mail in milliseconds (`60000` = 1 minute)

---

## How the App Connects to Gmail

```
App starts
        ↓
Opens TLS connection to imap.gmail.com:993
        ↓
Authenticates with IMAP_USER + IMAP_PASS
        ↓
Opens INBOX (read-write mode)
        ↓
Immediately checks all UNSEEN emails on startup
        ↓
Listens for server PUSH events (Gmail notifies instantly on new mail)
        ↓
Also polls every IMAP_POLL_INTERVAL_MS as a fallback

On IMAP error    → reconnects automatically after 30 seconds
On disconnection → reconnects automatically after 10 seconds
```

---

## How Emails Are Processed

```
New email arrives
        ↓
App fetches full email (headers + body + attachments)
        ↓
Marks email as SEEN (so it is never processed twice)
        ↓
Does the email have a PDF attachment?
  YES → Extract text from the PDF (used if text > 50 chars)
  NO  → Use plain text body, or strip HTML tags from HTML body
        ↓
Run regex patterns to extract invoice fields
        ↓
If no usable text found → skip email, log warning
If invoice data extracted → push to queue → create in Xero
```

---

## Using Outlook / Office 365 Instead

```
IMAP_HOST=outlook.office365.com
IMAP_PORT=993
IMAP_USER=your_invoice_inbox@yourdomain.com
IMAP_PASS=your_outlook_password_or_app_password
```

---

## Common Errors

| Error | Cause | Fix |
|---|---|---|
| `Invalid credentials` | Using regular Gmail password | Generate an App Password (see Part C) |
| App Passwords page not visible | 2-Step Verification not enabled | Enable 2-Step Verification first (Part A) |
| `IMAP not enabled` error | IMAP access is disabled in Gmail | Gmail → Settings → Forwarding and POP/IMAP → Enable IMAP |
| Emails not being picked up | All existing emails are already SEEN | In Gmail, mark the emails as Unread — the app only processes UNSEEN emails |
| `ECONNREFUSED` on port 993 | Wrong host or port | Confirm `IMAP_HOST=imap.gmail.com` and `IMAP_PORT=993` |
| App skips all emails with a warning | Emails have no parseable invoice text | Check the email body has fields like "Invoice No:", "Total:", "Date:" |

---

## Next Step

→ [Step_4_Database_Redis_Setup.MD](Step_4_Database_Redis_Setup.MD)
