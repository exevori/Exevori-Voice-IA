-- Migration 008 — version finale corrigée
-- Colonnes companies déjà existantes — retirées de cette migration

CREATE TABLE IF NOT EXISTS phone_numbers (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number                TEXT NOT NULL UNIQUE,
  company_id                  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  elevenlabs_agent_id         TEXT,
  elevenlabs_phone_number_id  TEXT,
  twilio_phone_sid            TEXT,
  status                      TEXT DEFAULT 'active'
    CHECK (status IN ('active','suspended','released')),
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pn_phone
  ON phone_numbers(phone_number);
CREATE INDEX IF NOT EXISTS idx_pn_company
  ON phone_numbers(company_id);

ALTER TABLE assistant_configs
  ADD COLUMN IF NOT EXISTS elevenlabs_agent_id TEXT;

ALTER TABLE onboarding_progress
  ADD COLUMN IF NOT EXISTS provisioning_status
    TEXT DEFAULT 'idle';
ALTER TABLE onboarding_progress
  ADD COLUMN IF NOT EXISTS provisioning_error TEXT;
ALTER TABLE onboarding_progress
  ADD COLUMN IF NOT EXISTS provisioning_started_at TIMESTAMPTZ;

ALTER TABLE phone_numbers ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename='phone_numbers' AND policyname='tenant_pn'
  ) THEN
    CREATE POLICY "tenant_pn" ON phone_numbers FOR ALL
      USING (
        company_id IN (
          SELECT company_id FROM profiles WHERE user_id = auth.uid()
        )
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename='phone_numbers' AND policyname='svc_pn'
  ) THEN
    CREATE POLICY "svc_pn" ON phone_numbers
      FOR ALL TO service_role
      USING (true) WITH CHECK (true);
  END IF;
END $$;
