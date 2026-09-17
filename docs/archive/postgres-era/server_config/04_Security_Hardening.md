# 🔒 Security Hardening Guide

> Security audit of the Xero Invoice App and hardening requirements for B2B SaaS
> production deployment. Companies will trust this system with financial data,
> Xero credentials, and email passwords — security is non-negotiable.

---

## Current Security Audit

### ✅ What's Already Strong

| Layer | Implementation | File | Grade |
|:---|:---|:---|:---:|
| **Password Hashing** | `bcryptjs` (industry standard, salted hash) | `routes/auth.js` | A |
| **Secrets Encryption at Rest** | AES-256-GCM with random IV + auth tag | `utils/crypto.js` | A+ |
| **HTTP Security Headers** | `helmet` (XSS, clickjacking, MIME-sniff protection) | `main/index.js:57` | A |
| **Rate Limiting** | `express-rate-limit` with per-user keying via JWT | `main/index.js:64-82` | A |
| **Input Validation** | `express-validator` on API routes | `routes/setup.js`, `routes/auth.js` | B+ |
| **JWT Authentication** | Stateless token-based auth with role-based access | `middleware/auth-middleware.js` | B+ |
| **SQL Injection Prevention** | Parameterized queries via `better-sqlite3` prepared statements | `utils/invoice-store.js` | A |
| **Cascade Data Cleanup** | `ON DELETE CASCADE` on all foreign keys | `db/schema.sql` | A |
| **Secrets in .gitignore** | `.env` excluded from version control | `.gitignore` | A |
| **Graceful Shutdown** | SIGTERM/SIGINT handling, port release | `main/index.js:159-176` | A |
| **Error Sanitisation** | Global error handler returns generic message, not stack traces | `main/index.js:110-113` | A |

### 🔴 Critical Security Gaps (Must Fix Before Launch)

#### 1. JWT Fallback Secret

**File:** `middleware/auth-middleware.js:4`
```javascript
// CURRENT (DANGEROUS):
return process.env.JWT_SECRET || 'dev-secret-change-in-production';

// FIX (SAFE):
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required in production');
}
return process.env.JWT_SECRET;
```

**Risk:** If deployed without `JWT_SECRET`, anyone who knows this fallback string can forge
admin tokens and access every company's data. Severity: **CRITICAL**.

#### 2. No CORS Policy

**File:** `main/index.js` — no CORS middleware configured.

```javascript
// ADD THIS after helmet():
const cors = require('cors');
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'https://yourdomain.com',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
```

**Risk:** Without CORS, any website on the internet can make API requests to your backend
using a logged-in user's browser session. Severity: **CRITICAL**.

#### 3. Exposed Secrets in Git History

**File:** `.env` — contains live Xero, Gmail, OpenRouter, Nvidia, and Gemini API keys.

Even though `.env` is in `.gitignore`, if these credentials were ever committed to git
history (even once), they must be considered compromised.

**Action:** Regenerate ALL of these before production deployment:
- Xero Client ID & Secret (developer.xero.com)
- Gmail App Password (myaccount.google.com → Security)
- OpenRouter API Key
- Nvidia API Key
- Gemini API Key
- Session Secret (generate new: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
- JWT Secret (generate new: same command)
- Encryption Key (generate new: same command)

### 🟡 High Priority Security Improvements

#### 4. HTTPS Redirect Enforcement

Add middleware to force HTTP → HTTPS in production:

```javascript
// Add before all routes:
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, `https://${req.hostname}${req.url}`);
    }
    next();
  });
}
```

#### 5. Per-Company Rate Limiting

Current rate limit is global (500 req/15min). One aggressive company can exhaust the
limit for all users. Add tenant-scoped limits:

```javascript
// Stricter limits on sensitive routes:
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,    // 10 login attempts per 15 minutes
  message: { error: 'Too many login attempts' },
});
app.use('/api/auth/login', authLimiter);
```

#### 6. Audit Logging

For a financial tool serving companies, you NEED an audit trail:
- Who logged in and when
- Who modified invoice data
- Who connected/disconnected Xero
- Who changed credentials

This is a compliance requirement for finance-adjacent software.

#### 7. Session/Token Expiry

Ensure JWT tokens have a reasonable expiry (e.g., 24 hours) and implement refresh
tokens for long-lived sessions. Verify `expiresIn` is set in token signing.

---

## Server-Level Security Configuration

### Firewall Rules

| Rule | Port | Source | Direction | Action |
|:---|:---:|:---|:---|:---|
| HTTPS | 443 | `0.0.0.0/0` (all) | Inbound | ✅ Allow |
| SSH | 22 | Your admin IP(s) only | Inbound | ✅ Allow |
| PostgreSQL | 5432 | App server private IP only | Inbound | ✅ Allow |
| Redis | 6379 | App server private IP only | Inbound | ✅ Allow |
| Node.js | 4000 | Localhost / Nginx only | Inbound | ✅ Allow |
| All other | * | * | Inbound | ❌ Deny |

### SSH Hardening

```bash
# /etc/ssh/sshd_config — apply these settings:
PasswordAuthentication no          # Key-based auth only
PermitRootLogin no                 # Disable root SSH
MaxAuthTries 3                     # Lock out after 3 failed attempts
AllowUsers deploy                  # Only allow the deploy user
```

### Nginx Reverse Proxy Config

```nginx
server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    # Security headers (supplement helmet)
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;

    # Rate limit at Nginx level (defense in depth)
    limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;

    location / {
        limit_req zone=api burst=20 nodelay;
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support (if needed for future real-time features)
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$host$request_uri;
}
```

### Database Security

| Setting | Value | Why |
|:---|:---|:---|
| **Connection** | SSL required (`?sslmode=require` in `DATABASE_URL`) | Encrypts data between app and DB |
| **User** | Dedicated app user (not `postgres` superuser) | Principle of least privilege |
| **Network** | Private VPC only — no public IP assigned | DB never exposed to internet |
| **Backups** | Daily automated with 7-day retention | Point-in-time recovery for data loss |
| **Encryption at Rest** | Enabled | Data on disk is encrypted by the provider |
| **Password** | 32+ character randomly generated | Resist brute-force |

### Redis Security

| Setting | Value | Why |
|:---|:---|:---|
| **Network** | Private VPC only — no public IP | Redis has no auth by default — MUST be private |
| **AUTH password** | Set a strong password if provider supports it | Extra layer even within VPC |
| **TLS** | Enable if provider supports it | Encrypt queue data in transit |
| **maxmemory-policy** | `noeviction` | Never silently drop queued invoice jobs |

---

## Encryption Summary

| Data Type | At Rest | In Transit | Implementation |
|:---|:---:|:---:|:---|
| **User passwords** | ✅ bcrypt hash | ✅ HTTPS | `bcryptjs` in `routes/auth.js` |
| **Xero client secrets** | ✅ AES-256-GCM | ✅ HTTPS | `utils/crypto.js` → `user_credentials` table |
| **IMAP passwords** | ✅ AES-256-GCM | ✅ HTTPS | Same |
| **LLM API keys** | ✅ AES-256-GCM | ✅ HTTPS | Same |
| **Invoice data** | ✅ DB disk encryption | ✅ HTTPS + DB SSL | Managed PostgreSQL encryption |
| **PDF files** | ⚠️ Unencrypted on disk | ✅ HTTPS | Consider encrypting or moving to encrypted object storage |
| **JWT tokens** | N/A (stateless) | ✅ HTTPS | `jsonwebtoken` with HS256 |
| **Session data** | ⚠️ In-memory only | ✅ HTTPS | Lost on restart — move to Redis for persistence |

---

## Security Checklist — Pre-Launch

```
[ ] JWT_SECRET set as environment variable (crashes if missing)
[ ] ENCRYPTION_KEY set as environment variable (64 hex chars)
[ ] SESSION_SECRET set as environment variable (64 hex chars)
[ ] CORS origin restricted to your production domain
[ ] ALL API keys regenerated (Xero, Gmail, OpenRouter, Nvidia, Gemini)
[ ] HTTPS enforced (HTTP redirects to HTTPS)
[ ] Firewall configured (only 443 + 22 open)
[ ] SSH key-based auth only (password auth disabled)
[ ] PostgreSQL on private VPC (no public IP)
[ ] Redis on private VPC (no public IP)
[ ] DB SSL connection enabled (sslmode=require)
[ ] DB user is NOT superuser (dedicated app user)
[ ] Automated daily DB backups enabled
[ ] Error monitoring set up (Sentry or equivalent)
[ ] Rate limiting verified on login endpoint
[ ] Uptime monitoring configured (ping every 5 min)
[ ] Content Security Policy reviewed (currently disabled for React SPA)
```
