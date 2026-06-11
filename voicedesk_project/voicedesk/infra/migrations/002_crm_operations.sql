-- ============================================================
-- MIGRATION 002 — CRM & Operations
-- Tables : contacts, contact_notes, calls, outbound_calls,
--          missions, emails, email_drafts, appointments,
--          knowledge_base, learning_suggestions
-- ============================================================

-- contacts
CREATE TABLE IF NOT EXISTS contacts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid REFERENCES companies(id),
  full_name            text NOT NULL,
  first_name           text,
  last_name            text,
  email                text,
  phone                text,
  company              text,
  status               text DEFAULT 'new',
  source               text DEFAULT 'manual',
  main_need            text,
  budget               text,
  urgency              text DEFAULT 'normal' CHECK (urgency IN ('low','normal','high')),
  tags                 text[],
  notes                text,
  next_action          text,
  last_interaction_at  timestamptz,
  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contact_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid REFERENCES companies(id),
  contact_id  uuid REFERENCES contacts(id) ON DELETE CASCADE,
  direction   text,
  note        text NOT NULL,
  next_action text,
  created_by  text,
  created_at  timestamptz DEFAULT now()
);

-- calls (inbound)
CREATE TABLE IF NOT EXISTS calls (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid REFERENCES companies(id),
  contact_id          uuid REFERENCES contacts(id),
  twilio_call_sid     text UNIQUE,
  caller_phone        text,
  caller_name         text,
  duration_seconds    integer DEFAULT 0,
  status              text DEFAULT 'in_progress',
  intent              text,
  outcome             text,
  language_used       text DEFAULT 'fr-CA',
  ai_summary          text,
  ai_transcript       jsonb,
  confidence_score    integer,
  cost_usd            decimal(8,4),
  ended_at            timestamptz,
  created_at          timestamptz DEFAULT now()
);

-- outbound_calls
CREATE TABLE IF NOT EXISTS outbound_calls (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid REFERENCES companies(id),
  contact_id          uuid REFERENCES contacts(id),
  mission_id          uuid,
  twilio_call_sid     text UNIQUE,
  contact_name        text,
  contact_phone       text,
  status              text DEFAULT 'queued',
  duration_seconds    integer DEFAULT 0,
  outcome             text,
  appointment_booked  boolean DEFAULT false,
  answered_by         text,
  ai_summary          text,
  ai_transcript       jsonb,
  cost_usd            decimal(8,4),
  ended_at            timestamptz,
  created_at          timestamptz DEFAULT now()
);

-- missions (outbound campaigns)
CREATE TABLE IF NOT EXISTS missions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid REFERENCES companies(id),
  name            text NOT NULL,
  objective       text,
  source          text CHECK (source IN ('calendar','crm_filter','csv_import','manual')),
  script_template text,
  status          text DEFAULT 'draft',
  total_contacts  integer DEFAULT 0,
  completed       integer DEFAULT 0,
  successful      integer DEFAULT 0,
  created_at      timestamptz DEFAULT now()
);

-- emails
CREATE TABLE IF NOT EXISTS emails (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid REFERENCES companies(id),
  contact_id      uuid REFERENCES contacts(id),
  gmail_message_id text UNIQUE,
  from_email      text NOT NULL,
  from_name       text,
  subject         text,
  body            text,
  received_at     timestamptz,
  status          text DEFAULT 'received',
  classification  text,
  confidence      integer,
  level           integer DEFAULT 1,
  ai_summary      text,
  created_at      timestamptz DEFAULT now()
);

-- email_drafts
CREATE TABLE IF NOT EXISTS email_drafts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid REFERENCES companies(id),
  email_id        uuid REFERENCES emails(id),
  to_email        text NOT NULL,
  subject         text,
  body            text,
  status          text DEFAULT 'pending_validation' CHECK (status IN
                   ('pending_validation','sent','approved','rejected','editing')),
  ai_confidence   integer,
  ai_reasoning    text,
  sent_at         timestamptz,
  approved_by     text,
  created_at      timestamptz DEFAULT now()
);

-- appointments
CREATE TABLE IF NOT EXISTS appointments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid REFERENCES companies(id),
  contact_id      uuid REFERENCES contacts(id),
  external_id     text,
  source          text DEFAULT 'manual',
  date            date NOT NULL,
  time            time,
  duration_min    integer DEFAULT 30,
  type            text,
  status          text DEFAULT 'confirmed',
  channel         text,
  notes           text,
  created_at      timestamptz DEFAULT now()
);

-- knowledge_base
CREATE TABLE IF NOT EXISTS knowledge_base (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid REFERENCES companies(id),
  question    text NOT NULL,
  answer      text NOT NULL,
  category    text DEFAULT 'FAQ',
  status      text DEFAULT 'active' CHECK (status IN ('active','archived','draft')),
  source      text DEFAULT 'manual',
  approved_by text,
  usage_count integer DEFAULT 0,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- learning_suggestions
CREATE TABLE IF NOT EXISTS learning_suggestions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid REFERENCES companies(id),
  type            text,
  question        text,
  proposed_answer text,
  source          text,
  occurrences     integer DEFAULT 1,
  confidence      integer,
  status          text DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','modified')),
  detected_at     timestamptz DEFAULT now(),
  reviewed_at     timestamptz,
  reviewed_by     text
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(company_id, phone);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(company_id, email);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(company_id, status);
CREATE INDEX IF NOT EXISTS idx_calls_company ON calls(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_contact ON calls(contact_id);
CREATE INDEX IF NOT EXISTS idx_outbound_company ON outbound_calls(company_id);
CREATE INDEX IF NOT EXISTS idx_outbound_mission ON outbound_calls(mission_id);
CREATE INDEX IF NOT EXISTS idx_emails_company ON emails(company_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON email_drafts(company_id, status);
CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(company_id, date);
CREATE INDEX IF NOT EXISTS idx_kb_company ON knowledge_base(company_id, status);
CREATE INDEX IF NOT EXISTS idx_suggestions_status ON learning_suggestions(company_id, status);

-- RLS
ALTER TABLE contacts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_notes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls                ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_calls       ENABLE ROW LEVEL SECURITY;
ALTER TABLE missions             ENABLE ROW LEVEL SECURITY;
ALTER TABLE emails               ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_drafts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_base       ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_suggestions ENABLE ROW LEVEL SECURITY;

CREATE POLICY company_isolation ON contacts USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON contact_notes USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON calls USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON outbound_calls USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON missions USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON emails USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON email_drafts USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON appointments USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON knowledge_base USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON learning_suggestions USING (company_id = current_company_id() OR is_super_admin());
