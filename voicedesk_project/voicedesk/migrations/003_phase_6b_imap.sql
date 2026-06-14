-- ═══════════════════════════════════════════════════════════
-- EXEVORI VOICE IA — Migration Phase 6B
-- Email multi-comptes IMAP/SMTP (sans OAuth, voir Phase 11)
--
-- Préreq : extension pgcrypto pour gen_random_uuid() — déjà active
-- Idempotent (IF NOT EXISTS partout)
-- Validation : Karim, 14/06/2026
-- ═══════════════════════════════════════════════════════════

-- ── ENUMS ──────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE email_provider AS ENUM ('imap', 'zoho', 'gmail', 'outlook', 'custom');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE email_account_status AS ENUM ('active', 'error', 'disconnected', 'disabled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE email_persona_tone AS ENUM ('formal', 'friendly', 'direct');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE email_account_mode AS ENUM ('auto', 'draft_only', 'forward_only', 'disabled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── TABLE email_accounts ───────────────────────────────────
CREATE TABLE IF NOT EXISTS email_accounts (
  id                    UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider              email_provider  NOT NULL DEFAULT 'imap',
  email                 TEXT            NOT NULL,
  display_name          TEXT,
  status                email_account_status NOT NULL DEFAULT 'active',
  is_primary            BOOLEAN         NOT NULL DEFAULT FALSE,

  -- Persona inline (option d validée par Karim)
  signature             TEXT,
  tone                  email_persona_tone NOT NULL DEFAULT 'friendly',
  auto_reply_threshold  REAL            NOT NULL DEFAULT 0.85
                           CHECK (auto_reply_threshold >= 0 AND auto_reply_threshold <= 1),
  mode                  email_account_mode NOT NULL DEFAULT 'draft_only',
  kb_filter             JSONB           NOT NULL DEFAULT '{}'::jsonb,

  last_sync_at          TIMESTAMPTZ,
  sync_error            TEXT,
  created_at            TIMESTAMPTZ     NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ     NOT NULL DEFAULT now(),

  CONSTRAINT email_accounts_company_email_unique UNIQUE (company_id, email)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_email_accounts_primary_per_company
  ON email_accounts(company_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS idx_email_accounts_company ON email_accounts(company_id);
CREATE INDEX IF NOT EXISTS idx_email_accounts_status  ON email_accounts(company_id, status);

-- ── TABLE imap_configs (credentials chiffrés AES-256-GCM) ──
CREATE TABLE IF NOT EXISTS imap_configs (
  id                    UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  email_account_id      UUID            NOT NULL UNIQUE REFERENCES email_accounts(id) ON DELETE CASCADE,
  company_id            UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  imap_host             TEXT            NOT NULL,
  imap_port             INTEGER         NOT NULL DEFAULT 993,
  imap_use_tls          BOOLEAN         NOT NULL DEFAULT TRUE,
  smtp_host             TEXT            NOT NULL,
  smtp_port             INTEGER         NOT NULL DEFAULT 465,
  smtp_use_tls          BOOLEAN         NOT NULL DEFAULT TRUE,
  username              TEXT            NOT NULL,
  password_encrypted    TEXT            NOT NULL,
  password_iv           TEXT            NOT NULL,
  password_tag          TEXT            NOT NULL,

  last_test_at          TIMESTAMPTZ,
  last_test_ok          BOOLEAN,
  last_test_error       TEXT,
  created_at            TIMESTAMPTZ     NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_imap_configs_company ON imap_configs(company_id);

-- ── Extension table emails ─────────────────────────────────
ALTER TABLE emails ADD COLUMN IF NOT EXISTS email_account_id UUID
  REFERENCES email_accounts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_emails_account ON emails(email_account_id);

-- ── RLS policies ───────────────────────────────────────────
ALTER TABLE email_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE imap_configs   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_accounts_isolation ON email_accounts;
CREATE POLICY email_accounts_isolation ON email_accounts
  FOR ALL USING (company_id = current_company_id() OR is_super_admin());

DROP POLICY IF EXISTS imap_configs_isolation ON imap_configs;
CREATE POLICY imap_configs_isolation ON imap_configs
  FOR ALL USING (company_id = current_company_id() OR is_super_admin());

-- ── Triggers updated_at ────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_email_accounts_updated_at ON email_accounts;
CREATE TRIGGER trg_email_accounts_updated_at BEFORE UPDATE ON email_accounts
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

DROP TRIGGER IF EXISTS trg_imap_configs_updated_at ON imap_configs;
CREATE TRIGGER trg_imap_configs_updated_at BEFORE UPDATE ON imap_configs
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- ── Vérifications post-migration ──────────────────────────
-- SELECT count(*) FROM information_schema.tables
--   WHERE table_name IN ('email_accounts', 'imap_configs');     -- attendu: 2
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'emails' AND column_name = 'email_account_id';  -- attendu: 1 row
