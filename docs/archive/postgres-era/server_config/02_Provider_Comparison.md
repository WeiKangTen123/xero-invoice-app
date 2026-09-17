# ⚖️ Cloud Provider Comparison

> Unbiased comparison of all major server providers for deploying the Xero Invoice App
> as a B2B SaaS product. Evaluated across security, cost, scalability, and compatibility.

---

## Critical App Requirements

Before comparing providers, understand what our app **requires**:

| Requirement | Reason |
|:---|:---|
| ✅ Persistent disk storage | SQLite/PostgreSQL data must survive redeployments |
| ✅ Always-on process | IMAP email listener runs 24/7 — cannot sleep or scale-to-zero |
| ✅ Managed PostgreSQL available | Required for multi-company concurrent writes |
| ✅ Managed Redis available | Required for Bull job queue |
| ✅ Private networking (VPC) | Database and Redis must NOT be publicly accessible |
| ✅ HTTPS / TLS | Financial data in transit must be encrypted |
| ✅ Asia-Pacific data centre | Low latency for MY/SG/AU companies |

---

## ❌ Providers That DO NOT Work

| Provider | Why It Fails |
|:---|:---|
| **Vercel** | Serverless functions only — no persistent disk, no long-running IMAP process |
| **Cloudflare Workers** | No filesystem, no persistent TCP connections |
| **Netlify** | Frontend-only hosting — no Node.js backend server |
| **GCP Cloud Run** | Ephemeral filesystem (SQLite/data lost), scales-to-zero (IMAP dies) |
| **AWS Lambda** | Serverless — same problems as Cloud Run |
| **GitHub Pages** | Static files only — no backend |
| **Render Free/Starter** | App sleeps after 15min idle → kills IMAP listener. Need $25/mo plan minimum |

---

## ✅ Viable Providers — Detailed Comparison

### Tier 1: Managed PaaS (Zero Server Management)

#### Railway

| | Details |
|:---|:---|
| **Type** | Managed PaaS |
| **Plan** | Pro — $5/month base + usage |
| **Spec** | Up to 8 vCPU, 8 GB RAM (shared, pay-per-use) |
| **Persistent Disk** | ✅ Yes (volume add-on, $0.25/GB/month) |
| **Managed PostgreSQL** | ❌ No — must use third-party or self-manage |
| **Managed Redis** | ❌ No — must use third-party |
| **Private VPC** | ❌ Limited |
| **HTTPS** | ✅ Automatic |
| **Deploy** | Git push → auto-deploy |
| **Asia DC** | ✅ Singapore |
| **Est. Cost** | $5–15/month (app only, no managed DB) |

| ✅ Pros | ⚠️ Cons |
|:---|:---|
| Fastest to deploy (minutes) | No managed PostgreSQL or Redis |
| Great dashboard for env vars | Shared CPU — can throttle during PDF parsing |
| Built-in monitoring & logs | No VPC / private networking for DB isolation |
| We already have `railway.json` configured | Smaller company — enterprises won't trust it |
| | **Not recommended for B2B SaaS** |

#### Render

| | Details |
|:---|:---|
| **Type** | Managed PaaS |
| **Plan** | Starter $7/mo, Standard $25/mo |
| **Persistent Disk** | ✅ Yes ($0.25/GB/month add-on) |
| **Managed PostgreSQL** | ✅ Yes (free tier available) |
| **Managed Redis** | ✅ Yes ($10/mo) |
| **Private VPC** | ✅ Yes (on paid plans) |
| **HTTPS** | ✅ Automatic |
| **Asia DC** | ✅ Singapore |
| **Est. Cost** | $25–45/month (with DB + Redis) |

| ✅ Pros | ⚠️ Cons |
|:---|:---|
| Similar ease to Railway | Starter plan sleeps after 15 min (kills IMAP) |
| Has managed PostgreSQL + Redis | Need $25/mo Standard plan for always-on |
| Free PostgreSQL tier for dev | Limited monitoring tools |
| Built-in cron jobs | Weaker community than DigitalOcean |

---

### Tier 2: Cloud VPS (Full Control, You Manage the Server)

#### DigitalOcean ⭐ RECOMMENDED

| | Details |
|:---|:---|
| **Type** | Cloud VPS + Managed Services |
| **App Server** | Droplet: 2 vCPU, 4 GB RAM, 80 GB SSD — $24/mo |
| **Managed PostgreSQL** | ✅ 1 vCPU, 1 GB RAM, 10 GB — $15/mo |
| **Managed Redis** | ✅ 1 GB RAM — $15/mo |
| **Private VPC** | ✅ Yes (free, built-in) |
| **Firewall** | ✅ Cloud firewall (free) |
| **Backups** | ✅ Weekly automated (free), DB daily auto-backup |
| **HTTPS** | Manual (Nginx + Let's Encrypt) or via Cloudflare |
| **Asia DC** | ✅ Singapore (SGP1) |
| **Est. Cost** | **~$54/month** |

| ✅ Pros | ⚠️ Cons |
|:---|:---|
| **Best documentation in the industry** | Must set up Nginx + SSL yourself |
| Predictable flat pricing — no surprise bills | No auto-deploy (need GitHub Actions CI/CD) |
| Dedicated resources (not shared) | No KL data centre (Singapore only) |
| Managed DB with auto-backups + encryption at rest | |
| VPC + firewall for DB/Redis isolation | |
| Scales cleanly (just resize) | |

#### Alibaba Cloud (Aliyun / 阿里云) ⭐ BEST FOR MALAYSIA

| | Details |
|:---|:---|
| **Type** | Cloud VPS + Managed Services |
| **App Server** | ECS: 2 vCPU, 4 GB RAM, 40 GB SSD — ~$20/mo |
| **Managed PostgreSQL** | ✅ ApsaraDB RDS: 1 vCPU, 2 GB RAM — ~$25/mo |
| **Managed Redis** | ✅ ApsaraDB Redis: 1 GB — ~$15/mo |
| **Private VPC** | ✅ Yes |
| **Firewall** | ✅ Security Groups |
| **Backups** | ✅ RDS auto daily backup |
| **HTTPS** | Manual (Nginx + Let's Encrypt) |
| **Asia DC** | ✅ **Kuala Lumpur** + Singapore + Jakarta |
| **Est. Cost** | **~$60/month** |

| ✅ Pros | ⚠️ Cons |
|:---|:---|
| **Kuala Lumpur data centre** — lowest latency for MY | Weaker English documentation |
| Cheapest APAC pricing (20–30% cheaper than GCP) | Console UI can be confusing |
| Data residency compliance for Malaysian companies | Smaller English-speaking community |
| Aggressive startup credits available | |
| Strong DDoS protection built-in | |

#### Google Cloud Platform (GCP)

| | Details |
|:---|:---|
| **Type** | Cloud VPS + Managed Services |
| **App Server** | Compute Engine e2-medium: 2 vCPU, 4 GB — ~$25/mo |
| **Managed PostgreSQL** | ✅ Cloud SQL: db-f1-micro, 10 GB — ~$10/mo |
| **Managed Redis** | ✅ Memorystore: 1 GB — ~$35/mo |
| **Private VPC** | ✅ Yes |
| **Firewall** | ✅ VPC firewall rules |
| **Backups** | ✅ Cloud SQL auto daily — ~$2/mo |
| **HTTPS** | Manual (Nginx + Certbot) |
| **Asia DC** | ✅ Singapore (asia-southeast1) |
| **Est. Cost** | **~$72/month** |

| ✅ Pros | ⚠️ Cons |
|:---|:---|
| Google infrastructure — best-in-class security | Most expensive at launch tier |
| SOC2/ISO27001 compliance built-in | Redis (Memorystore) is very pricey |
| Best long-term scaling path (Cloud Run, GKE) | Billing can be confusing (egress charges) |
| Free tier e2-micro for dev/staging | Complex console UI |
| Excellent monitoring (Cloud Monitoring, free) | |

#### GCP Compute Engine — Free Tier (Dev/Staging Only)

| | Details |
|:---|:---|
| **Spec** | e2-micro: 0.25 vCPU, 1 GB RAM, 30 GB HDD |
| **Cost** | **$0/month forever** (not a trial) |
| **Region** | US only (us-west1, us-central1, us-east1) |
| **Use for** | Development, staging, testing — NOT production |

> ⚠️ e2-micro (0.25 vCPU) is too weak for production PDF parsing with multiple companies.
> Use it for a free staging environment alongside your paid production server.

#### AWS Lightsail

| | Details |
|:---|:---|
| **Type** | Simple VPS |
| **App Server** | 1 vCPU, 2 GB RAM, 60 GB SSD — $12/mo |
| **Managed PostgreSQL** | ✅ Lightsail Database: 1 vCPU, 1 GB — $15/mo |
| **Managed Redis** | ❌ Not available in Lightsail (need ElastiCache — more complex) |
| **Private VPC** | ⚠️ Limited (Lightsail peering to AWS VPC needed) |
| **HTTPS** | Via Lightsail Load Balancer (+$18/mo) or manual |
| **Asia DC** | ✅ Singapore (ap-southeast-1) |
| **Est. Cost** | **$27–45/month** (without Redis) |

| ✅ Pros | ⚠️ Cons |
|:---|:---|
| Cheapest reliable VPS | No managed Redis in Lightsail |
| Static IP included free | 2 GB RAM tighter than alternatives |
| AWS infrastructure reliability | HTTPS setup more complex |
| 3 TB transfer included | Need full AWS for Redis → defeats simplicity |

#### Microsoft Azure — B2s VM

| | Details |
|:---|:---|
| **Type** | Cloud VPS + Managed Services |
| **App Server** | B2s: 2 vCPU, 4 GB RAM — ~$30/mo |
| **Managed PostgreSQL** | ✅ Azure Database for PostgreSQL — ~$25/mo |
| **Managed Redis** | ✅ Azure Cache for Redis — ~$40/mo |
| **Private VPC** | ✅ Yes |
| **Asia DC** | ✅ Southeast Asia (Singapore) |
| **Est. Cost** | **~$95/month** |

| ✅ Pros | ⚠️ Cons |
|:---|:---|
| Enterprise reputation | Most expensive option |
| 12-month free tier for testing | Free tier is temporary |
| Good compliance certifications | Most complex console UI of all options |
| | Overkill for a launch-phase SaaS |

---

## 📊 Head-to-Head Comparison Matrix

| Factor | DigitalOcean | Aliyun | GCP | Render | Railway | AWS Lightsail | Azure |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Monthly Cost** | **$54** | **$60** | **$72** | $35–45 | $5–15 | $27–45 | $95 |
| **Managed PostgreSQL** | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| **Managed Redis** | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| **Private VPC** | ✅ | ✅ | ✅ | ✅ | ❌ | ⚠️ | ✅ |
| **KL Data Centre** | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **SG Data Centre** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Auto HTTPS** | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ |
| **Auto Deploy** | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ |
| **Setup Difficulty** | ⭐⭐ Medium | ⭐⭐⭐ Hard | ⭐⭐⭐ Hard | ⭐ Easy | ⭐ Easy | ⭐⭐ Medium | ⭐⭐⭐ Hard |
| **Documentation** | ⭐⭐⭐ Best | ⭐ Weak (EN) | ⭐⭐ Good | ⭐⭐ Good | ⭐⭐ Good | ⭐⭐ Good | ⭐⭐ Good |
| **Enterprise Trust** | Good | Good (Asia) | Excellent | Fair | Low | Excellent | Excellent |
| **B2B SaaS Ready** | ✅ | ✅ | ✅ | ⚠️ | ❌ | ⚠️ | ✅ |

---

## 🏅 Final Recommendation

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Your companies are in MALAYSIA / SOUTHEAST ASIA?                   │
│  ├── Need data in Malaysia specifically?                             │
│  │   └── 🥇 Alibaba Cloud (Aliyun) — KL data centre, ~$60/mo      │
│  │                                                                   │
│  ├── Want easiest setup + best documentation?                        │
│  │   └── 🥇 DigitalOcean — SG data centre, ~$54/mo                 │
│  │                                                                   │
│  └── Planning for 50+ companies long-term?                          │
│      └── 🥇 GCP — SG data centre, ~$72/mo, scales to enterprise    │
│                                                                      │
│  Your companies are GLOBAL?                                          │
│  └── 🥇 GCP or AWS — broadest global coverage + compliance         │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```
