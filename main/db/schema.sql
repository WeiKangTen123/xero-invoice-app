-- Xero Invoice Automation — SQLite schema
-- users is the root table; everything else hangs off it via user_id FK with
-- ON DELETE CASCADE so deleting a user cleans up their credentials, settings,
-- invoices, and reports automatically.

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  password   TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL
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
  nvidia_api_key        TEXT,
  openrouter_api_key    TEXT,
  openrouter_model      TEXT,
  default_account_code  TEXT,
  default_currency      TEXT,
  zero_tax_rate         TEXT,
  -- OAuth2 "Web app" Xero connection — a second, parallel connection method to the
  -- Custom Connection fields above (xero_client_id/secret). xero_connection_type
  -- records which one is actually active ('custom' | 'oauth' | NULL); the OAuth
  -- refresh token is encrypted the same way as the other secrets in this table
  -- (see ENCRYPTED_COLUMNS in utils/users.js).
  xero_connection_type     TEXT,
  xero_oauth_refresh_token TEXT,
  xero_oauth_connected_at  TEXT
);

-- 1:1 with users — app behaviour toggles (was data/users/<id>/settings.json)
CREATE TABLE IF NOT EXISTS user_settings (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  auto_process INTEGER NOT NULL DEFAULT 1
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
  error_msg         TEXT,
  duplicate_of      TEXT REFERENCES invoices(id) ON DELETE SET NULL,
  resolved_by       TEXT,
  resolved_at       TEXT,
  submitted_at      TEXT,
  processed_at      TEXT NOT NULL,
  updated_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoices_user_id ON invoices(user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status  ON invoices(user_id, status);

-- One posted Xero invoice can't back two local records for the same user. NULLs
-- (every non-posted invoice) are exempt — SQLite treats each NULL as distinct, and
-- the partial WHERE clause makes that explicit rather than incidental.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_user_xero_invoice
  ON invoices(user_id, xero_invoice_id) WHERE xero_invoice_id IS NOT NULL;

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
