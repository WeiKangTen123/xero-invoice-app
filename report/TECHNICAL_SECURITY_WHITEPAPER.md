# 🛡️ Technical Security Whitepaper & Security Q&A Guide
**System:** Xero Invoice Automation Platform  
**Target Audience:** Security Auditors, Enterprise Technical Evaluators, Cloud Architects, and Compliance Officers  
**Deployment Profile:** Multi-Tenant Node.js / React Web & Worker Engine on Cloud VPS (GCP / DigitalOcean) + Cloudflare Edge  

---

## Executive Summary

The **Xero Invoice Automation System** is an enterprise-grade financial integration platform that ingests unstructured incoming invoice emails via IMAP, parses invoice metadata using isolated Large Language Model (LLM) engines, and synchronizes draft bills (`ACCPAY`) and invoices (`ACCREC`) with Xero via OAuth 2.0.

Financial data integrity, tenant isolation, and credential protection are the primary architectural pillars. The platform employs **Defense-in-Depth**, spanning Cloudflare Edge Protection, VPC network isolation, field-level **AES-256-GCM encryption at rest**, **TLS 1.3 in transit**, and strict **JWT-based Role-Based Access Control (RBAC)**.

```
                                  [ INTERNET CLIENTS ]
                                            │
                                            ▼ HTTPS (TLS 1.3 / HSTS)
                        ┌───────────────────────────────────────┐
                        │     Cloudflare Edge Network / WAF     │ ◄── DDoS Mitigation & Origin Shield
                        └───────────────────┬───────────────────┘
                                            │ Authenticated Origin Pull
                                            ▼
                    ┌───────────────────────────────────────────────┐
                    │    App & Worker Node (GCP / DigitalOcean)     │
                    │  - Node.js / Express Server (Port 4000)       │
                    │  - Helmet Security Headers & CORS Lockdown    │
                    │  - JWT Auth Middleware & User Rate Limiting   │
                    │  - Persistent 24/7 IMAP Listener (TLS 993)   │
                    └───────────────┬───────────────┬───────────────┘
                                    │               │
      Encrypted SQL (VPC Private)   │               │ Encrypted REST (TLS 1.3)
                                    ▼               ▼
┌──────────────────────────────────────┐  ┌─────────────────────────────────────┐
│    Managed PostgreSQL Database       │  │          Third-Party APIs           │
│  - Isolated Private VPC (No Public)  │  │  - Xero API (OAuth 2.0 PKCE)        │
│  - Field-Level AES-256-GCM Secrets   │  │  - Gmail IMAP over SSL (Port 993)   │
│  - Multi-Tenant Row & Foreign Keys   │  │  - Gemini / LLM Extraction APIs     │
│  - Automated 7-Day Encrypted Backups │  │    (Zero-Data Retention Policy)     │
└──────────────────────────────────────┘  └─────────────────────────────────────┘
```

---

## Security Architecture & Technical Q&A

---

### Pillar 1: Data Protection & Cryptography

#### Q1: How are sensitive third-party credentials (Xero Client Secrets, Gmail Passwords, LLM Keys) stored?
* **Answer:** All tenant secrets stored in the database are encrypted at rest using **authenticated AES-256-GCM** (Galois/Counter Mode).
  - Every encrypted secret is generated with a unique, cryptographically random **12-byte Initialization Vector (IV)** and a **16-byte authentication tag**.
  - Ciphertexts are stored in the format `enc:v1:<base64(iv + authTag + ciphertext)>`.
  - The authentication tag ensures both **confidentiality** and **ciphertext integrity**, preventing bit-flipping attacks.
  - Encryption keys are injected at runtime exclusively via environment variables (`ENCRYPTION_KEY`, 256-bit hex) and are never hardcoded or committed to version control.

#### Q2: How is data secured in transit across external and internal networks?
* **Answer:**
  - **Client-to-Edge:** End-to-end TLS 1.3 with automated certificate renewal and strict HSTS headers.
  - **Server-to-Database:** Database traffic is routed exclusively over a private VPC using mandatory SSL/TLS (`sslmode=require`).
  - **Server-to-Email Providers:** IMAP communication with Gmail/mail servers occurs strictly over secure sockets via TLS on Port 993.
  - **Server-to-Xero/LLMs:** Outbound REST requests to Xero and LLM APIs use HTTPS with standard certificate authority (CA) verification.

---

### Pillar 2: Cloud Infrastructure, Hosting & Network Defense

#### Q3: Why deploy on a dedicated Cloud VPS (GCP Compute Engine / DigitalOcean Droplet) instead of serverless functions?
* **Answer:** 
  - The system operates an **always-on IMAP IDLE listener** that maintains a persistent 24/7 TCP connection to mailboxes for real-time invoice detection.
  - Serverless platforms (AWS Lambda, GCP Cloud Run) enforce execution timeouts and scale-to-zero lifecycles that terminate long-running socket listeners.
  - A hardened Linux VPS (Ubuntu 24.04 LTS) managed by PM2 provides uninterrupted background ingestion, local failover queues, and predictable resource allocation.

#### Q4: How is the server protected from DDoS attacks, port scanning, and IP exposure?
* **Answer:**
  - **Edge Cloaking:** The backend server is fronted by **Cloudflare**. The server’s real public IP address is hidden behind Cloudflare DNS proxying.
  - **Firewall Rules:** The cloud provider firewall (GCP VPC Firewall / DigitalOcean Cloud Firewall) and host-level `ufw` block all direct public ingress except:
    - HTTP/HTTPS (restricted solely to Cloudflare's published IP ranges).
    - SSH (restricted to explicit developer public keys / Google Cloud IAP bastion tunnels; password authentication disabled).
  - **DDoS Mitigation:** Layer 3/4 and Layer 7 volumetric attacks are mitigated at Cloudflare edge nodes before reaching origin compute.

#### Q5: How are internal databases protected from public network exposure?
* **Answer:**
  - The PostgreSQL database resides in an **isolated Private Virtual Private Cloud (VPC)** subnet.
  - Public IP access to the database engine is disabled.
  - Connections are restricted by IP allowlisting strictly to the application server's private network adapter (`10.x.x.x`).

---

### Pillar 3: Authentication, Multi-Tenancy & Authorization (IDOR Defense)

#### Q6: How does the system guarantee tenant isolation and prevent Insecure Direct Object References (IDOR)?
* **Answer:**
  - **Authentication:** Stateless **JSON Web Tokens (JWT)** signed with a 256-bit secret.
  - **Middleware Scoping:** Every protected endpoint invokes `requireAuth` middleware, which verifies the token signature and extracts the authenticated `req.user.id`.
  - **Query-Level Scoping:** All database operations strictly bind the authenticated user's ID into parameterized queries:
    ```sql
    SELECT * FROM invoices WHERE id = $1 AND user_id = $2;
    ```
  - Users have zero visibility or access rights to any invoice record, PDF file, or third-party credential belonging to another tenant.
  - **Storage Isolation:** User-specific binary files (PDF attachments) are stored in partitioned, non-public directories (`main/data/users/{userId}/pdfs/`).

#### Q7: How are user passwords authenticated and protected against brute-force attacks?
* **Answer:**
  - Passwords are hashed using **`bcryptjs`** with cryptographically secure salt rounds. Plaintext passwords never touch logs or disk storage.
  - **Multi-tiered Rate Limiting:** 
    - Unauthenticated routes (such as `/api/auth/login`) are rate-limited by source IP.
    - Authenticated API routes enforce per-user rate limits (500 requests per 15-minute window) keyed dynamically to the user's JWT ID, preventing a single noisy tenant from degrading performance for others.

---

### Pillar 4: Third-Party Integrations & Data Privacy (Xero, Gmail, LLM)

#### Q8: What security practices govern the Xero OAuth 2.0 integration?
* **Answer:**
  - Implements **OAuth 2.0 Authorization Code Flow with PKCE** and the Principle of Least Privilege.
  - Requests only essential scopes: `accounting.transactions` (creating bills/invoices) and `offline_access` (refresh token exchange).
  - Access tokens (30-minute validity) are maintained in transient memory; refresh tokens (60-day validity) are stored encrypted at rest via AES-256-GCM.
  - Token refresh cycles are handled automatically prior to Xero API dispatches.

#### Q9: Does sending invoice text to LLMs (Gemini / OpenRouter) expose confidential financial data or train public models?
* **Answer:**
  - **Zero-Data Training Policy:** Ingestion relies on commercial API tiers (Google Cloud Gemini API / OpenRouter Enterprise) where customer API payloads are explicitly excluded from foundation model training.
  - **Payload Minimization:** Only extracted text contents necessary for line-item, vendor, and amount extraction are transmitted.
  - **Prompt Injection Defense:** LLM inputs are structured as strict system/user prompts with typed JSON Schema enforcement (`response_format: { type: "json_object" }`), ensuring LLM outputs cannot trigger arbitrary command execution.

#### Q10: How are malicious or malformed PDF attachments handled?
* **Answer:**
  - PDF files are parsed in isolated Node.js memory buffers via `pdf-parse`.
  - Payloads exceeding standard thresholds (10MB limit) are rejected immediately at the HTTP/IMAP boundary.
  - Corrupted, encrypted, or zero-text image scans are flagged as `review-needed` and quarantined for manual user inspection without executing scripts or macros.

---

### Pillar 5: Application Hardening & Defensive Engineering

#### Q11: How does the application defend against OWASP Top 10 vulnerabilities?

| Threat / Vulnerability | Mitigation in Place | Code Reference |
|:---|:---|:---|
| **SQL Injection (SQLi)** | 100% Parameterized queries using prepared statements (`pg` / `better-sqlite3`). No string concatenation in SQL. | `main/utils/invoice-store.js` |
| **Cross-Site Scripting (XSS)** | React automatic JSX escaping + HTTP security headers via `helmet` (X-Content-Type-Options, X-Frame-Options). | `main/index.js:59` |
| **Cross-Site Request Forgery (CSRF)** | Stateless Bearer token architecture stored in memory/sessionStorage (no ambient cookie transmission). | `main/middleware/auth-middleware.js` |
| **Race Conditions / Double Invoicing** | Dual-layer deduplication: upfront DB check (`findPosted`) + atomic pre-submit race guard in sequential queue (`_xeroChain`). | `main/utils/invoice-handler.js` |
| **Information Leakage** | Production error handler suppresses internal stack traces and database schemas, responding with generic 500 status codes. | `main/index.js:123-126` |

---

### Pillar 6: Compliance, Audit Logging & Disaster Recovery

#### Q12: How does the platform support compliance frameworks (PDPA, GDPR, SOC 2)?
* **Answer:**
  - **Right to Erasure (GDPR Art. 17 / PDPA):** The database implements `ON DELETE CASCADE` across all foreign keys. Deleting a tenant account immediately and permanently purges all associated credentials, invoices, and PDF storage files.
  - **Data Minimization:** Only operational financial metadata (Invoice #, Date, Vendor, Line Items, Amount) required for accounting synchronization is retained.
  - **Audit Logging:** Structured audit logs (Pino/Winston) record timestamped synchronization events, authentication attempts, and API responses while masking passwords and authorization bearer tokens.

#### Q13: What is the Disaster Recovery and Backup Strategy?
* **Answer:**
  - **Automated DB Snapshots:** Managed PostgreSQL includes daily automated backups with a 7-day point-in-time recovery (PITR) window.
  - **Process Crash Recovery:** Email ingestion queues persist pending job states to disk. In the event of an unplanned server restart, `recoverPendingJobs()` and startup reconcilers automatically resume interrupted sync jobs without duplicate billing creation.

---

## ⚡ Rapid-Fire Meeting Defense Cheat Sheet

| Question / Challenge | 10-Second Executive Response |
|:---|:---|
| *"Can another company see our invoices?"* | **No.** Every database query is strictly filtered by the authenticated user's JWT ID. There are no shared data views or cross-tenant query vectors. |
| *"What happens if the server's database is stolen?"* | All Xero secrets, email passwords, and API keys are encrypted at rest using **AES-256-GCM**. Without the server's runtime master key, the data is mathematically unreadable. |
| *"Is your server vulnerable to direct DDoS?"* | All web traffic passes through **Cloudflare**. The origin IP is hidden, direct IP traffic is blocked by firewall, and Layer 7 DDoS mitigation is active. |
| *"Can an AI model learn from our financial numbers?"* | **No.** We use commercial API endpoints with strict zero-retention agreements where client payloads are never stored or used to train public LLMs. |
| *"Could a network blip cause an invoice to be created twice in Xero?"* | **No.** The system enforces an atomic, two-phase deduplication check before dispatching requests to Xero's API. |
