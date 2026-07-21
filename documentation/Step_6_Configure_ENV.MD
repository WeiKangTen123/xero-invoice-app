# Step 6 — Configure Your .env File

---

## What This Step Does

Brings together all the credentials from Steps 2–5 into a single `.env` file that the app reads on startup.

---

## How to Create the .env File

The `.env.example` file is a template showing all available variables. Copy it to `.env` and fill in your real values:

```bash
cp .env.example .env
```

Then open `.env` in your editor and replace every placeholder value.

---

## Complete .env Reference

```
# ── Xero OAuth2 ─────────────────────────────────────────────────
# From: developer.xero.com → your app → Configuration tab
XERO_CLIENT_ID=paste_your_client_id_here
XERO_CLIENT_SECRET=paste_your_client_secret_here

# Must exactly match the Redirect URI in the Xero Developer portal
# Local dev:  http://localhost:3000/xero/callback
# Railway:    https://yourapp.up.railway.app/xero/callback
XERO_REDIRECT_URI=https://yourapp.up.railway.app/xero/callback


# ── App ─────────────────────────────────────────────────────────
NODE_ENV=production
PORT=3000

# Any random string, minimum 32 characters — signs session cookies
SESSION_SECRET=replace_with_a_long_random_string_at_least_32_chars

# Your public app URL — no trailing slash
APP_URL=https://yourapp.up.railway.app


# ── PostgreSQL ───────────────────────────────────────────────────
# Railway sets this automatically — do not add manually on Railway
# Local dev: postgresql://postgres:password@localhost:5432/xero_invoices
DATABASE_URL=postgresql://user:password@host:5432/dbname

# Set to true for hosted databases (Railway, Supabase, etc.)
# Set to false for local development
DB_SSL=true


# ── Redis ────────────────────────────────────────────────────────
# Railway sets this automatically — do not add manually on Railway
# Local dev: redis://localhost:6379
REDIS_URL=redis://localhost:6379


# ── Email inbox (IMAP) ───────────────────────────────────────────
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_USER=your_invoice_inbox@gmail.com

# Gmail App Password (16 chars, no spaces) — NOT your Gmail login password
# Generate at: myaccount.google.com → Security → App passwords
IMAP_PASS=your16charapppassword

# How often to poll for new emails (milliseconds)
# 60000 = 1 minute, 30000 = 30 seconds
IMAP_POLL_INTERVAL_MS=60000


# ── Slack Notifications (optional) ──────────────────────────────
# Leave blank to disable Slack notifications entirely
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/TXXXXXXXX/BXXXXXXXX/XXXXXXXXXX


# ── Xero Invoice Defaults ────────────────────────────────────────
# Expense account code from your Xero Chart of Accounts
# Xero → Accounting → Chart of Accounts → find an expense account code
DEFAULT_ACCOUNT_CODE=310

# ISO currency code for all invoices
DEFAULT_CURRENCY=SGD
```

---

## Variable Status at a Glance

| Variable | Required | Get it from |
|---|---|---|
| `XERO_CLIENT_ID` | Yes | Xero Developer → Configuration tab |
| `XERO_CLIENT_SECRET` | Yes | Xero Developer → Generate a secret |
| `XERO_REDIRECT_URI` | Yes | You set it — must match Xero portal exactly |
| `SESSION_SECRET` | Yes | Make one up — any random 32+ char string |
| `DATABASE_URL` | Yes | Railway (auto) or your PostgreSQL connection string |
| `DB_SSL` | Yes | `true` for Railway/hosted, `false` for local |
| `REDIS_URL` | No | Railway (auto) or `redis://localhost:6379` |
| `NODE_ENV` | No | Set to `production` on server |
| `PORT` | No | Defaults to `3000` |
| `APP_URL` | No | Your public URL |
| `IMAP_HOST` | No* | `imap.gmail.com` for Gmail |
| `IMAP_PORT` | No* | `993` for Gmail |
| `IMAP_USER` | No* | Your invoice inbox Gmail address |
| `IMAP_PASS` | No* | Your Gmail App Password (16 chars) |
| `IMAP_POLL_INTERVAL_MS` | No | Default `60000` (1 minute) |
| `SLACK_WEBHOOK_URL` | No | Slack → Incoming Webhooks |
| `DEFAULT_ACCOUNT_CODE` | No | Default `310` — check your Xero Chart of Accounts |
| `DEFAULT_CURRENCY` | No | Default `SGD` |

> *All four `IMAP_*` variables must be set together. If any are missing, email watching is disabled and the app will log: `IMAP not configured — skipping email watcher`

---

## The App Checks These on Startup

The app will refuse to start (and print an error) if any of these are missing:

```
XERO_CLIENT_ID
XERO_CLIENT_SECRET
XERO_REDIRECT_URI
SESSION_SECRET
DATABASE_URL
```

All other variables are optional and the app falls back to defaults or skips the feature.

---

## Security Rules for the .env File

- **Never commit `.env` to GitHub** — it is already in `.gitignore`
- **Never share the file** — it contains your Xero credentials and Gmail App Password
- On Railway: paste each value into the **Variables** tab instead of uploading the file
- If credentials are ever exposed, immediately:
  1. Regenerate the Xero client secret in the Xero Developer portal
  2. Revoke the Gmail App Password and generate a new one
  3. Generate a new `SESSION_SECRET`

---

## How to Generate a Secure SESSION_SECRET

Run this in your terminal to generate a random 64-character string:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output and paste it as your `SESSION_SECRET`.

---

## Next Step

→ [Step_7_Run_And_Test.MD](Step_7_Run_And_Test.MD)
