# 🖥️ Server Configuration & Deployment Guide

> **Complete documentation for deploying the Xero Invoice App as a B2B SaaS product.**
>
> This guide covers server specs, provider selection, security hardening, and scaling
> strategy for serving multiple companies in production.

## 📑 Table of Contents

| Document | Description |
|:---|:---|
| [01_Architecture_Overview.md](./01_Architecture_Overview.md) | System architecture, component map, and infrastructure diagram |
| [02_Provider_Comparison.md](./02_Provider_Comparison.md) | Side-by-side comparison of all cloud providers (GCP, AWS, Aliyun, DigitalOcean, Railway, Render, Azure) |
| [03_Server_Specs.md](./03_Server_Specs.md) | Exact RAM, CPU, storage, and cost for each growth phase |
| [04_Security_Hardening.md](./04_Security_Hardening.md) | Security audit, gaps to fix, firewall rules, encryption config |
| [05_Deployment_Roadmap.md](./05_Deployment_Roadmap.md) | Week-by-week launch plan and pre-launch checklist |

## ⚡ Quick Start

If you just want the recommended config:

- **Provider:** DigitalOcean (Singapore) or Aliyun (Kuala Lumpur)
- **App Server:** 2 vCPU, 4 GB RAM, 50 GB SSD — ~$24/month
- **Database:** Managed PostgreSQL, 1 vCPU, 2 GB RAM, 20 GB — ~$15/month
- **Job Queue:** Managed Redis, 1 GB RAM — ~$15/month
- **Total:** ~$54/month for 1–10 companies

See [03_Server_Specs.md](./03_Server_Specs.md) for full details.
