# 🖥️ Final Server Configuration — DigitalOcean (Production)

> **Provider:** DigitalOcean
> **Region:** Singapore (SGP1)
> **Monthly Cost:** ~$39/month
> **Capacity:** 1–10 companies

---

## 📦 What You're Paying For

| # | Component | Purpose | Monthly Cost |
|:---:|:---|:---|---:|
| 1 | **App Server (Droplet)** | Runs your Node.js app, IMAP listener, serves dashboard | $24 |
| 2 | **Managed PostgreSQL** | Stores all data (users, invoices, credentials) | $15 |
| 3 | **Cloudflare (Free Plan)** | HTTPS, DDoS protection, CDN, hides server IP | $0 |
| | | **Total** | **$39/month** |

No Redis needed — your app already queues in memory + database.

---

## 1. App Server (Droplet)

| Setting | Value |
|:---|:---|
| **Plan** | Basic (Regular Intel) |
| **CPU** | 2 vCPU |
| **RAM** | 4 GB |
| **Storage** | 80 GB SSD |
| **Transfer** | 4 TB/month |
| **Region** | SGP1 (Singapore) |
| **OS** | Ubuntu 24.04 LTS |
| **Cost** | $24/month |

### Software to Install

| Software | Version | Purpose |
|:---|:---|:---|
| **Node.js** | v22 LTS | Runtime for your app |
| **npm** | v9+ | Package manager |
| **Nginx** | Latest | Reverse proxy (routes port 443 → port 4000) |
| **PM2** | Latest | Process manager — auto-restarts app on crash |
| **Certbot** | Latest | Auto-renews SSL certificates (if not using Cloudflare) |
| **Git** | Latest | Pull code from GitHub |

### PM2 Setup

```bash
# Install PM2 globally
npm install -g pm2

# Start app with PM2
pm2 start main/index.js --name xero-app

# Auto-start on server reboot
pm2 startup
pm2 save

# View logs
pm2 logs xero-app

# Restart after code update
pm2 restart xero-app
```

---

## 2. Managed PostgreSQL Database

| Setting | Value |
|:---|:---|
| **Plan** | Basic |
| **CPU** | 1 vCPU |
| **RAM** | 1 GB |
| **Storage** | 10 GB SSD (auto-expandable) |
| **PostgreSQL Version** | 16 |
| **Region** | SGP1 (same as Droplet) |
| **Network** | Private VPC only — NO public IP |
| **Connection** | SSL required |
| **Backups** | ✅ Daily automated, 7-day retention (included free) |
| **Standby Nodes** | 0 (add when scaling to 10+ companies) |
| **Cost** | $15/month |

### Connection String

```
DATABASE_URL=postgresql://app_user:<password>@private-db-host:25060/xero_invoices?sslmode=require
```

- Use a **dedicated `app_user`** — NOT the `doadmin` superuser
- Connect via **private network hostname** — never the public one
- Always use `sslmode=require` — encrypts data between app and DB

---

## 3. Cloudflare (Free Plan)

| Setting | Value |
|:---|:---|
| **Plan** | Free |
| **SSL Mode** | Full (Strict) |
| **Always Use HTTPS** | ✅ ON |
| **Auto Minify** | ✅ ON (JS, CSS, HTML) |
| **Brotli Compression** | ✅ ON |
| **Browser Cache TTL** | 4 hours |
| **Security Level** | Medium |
| **Bot Fight Mode** | ✅ ON |
| **Under Attack Mode** | OFF (turn ON if under active DDoS) |
| **Cost** | $0/month |

### DNS Setup

```
Type    Name              Content              Proxy
A       yourdomain.com    <Droplet Public IP>  ☁️ Proxied (orange cloud ON)
CNAME   www               yourdomain.com       ☁️ Proxied
```

Orange cloud = Cloudflare proxies traffic (hides your real server IP).

---

## 4. Firewall Rules (DigitalOcean Cloud Firewall)

| Rule | Port | Source | Action |
|:---|:---:|:---|:---|
| **HTTPS** | 443 | All IPv4 / IPv6 (`0.0.0.0/0`, `::/0`) | ✅ Allow |
| **HTTP** | 80 | All (Cloudflare redirects to HTTPS) | ✅ Allow |
| **SSH** | 22 | Your admin IP(s) only | ✅ Allow |
| **PostgreSQL** | 25060 | Droplet private IP only (auto-managed by DO) | ✅ Allow |
| **Everything else** | * | * | ❌ Deny |

Create the firewall in DigitalOcean dashboard → Networking → Firewalls → assign to your Droplet.

---

## 5. SSH Hardening

```bash
# Edit SSH config
sudo nano /etc/ssh/sshd_config

# Apply these settings:
PasswordAuthentication no       # Key-based only — no brute force possible
PermitRootLogin no              # Never SSH as root
MaxAuthTries 3                  # Lock out after 3 failed attempts
AllowUsers deploy               # Only allow the deploy user

# Restart SSH
sudo systemctl restart sshd
```

### Create a deploy user (don't run app as root)

```bash
# Create user
adduser deploy
usermod -aG sudo deploy

# Copy your SSH key to the new user
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
```

---

## 6. Nginx Reverse Proxy

```nginx
# /etc/nginx/sites-available/xero-app

server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    # If using Cloudflare, Cloudflare handles SSL termination.
    # If NOT using Cloudflare, uncomment these lines:
    # ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    # Security headers
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Max upload size (for PDF uploads)
    client_max_body_size 10M;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeouts for long-running requests (PDF parsing)
        proxy_read_timeout 120s;
        proxy_connect_timeout 10s;
    }
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$host$request_uri;
}
```

```bash
# Enable the site
sudo ln -s /etc/nginx/sites-available/xero-app /etc/nginx/sites-enabled/
sudo nginx -t          # Test config
sudo systemctl reload nginx
```

---

## 7. Environment Variables (Production)

Set these on the server — NEVER in code.

```bash
# Create env file on the server
sudo nano /opt/xero-invoice-app/main/.env
```

```bash
# ═══════════════════════════════════════════════════
#  PRODUCTION ENVIRONMENT VARIABLES
# ═══════════════════════════════════════════════════

# ── App ───────────────────────────────────────────
NODE_ENV=production
PORT=4000
APP_URL=https://yourdomain.com

# ── Secrets (generate fresh for production) ───────
# Generate each with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
JWT_SECRET=<64-char-hex>
SESSION_SECRET=<64-char-hex>
ENCRYPTION_KEY=<64-char-hex>

# ── PostgreSQL (from DigitalOcean dashboard) ──────
DATABASE_URL=postgresql://app_user:<password>@private-db-host:25060/xero_invoices?sslmode=require
DB_SSL=true

# ── Redis (NOT NEEDED — leave empty) ──────────────
REDIS_URL=

# ── Xero defaults ────────────────────────────────
DEFAULT_ACCOUNT_CODE=200
DEFAULT_CURRENCY=USD

# ── Per-user credentials ─────────────────────────
# Xero, IMAP, and LLM API keys are set per-user
# via the Setup page in the dashboard.
# They are stored encrypted (AES-256-GCM) in the database.
# Do NOT set them here.
```

---

## 8. Automated Backups

### Database (Handled by DigitalOcean)

- ✅ Daily automated backups — included free
- ✅ 7-day retention
- ✅ One-click restore from DigitalOcean dashboard
- ✅ Encrypted at rest

### Server Snapshots

```
DigitalOcean Dashboard → Droplets → Your Droplet → Snapshots
→ Enable weekly backups ($4.80/month = 20% of Droplet cost)
```

This snapshots your entire server (code, configs, logs) weekly.

### App-Level Backup (Optional Extra Safety)

```bash
# Daily cron job for additional DB backup
# Edit crontab: crontab -e
0 2 * * * cd /opt/xero-invoice-app && node main/db/backup.js >> /var/log/xero-backup.log 2>&1
```

---

## 9. Monitoring (Free)

| Service | Purpose | Cost |
|:---|:---|:---:|
| **DigitalOcean Monitoring** | CPU, RAM, disk alerts (built-in) | $0 |
| **Better Stack (free tier)** | Uptime monitoring — pings your app every 3 min | $0 |
| **Sentry (free tier)** | Error tracking — 5,000 errors/month | $0 |

### DigitalOcean Alert Policies (set in dashboard)

| Alert | Threshold | Action |
|:---|:---|:---|
| CPU usage | > 80% for 5 min | Email alert |
| RAM usage | > 85% for 5 min | Email alert |
| Disk usage | > 80% | Email alert |
| Droplet is down | Unreachable | Email alert |

---

## 10. Full Security Summary

| Layer | Protection | Status |
|:---|:---|:---:|
| **Network** | Cloudflare DDoS protection | ✅ |
| **Transport** | HTTPS/TLS encryption (all traffic) | ✅ |
| **Server IP** | Hidden behind Cloudflare proxy | ✅ |
| **Firewall** | Only ports 443, 80, 22 (restricted) open | ✅ |
| **SSH** | Key-based auth only, root disabled | ✅ |
| **App** | Helmet security headers | ✅ |
| **App** | Rate limiting (500 req/15min per user) | ✅ |
| **App** | CORS restricted to your domain | ⚠️ Add before launch |
| **App** | JWT authentication (no fallback secret) | ⚠️ Fix before launch |
| **Auth** | Passwords hashed with bcrypt | ✅ |
| **Database** | Private VPC — no public access | ✅ |
| **Database** | SSL connection required | ✅ |
| **Database** | Encrypted at rest | ✅ |
| **Database** | Daily automated backups | ✅ |
| **Credentials** | AES-256-GCM encryption at rest | ✅ |
| **Input** | express-validator sanitisation | ✅ |
| **SQL** | Parameterized queries (no injection) | ✅ |

---

## Quick Reference Card

```
╔══════════════════════════════════════════════════╗
║     PRODUCTION SERVER — FINAL SPEC               ║
╠══════════════════════════════════════════════════╣
║                                                  ║
║  Provider:    DigitalOcean                       ║
║  Region:      Singapore (SGP1)                   ║
║  Cost:        $39/month                          ║
║                                                  ║
║  ── App Server (Droplet) ─── $24/mo ──────────  ║
║  CPU:         2 vCPU                             ║
║  RAM:         4 GB                               ║
║  Storage:     80 GB SSD                          ║
║  OS:          Ubuntu 24.04 LTS                   ║
║  Node.js:     v22 LTS                            ║
║  Process:     PM2 (auto-restart)                 ║
║  Proxy:       Nginx → port 4000                  ║
║                                                  ║
║  ── Database (Managed PostgreSQL) ── $15/mo ──  ║
║  CPU:         1 vCPU                             ║
║  RAM:         1 GB                               ║
║  Storage:     10 GB SSD (auto-expand)            ║
║  Version:     PostgreSQL 16                      ║
║  Network:     Private VPC only                   ║
║  Backups:     Daily, 7-day retention             ║
║  Encryption:  At rest + SSL in transit           ║
║                                                  ║
║  ── Security (Cloudflare) ── $0/mo ────────────  ║
║  SSL:         Full (Strict)                      ║
║  DDoS:        Protected                          ║
║  CDN:         Dashboard assets cached globally   ║
║  Server IP:   Hidden                             ║
║                                                  ║
║  ── Redis ────────────────────────────────────   ║
║  Not needed. Queue runs in memory + database.    ║
║                                                  ║
╚══════════════════════════════════════════════════╝
```
