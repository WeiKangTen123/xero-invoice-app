# Step 4 — PostgreSQL & Redis Setup

---

## Overview

| Service | Required? | Purpose |
|---|---|---|
| PostgreSQL | **Yes** | Stores Xero tokens + invoice logs + failed jobs |
| Redis | No (recommended) | Powers the job queue with auto-retries |

---

## Option A — Railway (Recommended, No Local Install)

If you are deploying to Railway, both services are added with one click and Railway sets the connection URLs automatically.

**PostgreSQL on Railway:**
1. Open your Railway project
2. Click **+ New** → **Database** → **Add PostgreSQL**
3. Railway automatically sets `DATABASE_URL` — done

**Redis on Railway:**
1. Click **+ New** → **Database** → **Add Redis**
2. Railway automatically sets `REDIS_URL` — done

Set `DB_SSL=true` in your Railway environment variables (Railway PostgreSQL requires SSL).

Skip to [Option C — Run the Migration](#option-c--run-the-migration) after adding both services.

---

## Option B — Local Install (for local development)

### PostgreSQL (local)

**macOS:**
```bash
brew install postgresql@16
brew services start postgresql@16
createdb xero_invoices
```

**Ubuntu/Debian:**
```bash
sudo apt install postgresql postgresql-contrib
sudo systemctl start postgresql
sudo -u postgres createdb xero_invoices
```

**Windows:**
Download from [postgresql.org/download](https://www.postgresql.org/download/) and use the installer.

**Set in `.env`:**
```
DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/xero_invoices
DB_SSL=false
```

---

### Redis (local)

**macOS:**
```bash
brew install redis
brew services start redis
```

**Ubuntu/Debian:**
```bash
sudo apt install redis-server
sudo systemctl start redis
```

**Set in `.env`:**
```
REDIS_URL=redis://localhost:6379
```

---

## Option C — Run the Migration

After PostgreSQL is running and `DATABASE_URL` is set in `.env`, run the migration **once** to create the database tables:

```bash
node db/migrate.js
```

This creates three tables:

| Table | Purpose |
|---|---|
| `xero_tenants` | Xero OAuth tokens per connected org |
| `invoice_log` | Record of every invoice created |
| `dead_letter_queue` | Invoices that failed all retries |

The migration is **idempotent** — safe to run multiple times, will not overwrite existing data.

---

## Database Schema

### xero_tenants
```
tenant_id       — UUID — which Xero org this is
tenant_name     — display name of the Xero org
access_token    — short-lived token (30 min)
refresh_token   — long-lived token used to renew access
token_expires_at — when the access token expires
```

### invoice_log
```
tenant_id       — which Xero org the invoice was created in
xero_invoice_id — invoice ID returned by Xero
invoice_number  — extracted from the email
vendor_name     — extracted from the email
total_amount    — extracted from the email
source_email    — who sent the email
status          — always "created" on success
```

### dead_letter_queue
```
raw_email       — the original email content (truncated)
error_message   — what went wrong
attempts        — how many times it was retried
```

---

## PostgreSQL Connection Pool Settings

These are hardcoded in `db/pool.js`:

| Setting | Value | Meaning |
|---|---|---|
| Max connections | 20 | Maximum simultaneous DB connections |
| Idle timeout | 30s | Close connections idle for 30+ seconds |
| Connection timeout | 2s | Fail fast if DB is unreachable |

---

## Redis / Bull Queue Settings

These are configured in `queue/processor.js`:

| Setting | Value | Meaning |
|---|---|---|
| Concurrent workers | 3 | Max 3 invoices processed at the same time |
| Max retry attempts | 5 | Retry up to 5 times before dead-letter |
| Backoff | Exponential from 2s | 2s → 4s → 8s → 16s between retries |
| Completed job retention | 100 | Keep last 100 completed jobs in Redis |
| Failed job retention | 200 | Keep last 200 failed jobs in Redis |

---

## What Happens Without Redis

If `REDIS_URL` is not set, the app logs a warning and processes invoices **inline** (synchronously):

```
REDIS_URL not set — Bull queue disabled, processing inline
```

Inline mode means:
- No automatic retries on failure
- One network blip = that invoice is permanently lost
- No concurrency limiting (could hit Xero rate limits under heavy load)
- Dead-letter queue is not used

For production use, Redis is strongly recommended.

---

## Common Errors

| Error | Cause | Fix |
|---|---|---|
| `ECONNREFUSED` on database | PostgreSQL not running or wrong `DATABASE_URL` | Check service is running; verify connection string |
| `SSL SYSCALL error` | Hosted DB requires SSL but `DB_SSL` is not set | Set `DB_SSL=true` in `.env` |
| `relation "xero_tenants" does not exist` | Migration not run | Run `node db/migrate.js` |
| `too many connections` | Pool limit (20) exceeded | Check for connection leaks or reduce concurrent load |
| `Failed to init Bull queue` | Redis not reachable | Check `REDIS_URL` is correct and Redis is running |

---

## Next Step

→ [Step_5_Slack_Setup.MD](Step_5_Slack_Setup.MD)
