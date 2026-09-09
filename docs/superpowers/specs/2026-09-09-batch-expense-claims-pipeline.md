# Batch Expense Claims Pipeline, Deduplication & Queue Architecture

**Date:** 2026-09-09  
**Status:** Implemented & Verified  

---

## 1. Overview & Objective

The **Batch Expense Claims Pipeline** automates the ingestion, parsing, verification, and reconciliation of employee expense claims.

Employees commonly submit claims via emails (`.eml`) containing:
1. A compressed archive of receipt photos/scans (`.zip`).
2. An itemised spreadsheet (`Claims form.xlsx`).

This feature processes these files asynchronously, runs AI extraction across all receipt images, matches receipts one-to-one against claim form lines, identifies discrepancies, enforces strict deduplication, and isolates execution via a persistent, crash-resilient disk queue.

> **Strict Non-Goal / Safety Invariant:**  
> **ZERO writes to Xero API.** All parsed claims are saved into the local user store with `status: 'review-needed'` and `source: 'claim'`. No data is submitted or exported to Xero without explicit, human-reviewed approval.

---

## 2. Pipeline Stages & Modules

```
Intake (.zip + .xlsx) 
   │
   ▼
[claim-queue] ──> Disk storage (.que + .bin) ──> Concurrency cap & poison guard
   │
   ▼
[claim-worker] ──> Background polling & job recovery on server restarts
   │
   ▼
1. [claim-archive]    : In-memory zip extraction, filters Mac shadow metadata (__MACOSX/._*)
2. [claim-form]       : Excel header-based parser; skips blank lines and summary footers
3. Receipt Extraction : Gemini Vision with automated rate-limiting & delay intervals
4. [claim-dedup]      : SHA-256 byte-hash match (certain) + Vendor/Date/Amount heuristic
5. [claim-matcher]    : Date-led one-to-one pairing; flags amount mismatches (cent-rounded)
6. [claim-categories] : Suggests accounts categories strictly from form headings for blank lines
   │
   ▼
Reconciliation Output : Local review records + verified vs mismatched discrepancy summary
```

### Module Responsibilities:

| Module | File | Responsibility |
|---|---|---|
| **Archive Extractor** | `main/claims/claim-archive.js` | Streams and extracts archives using `yauzl`. Filters out macOS `__MACOSX` files and enforces limits. |
| **Spreadsheet Parser** | `main/claims/claim-form.js` | Parses `.xlsx` via `exceljs`. Handles Excel serial dates, ignores blank template rows and footers. |
| **Claim Matcher** | `main/claims/claim-matcher.js` | Leads with date matching, uses amount to corroborate, reports discrepancies, handles rounding. |
| **Deduplication Engine** | `main/claims/claim-dedup.js` | Content-hash (SHA-256) exact matching + soft vendor/date/amount heuristics. |
| **Durable Queue** | `main/claims/claim-queue.js` | Serialises jobs and payloads to disk (`.que`), protects against reboots and crashes. |
| **Queue Worker** | `main/claims/claim-worker.js` | Drains pending claim jobs sequentially per user, manages retry limits and recovery. |
| **API Endpoints** | `main/routes/claims.js` | `/api/claims/import`, `/api/claims/import/:jobId`, `/api/claims/group/:groupId`. |

---

## 3. Deduplication Architecture (`claim-dedup.js`)

To maintain accounting integrity and prevent duplicate expense entries, deduplication operates on two distinct certainty tiers:

1. **Tier 1: Exact Receipt Image Match (`certain: true`)**
   - When a receipt image buffer is processed, a SHA-256 hash is computed and stored in the `receipt_hash` column.
   - If an incoming receipt matches an existing hash in the user's records, it is **factually a duplicate**.
   - Action: The record is automatically marked as `status: 'duplicate'`, pointing to the original record with `duplicateOf: <originalId>`. No second image file is written to storage.

2. **Tier 2: Field Heuristic Suspicion (`certain: false`)**
   - If a claim line has no image attached, the system checks whether `vendorName`, `invoiceDate`, and `totalAmount` match an existing claim.
   - Because identical repeat expenses can legitimately occur (e.g. two identical train fares on the same day), guessing would risk locking out real expenses behind an irreversible duplicate status.
   - Action: The row is marked `status: 'review-needed'` and flagged with a descriptive warning: `Possible duplicate of <id> (<vendor>, <date>, <amount>)`. A human reviewer settles the suspicion.

---

## 4. Crash Resilience & Queue Processing (`claim-queue.js` + `claim-worker.js`)

Processing 20–50 receipts through an AI vision model takes minutes due to API quotas (e.g. Gemini 15 RPM). Holding open an HTTP connection risks gateway timeouts and browser tab closure failures. Furthermore, a flood of concurrent uploads could exhaust server memory.

### Key Resilience Guarantees:

1. **Disk Durability**:
   - Jobs are written to `data/users/<userId>/claim-queue/<jobId>.que` before execution begins.
   - Upload payloads are stored alongside as temporary binary blobs (`.bin`).
   - Uses atomic file writes (temp file + OS `renameSync`) to ensure a server crash mid-write never leaves corrupt JSON.

2. **Reboot & Crash Recovery**:
   - On server startup (`main/index.js`), `claimWorker.recoverPendingJobs()` scans the user queue directories and resumes interrupted jobs.
   - User does not lose submitted claims if PM2 restarts or the server is bounced.

3. **Crash Loop & Poison Prevention**:
   - Each job tracks an `attempts` counter.
   - If a corrupted archive or unhandled exception causes a job to fail `MAX_ATTEMPTS = 3` times, `getPoisoned` catches it and marks it permanently `failed`. This prevents an unparseable job from trapping the server in an infinite restart loop.

4. **Load & Concurrency Limits**:
   - Each user is capped at `MAX_QUEUED_PER_USER = 10` pending imports.
   - Additional submissions are cleanly rejected with HTTP 429 rather than overwhelming server memory or CPU.

5. **Storage Cleanup & TTL**:
   - As soon as a job reaches a terminal state (`done`, `failed`, `cancelled`), its binary payload blobs are unlinked immediately to free disk space.
   - Job metadata (`.que`) is retained for `JOB_TTL_MS = 1 hour` so users can review the reconciliation results.
   - Automated sweep sweeps expired jobs and purges any orphaned binary blobs.

---

## 5. Summary of API Endpoints

* `POST /api/claims/import` — Enqueues `.zip` archives and `.xlsx` forms (max 25MB). Returns `202 Accepted` with `{ jobId, stage }`.
* `GET /api/claims/import/:jobId` — Polls job progress (`unpacking`, `reading form`, `reading receipts`, `matching`, `categorising`, `saving`, `done`). Returns reconciliation summary upon completion.
* `DELETE /api/claims/import/:jobId` — Cancels an in-flight or queued claim import.
* `DELETE /api/claims/group/:groupId` — Undoes an entire batch import in one atomic operation, safely deleting all created records and unreferencing shared receipt files.
