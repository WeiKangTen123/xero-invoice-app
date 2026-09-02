# 🎯 Pure Technical Security & Data Protection Q&A

**System:** Xero Invoice Automation Platform  
**Scope:** Data Integrity, Data Security, Data Exposure, Infrastructure, and Operational Compliance  
**Target Audience:** Technical Auditors, Enterprise Clients, Security Evaluators, and Due-Diligence Reviewers  

---

## 📑 Table of Contents
1. [Category A: Data Integrity & Reliability](#category-a-data-integrity--reliability)
2. [Category B: Data Security & Cryptography](#category-b-data-security--cryptography)
3. [Category C: Data Exposure & Leakage Prevention](#category-c-data-exposure--leakage-prevention)
4. [Category D: Infrastructure, Cloud Defense & Operational Factors](#category-d-infrastructure-cloud-defense--operational-factors)

---

## Category A: Data Integrity & Reliability

#### Q1: How does the system prevent duplicate invoice entries in Xero if an email is received twice or scanned multiple times?
**Answer:** The platform implements a **two-phase deduplication pipeline**:
1. **Upfront Pre-Check (`findPosted`):** Before initiating parsing or Xero calls, the system cross-references the invoice number, supplier name, and amount against existing posted records in the database.
2. **Atomic Race-Guard (`_xeroChain`):** During submission, jobs are processed through a sequential, paced queue with a 1.5-second buffer. A final verification check is executed immediately prior to the Xero API call. If an invoice was posted milliseconds earlier, the second call is aborted as idempotent, returning the existing Xero invoice ID.

#### Q2: What prevents the AI/LLM from hallucinating invoice figures and corrupting financial records?
**Answer:**
- **Deterministic Validation Rules:** Extracted LLM data is evaluated against strict business rules before reaching Xero. Any invoice extracted with a `$0.00` total, missing line items, or an empty invoice number is flagged as an extraction failure.
- **Status Quarantine (`review-needed`):** Unverified or ambiguous records are placed in a quarantined `review-needed` queue. They require human confirmation in the dashboard before draft creation in Xero.
- **Draft Mode Default:** All uploaded invoices are submitted to Xero strictly as **Drafts (`ACCPAY` Bills or `ACCREC` Invoices)**, preventing automated modifications to approved general ledgers without accountant approval.

#### Q3: How is database referential integrity maintained across related tables (Users, Invoices, Credentials)?
**Answer:** The database schema enforces strict foreign key constraints with **`ON DELETE CASCADE`** on all relational tables (`invoices`, `user_credentials`, `settings`). Prepared statements ensure that operations are atomic, preventing orphaned child records if an operation is interrupted midway.

#### Q4: If the server crashes or restarts during email parsing or Xero submission, how is data recovered without corruption?
**Answer:**
- **Persistent Disk Queues:** Incoming email jobs are committed to a persistent queue state before processing begins.
- **Startup Reconciler (`recoverPendingJobs`):** Upon boot, the server checks for in-flight tasks marked `pending` or `submitting`, cross-checks Xero to see if the record already posted, and safely resumes uncompleted syncs.

---

## Category B: Data Security & Cryptography

#### Q5: How are third-party credentials (Xero Client Secret, IMAP Email Passwords, LLM API Keys) encrypted at rest?
**Answer:** Secrets are encrypted using **AES-256-GCM** (Galois/Counter Mode) authenticated encryption:
- Every secret uses a unique, cryptographically random **12-byte Initialization Vector (IV)**.
- A **16-byte authentication tag** is generated to verify ciphertext integrity against tampering.
- Stored format: `enc:v1:<base64(iv + authTag + ciphertext)>`.
- The 256-bit encryption key is loaded strictly at runtime via environment variables (`ENCRYPTION_KEY`) and is never written to disk or logs.

#### Q6: How are user login credentials secured against offline database theft and cracking?
**Answer:** User passwords are never stored in plaintext. They are hashed using **`bcryptjs`** with cryptographically secure salt rounds. Bcrypt incorporates a work factor that makes brute-force dictionary and rainbow-table attacks computationally impractical.

#### Q7: How is data protected while in transit over the internet and internal networks?
**Answer:**
- **Web Clients:** Enforced **TLS 1.3** with HTTPS redirection and HSTS headers.
- **Database Traffic:** PostgreSQL connections require SSL/TLS (`sslmode=require`) over private network interfaces.
- **Mail Ingestion:** IMAP client communicates over SSL/TLS on dedicated **Port 993**.
- **External Integrations:** Outbound requests to Xero, Google Gemini, and OpenRouter APIs are routed through HTTPS with strict TLS certificate verification.

#### Q8: How are user sessions and API requests authenticated?
**Answer:** Authentication is stateless using signed **JSON Web Tokens (JWT)**. Every API request must supply a valid token in the `Authorization: Bearer <token>` header. Tokens have bounded lifetimes and are verified cryptographically on every protected endpoint.

---

## Category C: Data Exposure & Leakage Prevention

#### Q9: How does the system prevent multi-tenant data leaks and Insecure Direct Object References (IDOR)?
**Answer:**
- **JWT Identity Extraction:** The application middleware (`requireAuth`) extracts the tenant ID directly from the cryptographically verified JWT payload (`req.user.id`).
- **Parameterized SQL Scoping:** Database queries never rely on untrusted client-supplied user IDs. Every query strictly scopes data access to the authenticated user:
  ```sql
  SELECT * FROM invoices WHERE id = $1 AND user_id = $2;
  ```
- **Physical File Isolation:** PDF attachments and individual user configs are partitioned into isolated filesystem paths: `main/data/users/{userId}/pdfs/`.

#### Q10: How do you prevent sensitive financial data (PII, bank details, passwords) from leaking into server logs?
**Answer:**
- **Sanitized Logging:** Winston and Pino loggers are configured to omit sensitive fields (passwords, JWTs, OAuth tokens, and raw credit card numbers).
- **Error Obfuscation:** Global Express error middleware intercepts unhandled exceptions, logs the technical trace internally, and returns a generic `{ error: "Internal server error" }` to client responses, preventing database schemas and stack traces from being exposed.

#### Q11: Does transmitting invoices to LLM providers (Gemini / OpenRouter) expose confidential financial data or train public models?
**Answer:**
- **Zero-Retention API Agreements:** The platform connects via enterprise/commercial API endpoints governed by strict data privacy terms: customer prompt data is processed in transit and is **not stored or used to train public foundation models**.
- **Payload Minimization:** Only extracted plain text necessary for line-item and vendor reconciliation is transmitted to the model.

#### Q12: How does the system defend against Directory Traversal and Arbitrary File Download attacks?
**Answer:**
- Static asset endpoints only serve compiled frontend artifacts from `ui/dist`.
- PDF downloads and file reads use strict path sanitization (`path.join` with validated tenant IDs and UUID-based file references), preventing `../` traversal outside designated user directories.

---

## Category D: Infrastructure, Cloud Defense & Operational Factors

#### Q13: Why is the application hosted on a Cloud VPS (GCP Compute Engine / DigitalOcean Droplet) rather than Serverless?
**Answer:** The core automation requires an **always-on IMAP IDLE listener** that maintains a persistent 24/7 TCP connection to mailbox servers for real-time invoice triggers. Serverless platforms (AWS Lambda, GCP Cloud Run) sleep or terminate connections after short timeouts, which breaks continuous email listening.

#### Q14: How does the infrastructure protect against Distributed Denial of Service (DDoS) and brute force attacks?
**Answer:**
- **Cloudflare Edge Shield:** The origin server IP is hidden behind Cloudflare DNS. Layer 3/4 and Layer 7 volumetric traffic is absorbed at the CDN edge.
- **Dual-Tier Rate Limiting:**
  - **IP-Level Limiting:** Cloudflare and `express-rate-limit` restrict unauthenticated login attempts (`/api/auth/login`) to prevent credential stuffing.
  - **User-Level Limiting:** Authenticated endpoints enforce a 500-request per 15-minute window keyed by JWT user ID, preventing single-tenant request flooding.
- **Port Lockdown:** Host firewalls (UFW / Cloud VPC Security Groups) reject all public ingress except Cloudflare edge IP ranges and restricted SSH key access.

#### Q15: How are internal database instances isolated from public exposure?
**Answer:**
- The PostgreSQL database is provisioned in a **Private VPC subnet** with no public IP address assigned.
- Ingress is restricted via firewall rules strictly to the internal private IP (`10.x.x.x`) of the application droplet/VM.

#### Q16: How is the system compliant with data privacy regulations like GDPR and PDPA?
**Answer:**
- **Right to Erasure (GDPR Art. 17 / PDPA):** When an account is terminated, executing a user deletion triggers database cascades (`ON DELETE CASCADE`) and filesystem cleanup, permanently wiping all associated invoices, encrypted credentials, and cached PDF files.
- **Data Portability:** Invoice and financial mapping data can be exported in standardized JSON / CSV formats.

#### Q17: What is the Backup and Disaster Recovery (RPO / RTO) strategy?
**Answer:**
- **Automated Snapshots:** Managed PostgreSQL performs daily automated backups with 7-day point-in-time recovery (PITR).
- **Recovery Point Objective (RPO):** Maximum 24 hours of local data (0 hours for Xero, as posted drafts exist permanently in Xero's cloud).
- **Recovery Time Objective (RTO):** Under 15 minutes to re-provision a new compute node and attach the managed database.

#### Q18: How does the system defend against Cross-Site Scripting (XSS) and Cross-Site Request Forgery (CSRF)?
**Answer:**
- **XSS Protection:** React UI auto-escapes rendered variables by default. HTTP response headers configured via `helmet` enforce `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, and XSS filtering.
- **CSRF Immunity:** The API uses stateless Bearer token authorization in the HTTP `Authorization` header rather than ambient browser cookies. Browsers do not automatically attach Bearer tokens on cross-origin requests, eliminating standard CSRF attack vectors.

---

## 📌 Summary Matrix: Risk vs. Defensive Control

| Threat / Risk Area | Primary Vector | Engineering Control in Platform |
|:---|:---|:---|
| **Data Integrity** | Duplicate bills in Xero | Two-phase deduplication: pre-scan check + sequential queue race guard |
| **Data Integrity** | AI OCR hallucinations | Rule-based zero-amount quarantine to `review-needed` status |
| **Data Security** | Stolen DB credentials | Field-level **AES-256-GCM** encryption with dynamic runtime master keys |
| **Data Security** | Credential stuffing | **Bcrypt** password hashing + per-IP & per-user rate limiting |
| **Data Exposure** | Multi-tenant cross-talk | JWT-scoped queries (`WHERE user_id = $id`) + isolated user folders |
| **Data Exposure** | Public AI model training | Zero-data retention enterprise API contracts (Google / OpenRouter) |
| **Infrastructure** | DDoS & direct IP attacks | Cloudflare edge proxying + Private VPC firewall locking origin IP |
| **Infrastructure** | Server crash in processing | Persistent queue state + startup reconciler (`recoverPendingJobs`) |
| **Compliance** | GDPR / PDPA right to delete | `ON DELETE CASCADE` automated database & disk file purging |
