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
  gemini_api_key        TEXT,
  nvidia_api_key        TEXT,
  openrouter_api_key    TEXT,
  openrouter_model      TEXT,
  default_account_code  TEXT,
  default_currency      TEXT,
  zero_tax_rate         TEXT
);

-- 1:1 with users — app behaviour toggles (was data/users/<id>/settings.json)
CREATE TABLE IF NOT EXISTS user_settings (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  auto_process INTEGER NOT NULL DEFAULT 1
);

-- 1:many — invoice records (was data/users/<id>/invoices.json array)
CREATE TABLE IF NOT EXISTS invoices (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status            TEXT NOT NULL,
  has_pdf           INTEGER NOT NULL DEFAULT 0,
  pdf_filename      TEXT,
  vendor_name       TEXT,
  contact_name      TEXT,
  contact_email     TEXT,
  contact_address   TEXT,
  invoice_number    TEXT,
  invoice_date      TEXT,
  due_date          TEXT,
  total_amount      REAL DEFAULT 0,
  currency          TEXT,
  invoice_type      TEXT,
  source            TEXT,
  source_email      TEXT,
  line_items        TEXT,
  description       TEXT,
  account_code      TEXT,
  tax_amount        REAL DEFAULT 0,
  sub_total         REAL DEFAULT 0,
  payment_reference TEXT,
  xero_invoice_id   TEXT,
  error_msg         TEXT,
  duplicate_of      TEXT,
  resolved_by       TEXT,
  resolved_at       TEXT,
  submitted_at      TEXT,
  processed_at      TEXT NOT NULL,
  updated_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoices_user_id ON invoices(user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status  ON invoices(user_id, status);

-- 1:many — invoice reports (was invoices[i].reports[])
CREATE TABLE IF NOT EXISTS invoice_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  user_email  TEXT NOT NULL,
  note        TEXT NOT NULL,
  reported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_invoice_id ON invoice_reports(invoice_id);

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
