# 📊 Server Specifications & Sizing

> Exact CPU, RAM, storage, and cost recommendations for each growth phase.

---

## Phase 1: Launch (1–10 Companies)

### App Server

| Setting | Value | Rationale |
|:---|:---|:---|
| **CPU** | 2 vCPU | IMAP polling + PDF parsing + Xero API calls for 10 companies |
| **RAM** | 4 GB | Node.js ~300MB base + PostgreSQL client queries + PDF parsing spikes (~800MB peak) + OS overhead. 4 GB gives comfortable headroom |
| **Disk** | 50 GB SSD | OS (~5GB) + app code (~200MB) + logs (~1GB rotating) + temp PDF processing. 50 GB is generous |
| **OS** | Ubuntu 24.04 LTS | Long-term security updates until 2029 |
| **Node.js** | v22 LTS | Matches `engines` field in `package.json` |
| **Region** | Singapore or Kuala Lumpur | Low latency for Southeast Asian companies |

### Managed PostgreSQL (Database)

| Setting | Value | Rationale |
|:---|:---|:---|
| **CPU** | 1 vCPU | Sufficient for ~10 companies' concurrent read/write load |
| **RAM** | 2 GB | PostgreSQL uses RAM to cache frequently-accessed rows (`shared_buffers`). 2 GB caches most active data for 10 companies |
| **Storage** | 20 GB SSD | Invoice records are small (~1KB each). Users, credentials, settings are tiny. 20 GB holds millions of records. Storage is auto-expandable on most providers |
| **Backups** | Daily automated, 7-day retention | Company financial data — cannot afford data loss |
| **Encryption** | At-rest encryption ON | Required for storing Xero client secrets, IMAP passwords, API keys |
| **Network** | Private VPC only (no public IP) | Database accessible ONLY from the app server — never exposed to internet |
| **SSL Connection** | Required | Encrypt data in transit between app server and DB |
| **Version** | PostgreSQL 16 | Latest LTS with performance improvements |

### Managed Redis (Job Queue)

| Setting | Value | Rationale |
|:---|:---|:---|
| **RAM** | 1 GB | Bull queue jobs are tiny (~2KB each). 1 GB handles thousands of concurrent queued jobs plus session data |
| **Persistence** | AOF (Append Only File) enabled | Queued invoice jobs survive Redis restarts — no lost work |
| **Eviction Policy** | `noeviction` | Never silently drop queued jobs when memory is full — throw error instead |
| **Network** | Private VPC only (no public IP) | Same as DB — never exposed to internet |
| **Version** | Redis 7+ | Latest stable |

### Cost Breakdown (Phase 1)

| Component | DigitalOcean | Aliyun | GCP |
|:---|---:|---:|---:|
| App Server (2 vCPU, 4 GB) | $24 | $20 | $25 |
| Managed PostgreSQL (1 vCPU, 2 GB) | $15 | $25 | $10 |
| Managed Redis (1 GB) | $15 | $15 | $35 |
| Domain + SSL (Cloudflare Free) | $0 | $0 | $0 |
| **Total** | **$54/month** | **$60/month** | **$72/month** (Redis is expensive on GCP) |

### What This Handles

| Metric | Capacity |
|:---|:---|
| Concurrent companies | Up to 10 |
| Invoices per day | ~200–500 |
| IMAP connections | 10 simultaneous |
| PDF parsing | ~50/hour |
| Dashboard concurrent users | ~20 |
| Database size (1 year) | ~2–5 GB |

---

## Phase 2: Growth (10–50 Companies)

### Upgrades Required

| Component | Upgrade To | Reason |
|:---|:---|:---|
| **App Server** | 4 vCPU, 8 GB RAM, 80 GB SSD | More concurrent IMAP connections, more PDF parsing, more API routes |
| **PostgreSQL** | 2 vCPU, 4 GB RAM, 50 GB SSD | More concurrent queries, larger dataset, add a read replica |
| **Redis** | 2 GB RAM | More queued jobs in flight simultaneously |
| **Add: Object Storage** | 50 GB (S3/GCS/OSS) | Move PDF files off local disk for durability and horizontal scaling |
| **Add: Read Replica** | PostgreSQL standby | Dashboard queries don't slow down invoice processing |
| **Add: CI/CD** | GitHub Actions | Auto-deploy on merge to `main` — zero-downtime dashboard updates |

### Cost Breakdown (Phase 2)

| Component | DigitalOcean | Aliyun | GCP |
|:---|---:|---:|---:|
| App Server (4 vCPU, 8 GB) | $48 | $40 | $50 |
| PostgreSQL Primary (2 vCPU, 4 GB) | $60 | $50 | $50 |
| PostgreSQL Read Replica | $60 | $50 | $50 |
| Redis (2 GB) | $30 | $30 | $70 |
| Object Storage (50 GB) | $5 | $2 | $1 |
| Monitoring (Better Stack free / Sentry) | $0 | $0 | $0 |
| **Total** | **~$203/month** | **~$172/month** | **~$221/month** |

### What This Handles

| Metric | Capacity |
|:---|:---|
| Concurrent companies | Up to 50 |
| Invoices per day | ~1,000–2,500 |
| IMAP connections | 50 simultaneous |
| PDF parsing | ~200/hour |
| Dashboard concurrent users | ~100 |
| Database size (1 year) | ~10–25 GB |

---

## Phase 3: Enterprise (50+ Companies)

### Upgrades Required

| Component | Upgrade To | Reason |
|:---|:---|:---|
| **App Servers** | 2× instances (4 vCPU, 8 GB each) behind load balancer | Redundancy — one server can go down without outage |
| **PostgreSQL** | 4 vCPU, 8 GB RAM, 100 GB SSD + read replica + point-in-time recovery | High-availability, fast recovery from any failure |
| **Redis** | 4 GB RAM cluster with failover | High-availability queue — no single point of failure |
| **Load Balancer** | Cloud LB or Nginx | Distributes traffic across app servers |
| **Object Storage** | 200 GB | More companies = more PDFs |
| **Monitoring** | Sentry + Datadog / Grafana | Full APM, error tracking, alerting |
| **CDN** | Cloudflare Pro ($20/mo) | WAF rules, bot protection, advanced DDoS |

### Cost Breakdown (Phase 3)

| Component | DigitalOcean | GCP |
|:---|---:|---:|
| 2× App Servers (4 vCPU, 8 GB each) | $96 | $100 |
| Load Balancer | $12 | $18 |
| PostgreSQL Primary (4 vCPU, 8 GB, 100 GB) | $120 | $100 |
| PostgreSQL Read Replica | $120 | $100 |
| Redis Cluster (4 GB, HA) | $60 | $140 |
| Object Storage (200 GB) | $10 | $5 |
| Cloudflare Pro | $20 | $20 |
| Monitoring (Sentry + uptime) | $30 | $0 (Cloud Monitoring) |
| **Total** | **~$468/month** | **~$483/month** |

### What This Handles

| Metric | Capacity |
|:---|:---|
| Concurrent companies | 50–200+ |
| Invoices per day | ~5,000–10,000+ |
| IMAP connections | 100+ simultaneous |
| PDF parsing | ~500+/hour |
| Dashboard concurrent users | ~500 |
| Database size (1 year) | ~50–100 GB |
| Uptime SLA | 99.9%+ |

---

## Quick Reference — Sizing Summary

| | Phase 1 | Phase 2 | Phase 3 |
|:---|:---:|:---:|:---:|
| **Companies** | 1–10 | 10–50 | 50+ |
| **App CPU** | 2 vCPU | 4 vCPU | 4 vCPU × 2 |
| **App RAM** | **4 GB** | **8 GB** | **8 GB × 2** |
| **App Disk** | **50 GB** | **80 GB** | **80 GB × 2** |
| **DB CPU** | 1 vCPU | 2 vCPU | 4 vCPU |
| **DB RAM** | **2 GB** | **4 GB** | **8 GB** |
| **DB Storage** | **20 GB** | **50 GB** | **100 GB** |
| **Redis RAM** | **1 GB** | **2 GB** | **4 GB (HA)** |
| **PDF Storage** | Local disk | Object Storage 50 GB | Object Storage 200 GB |
| **Redundancy** | Single server | Single server + read replica | Dual servers + HA DB + HA Redis |
| **Cost (DO)** | **$54/mo** | **$203/mo** | **$468/mo** |
| **Cost (Aliyun)** | **$60/mo** | **$172/mo** | — |
| **Cost (GCP)** | **$72/mo** | **$221/mo** | **$483/mo** |

> **Start with Phase 1.** Upgrade when you approach ~10 companies or notice response time
> increasing. All recommended providers allow resizing in minutes with zero data loss.
