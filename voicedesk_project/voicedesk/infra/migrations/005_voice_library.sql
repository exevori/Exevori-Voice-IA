-- ============================================================
-- MIGRATION 005 — Voice Library multi-voix flexible
-- Tables : voice_library, services, voice_assignments,
--          agent_profiles, plan_limits
-- ============================================================

CREATE TABLE IF NOT EXISTS voice_library (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_voice_id text UNIQUE NOT NULL,
  provider          text DEFAULT 'elevenlabs',
  name              text NOT NULL,
  display_name      text,
  description_fr    text,
  description_en    text,
  gender            text CHECK (gender IN ('feminine','masculine','neutral')),
  language          text DEFAULT 'fr-CA',
  languages_supported text[] DEFAULT ARRAY['fr-CA','en-CA'],
  category          text DEFAULT 'general',
  style             text,
  accent            text,
  preview_url       text,
  preview_text_fr   text,
  preview_text_en   text,
  default_settings  jsonb DEFAULT '{"stability":0.8,"similarity_boost":0.9,"speed":1.0}',
  tags              text[],
  is_active         boolean DEFAULT true,
  is_premium        boolean DEFAULT false,
  required_plan     text,
  cost_per_1k_chars decimal(10,6) DEFAULT 0.000150,
  added_by          text,
  notes_admin       text,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS services (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid REFERENCES companies(id),
  code              text NOT NULL,
  name_fr           text NOT NULL,
  name_en           text,
  description_fr    text,
  description_en    text,
  icon              text,
  color             text DEFAULT '#3B82F6',
  is_active         boolean DEFAULT true,
  display_order     integer DEFAULT 0,
  scenario_triggers text[],
  business_hours    jsonb DEFAULT '{}',
  transfer_phone    text,
  metadata          jsonb DEFAULT '{}',
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now(),
  UNIQUE(company_id, code)
);

CREATE TABLE IF NOT EXISTS voice_assignments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid REFERENCES companies(id),
  voice_library_id  uuid REFERENCES voice_library(id),
  service_id        uuid REFERENCES services(id),
  scenario          text,
  agent_profile_id  uuid,
  language          text DEFAULT 'fr-CA',
  custom_settings   jsonb,
  custom_name       text,
  is_default        boolean DEFAULT false,
  display_order     integer DEFAULT 0,
  created_at        timestamptz DEFAULT now(),
  UNIQUE(company_id, voice_library_id, service_id, language)
);

CREATE TABLE IF NOT EXISTS agent_profiles (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid REFERENCES companies(id),
  name              text NOT NULL,
  role              text,
  description       text,
  personality       text,
  default_voice_id  uuid REFERENCES voice_library(id),
  default_language  text DEFAULT 'fr-CA',
  system_prompt_fr  text,
  system_prompt_en  text,
  capabilities      text[],
  is_active         boolean DEFAULT true,
  created_at        timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plan_limits (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_name         text UNIQUE NOT NULL,
  plan_label        text,
  max_voices        integer DEFAULT 1,
  max_services      integer DEFAULT 1,
  max_agents        integer DEFAULT 1,
  max_languages     integer DEFAULT 2,
  voice_cloning_enabled boolean DEFAULT false,
  custom_voices_enabled boolean DEFAULT false,
  premium_voices_enabled boolean DEFAULT false,
  multi_voice_per_service boolean DEFAULT false,
  auto_voice_selection boolean DEFAULT false,
  features          jsonb DEFAULT '{}',
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

-- Seed plan_limits
INSERT INTO plan_limits (plan_name, plan_label, max_voices, max_services, max_agents, max_languages,
                         voice_cloning_enabled, custom_voices_enabled, premium_voices_enabled,
                         multi_voice_per_service, auto_voice_selection) VALUES
  ('solo', 'Solo', 1, 1, 1, 2, false, false, false, false, false),
  ('demarrage', 'Démarrage', 1, 2, 1, 2, false, false, false, false, false),
  ('essentiel', 'Essentiel', 2, 4, 1, 2, false, false, true, false, false),
  ('professionnel', 'Professionnel', 4, 8, 2, 2, false, true, true, true, false),
  ('entreprise', 'Entreprise', 99, 99, 5, 4, true, true, true, true, true)
ON CONFLICT (plan_name) DO NOTHING;

-- Seed voice_library (catalogue initial)
INSERT INTO voice_library (external_voice_id, name, display_name, description_fr, description_en,
                            gender, language, languages_supported, category, style, accent,
                            preview_text_fr, preview_text_en, tags, is_active, is_premium) VALUES
  ('ZF6FPAbjXT4488VcRRnw', 'Charlotte', 'Charlotte',
   'Voix féminine professionnelle et chaleureuse',
   'Professional and warm female voice',
   'feminine', 'fr-CA', ARRAY['fr-CA','en-CA','fr-FR','en-US'], 'reception', 'conversational', 'neutral',
   'Bonjour, comment puis-je vous aider aujourd''hui?',
   'Hello, how may I help you today?',
   ARRAY['feminine','professional','warm','bilingual'], true, false),
  ('ErXwobaYiN019PkySvjV', 'Antoine', 'Antoine',
   'Voix masculine québécoise professionnelle',
   'Professional Quebec French male voice',
   'masculine', 'fr-CA', ARRAY['fr-CA','en-CA'], 'reception', 'professional', 'quebec',
   'Bonjour, vous avez bien joint notre entreprise.',
   'Hello, you have reached our company.',
   ARRAY['masculine','quebec','professional'], true, false),
  ('XB0fDUnXU5powFXDhCwa', 'Charlotte FR', 'Charlotte (France)',
   'Voix féminine française professionnelle (accent FR)',
   'Professional French female voice (FR-FR accent)',
   'feminine', 'fr-FR', ARRAY['fr-FR','fr-CA','en-US'], 'reception', 'professional', 'france',
   'Bonjour, comment puis-je vous aider aujourd''hui?',
   'Hello, how may I help you today?',
   ARRAY['feminine','professional','france','bilingual'], true, false),
  ('pFZP5JQG7iQjIQuC4Bku', 'Sophie FR', 'Sophie (France)',
   'Voix féminine française chaleureuse (accent FR)',
   'Warm French female voice (FR-FR accent)',
   'feminine', 'fr-FR', ARRAY['fr-FR','fr-CA'], 'support', 'warm', 'france',
   'Bonjour, c''est un plaisir de vous parler.',
   'Hello, it''s a pleasure to speak with you.',
   ARRAY['feminine','warm','france'], true, false),
  ('IKne3meq5aSn9XLyUdCD', 'Thomas FR', 'Thomas (France)',
   'Voix masculine française professionnelle (accent FR)',
   'Professional French male voice (FR-FR accent)',
   'masculine', 'fr-FR', ARRAY['fr-FR','en-US'], 'reception', 'professional', 'france',
   'Bonjour, vous avez bien rejoint notre service.',
   'Hello, you have reached our service.',
   ARRAY['masculine','professional','france'], true, false),
  ('pNInz6obpgDQGcFmaJgB', 'Adam', 'Adam (multilingue)',
   'Voix masculine multilingue de qualité premium',
   'High-quality multilingual male voice',
   'masculine', 'multi', ARRAY['fr-FR','fr-CA','en-US','en-GB','es-ES','de-DE'], 'general', 'conversational', 'neutral',
   'Bonjour, je peux m''adapter à plusieurs langues.',
   'Hello, I can adapt to multiple languages.',
   ARRAY['masculine','multilingual','premium','neutral'], true, true)
ON CONFLICT (external_voice_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_voice_library_active ON voice_library(is_active);
CREATE INDEX IF NOT EXISTS idx_voice_library_category ON voice_library(category);
CREATE INDEX IF NOT EXISTS idx_services_company ON services(company_id);
CREATE INDEX IF NOT EXISTS idx_voice_assignments_company ON voice_assignments(company_id);
CREATE INDEX IF NOT EXISTS idx_agent_profiles_company ON agent_profiles(company_id);

ALTER TABLE voice_library      ENABLE ROW LEVEL SECURITY;
ALTER TABLE services           ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_assignments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_profiles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_limits        ENABLE ROW LEVEL SECURITY;

CREATE POLICY voice_library_read ON voice_library FOR SELECT USING (is_active = true OR is_super_admin());
CREATE POLICY voice_library_write ON voice_library FOR ALL USING (is_super_admin());
CREATE POLICY company_isolation ON services USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON voice_assignments USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON agent_profiles USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY plan_limits_read ON plan_limits FOR SELECT USING (true);
CREATE POLICY plan_limits_write ON plan_limits FOR ALL USING (is_super_admin());
