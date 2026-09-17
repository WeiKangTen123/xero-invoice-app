# 🚀 Deployment Roadmap

> Week-by-week plan for launching the Xero Invoice App as a production B2B SaaS product.

---

## Pre-Launch Timeline

### Week 1: Fix Critical Security Gaps

| Task | Priority | Effort | Details |
|:---|:---:|:---:|:---|
| Fix JWT fallback secret | 🔴 Critical | 5 min | Crash on startup if `JWT_SECRET` not set (see `04_Security_Hardening.md`) |
| Add CORS middleware | 🔴 Critical | 10 min | `cors({ origin: 'https://yourdomain.com' })` |
| Add HTTPS redirect | 🟡 High | 10 min | Force HTTP → HTTPS in production |
| Regenerate ALL API keys | 🔴 Critical | 30 min | New Xero, Gmail, OpenRouter, Nvidia, Gemini keys |
| Generate production secrets | 🔴 Critical | 5 min | New `JWT_SECRET`, `SESSION_SECRET`, `ENCRYPTION_KEY` |
| Add stricter login rate limit | 🟡 High | 15 min | 10 attempts/15min on `/api/auth/login` |

### Week 2: Migrate SQLite → PostgreSQL

| Task | Priority | Effort | Details |
|:---|:---:|:---:|:---|
| Adapt `db/index.js` for PostgreSQL | 🟡 High | 1 day | Replace `better-sqlite3` with `pg` pool |
| Convert `schema.sql` to PostgreSQL syntax | 🟡 High | 2 hours | `AUTOINCREMENT` → `SERIAL`, `TEXT` dates → `TIMESTAMPTZ`, boolean handling |
| Update all parameterized queries | 🟡 High | 1 day | SQLite uses `?` placeholders; PostgreSQL uses `$1, $2, ...` |
| Migrate `invoice-store.js` queries | 🟡 High | 1 day | Largest query file — needs careful conversion |
| Write data migration script | 🟡 High | 4 hours | Export SQLite data → import to PostgreSQL |
| Test all API routes with PostgreSQL | 🟡 High | 4 hours | Run existing test suite (`npm test`) against PG |

### Week 3: Enable Redis + Set Up Infrastructure

| Task | Priority | Effort | Details |
|:---|:---:|:---:|:---|
| Set `REDIS_URL` environment variable | 🟢 Medium | 5 min | Bull queue auto-activates (already coded in `processor.js`) |
| Provision managed PostgreSQL | 🟡 High | 30 min | DigitalOcean/Aliyun/GCP managed DB |
| Provision managed Redis | 🟢 Medium | 15 min | Same provider |
| Configure VPC / private networking | 🟡 High | 30 min | DB + Redis on private network only |
| Set up Cloudflare (free) for domain | 🟢 Medium | 30 min | DNS, SSL termination, DDoS protection |
| Test Bull queue end-to-end | 🟢 Medium | 1 hour | Queue an invoice job, verify processing + retry |

### Week 4: Deploy to Production

| Task | Priority | Effort | Details |
|:---|:---:|:---:|:---|
| Provision app server | 🟡 High | 30 min | 2 vCPU, 4 GB RAM, 50 GB SSD |
| Install Node.js 22, Nginx, Certbot | 🟡 High | 1 hour | Server setup |
| Configure Nginx reverse proxy | 🟡 High | 30 min | See config in `04_Security_Hardening.md` |
| Configure firewall rules | 🔴 Critical | 15 min | Only 443 + 22 (restricted) open |
| Set all environment variables | 🔴 Critical | 30 min | On the server, NOT in code |
| Deploy code + build UI | 🟡 High | 30 min | `git clone`, `npm install`, `npm run build:ui`, `node main/index.js` |
| Set up process manager (PM2) | 🟡 High | 15 min | `pm2 start main/index.js --name xero-app` — auto-restart on crash |
| Verify HTTPS + all routes working | 🔴 Critical | 1 hour | Manual testing of login, setup, invoice flow |
| Run data migration (if existing data) | 🟡 High | 1 hour | SQLite → PostgreSQL migration script |

### Week 5: Monitoring + Resilience

| Task | Priority | Effort | Details |
|:---|:---:|:---:|:---|
| Set up error monitoring (Sentry) | 🟢 Medium | 1 hour | Real-time error alerts — know before customers tell you |
| Set up uptime monitoring | 🟢 Medium | 15 min | Ping `/dashboard/health` every 5 min, alert on downtime |
| Schedule daily DB backups | 🟡 High | 15 min | Cron job or managed DB auto-backup |
| Schedule daily SQLite backup (if still used) | 🟡 High | 5 min | `0 2 * * * node db/backup.js` |
| Set up log rotation | 🟢 Medium | 15 min | Prevent logs from filling disk |
| Test disaster recovery | 🟡 High | 2 hours | Restore from backup, verify data integrity |
| Document runbook (common ops tasks) | 🟢 Medium | 2 hours | How to restart, check logs, restore backup |

### Week 6: Final Testing + First Company Onboarding

| Task | Priority | Effort | Details |
|:---|:---:|:---:|:---|
| End-to-end test with real company data | 🔴 Critical | 1 day | Full flow: email → PDF → parse → Xero |
| Dashboard update deployment test | 🟡 High | 1 hour | Deploy a UI change with zero downtime |
| Load test (simulate 5–10 companies) | 🟢 Medium | 2 hours | Verify server handles concurrent load |
| Security scan | 🟡 High | 1 hour | Run OWASP ZAP or similar against production URL |
| Onboard first company | 🟡 High | 1 day | Create account, configure Xero + IMAP, verify flow |

---

## Post-Launch Maintenance

### Daily (Automated)

| Task | How |
|:---|:---|
| Database backup | Managed DB auto-backup or cron `node db/backup.js` |
| Error monitoring | Sentry alerts to Slack/email |
| Uptime check | External monitor pings health endpoint |

### Weekly (Manual, 15 min)

| Task | How |
|:---|:---|
| Review error logs | Check Sentry dashboard for new errors |
| Check disk usage | `df -h` on server — ensure < 80% |
| Review rate limit logs | Check if any company is hitting limits |
| Check IMAP connection health | Verify all company email watchers are active |

### Monthly (Manual, 1 hour)

| Task | How |
|:---|:---|
| OS security updates | `sudo apt update && sudo apt upgrade` |
| Node.js patch updates | Check for security patches |
| Dependency audit | `npm audit` — fix critical vulnerabilities |
| Review access logs | Check for suspicious activity |
| Test backup restoration | Restore a backup to verify integrity |

### Quarterly (Manual, half day)

| Task | How |
|:---|:---|
| Evaluate scaling needs | Check if approaching Phase 2 thresholds |
| Review security posture | Re-run security scan |
| Update SSL certificates | Auto-renewed by Certbot, but verify |
| Review and prune old data | Clean up orphaned PDFs, old logs |

---

## CI/CD Pipeline (Recommended)

Set up GitHub Actions for automated deployments:

```yaml
# .github/workflows/deploy.yml
name: Deploy to Production

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm ci
      - run: npm test
      - run: cd ui && npm ci && npm run build

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to server
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: deploy
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            cd /opt/xero-invoice-app
            git pull origin main
            npm ci --production
            cd ui && npm ci && npm run build && cd ..
            pm2 restart xero-app
```

This ensures:
- Every push to `main` runs tests first
- UI is rebuilt automatically
- Server restarts with zero manual intervention
- Dashboard updates deploy in < 2 minutes

---

## Environment Variables Checklist (Production)

```bash
# ── Required (app crashes without these) ──────────────────
NODE_ENV=production
PORT=4000
JWT_SECRET=<64-char-hex>                    # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SESSION_SECRET=<64-char-hex>                # same command
ENCRYPTION_KEY=<64-char-hex>                # same command
DATABASE_URL=postgresql://user:pass@private-db-host:5432/xero_invoices?sslmode=require
APP_URL=https://yourdomain.com

# ── Optional but recommended ──────────────────────────────
REDIS_URL=redis://private-redis-host:6379   # Enables Bull job queue
CORS_ORIGIN=https://yourdomain.com          # CORS whitelist
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...  # Error/success notifications

# ── Per-company (set via UI Setup page, NOT here) ─────────
# Xero Client ID/Secret     → per user, stored encrypted in DB
# IMAP Host/User/Pass        → per user, stored encrypted in DB
# LLM API Keys               → per user, stored encrypted in DB
```

> ⚠️ **NEVER** put these in code or commit them to git. Set them as environment
> variables on the server or in the hosting provider's dashboard.
