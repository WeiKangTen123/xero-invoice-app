-- Xero Invoice Automation — SQLite schema
-- users is the root table; everything else hangs off it via user_id FK with
-- ON DELETE CASCADE so deleting a user cleans up their credentials, settings,
-- invoices, and reports automatically.

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  password     TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'user',
  created_at   TEXT NOT NULL,
  -- Updated (throttled — at most once/minute, see users.js#touchLastSeen) on every
  -- authenticated request. This is real browser presence ("is this person using the
  -- app right now"), distinct from process-state.js's lastActivity, which tracks the
  -- EMAIL PIPELINE's activity (an invoice was processed) and says nothing about
  -- whether anyone is actually looking at the app.
  last_seen_at TEXT,
  -- Tokens issued before this instant are refused (auth-middleware.js). Moved
  -- forward by a password change or reset and by an admin's "sign out
  -- everywhere". JWTs are stateless and live seven days; this is the one
  -- revocation lever.
  sessions_valid_from TEXT,
  -- Set while the account is disabled: sign-in and existing tokens are refused
  -- and the mailbox watcher is stopped. Rows and files stay. NULL = active.
  disabled_at TEXT
);

-- 1:1 with users — Xero/IMAP/LLM credentials (was data/users/<id>/config.json)
CREATE TABLE IF NOT EXISTS user_credentials (
  user_id               TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  xero_client_id        TEXT,
  xero_client_secret     TEXT,
  imap_host             TEXT,
  imap_port             TEXT,
  imap_user             TEXT,
  imap_pass             TEXT,
  imap_filter_from      TEXT,
  imap_poll_interval_ms TEXT,
  imap_lookback_days    TEXT,
  gemini_api_key        TEXT,
  default_account_code  TEXT,
  default_currency      TEXT,
  zero_tax_rate         TEXT,
  -- OAuth2 "Web app" Xero connection — a second, parallel connection method to the
  -- Custom Connection fields above. Each user brings their own Xero Web app (own
  -- Client ID/Secret, same as Custom Connection's per-user model) rather than
  -- sharing one deployment-wide app — Xero's 60-calls/minute rate limit is per-app,
  -- so per-user apps give each user an independent budget instead of one shared
  -- pool across every user. Only the redirect URI is shared (it's a property of
  -- this server's deployment, not of any one user — see XERO_OAUTH_REDIRECT_URI
  -- in routes/setup.js GLOBAL_SECTIONS). xero_connection_type records which method
  -- is actually active ('custom' | 'oauth' | NULL). Both OAuth secrets are
  -- encrypted the same way as the other secrets in this table (see
  -- ENCRYPTED_COLUMNS in utils/users.js).
  xero_connection_type     TEXT,
  xero_oauth_client_id     TEXT,
  xero_oauth_client_secret TEXT,
  xero_oauth_refresh_token TEXT,
  xero_oauth_connected_at  TEXT,
  -- IANA timezone name (e.g. 'Asia/Singapore'), used only to FORMAT timestamps for
  -- display — every timestamp is still stored in UTC everywhere in this schema.
  -- Defaults to 'Asia/Singapore' at the application layer when unset, not here.
  timezone TEXT,
  -- The claimant's name as a Xero contact. When set, expense claims are posted
  -- as owed to this person, not to the merchant on the receipt.
  claim_payee_name TEXT,
  -- Claims with no receipt: a rate per km driven and a daily travel
  -- allowance, each with the Xero account it is coded to. A blank rate turns
  -- that kind of claim off; a blank account means the claim account. Text,
  -- like every default here, holding the number as it was typed and checked
  -- (routes/setup.js); the rate a claim used is copied onto the claim itself.
  mileage_rate          TEXT,
  mileage_account_code  TEXT,
  per_diem_rate         TEXT,
  per_diem_account_code TEXT
);

-- 1:1 with users — app behaviour toggles (was data/users/<id>/settings.json)
CREATE TABLE IF NOT EXISTS user_settings (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Defaults OFF: auto-submit posts invoices to a live accounting system,
  -- so it must be opted into, never inherited.
  auto_process INTEGER NOT NULL DEFAULT 0,
  -- The Xero company a new document is sent to when more than one is
  -- connected. Every connected company used to get its own copy of every bill.
  -- NULL = not chosen; with one company connected that one is used, with
  -- several nothing is sent until a person picks.
  default_tenant_id TEXT,
  -- 1 while the owner wants the mailbox watched: set by Start, cleared by Stop,
  -- logout or an admin. Automatic stops (idle sweep, a refused password,
  -- retries exhausted, shutdown) leave it, and boot resumes every account
  -- that has it (routes/process.js resumeWatchers). The watcher used to stay
  -- off after every restart until each user pressed Start again.
  watcher_enabled INTEGER NOT NULL DEFAULT 0,
  -- JSON array of revenue account names the user has marked, each
  -- {label, recurring}: recurring or project, overriding the guess from the
  -- name (settings-store; Dashboard -> Revenue). NULL = none marked.
  recurring_accounts TEXT
);

-- 1:1 with users — whether the Xero connection still works, so the app stops
-- retrying credentials Xero has refused and the banner can say why. Also
-- created on first use by utils/token-cache.js with this same definition, for
-- a database migrated before this table was declared here.
CREATE TABLE IF NOT EXISTS xero_connection_health (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  method             TEXT,
  needs_reconnect    INTEGER NOT NULL DEFAULT 0,
  reason             TEXT,
  fingerprint        TEXT,
  granted_scopes     TEXT,
  last_refreshed_at  TEXT,
  updated_at         TEXT NOT NULL
);

-- 1:many — invoice records (was data/users/<id>/invoices.json array)
-- total_amount/tax_amount/sub_total are stored as INTEGER cents (not REAL dollars)
-- to avoid float rounding drift on repeated read-modify-write cycles; invoice-store.js
-- converts to/from decimal dollars at the JS boundary, so every other layer of the
-- app (parsing, Xero posting, the UI) keeps working with plain dollar amounts.
CREATE TABLE IF NOT EXISTS invoices (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status            TEXT NOT NULL CHECK (status IN (
                       'pending', 'submitting', 'posted', 'error',
                       'duplicate', 'reported', 'review-needed', 'reviewed'
                     )),
  has_pdf           INTEGER NOT NULL DEFAULT 0,
  pdf_filename      TEXT,
  vendor_name       TEXT,
  contact_name      TEXT,
  contact_email     TEXT,
  contact_address   TEXT,
  invoice_number    TEXT,
  invoice_date      TEXT,
  due_date          TEXT,
  total_amount      INTEGER DEFAULT 0, -- cents
  currency          TEXT,
  invoice_type      TEXT,
  source            TEXT,
  source_email      TEXT,
  description       TEXT,
  account_code      TEXT,
  tax_amount        INTEGER DEFAULT 0, -- cents
  sub_total         INTEGER DEFAULT 0, -- cents
  payment_reference TEXT,
  xero_invoice_id   TEXT,
  -- The Xero company xero_invoice_id belongs to. A correction is sent there
  -- and nowhere else; an invoice ID means nothing in another company.
  xero_tenant_id    TEXT,
  error_msg         TEXT,
  duplicate_of      TEXT REFERENCES invoices(id) ON DELETE SET NULL,
  resolved_by       TEXT,
  resolved_at       TEXT,
  submitted_at      TEXT,
  processed_at      TEXT NOT NULL,
  updated_at        TEXT,
  -- Expense claims: a receipt is an attached FILE the way a bill has a PDF, but
  -- it is usually an image and Xero needs the mime type to attach it. One
  -- upload can hold several receipts; every split record points at the SAME
  -- stored file and carries the region it owns — a box for a photo, a page
  -- for a PDF. (Older databases gain these through migrate.js.)
  receipt_file      TEXT,
  receipt_mime      TEXT,
  receipt_box       TEXT,     -- JSON [ymin,xmin,ymax,xmax], 0-1000
  receipt_page      INTEGER,  -- 1-based page of a multi-page PDF
  receipt_group     TEXT,     -- ties siblings from one upload together
  received_at       TEXT,     -- when the DOCUMENT reached us, not when we made the row
  receipt_hash      TEXT,     -- SHA-256 of the receipt image
  parsed_at         TEXT,     -- when the automatic read of this receipt ENDED, found something or not
  -- Read from a bill by the model and sent to Xero with the contact and the
  -- reference; they were built on every parse and never stored, so the review
  -- page's Phone and Project rows were always empty and a manual submit sent
  -- a different payload from an automatic one.
  vendor_phone      TEXT,
  project_name      TEXT,
  -- 'Inclusive' or 'Exclusive' (line amounts with or without tax) and the
  -- sales invoice's branding theme, as read from the document. Never stored
  -- before, so every row went to Xero tax-exclusive.
  line_amount_types   TEXT,
  branding_theme_name TEXT,
  -- Xero CurrencyRate for a foreign-currency claim: units of the claim's
  -- currency per one unit of the org's base currency. NULL = Xero's daily rate.
  currency_rate       REAL,
  -- A note from the send in progress (an attachment Xero refused, a total that
  -- came back different). invoice-store.js moves it into error_msg when the
  -- send's closing update would otherwise clear that.
  post_note           TEXT,
  -- The Message-ID of the email a row was read from. A mailbox reconnect or a
  -- mail marked unread delivers the same message again; with this the
  -- attachment is recognised before the model reads it a second time.
  -- Indexed on (user_id, message_id) by migrate.js, after the column is
  -- ensured: an index here would fail on a database that predates it.
  message_id          TEXT,
  -- How sure the reader was of what it read: 'high', 'medium' or 'low'.
  confidence          TEXT,
  -- What Xero says about the document now, read back by xero/status-sync.js.
  -- Nothing else learns that a bill was approved, paid, voided or deleted
  -- there, and a correction cannot be sent once it has left DRAFT. All NULL
  -- until the first check: unknown, not "still a draft".
  xero_status         TEXT,     -- DRAFT | SUBMITTED | AUTHORISED | PAID | VOIDED | DELETED
  xero_amount_due     INTEGER,  -- cents, as Xero reports it
  xero_amount_paid    INTEGER,  -- cents
  xero_paid_on        TEXT,     -- YYYY-MM-DD, Xero's FullyPaidOnDate
  xero_synced_at      TEXT,     -- when Xero last confirmed the four above
  -- An expense claim with no receipt behind it: mileage or a per diem. The
  -- amount is quantity x rate, worked out here and never taken from the
  -- browser, and the rate is the one in Setup when the claim was made, kept so
  -- a later change there does not reprice it. claim_details is JSON of what
  -- was typed (from/to/purpose, or destination/dates/purpose). NULL kind on a
  -- receipt claim and on every bill and invoice.
  claim_kind          TEXT,     -- 'mileage' | 'per_diem' (NULL = receipt)
  claim_quantity      REAL,     -- km, or days in half-day steps
  claim_rate          REAL,     -- per km, or per day, in the claim's currency
  claim_unit          TEXT,     -- 'km' | 'day'
  claim_details       TEXT,
  -- Which fields were filled from the last bill or invoice a person settled
  -- for the same contact (utils/supplier-memory.js), and from which record:
  -- JSON { accountCode: { fromId, fromNumber, fromDate }, currency: ..., xeroTenantId: ... }.
  -- The review page says so beside each one. A field's entry is dropped when
  -- its value is changed (invoice-store update), since it is then a person's
  -- choice and no longer what was remembered. NULL = nothing was prefilled.
  prefilled_from      TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoices_user_id ON invoices(user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status  ON invoices(user_id, status);

-- One posted Xero invoice can't back two local records for the same user. NULLs
-- (every non-posted invoice) are exempt — SQLite treats each NULL as distinct, and
-- the partial WHERE clause makes that explicit rather than incidental.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_user_xero_invoice
  ON invoices(user_id, xero_invoice_id) WHERE xero_invoice_id IS NOT NULL;

-- When each connected company's statuses were last read back in full
-- (xero/status-sync.js). The next read sends it as If-Modified-Since, so Xero
-- answers with only the documents that changed since. Only a read that
-- finished is recorded: one cut short by a limit or an error must not let the
-- next read skip what it never saw.
CREATE TABLE IF NOT EXISTS xero_status_sync (
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id       TEXT NOT NULL,
  last_success_at TEXT NOT NULL,
  PRIMARY KEY (user_id, tenant_id)
);

-- Live updates (xero/change-detector.js): where the last look at each
-- company's journal got to (last_journal_number, the newest budget edit),
-- when it was taken, when a change was last noticed and why, when someone
-- last had a report of the company on screen (which sets how often it is
-- looked at), and whether looking is possible at all (live, live_reason:
-- the journals scope, the connection, the daily allowance).
CREATE TABLE IF NOT EXISTS xero_change_cursor (
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id           TEXT NOT NULL,
  last_journal_number INTEGER,
  last_poll_at        TEXT,
  last_budget_updated TEXT,
  changed_at          TEXT,
  change_reason       TEXT,
  last_viewed_at      TEXT,
  live                INTEGER,
  live_reason         TEXT,
  PRIMARY KEY (user_id, tenant_id)
);

-- 1:many — invoice reports (was invoices[i].reports[])
CREATE TABLE IF NOT EXISTS invoice_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  user_email  TEXT NOT NULL,
  note        TEXT NOT NULL,
  reported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_invoice_id ON invoice_reports(invoice_id);

-- 1:many — invoice line items (was invoices.line_items, a JSON-encoded TEXT blob).
-- Normalised into its own table for the same reason as invoice_reports: the app
-- never queries into individual line items, but keeping them in a real table with
-- a real cents column avoids float drift the same way total_amount/tax_amount do,
-- and sort_order preserves the original array order on read.
CREATE TABLE IF NOT EXISTS invoice_line_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id     TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  sort_order     INTEGER NOT NULL,
  description    TEXT,
  unit_amount    INTEGER NOT NULL DEFAULT 0, -- cents
  discount_rate  REAL -- percent (0-100), not a currency value
);
CREATE INDEX IF NOT EXISTS idx_line_items_invoice_id ON invoice_line_items(invoice_id);

-- 1:many — persisted connected-org list. Tokens themselves are NOT stored here;
-- they stay in-memory in token-cache.js and auto-refresh via client credentials.
-- This table only survives a restart so the UI can show "connected" without
-- forcing a reconnect.
CREATE TABLE IF NOT EXISTS xero_tenants (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id    TEXT NOT NULL,
  tenant_name  TEXT,
  connected_at TEXT NOT NULL,
  PRIMARY KEY (user_id, tenant_id)
);

-- 1:many — a user can add multiple Gemini API keys. gemini-client.js rotates
-- through every model on the first key before moving to the next key, so adding
-- a key is a real way to add quota headroom, not just a backup. api_key is
-- encrypted at rest the same way as other secrets (see utils/crypto.js).
CREATE TABLE IF NOT EXISTS user_gemini_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key    TEXT NOT NULL,
  label      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gemini_keys_user_id ON user_gemini_keys(user_id);

-- ── Audit trail ──────────────────────────────────────────────────────────────
-- What happened to each record and what admins did to accounts
-- (utils/audit-log.js). The exception to the cascade rule at the top of this
-- file, on purpose: no foreign keys at all. A history that vanished with the
-- record or the account it describes could not answer "who deleted this", or
-- "what did that account do before it was removed". Ids and emails are kept
-- as plain text for the same reason. Rows older than two years are pruned at
-- boot, by the index on `at`.

-- One event on one record. user_id is the account that owns the record, which
-- is not always who acted: actor_type says whether it was that owner ('user'),
-- an admin acting on someone else's account ('admin') or background work
-- ('system'). summary is the sentence the review page shows; details the
-- facts behind it as JSON (for an edit, each changed field before and after).
CREATE TABLE IF NOT EXISTS invoice_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  invoice_id  TEXT NOT NULL,
  at          TEXT NOT NULL,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user', 'admin', 'system')),
  actor_id    TEXT,
  actor_email TEXT,
  action      TEXT NOT NULL,
  summary     TEXT NOT NULL,
  details     TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoice_events_record ON invoice_events(user_id, invoice_id, at);
CREATE INDEX IF NOT EXISTS idx_invoice_events_at     ON invoice_events(at);
-- An admin reads a record's history by its id alone, without its owner (who
-- may be deleted); without this that read was a scan of every event.
CREATE INDEX IF NOT EXISTS idx_invoice_events_invoice ON invoice_events(invoice_id);

-- One admin action on an account (or a person changing their own password).
-- No summary column: the sentence is made from action and details when read,
-- so its wording can improve without rewriting history. Never a password.
CREATE TABLE IF NOT EXISTS admin_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             TEXT NOT NULL,
  actor_id       TEXT,
  actor_email    TEXT,
  target_user_id TEXT,
  target_email   TEXT,
  action         TEXT NOT NULL,
  details        TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_events_at     ON admin_events(at);
CREATE INDEX IF NOT EXISTS idx_admin_events_target ON admin_events(target_user_id, at);
