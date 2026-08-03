# 🏗️ Architecture Overview

> How the Xero Invoice App is structured and what each component needs to run in production.

---

## System Component Map

| Component | Technology | Role | Resource Profile |
|:---|:---|:---|:---|
| **Backend API** | Node.js 22 + Express | REST API, business logic, IMAP polling | CPU-light, I/O-heavy |
| **Frontend UI** | React 18 + Vite | Dashboard, invoice management | Pre-built static bundle — near-zero cost |
| **Database** | SQLite (current) → PostgreSQL (production) | Users, credentials, invoices, settings | Low CPU, RAM-dependent (caching) |
| **Job Queue** | File-based (current) → Redis + Bull (production) | Email parsing queue, retry logic | Low CPU, low RAM |
| **Email Ingestion** | IMAP polling (Gmail/Outlook) | Long-lived TCP connections, polls every 60s | Always-on, minimal resources |
| **PDF Processing** | `pdf-parse` + LLM APIs | Extract invoice data from PDF attachments | Short CPU spikes during parsing |
| **External APIs** | Xero, OpenRouter, Gemini, Nvidia | OAuth2 invoice posting, LLM-based parsing | Outbound HTTPS calls |
| **Encryption** | AES-256-GCM (`utils/crypto.js`) | Encrypts Xero/IMAP/API secrets at rest | Negligible overhead |

---

## Infrastructure Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                          INTERNET                                   │
└─────────────┬───────────────────────────────────────┬───────────────┘
              │                                       │
              ▼                                       ▼
    ┌──────────────────┐                   ┌──────────────────┐
    │   Cloudflare     │                   │   External APIs  │
    │   (Free Plan)    │                   │                  │
    │                  │                   │  • Xero API      │
    │  • DDoS protect  │                   │  • Gmail IMAP    │
    │  • SSL/TLS       │                   │  • OpenRouter    │
    │  • CDN cache     │                   │  • Gemini API    │
    │  • WAF rules     │                   │  • Nvidia API    │
    └────────┬─────────┘                   └──────────────────┘
             │ HTTPS (443)                         ▲
             ▼                                     │
    ┌──────────────────┐                           │
    │   App Server     │───────────────────────────┘
    │                  │        (outbound API calls)
    │  Node.js 22      │
    │  Express API     │
    │  IMAP Listener   │
    │  Bull Worker     │
    │                  │
    │  2 vCPU / 4 GB   │
    │  50 GB SSD       │
    └───────┬──────┬───┘
            │      │
     Private VPC   Private VPC
     (port 5432)   (port 6379)
            │      │
            ▼      ▼
    ┌──────────┐  ┌──────────┐
    │PostgreSQL│  │  Redis   │
    │(Managed) │  │(Managed) │
    │          │  │          │
    │ 1 vCPU   │  │  1 GB    │
    │ 2 GB RAM │  │  RAM     │
    │ 20 GB    │  │          │
    │          │  │ Bull job  │
    │ Auto     │  │ queue    │
    │ backups  │  │          │
    └──────────┘  └──────────┘
```

---

## Current vs Production Architecture

| Layer | Current (Dev) | Production (B2B SaaS) | Why Change |
|:---|:---|:---|:---|
| **Database** | SQLite (`main/data/app.db`) | Managed PostgreSQL | SQLite has single-writer lock — blocks concurrent companies |
| **Job Queue** | `.que` files on disk | Redis + Bull (already coded in `queue/processor.js`) | File I/O bottleneck with many companies; no retry visibility |
| **PDF Storage** | Local filesystem (`main/data/users/`) | Local disk (Phase 1) → Object Storage (Phase 2+) | Local is fine at launch; move to S3/GCS/OSS when scaling |
| **SSL/TLS** | None (localhost) | Cloudflare or Nginx + Let's Encrypt | Encrypts all traffic — required for financial data |
| **Monitoring** | Console logs + `winston`/`pino` | Sentry + uptime checks | Need to know when things break before customers complain |
| **Deploy** | `npm run dev` | Git push → CI/CD → auto-deploy | Zero-downtime updates for dashboard changes |

---

## Port Map

| Port | Service | Exposure |
|:---|:---|:---|
| 443 | HTTPS (Nginx / Cloudflare → App) | Public |
| 4000 | Node.js Express (internal) | Private (behind reverse proxy) |
| 5432 | PostgreSQL | Private VPC only — **NEVER public** |
| 6379 | Redis | Private VPC only — **NEVER public** |
| 22 | SSH | Restricted to admin IPs only |

---

## Data Flow

```
1. Company user logs in via browser
   └─→ HTTPS → Cloudflare → Nginx → Express API → JWT auth

2. Email arrives at company's inbox
   └─→ IMAP listener polls inbox (every 60s)
   └─→ Email parsed → PDF extracted → LLM API called
   └─→ Invoice record saved to PostgreSQL
   └─→ Job queued in Redis (Bull)
   └─→ Bull worker submits to Xero API
   └─→ Status updated in PostgreSQL

3. Company views dashboard
   └─→ Browser fetches /api/invoices → PostgreSQL query → JSON response
```
