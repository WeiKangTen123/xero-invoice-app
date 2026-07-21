require('dotenv').config();
const pool = require('./pool');
const logger = require('../utils/logger');

const schema = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS xero_tenants (
  id              SERIAL PRIMARY KEY,
  user_id         VARCHAR(255) NOT NULL,
  tenant_id       UUID NOT NULL UNIQUE,
  tenant_name     VARCHAR(255) NOT NULL,
  access_token    TEXT NOT NULL,
  refresh_token   TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  id_token        TEXT,
  scopes          TEXT,
  connected_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenants_user_id ON xero_tenants(user_id);
CREATE INDEX IF NOT EXISTS idx_tenants_tenant_id ON xero_tenants(tenant_id);

CREATE TABLE IF NOT EXISTS invoice_log (
  id              SERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  xero_invoice_id UUID,
  invoice_number  VARCHAR(100),
  vendor_name     VARCHAR(255),
  total_amount    NUMERIC(12,2),
  currency        VARCHAR(10) DEFAULT 'SGD',
  source_email    TEXT,
  status          VARCHAR(50) DEFAULT 'created',
  error_message   TEXT,
  raw_email_subject TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_log_tenant ON invoice_log(tenant_id);

CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id              SERIAL PRIMARY KEY,
  raw_email       TEXT,
  error_message   TEXT,
  attempts        INT DEFAULT 1,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  last_attempted  TIMESTAMPTZ DEFAULT NOW()
);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(schema);
    logger.info('Database migration complete');
  } catch (err) {
    logger.error('Migration failed', { error: err.message });
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(() => process.exit(1));
