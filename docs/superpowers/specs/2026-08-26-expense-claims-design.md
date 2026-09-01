# Expense Claims — Design

**Date:** 2026-08-26
**Status:** Approved for planning

## Goal

Add expense claims as a third document type in AR & AP. A receipt enters as an
image — uploaded from the desktop or photographed on a phone — is read
automatically, is reviewed by the user, and produces a Xero-ready payload.

The pipeline is built end to end. **The POST to Xero is not executed.** It stops
at a preview until the contact and account mapping are decided.

## Non-goals

Explicitly out of scope, and not to be added speculatively:

- **No approval workflow.** Each user connects their own company's Xero and
  reviews their own claims. The admin role monitors usage; it does not approve.
- **No reimbursement tracking.** Whether anyone has been paid back is not modelled.
- **No contact or account-code mapping.** Deferred by decision, not by oversight.
- **No POST to Xero.** Phases 1–4 cannot alter Xero data. Phase 5 is gated on an
  explicit instruction.

## Constraints

| Constraint | Source | Consequence |
|---|---|---|
| ExpenseClaims and Receipts endpoints disabled Feb 2026 | Xero changelog | A claim must be modelled as an **ACCPAY bill with an attachment**. No alternative endpoint exists. |
| Attachments capped at 3MB; PDF/JPG/PNG only | Xero Files API | Phone photos are 4–12MB. **Client-side compression is mandatory.** |
| `accounting.attachments` scope not currently granted | `main/xero/oauth.js` | Needed only at Phase 5. Phases 1–4 require no reconnect. |
| Xero bills on GET egress since Mar 2026 | Xero pricing | Uploads are ingress (free). Any contact/account lookup is billed, so cache it. |
| Existing parser is text-only (`pdf-parse` → text → Gemini) | `main/email/parser.js` | A photo has no text layer. Needs a vision path. |

### Why vision works without a new dependency

`main/utils/gemini-client.js` posts to Google's OpenAI-compatibility endpoint
(`generativelanguage.googleapis.com/v1beta/openai/chat/completions`), which
accepts an `image_url` content part carrying a base64 data URI. `_callOnce`
passes `messages` through opaquely, so **only the caller changes** — existing
model rotation, key rotation and quota handling are inherited unchanged.

## Architecture

```
INTAKE                    PROCESS                 REVIEW            XERO
──────────────────────    ───────────────────     ─────────────     ────────────
Desktop drag/drop  ─┐
                    ├──→  compress → store  ──→   Gemini vision ──→ user edits ──→ payload preview
Phone via QR pair  ─┘     (≤3MB, per-user)        (merchant, date,   in AR & AP     ┃
                                                   total, tax, ccy)                  ╹ STOPS HERE
```

### Units

Each has one purpose, a defined interface, and is testable in isolation.

| Unit | Responsibility | Mirrors |
|---|---|---|
| `main/utils/receipt-store.js` | Per-user image storage under `main/data/users/<id>/receipts/` | `pdf-store.js` — same interface, different extension |
| `main/utils/pairing.js` | Single-use, short-TTL QR tokens bound to one user | `oauth-state.js` — in-memory, swept, single-process |
| `main/utils/receipt-parser.js` | Image buffer → structured fields via Gemini vision | `email/llm-parser.js` |
| `main/routes/receipts.js` | Upload, pair, poll, list, review endpoints | `routes/invoices.js` |
| `main/xero/expense-payload.js` | Build + validate the ACCPAY payload. **Never sends.** | `xero/invoices.js` |
| `ui/.../ReceiptCapture.jsx` | Add-receipt menu, dropzone, QR panel | — |
| `ui/src/pages/Capture.jsx` | Mobile capture page reached by QR | — |

## Data model

The existing `invoices` table already carries `invoice_type`, `vendor_name`,
`total_amount`, `tax_amount`, `sub_total`, `currency`, `account_code`, `source`
and the exact status vocabulary needed. There is **no CHECK constraint on
`invoice_type`**, so `'EXPENSE'` is accepted without altering a constraint.

Two additive columns, applied by the existing idempotent migration runner:

```sql
ALTER TABLE invoices ADD COLUMN receipt_file TEXT;   -- filename in receipt-store
ALTER TABLE invoices ADD COLUMN receipt_mime TEXT;   -- image/jpeg | image/png | application/pdf
```

`source` distinguishes intake: `'upload'` or `'phone'`.

Reusing the table means the AR & AP list, status badges, counts, filters, dedup
and review screen work unchanged.

## Layout

Receipts join the **existing type filter row** as a third chip. No new
navigation level. Rows render in the same table as bills, with a thumbnail in
the first column. An `+ Add receipt` menu offers Upload or Use my phone.

```
AR & AP                                        [+ Add receipt ▾]
┌──────────────────────────────────────────────────────────────┐
│ All(24)  Bills(12)  Invoices(9)  ●Receipts(3)                │
├──────────────────────────────────────────────────────────────┤
│ All │ ✓Posted │ ●Ready │ Pending │ ⚠Review │ Reported        │
└──────────────────────────────────────────────────────────────┘
┌────┬────────────┬──────────┬───────────┬──────────┐
│ ▪  │ Grab       │ 08-24    │  18.40    │ ●Ready   │
│ ▪  │ FairPrice  │ 08-23    │  62.10    │ ⚠Review  │
│ 📄 │ Payroll    │ 07-31    │  9371.00  │ ✓Posted  │
└────┴────────────┴──────────┴───────────┴──────────┘
```

### Review screen

Image left, fields right, so a figure can be checked against the photo without
switching context. The Xero panel shows exactly what would be sent and is
disabled.

```
Review receipt                                   [Discard]  [Save]
┌─────────────────────────┬─────────────────────────────────────┐
│    ┌───────────────┐    │  Merchant  [ Grab              ]    │
│    │ receipt photo │    │  Date      [ 2026-08-24        ]    │
│    │  zoom  rotate │    │  Total     [ SGD 18.40         ]    │
│    └───────────────┘    │  Tax (GST) [ SGD 1.51          ]    │
│                         │  ⓘ Read by AI — check before saving │
└─────────────────────────┴─────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────┐
│  Xero preview — nothing is sent                                │
│  Bill · DRAFT · ACCPAY · attachment 1 file (412 KB)            │
│  Contact  ⚠ not mapped yet     Account  ⚠ not mapped yet       │
│  [ Send to Xero ]  ← disabled                                  │
└────────────────────────────────────────────────────────────────┘
```

## Phone pairing flow

1. User picks **Add receipt → Use my phone**
2. Server mints a single-use token, 10-minute TTL, bound to that user
3. Desktop renders it as a QR code with a live countdown
4. Phone scans, opens `/capture/<token>` — no login typing
5. Camera opens via `capture="environment"`
6. Photo is compressed **on the phone** (canvas resize → JPEG ≈0.8) before upload
7. Upload arrives; desktop polls every 3s and the row appears

**Security.** The token is single-use, short-lived, bound to one user, and grants
**upload only** — it cannot read existing data. Same threat model as the OAuth
`state` parameter, which this deliberately mirrors. A token that has been spent
or has expired is rejected with no information about which.

## Error handling

Every failure degrades to something the user can act on, never a silent drop.

| Failure | Behaviour |
|---|---|
| File over 3MB after compression | Rejected at upload with the actual size and the limit |
| Unsupported type (HEIC, TIFF) | Rejected naming the accepted formats |
| Gemini unavailable or over quota | Receipt is **still saved** at `review-needed` with empty fields for manual entry. Parsing is an enhancement, never a gate. |
| Parse returns implausible values | Saved at `review-needed`, fields shown as read but flagged |
| QR token expired or already used | Phone shows "link expired, scan a fresh code" |
| Disk write fails | Upload fails loudly; no orphan DB row is created |

The ordering rule: **the image is stored before parsing is attempted.** A parse
failure must never lose the receipt.

## Testing

- `receipt-store` — save, read, missing-file, delete, per-user isolation
- `pairing` — mint, redeem once, reject reuse, reject expiry, reject cross-user
- `receipt-parser` — mocked Gemini: good response, malformed JSON, empty, quota
  error; asserts a failure still yields a saved receipt at `review-needed`
- `expense-payload` — asserts the built payload shape, `status: 'DRAFT'`, and
  **that no Xero write method is called**
- `routes/receipts` — auth required, size and type rejection, happy path

A contract test asserts the payload builder never invokes a Xero write, so the
"built but not sent" guarantee cannot regress silently.

## Phases

| Phase | Delivers | Touches Xero |
|---|---|---|
| 1 | Upload, storage, compression, third chip, manual field entry | No |
| 2 | QR pairing, phone camera, live desktop arrival | No |
| 3 | Gemini vision extraction and review screen | No |
| 4 | Xero payload builder and preview. POST written and tested, never called. | No |
| 5 | **Only on explicit instruction:** enable POST, add `accounting.attachments`, reconnect | Yes |

Phases 1–4 are independently useful and cannot alter Xero data.

## Open decisions

Deferred deliberately. Neither blocks phases 1–4.

1. **Which Xero contact** a claim maps to.
2. **Which account code** it books against.
