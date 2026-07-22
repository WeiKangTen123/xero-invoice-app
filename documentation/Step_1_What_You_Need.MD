# Step 1 — What You Need Before Starting

---

## Overview

Before you run a single command, you need accounts and credentials from **5 external services**. Some are required, some are optional.

---

## Services Required

| Service | Required? | Purpose | What breaks without it |
|---|---|---|---|
| **Xero** | Yes | Where invoices are created | App has no output — nothing gets created |
| **Gmail / IMAP inbox** | Yes | Where the app watches for emails | App has no input — never sees emails |
| **PostgreSQL** | Yes | Stores tokens + invoice logs | App crashes on startup |
| **Redis** | No (recommended) | Queue + retry failed jobs | Falls back to no-retry inline processing |
| **Slack** | No | Alert when invoice is created or fails | Silent — invoices still created, just no notifications |

---

## Checklist

Go through this before touching any config:

```
[ ] I have a Xero account (xero.com)
[ ] I have a Xero Developer account (developer.xero.com)
[ ] I have a Gmail account to use as the invoice inbox
[ ] I have 2-Step Verification enabled on that Gmail account
[ ] I have PostgreSQL available (local install or Railway)
[ ] I have Redis available (local install or Railway) — optional
[ ] I have a Slack workspace — optional
[ ] I have Node.js 22+ installed
[ ] I have npm 9+ installed
```

Check Node and npm versions:
```bash
node --version    # must be v22.x or higher (better-sqlite3 requires Node >=22)
npm --version     # must be 9.x or higher
```

---

## What Each Service Does in This App

### Xero
- You connect your Xero organisation via OAuth2 (one-time browser login)
- After that, the app creates invoices in your org automatically
- No manual work in Xero needed after setup
- → Setup: [Step_2_Xero_Setup.MD](Step_2_Xero_Setup.MD)

### Gmail / IMAP Inbox
- The app connects to your Gmail inbox like an email client
- It watches for new unread emails and processes them automatically
- Use a **dedicated inbox** just for invoices (not your main personal email)
- → Setup: [Step_3_Gmail_Setup.MD](Step_3_Gmail_Setup.MD)

### PostgreSQL
- Stores your Xero OAuth tokens so you don't have to log in again
- Keeps a log of every invoice created
- Stores failed invoices for manual review
- → Setup: [Step_4_Database_Redis_Setup.MD](Step_4_Database_Redis_Setup.MD)

### Redis
- Powers the Bull job queue
- Automatically retries failed invoice creation (up to 5 times)
- Without it: invoices are processed inline with no retry on failure
- → Setup: [Step_4_Database_Redis_Setup.MD](Step_4_Database_Redis_Setup.MD)

### Slack
- Sends a message to a Slack channel when a draft invoice is created
- Sends an error alert when a job permanently fails
- If not configured: the app runs fine, just silently
- → Setup: [Step_5_Slack_Setup.MD](Step_5_Slack_Setup.MD)

---

## Recommended: Deploy on Railway (no local installs needed)

Railway is a hosting platform that provides PostgreSQL and Redis as managed services with one click — no local database setup needed.

**Railway setup:**
1. Go to [railway.app](https://railway.app) → sign up with GitHub
2. New Project → Deploy from GitHub repo → select your repo
3. Click **+ New** → Database → **Add PostgreSQL**
4. Click **+ New** → Database → **Add Redis**
5. Railway automatically sets `DATABASE_URL` and `REDIS_URL` for you

Then skip the PostgreSQL and Redis sections of Step 4 — Railway handles them.

---

## Next Step

→ [Step_2_Xero_Setup.MD](Step_2_Xero_Setup.MD)
