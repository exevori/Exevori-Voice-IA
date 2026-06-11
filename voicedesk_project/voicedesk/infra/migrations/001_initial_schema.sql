-- ============================================================
-- MIGRATION 001 — Schema initial SaaS
-- Tables : companies, profiles, invitations, subscriptions,
--          assistant_configs, onboarding_progress, integration_configs,
--          activity_logs, ai_usage_logs
-- ============================================================

-- Helper functions
CREATE OR REPLACE FUNCTION current_company_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT (current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'company_id')::uuid;
$$;

CREATE OR REPLACE FUNCTION is_super_admin()
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT (current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role') = 'super_admin';
$$;

-- 1. companies
CREATE TABLE IF NOT EXISTS companies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  contact_name        text,
  contact_email       text NOT NULL,
  phone               text,
  city                text,
  province            text DEFAULT 'Québec',
  country             text DEFAULT 'CA',
  sector              text,
  size                text,
  website             text,
  assistant_name      text,
  plan                text DEFAULT 'demarrage',
  status              text DEFAULT 'trial' CHECK (status IN
                       ('trial','active','overdue','suspended','suspended_overage','cancelled')),
  preferred_language  text DEFAULT 'fr-CA',
  notes_admin         text,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

-- 2. profiles
CREATE TABLE IF NOT EXISTS profiles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid UNIQUE,
  company_id          uuid REFERENCES companies(id),
  full_name           text,
  email               text NOT NULL,
  phone               text,
  role                text DEFAULT 'company_user' CHECK (role IN
                       ('super_admin','company_admin','company_user')),
  status              text DEFAULT 'active' CHECK (status IN ('active','inactive','pending')),
  preferred_language  text DEFAULT 'fr-CA',
  last_login_at       timestamptz,
  created_at          timestamptz DEFAULT now()
);

-- 3. invitations
CREATE TABLE IF NOT EXISTS invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid REFERENCES companies(id),
  email       text NOT NULL,
  role        text DEFAULT 'company_user',
  token       text UNIQUE NOT NULL,
  status      text DEFAULT 'pending' CHECK (status IN ('pending','accepted','expired','cancelled')),
  sent_by     text,
  expires_at  timestamptz,
  accepted_at timestamptz,
  created_at  timestamptz DEFAULT now()
);

-- 4. subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid REFERENCES companies(id) UNIQUE,
  plan_name                   text NOT NULL,
  plan_label                  text,
  monthly_price               decimal(8,2),
  annual_price                decimal(10,2),
  billing_cycle               text DEFAULT 'monthly',
  payment_status              text DEFAULT 'trial',
  stripe_customer_id          text UNIQUE,
  stripe_subscription_id      text UNIQUE,
  trial_ends_at               timestamptz,
  current_period_start        date,
  current_period_end          date,
  next_payment_date           date,
  last_payment_date           date,
  last_payment_amount         decimal(8,2),
  minutes_included            integer DEFAULT 400,
  minutes_used_current_period decimal(10,2) DEFAULT 0,
  overage_rate_usd            decimal(6,4) DEFAULT 0.30,
  overage_policy              text DEFAULT 'pay_as_you_go' CHECK (overage_policy IN
                               ('pay_as_you_go','block_at_limit')),
  stripe_meter_id             text,
  created_at                  timestamptz DEFAULT now(),
  updated_at                  timestamptz DEFAULT now()
);

-- 5. assistant_configs
CREATE TABLE IF NOT EXISTS assistant_configs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid REFERENCES companies(id) UNIQUE,
  assistant_name           text NOT NULL,
  assistant_gender         text DEFAULT 'feminine',
  assistant_pronoun_fr     text,
  assistant_pronoun_en     text,
  voice_id                 text,
  voice_model              text DEFAULT 'flash_v2_5',
  voice_stability          decimal(3,2) DEFAULT 0.80,
  voice_similarity         decimal(3,2) DEFAULT 0.90,
  voice_speed              decimal(3,2) DEFAULT 1.00,
  tone                     text DEFAULT 'professional',
  language_primary         text DEFAULT 'fr-CA',
  greeting_inbound_fr      text,
  greeting_inbound_en      text,
  greeting_outbound_fr     text,
  voicemail_message_fr     text,
  signature_email_fr       text,
  email_from               text,
  email_auto_send_threshold integer DEFAULT 85,
  twilio_number            text,
  phone_mode               text DEFAULT 'both',
  transfer_phone           text,
  transfer_triggers        text[],
  system_prompt_fr         text,
  system_prompt_en         text,
  created_at               timestamptz DEFAULT now(),
  updated_at               timestamptz DEFAULT now()
);

-- 6. onboarding_progress
CREATE TABLE IF NOT EXISTS onboarding_progress (
  company_id       uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  current_step     integer DEFAULT 1,
  completed_steps  integer[] DEFAULT '{}',
  completed_at     timestamptz,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

-- 7. integration_configs (Gmail, Calendly, Google Calendar, etc.)
CREATE TABLE IF NOT EXISTS integration_configs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid REFERENCES companies(id),
  provider    text NOT NULL,
  status      text DEFAULT 'active',
  config      jsonb DEFAULT '{}',
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  UNIQUE(company_id, provider)
);

-- 8. activity_logs
CREATE TABLE IF NOT EXISTS activity_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid REFERENCES companies(id),
  user_id     uuid,
  action      text NOT NULL,
  entity_type text,
  entity_id   uuid,
  details     jsonb DEFAULT '{}',
  ip_address  text,
  created_at  timestamptz DEFAULT now()
);

-- 9. ai_usage_logs
CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid REFERENCES companies(id),
  task            text,
  provider        text DEFAULT 'deepseek',
  tokens_input    integer DEFAULT 0,
  tokens_output   integer DEFAULT 0,
  cost_usd        decimal(8,4) DEFAULT 0,
  latency_ms      integer,
  metadata        jsonb DEFAULT '{}',
  created_at      timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_profiles_user ON profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_company ON profiles(company_id);
CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token);
CREATE INDEX IF NOT EXISTS idx_subscriptions_company ON subscriptions(company_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_company ON activity_logs(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_company_period ON ai_usage_logs(company_id, created_at);

-- RLS
ALTER TABLE companies            ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles             ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations          ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_configs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_progress  ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_configs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_logs        ENABLE ROW LEVEL SECURITY;

CREATE POLICY company_isolation ON companies USING (id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON profiles USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON invitations USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON subscriptions USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON assistant_configs USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON onboarding_progress USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON integration_configs USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON activity_logs USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON ai_usage_logs USING (company_id = current_company_id() OR is_super_admin());
