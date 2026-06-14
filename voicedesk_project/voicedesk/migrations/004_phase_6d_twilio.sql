-- ═══════════════════════════════════════════════════════════
-- EXEVORI VOICE IA — Migration Phase 6D
-- Twilio config par PME (1 row par company pour V1)
-- ═══════════════════════════════════════════════════════════

DO $$ BEGIN
  CREATE TYPE twilio_config_status AS ENUM ('active', 'error', 'disabled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS twilio_configs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               UUID NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,

  account_sid              TEXT NOT NULL,
  auth_token_encrypted     TEXT NOT NULL,
  auth_token_iv            TEXT NOT NULL,
  auth_token_tag           TEXT NOT NULL,

  phone_number             TEXT NOT NULL,
  phone_number_sid         TEXT,
  forwarding_number        TEXT,

  status                   twilio_config_status NOT NULL DEFAULT 'active',
  last_test_at             TIMESTAMPTZ,
  last_test_ok             BOOLEAN,
  last_test_error          TEXT,
  twilio_account_name      TEXT,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_twilio_configs_company ON twilio_configs(company_id);

ALTER TABLE twilio_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS twilio_configs_isolation ON twilio_configs;
CREATE POLICY twilio_configs_isolation ON twilio_configs
  FOR ALL USING (company_id = current_company_id() OR is_super_admin());

DROP TRIGGER IF EXISTS trg_twilio_configs_updated_at ON twilio_configs;
CREATE TRIGGER trg_twilio_configs_updated_at BEFORE UPDATE ON twilio_configs
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
