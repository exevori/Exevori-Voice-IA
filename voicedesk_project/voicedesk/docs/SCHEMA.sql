-- ============================================================
-- VOICEDESK IA — SCHÉMA BASE DE DONNÉES COMPLET
-- ============================================================
-- À coller dans Supabase SQL Editor en une seule exécution.
-- 19 tables + RLS + indexes + extensions nécessaires.
-- ============================================================

-- ── EXTENSIONS ────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- COUCHE SAAS — Multi-tenant
-- ============================================================

-- 1. companies — Clients d'Exevori
CREATE TABLE companies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  contact_name    text NOT NULL,
  contact_email   text NOT NULL,
  phone           text,
  city            text,
  province        text DEFAULT 'Québec',
  sector          text,
  plan            text DEFAULT 'demarrage',
  status          text DEFAULT 'trial',
  assistant_name  text,
  notes_admin     text,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- 2. profiles — Utilisateurs Supabase Auth liés à une company
CREATE TABLE profiles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id    uuid REFERENCES companies(id),
  full_name     text,
  email         text NOT NULL,
  role          text CHECK (role IN ('super_admin','company_admin','company_user')),
  status        text DEFAULT 'active',
  last_login_at timestamptz,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now(),
  UNIQUE(user_id)
);

-- 3. invitations — Invitations en attente
CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid REFERENCES companies(id),
  email       text NOT NULL,
  role        text DEFAULT 'company_admin',
  token       text UNIQUE NOT NULL,
  status      text DEFAULT 'pending',
  sent_by     text,
  expires_at  timestamptz DEFAULT (now() + interval '7 days'),
  accepted_at timestamptz,
  created_at  timestamptz DEFAULT now()
);

-- 4. subscriptions — Suivi paiements (manuel V0, Stripe V1)
CREATE TABLE subscriptions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid REFERENCES companies(id) UNIQUE,
  plan_name              text NOT NULL,
  plan_label             text,
  monthly_price          decimal(10,2),
  billing_cycle          text DEFAULT 'monthly',
  annual_price           decimal(10,2),
  payment_status         text DEFAULT 'trial' CHECK (payment_status IN
                          ('active_paid','trial','pending_payment','overdue','suspended','cancelled')),
  last_payment_date      date,
  last_payment_amount    decimal(10,2),
  next_payment_date      date,
  days_overdue           integer DEFAULT 0,
  trial_ends_at          timestamptz,
  stripe_customer_id     text,
  stripe_subscription_id text,
  notes                  text,
  created_at             timestamptz DEFAULT now(),
  updated_at             timestamptz DEFAULT now()
);

-- ============================================================
-- CONFIGURATION PAR ENTREPRISE
-- ============================================================

-- 5. assistant_configs — Paramètres de l'assistante par PME
CREATE TABLE assistant_configs (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid REFERENCES companies(id) UNIQUE,
  assistant_name            text NOT NULL,
  assistant_gender          text DEFAULT 'feminine' CHECK (assistant_gender IN ('feminine','masculine','neutral')),
  assistant_pronoun_fr      text DEFAULT 'elle',
  assistant_pronoun_en      text DEFAULT 'she',
  voice_id                  text,
  voice_model               text DEFAULT 'flash_v2_5',
  voice_stability           decimal(3,2) DEFAULT 0.8,
  voice_similarity          decimal(3,2) DEFAULT 0.9,
  voice_speed               decimal(3,2) DEFAULT 1.0,
  tone                      text DEFAULT 'professional',
  language_primary          text DEFAULT 'fr-CA',
  greeting_inbound_fr       text,
  greeting_inbound_en       text,
  greeting_outbound_fr      text,
  voicemail_message_fr      text,
  signature_email_fr        text,
  signature_email_en        text,
  email_from                text,
  email_reply_to            text,
  email_auto_send_threshold integer DEFAULT 85,
  twilio_number             text UNIQUE,
  phone_mode                text DEFAULT 'both' CHECK (phone_mode IN ('inbound_only','outbound_only','both')),
  outbound_caller_id        text,
  transfer_phone            text,
  transfer_triggers         text[] DEFAULT ARRAY['parler à quelqu''un','un humain','speak to someone','manager'],
  system_prompt_fr          text,
  system_prompt_en          text,
  system_prompt_outbound_fr text,
  created_at                timestamptz DEFAULT now(),
  updated_at                timestamptz DEFAULT now()
);

-- 6. onboarding_progress
CREATE TABLE onboarding_progress (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid REFERENCES companies(id) UNIQUE,
  current_step    integer DEFAULT 1,
  completed_steps integer[] DEFAULT '{}',
  phone_mode      text,
  completed_at    timestamptz,
  started_at      timestamptz DEFAULT now()
);

-- ============================================================
-- TABLES MÉTIER — CRM + OPÉRATIONS
-- ============================================================

-- 7. contacts
CREATE TABLE contacts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid REFERENCES companies(id),
  full_name           text NOT NULL,
  first_name          text,
  last_name           text,
  email               text,
  phone               text,
  company             text,
  status              text DEFAULT 'new',
  source              text,
  main_need           text,
  budget              text,
  urgency             text DEFAULT 'normal',
  tags                text[],
  notes               text,
  next_action         text,
  last_interaction_at timestamptz,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

-- 8. contact_notes
CREATE TABLE contact_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid REFERENCES companies(id),
  contact_id  uuid REFERENCES contacts(id) ON DELETE CASCADE,
  call_id     uuid,
  direction   text CHECK (direction IN ('inbound','outbound','email','manual')),
  note        text,
  next_action text,
  created_by  text DEFAULT 'lea_ai',
  created_at  timestamptz DEFAULT now()
);

-- 9. calls — Appels entrants
CREATE TABLE calls (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid REFERENCES companies(id),
  contact_id       uuid REFERENCES contacts(id),
  twilio_call_sid  text,
  caller_phone     text,
  direction        text DEFAULT 'inbound',
  duration_seconds integer DEFAULT 0,
  language_used    text DEFAULT 'fr-CA',
  intent           text,
  ai_summary       text,
  outcome          text,
  next_action      text,
  transcript       text,
  status           text DEFAULT 'completed',
  confidence_score integer,
  created_at       timestamptz DEFAULT now()
);

-- 10. outbound_calls
CREATE TABLE outbound_calls (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid REFERENCES companies(id),
  mission_id          uuid,
  contact_id          uuid REFERENCES contacts(id),
  twilio_call_sid     text,
  contact_name        text,
  contact_phone       text,
  contact_company     text,
  status              text DEFAULT 'to_call' CHECK (status IN
                       ('to_call','calling','in_progress','completed','voicemail','no_answer','failed')),
  duration_seconds    integer DEFAULT 0,
  called_at           timestamptz,
  answered_at         timestamptz,
  ended_at            timestamptz,
  attempt_number      integer DEFAULT 1,
  mission_subject     text,
  opening_script_used text,
  ai_summary          text,
  outcome             text,
  next_action         text,
  next_action_date    timestamptz,
  appointment_booked  boolean DEFAULT false,
  confidence_score    integer,
  language_used       text DEFAULT 'fr-CA',
  transcript          text,
  created_at          timestamptz DEFAULT now()
);

-- 11. missions
CREATE TABLE missions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid REFERENCES companies(id),
  name            text NOT NULL,
  subject         text,
  objective       text,
  source_type     text CHECK (source_type IN ('calendar','crm_filter','csv_import','manual')),
  source_config   jsonb DEFAULT '{}',
  trigger_mode    text DEFAULT 'manual',
  status          text DEFAULT 'active',
  total_contacts  integer DEFAULT 0,
  completed_count integer DEFAULT 0,
  success_count   integer DEFAULT 0,
  script_template text,
  created_at      timestamptz DEFAULT now()
);

-- 12. appointments
CREATE TABLE appointments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid REFERENCES companies(id),
  contact_id           uuid REFERENCES contacts(id),
  calendly_event_id    text,
  calendly_invitee_uri text,
  google_event_id      text,
  date                 date,
  time                 text,
  duration_minutes     integer,
  type                 text,
  channel              text,
  meet_link            text,
  status               text DEFAULT 'confirmed',
  confirmation_sent    boolean DEFAULT false,
  source_direction     text DEFAULT 'inbound',
  source_mission_id    uuid,
  notes                text,
  cancelled_at         timestamptz,
  cancellation_reason  text,
  created_at           timestamptz DEFAULT now()
);

-- 13. emails — Courriels reçus
CREATE TABLE emails (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid REFERENCES companies(id),
  contact_id       uuid REFERENCES contacts(id),
  from_email       text,
  from_name        text,
  subject          text,
  body             text,
  preview          text,
  message_id       text,
  intent           text,
  level            integer DEFAULT 1,
  status           text DEFAULT 'received',
  confidence_score integer,
  received_at      timestamptz,
  responded_at     timestamptz,
  created_at       timestamptz DEFAULT now()
);

-- 14. email_drafts — Brouillons à valider
CREATE TABLE email_drafts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid REFERENCES companies(id),
  contact_id        uuid REFERENCES contacts(id),
  related_email_id  uuid REFERENCES emails(id),
  related_call_id   uuid,
  subject           text,
  body              text,
  final_subject     text,
  final_body        text,
  status            text DEFAULT 'pending_validation',
  confidence_score  integer,
  notes_for_human   text,
  regenerated_count integer DEFAULT 0,
  rejection_reason  text,
  created_by        text DEFAULT 'lea_ai',
  sent_at           timestamptz,
  rejected_at       timestamptz,
  created_at        timestamptz DEFAULT now()
);

-- ============================================================
-- APPRENTISSAGE ET INTÉGRATIONS
-- ============================================================

-- 15. knowledge_base
CREATE TABLE knowledge_base (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid REFERENCES companies(id),
  question             text NOT NULL,
  answer               text NOT NULL,
  category             text DEFAULT 'FAQ',
  status               text DEFAULT 'active',
  source               text DEFAULT 'manual',
  source_suggestion_id uuid,
  approved_by          text,
  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now()
);

-- 16. learning_suggestions
CREATE TABLE learning_suggestions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid REFERENCES companies(id),
  type              text DEFAULT 'frequently_asked',
  question_detected text,
  suggested_answer  text,
  final_question    text,
  final_answer      text,
  source_summary    text,
  detected_from     text,
  occurrences       integer DEFAULT 1,
  source_ids        uuid[],
  confidence_score  integer,
  status            text DEFAULT 'pending',
  knowledge_base_id uuid REFERENCES knowledge_base(id),
  approved_by       text,
  rejected_by       text,
  modified_by       text,
  rejection_reason  text,
  approved_at       timestamptz,
  rejected_at       timestamptz,
  modified_at       timestamptz,
  created_at        timestamptz DEFAULT now()
);

-- 17. integration_configs
CREATE TABLE integration_configs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid REFERENCES companies(id),
  provider     text NOT NULL,
  config       jsonb DEFAULT '{}',
  status       text DEFAULT 'not_connected',
  connected_at timestamptz,
  created_at   timestamptz DEFAULT now(),
  UNIQUE(company_id, provider)
);

-- 18. ai_usage_logs
CREATE TABLE ai_usage_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid,
  task        text,
  provider    text DEFAULT 'deepseek',
  tokens_used integer,
  cost_usd    decimal(10,6),
  latency_ms  integer,
  created_at  timestamptz DEFAULT now()
);

-- 19. activity_logs
CREATE TABLE activity_logs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES companies(id),
  user_id    uuid,
  action     text,
  resource   text,
  details    jsonb,
  ip_address text,
  created_at timestamptz DEFAULT now()
);

-- ============================================================
-- INDEXES POUR LA PERFORMANCE
-- ============================================================

CREATE INDEX idx_profiles_user_id ON profiles(user_id);
CREATE INDEX idx_profiles_company ON profiles(company_id);
CREATE INDEX idx_invitations_token ON invitations(token);
CREATE INDEX idx_subscriptions_company ON subscriptions(company_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(payment_status);

CREATE INDEX idx_assistant_configs_company ON assistant_configs(company_id);
CREATE INDEX idx_assistant_configs_twilio ON assistant_configs(twilio_number);

CREATE INDEX idx_contacts_company ON contacts(company_id);
CREATE INDEX idx_contacts_email ON contacts(email);
CREATE INDEX idx_contacts_phone ON contacts(phone);
CREATE INDEX idx_contacts_status ON contacts(status);

CREATE INDEX idx_contact_notes_company ON contact_notes(company_id);
CREATE INDEX idx_contact_notes_contact ON contact_notes(contact_id);

CREATE INDEX idx_calls_company ON calls(company_id);
CREATE INDEX idx_calls_contact ON calls(contact_id);
CREATE INDEX idx_calls_twilio ON calls(twilio_call_sid);

CREATE INDEX idx_outbound_company ON outbound_calls(company_id);
CREATE INDEX idx_outbound_mission ON outbound_calls(mission_id);
CREATE INDEX idx_outbound_contact ON outbound_calls(contact_id);
CREATE INDEX idx_outbound_status ON outbound_calls(status);

CREATE INDEX idx_missions_company ON missions(company_id);
CREATE INDEX idx_appointments_company_date ON appointments(company_id, date);
CREATE INDEX idx_emails_company ON emails(company_id);
CREATE INDEX idx_emails_contact ON emails(contact_id);
CREATE INDEX idx_email_drafts_company ON email_drafts(company_id);
CREATE INDEX idx_email_drafts_status ON email_drafts(status);

CREATE INDEX idx_kb_company ON knowledge_base(company_id);
CREATE INDEX idx_kb_status ON knowledge_base(status);
CREATE INDEX idx_learning_company ON learning_suggestions(company_id);
CREATE INDEX idx_learning_status ON learning_suggestions(status);

CREATE INDEX idx_integrations_company ON integration_configs(company_id);
CREATE INDEX idx_ai_logs_company_date ON ai_usage_logs(company_id, created_at DESC);
CREATE INDEX idx_activity_company ON activity_logs(company_id, created_at DESC);

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================

-- Activer RLS sur toutes les tables avec company_id
ALTER TABLE companies            ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles             ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations          ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_configs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_progress  ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_notes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls                ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_calls       ENABLE ROW LEVEL SECURITY;
ALTER TABLE missions             ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE emails               ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_drafts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_base       ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_configs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs        ENABLE ROW LEVEL SECURITY;

-- Fonction helper pour récupérer le company_id de l'utilisateur connecté
CREATE OR REPLACE FUNCTION current_company_id() RETURNS uuid AS $$
  SELECT company_id FROM profiles WHERE user_id = auth.uid() LIMIT 1;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION is_super_admin() RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE user_id = auth.uid() AND role = 'super_admin'
  );
$$ LANGUAGE sql STABLE;

-- Policies universelles : company_id = current_company_id() OU super_admin
CREATE POLICY company_isolation ON contacts
  USING (company_id = current_company_id() OR is_super_admin());

CREATE POLICY company_isolation ON contact_notes
  USING (company_id = current_company_id() OR is_super_admin());

CREATE POLICY company_isolation ON calls
  USING (company_id = current_company_id() OR is_super_admin());

CREATE POLICY company_isolation ON outbound_calls
  USING (company_id = current_company_id() OR is_super_admin());

CREATE POLICY company_isolation ON missions
  USING (company_id = current_company_id() OR is_super_admin());

CREATE POLICY company_isolation ON appointments
  USING (company_id = current_company_id() OR is_super_admin());

CREATE POLICY company_isolation ON emails
  USING (company_id = current_company_id() OR is_super_admin());

CREATE POLICY company_isolation ON email_drafts
  USING (company_id = current_company_id() OR is_super_admin());

CREATE POLICY company_isolation ON knowledge_base
  USING (company_id = current_company_id() OR is_super_admin());

CREATE POLICY company_isolation ON learning_suggestions
  USING (company_id = current_company_id() OR is_super_admin());

CREATE POLICY company_isolation ON integration_configs
  USING (company_id = current_company_id() OR is_super_admin());

CREATE POLICY company_isolation ON assistant_configs
  USING (company_id = current_company_id() OR is_super_admin());

CREATE POLICY company_isolation ON onboarding_progress
  USING (company_id = current_company_id() OR is_super_admin());

CREATE POLICY company_isolation ON activity_logs
  USING (company_id = current_company_id() OR is_super_admin());

-- Tables admin-only (companies, profiles, invitations, subscriptions)
CREATE POLICY admin_only_companies ON companies
  USING (is_super_admin() OR id = current_company_id());

CREATE POLICY admin_only_profiles ON profiles
  USING (is_super_admin() OR user_id = auth.uid() OR company_id = current_company_id());

CREATE POLICY admin_only_invitations ON invitations
  USING (is_super_admin() OR company_id = current_company_id());

CREATE POLICY admin_only_subscriptions ON subscriptions
  USING (is_super_admin() OR company_id = current_company_id());

-- ============================================================
-- TRIGGERS
-- ============================================================

-- Updated_at automatique
CREATE OR REPLACE FUNCTION update_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at_companies
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_updated_at_assistant_configs
  BEFORE UPDATE ON assistant_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_updated_at_contacts
  BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_updated_at_subscriptions
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_updated_at_knowledge_base
  BEFORE UPDATE ON knowledge_base
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- FIN DU SCHÉMA
-- ============================================================
-- 19 tables créées
-- Toutes les RLS activées
-- Indexes créés
-- Triggers updated_at en place
--
-- PROCHAINES ÉTAPES :
-- 1. Tester avec : SELECT count(*) FROM companies;
-- 2. Importer les mock data depuis /data/
-- 3. Configurer Supabase Auth (Email Provider)
-- 4. Configurer Resend pour les invitations
-- ============================================================

-- ============================================================
-- AJOUT : STRIPE + USAGE METERING + INVOICING (Phase Billing)
-- ============================================================

-- 20. payment_methods — Cartes Stripe enregistrées
CREATE TABLE payment_methods (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid REFERENCES companies(id),
  stripe_payment_method_id text UNIQUE,
  brand                    text,
  last4                    text,
  exp_month                integer,
  exp_year                 integer,
  is_default               boolean DEFAULT false,
  created_at               timestamptz DEFAULT now()
);

-- 21. usage_records — Tracking minutes/tokens par client (metering)
CREATE TABLE usage_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid REFERENCES companies(id),
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  resource_type   text CHECK (resource_type IN
                   ('voice_minutes','ai_tokens','email_sends','sms_sends')),
  quantity        decimal(12,4) DEFAULT 0,
  unit_cost_usd   decimal(10,6) DEFAULT 0,
  total_cost_usd  decimal(10,2) DEFAULT 0,
  stripe_usage_record_id text,
  reported_to_stripe boolean DEFAULT false,
  created_at      timestamptz DEFAULT now(),
  UNIQUE(company_id, period_start, resource_type)
);

-- 22. invoices — Factures (Stripe + manuelles)
CREATE TABLE invoices (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid REFERENCES companies(id),
  stripe_invoice_id      text UNIQUE,
  invoice_number         text UNIQUE,
  period_start           date,
  period_end             date,
  subtotal_usd           decimal(10,2),
  tax_usd                decimal(10,2) DEFAULT 0,
  total_usd              decimal(10,2),
  base_plan_amount       decimal(10,2),
  overage_amount         decimal(10,2) DEFAULT 0,
  overage_minutes        decimal(10,2) DEFAULT 0,
  credits_applied        decimal(10,2) DEFAULT 0,
  status                 text DEFAULT 'draft' CHECK (status IN
                          ('draft','pending','paid','failed','refunded','void')),
  payment_method         text DEFAULT 'stripe' CHECK (payment_method IN
                          ('stripe','manual_transfer','manual_check','free')),
  paid_at                timestamptz,
  due_date               date,
  invoice_pdf_url        text,
  receipt_url            text,
  notes                  text,
  created_at             timestamptz DEFAULT now()
);

-- 23. credit_grants — Crédits / rabais / gratuités donnés par admin
CREATE TABLE credit_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid REFERENCES companies(id),
  amount_usd    decimal(10,2),
  reason        text,
  type          text CHECK (type IN ('discount','free_month','goodwill','referral','promo','beta_tester')),
  granted_by    text,
  expires_at    timestamptz,
  applied_to_invoice_id uuid REFERENCES invoices(id),
  status        text DEFAULT 'active' CHECK (status IN ('active','used','expired','cancelled')),
  notes         text,
  created_at    timestamptz DEFAULT now()
);

-- 24. stripe_webhook_events — Log des webhooks reçus
CREATE TABLE stripe_webhook_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id text UNIQUE,
  event_type      text,
  payload         jsonb,
  processed       boolean DEFAULT false,
  error           text,
  processed_at    timestamptz,
  created_at      timestamptz DEFAULT now()
);

-- ============================================================
-- AJOUT : SYSTÈME DE TICKETS PRO
-- ============================================================

-- 25. tickets — Tickets de support
CREATE TABLE tickets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid REFERENCES companies(id),
  ticket_number       text UNIQUE,
  subject             text NOT NULL,
  description         text,
  category            text DEFAULT 'general' CHECK (category IN
                       ('general','billing','technical','feature_request','bug','onboarding')),
  priority            text DEFAULT 'normal' CHECK (priority IN
                       ('low','normal','high','urgent')),
  status              text DEFAULT 'open' CHECK (status IN
                       ('open','in_progress','waiting_client','resolved','closed')),
  created_by_user_id  uuid REFERENCES auth.users(id),
  created_by_name     text,
  created_by_email    text,
  assigned_to_user_id uuid REFERENCES auth.users(id),
  assigned_to_name    text,
  tags                text[],
  sla_first_response_due  timestamptz,
  sla_resolution_due      timestamptz,
  first_response_at   timestamptz,
  resolved_at         timestamptz,
  closed_at           timestamptz,
  resolution_summary  text,
  satisfaction_rating integer CHECK (satisfaction_rating BETWEEN 1 AND 5),
  internal_notes      text,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

-- 26. ticket_messages — Conversation dans un ticket
CREATE TABLE ticket_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       uuid REFERENCES tickets(id) ON DELETE CASCADE,
  company_id      uuid REFERENCES companies(id),
  author_user_id  uuid REFERENCES auth.users(id),
  author_name     text,
  author_role     text CHECK (author_role IN ('client','exevori_agent','system')),
  body            text,
  is_internal     boolean DEFAULT false,
  attachments     jsonb DEFAULT '[]',
  created_at      timestamptz DEFAULT now()
);

-- 27. ticket_attachments — Pièces jointes
CREATE TABLE ticket_attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   uuid REFERENCES tickets(id) ON DELETE CASCADE,
  message_id  uuid REFERENCES ticket_messages(id) ON DELETE CASCADE,
  file_name   text,
  file_size   integer,
  file_url    text,
  mime_type   text,
  uploaded_by uuid REFERENCES auth.users(id),
  created_at  timestamptz DEFAULT now()
);

-- ============================================================
-- INDEXES POUR LES NOUVELLES TABLES
-- ============================================================

CREATE INDEX idx_payment_methods_company ON payment_methods(company_id);
CREATE INDEX idx_usage_records_company_period ON usage_records(company_id, period_start);
CREATE INDEX idx_usage_records_resource ON usage_records(resource_type);
CREATE INDEX idx_invoices_company ON invoices(company_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_period ON invoices(period_start);
CREATE INDEX idx_credit_grants_company ON credit_grants(company_id);
CREATE INDEX idx_credit_grants_status ON credit_grants(status);
CREATE INDEX idx_webhook_events_processed ON stripe_webhook_events(processed);

CREATE INDEX idx_tickets_company ON tickets(company_id);
CREATE INDEX idx_tickets_status ON tickets(status);
CREATE INDEX idx_tickets_priority ON tickets(priority);
CREATE INDEX idx_tickets_assigned ON tickets(assigned_to_user_id);
CREATE INDEX idx_tickets_sla_response ON tickets(sla_first_response_due) WHERE first_response_at IS NULL;
CREATE INDEX idx_tickets_sla_resolution ON tickets(sla_resolution_due) WHERE resolved_at IS NULL;
CREATE INDEX idx_ticket_messages_ticket ON ticket_messages(ticket_id);

-- ============================================================
-- RLS POUR LES NOUVELLES TABLES
-- ============================================================

ALTER TABLE payment_methods       ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_records         ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices              ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_grants         ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets               ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_messages       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_attachments    ENABLE ROW LEVEL SECURITY;

CREATE POLICY company_isolation ON payment_methods USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON usage_records USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON invoices USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON credit_grants USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON tickets USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON ticket_messages USING (
  (company_id = current_company_id() AND (NOT is_internal OR is_super_admin()))
  OR is_super_admin()
);
CREATE POLICY company_isolation ON ticket_attachments USING (
  EXISTS (SELECT 1 FROM tickets WHERE tickets.id = ticket_attachments.ticket_id
          AND (tickets.company_id = current_company_id() OR is_super_admin()))
);

-- Stripe webhook events : super_admin only
CREATE POLICY admin_only_webhooks ON stripe_webhook_events USING (is_super_admin());
ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- AJOUT — Champs Stripe + overage_policy sur subscriptions
-- ============================================================

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS overage_policy text DEFAULT 'pay_as_you_go'
    CHECK (overage_policy IN ('pay_as_you_go','block_at_limit')),
  ADD COLUMN IF NOT EXISTS minutes_included integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS minutes_used_current_period decimal(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS overage_rate_usd decimal(6,4) DEFAULT 0.25,
  ADD COLUMN IF NOT EXISTS current_period_start date,
  ADD COLUMN IF NOT EXISTS current_period_end date,
  ADD COLUMN IF NOT EXISTS stripe_meter_id text;

-- ============================================================
-- FIN — Nouvelles tables : 8 ajoutées (total : 27 tables)
-- ============================================================

-- ============================================================
-- AJOUT : ARCHITECTURE MULTI-VOIX FLEXIBLE (Phase Voice Library)
-- ============================================================

-- 28. voice_library — Catalogue maître des voix disponibles
-- Géré par Exevori, partagé entre toutes les entreprises
CREATE TABLE voice_library (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_voice_id text UNIQUE NOT NULL,  -- ID ElevenLabs ou autre provider
  provider          text DEFAULT 'elevenlabs' CHECK (provider IN
                     ('elevenlabs','custom_clone','azure','google','aws_polly')),
  name              text NOT NULL,         -- "Sophie", "Antoine", "Aria", etc.
  display_name      text,                  -- Nom affiché (peut être différent)
  description       text,                  -- "Voix féminine québécoise chaleureuse"
  description_fr    text,
  description_en    text,
  gender            text CHECK (gender IN ('feminine','masculine','neutral')),
  language          text DEFAULT 'fr-CA',  -- Langue principale
  languages_supported text[] DEFAULT ARRAY['fr-CA','en-CA'],
  category          text DEFAULT 'general' CHECK (category IN
                     ('general','reception','support','sales','medical','formal','casual')),
  style             text,                  -- "conversational", "professional", "energetic"
  age_range         text,                  -- "young", "middle", "mature"
  accent            text,                  -- "quebec", "france", "american", "british"
  preview_url       text,                  -- URL audio de preview
  preview_text_fr   text,                  -- Texte utilisé pour le preview FR
  preview_text_en   text,
  default_settings  jsonb DEFAULT '{"stability":0.8,"similarity_boost":0.9,"style":0,"use_speaker_boost":true,"speed":1.0}',
  tags              text[],                -- ["feminine","quebec","warm","professional"]
  is_active         boolean DEFAULT true,
  is_premium        boolean DEFAULT false, -- Réservé à certains forfaits
  required_plan     text,                  -- min plan required (null = all plans)
  cost_per_1k_chars decimal(10,6) DEFAULT 0.000150,  -- Pour tracking coût
  added_by          text,                  -- Admin qui a ajouté
  notes_admin       text,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

-- 29. services — Services configurables par entreprise
-- Liste extensible : réception, RDV, support, facturation, etc.
CREATE TABLE services (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid REFERENCES companies(id),
  code              text NOT NULL,         -- "reception", "appointments", "support", "billing"
  name_fr           text NOT NULL,         -- "Réception"
  name_en           text,                  -- "Reception"
  description_fr    text,
  description_en    text,
  icon              text,                  -- Lucide icon name
  color             text DEFAULT '#3B82F6',
  is_active         boolean DEFAULT true,
  display_order     integer DEFAULT 0,
  scenario_triggers text[],                -- Mots-clés pour router automatique
  business_hours    jsonb DEFAULT '{}',    -- Horaires spécifiques (override company)
  transfer_phone    text,                  -- Téléphone d'escalade pour CE service
  metadata          jsonb DEFAULT '{}',
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now(),
  UNIQUE(company_id, code)
);

-- 30. voice_assignments — Quelle voix pour quel service / scénario
-- Architecture flexible : pas de limite en dur, géré par le forfait
CREATE TABLE voice_assignments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid REFERENCES companies(id),
  voice_library_id  uuid REFERENCES voice_library(id),
  service_id        uuid REFERENCES services(id),
  scenario          text,                  -- Optionnel : scénario spécifique
  agent_profile_id  uuid,                  -- Pour les futurs agents IA
  language          text DEFAULT 'fr-CA',  -- fr-CA ou en-CA
  custom_settings   jsonb,                 -- Override des default_settings
  custom_name       text,                  -- L'entreprise peut renommer (ex: "Sophie" devient "Léa")
  is_default        boolean DEFAULT false,
  display_order     integer DEFAULT 0,
  created_at        timestamptz DEFAULT now(),
  -- Une voix peut être assignée à plusieurs services, et un service peut avoir plusieurs voix
  UNIQUE(company_id, voice_library_id, service_id, language)
);

-- 31. agent_profiles — Pour les futurs agents IA Exevori (Phase 3)
-- Préparation architecture extensible
CREATE TABLE agent_profiles (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid REFERENCES companies(id),
  name              text NOT NULL,         -- "Léa", "Antonella", "Sales Agent"
  role              text,                  -- "receptionist", "sales", "support"
  description       text,
  personality       text,
  default_voice_id  uuid REFERENCES voice_library(id),
  default_language  text DEFAULT 'fr-CA',
  system_prompt_fr  text,
  system_prompt_en  text,
  capabilities      text[],                -- ["appointments","quotes","faqs"]
  is_active         boolean DEFAULT true,
  created_at        timestamptz DEFAULT now()
);

-- 32. plan_limits — Limites par forfait (configurables, pas hard-codées)
-- Permet à Exevori d'ajuster les limites sans toucher au code
CREATE TABLE plan_limits (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_name         text UNIQUE NOT NULL,
  plan_label        text,
  max_voices        integer DEFAULT 1,           -- Combien de voix différentes
  max_services      integer DEFAULT 1,
  max_agents        integer DEFAULT 1,
  max_languages     integer DEFAULT 2,           -- FR + EN inclus
  voice_cloning_enabled boolean DEFAULT false,
  custom_voices_enabled boolean DEFAULT false,
  premium_voices_enabled boolean DEFAULT false,
  multi_voice_per_service boolean DEFAULT false,
  auto_voice_selection boolean DEFAULT false,
  features          jsonb DEFAULT '{}',
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

-- Pré-remplir les limites par défaut pour chaque forfait
INSERT INTO plan_limits (plan_name, plan_label, max_voices, max_services, max_agents, max_languages,
                         voice_cloning_enabled, custom_voices_enabled, premium_voices_enabled,
                         multi_voice_per_service, auto_voice_selection)
VALUES
  ('solo',          'Solo',          1, 1, 1, 2, false, false, false, false, false),
  ('demarrage',     'Démarrage',     1, 2, 1, 2, false, false, false, false, false),
  ('essentiel',     'Essentiel',     2, 4, 1, 2, false, false, true,  false, false),
  ('professionnel', 'Professionnel', 4, 8, 2, 2, false, true,  true,  true,  false),
  ('entreprise',    'Entreprise',    99, 99, 5, 4, true, true, true, true, true);

-- ============================================================
-- INDEXES POUR LES NOUVELLES TABLES
-- ============================================================

CREATE INDEX idx_voice_library_active ON voice_library(is_active);
CREATE INDEX idx_voice_library_category ON voice_library(category);
CREATE INDEX idx_voice_library_language ON voice_library(language);
CREATE INDEX idx_services_company ON services(company_id);
CREATE INDEX idx_services_active ON services(company_id, is_active);
CREATE INDEX idx_voice_assignments_company ON voice_assignments(company_id);
CREATE INDEX idx_voice_assignments_service ON voice_assignments(service_id);
CREATE INDEX idx_agent_profiles_company ON agent_profiles(company_id);

-- ============================================================
-- RLS POUR LES NOUVELLES TABLES
-- ============================================================

-- voice_library = public en lecture pour tous les users authentifiés
ALTER TABLE voice_library ENABLE ROW LEVEL SECURITY;
CREATE POLICY voice_library_read ON voice_library FOR SELECT
  USING (is_active = true OR is_super_admin());
CREATE POLICY voice_library_write ON voice_library FOR ALL
  USING (is_super_admin());

-- services, voice_assignments, agent_profiles = isolation par company
ALTER TABLE services           ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_assignments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_profiles     ENABLE ROW LEVEL SECURITY;

CREATE POLICY company_isolation ON services USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON voice_assignments USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON agent_profiles USING (company_id = current_company_id() OR is_super_admin());

-- plan_limits = lecture publique pour users authentifiés
ALTER TABLE plan_limits ENABLE ROW LEVEL SECURITY;
CREATE POLICY plan_limits_read ON plan_limits FOR SELECT USING (true);
CREATE POLICY plan_limits_write ON plan_limits FOR ALL USING (is_super_admin());

-- ============================================================
-- AJOUT DE COLONNES — companies + users i18n
-- ============================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS preferred_language text DEFAULT 'fr-CA' CHECK (preferred_language IN ('fr-CA','en-CA'));

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS preferred_language text DEFAULT 'fr-CA' CHECK (preferred_language IN ('fr-CA','en-CA'));

-- ============================================================
-- SEED — Catalogue initial de voix ElevenLabs
-- ============================================================

INSERT INTO voice_library (external_voice_id, name, display_name, description_fr, description_en,
                            gender, language, languages_supported, category, style, accent,
                            preview_text_fr, preview_text_en, tags, is_active, is_premium)
VALUES
  ('ZF6FPAbjXT4488VcRRnw', 'Charlotte', 'Charlotte',
   'Voix féminine professionnelle et chaleureuse',
   'Professional and warm female voice',
   'feminine', 'fr-CA', ARRAY['fr-CA','en-CA','fr-FR','en-US'], 'reception', 'conversational', 'neutral',
   'Bonjour, comment puis-je vous aider aujourd''hui?',
   'Hello, how may I help you today?',
   ARRAY['feminine','professional','warm','bilingual'], true, false),

  ('EXAVITQu4vr4xnSDxMaL', 'Sarah', 'Sarah',
   'Voix féminine claire et énergique',
   'Clear and energetic female voice',
   'feminine', 'en-CA', ARRAY['en-US','en-CA','fr-CA'], 'sales', 'energetic', 'american',
   'Bonjour! Je suis ravie de vous parler aujourd''hui.',
   'Hi! I''m delighted to speak with you today.',
   ARRAY['feminine','energetic','sales','bilingual'], true, false),

  ('TX3LPaxmHKxFdv7VOQHJ', 'Liam', 'Liam',
   'Voix masculine moderne et amicale',
   'Modern and friendly male voice',
   'masculine', 'en-CA', ARRAY['en-US','en-CA','fr-CA'], 'general', 'conversational', 'american',
   'Bonjour, c''est un plaisir de vous parler.',
   'Hello, it''s a pleasure speaking with you.',
   ARRAY['masculine','friendly','modern','bilingual'], true, false),

  ('ErXwobaYiN019PkySvjV', 'Antoine', 'Antoine',
   'Voix masculine québécoise professionnelle',
   'Professional Quebec French male voice',
   'masculine', 'fr-CA', ARRAY['fr-CA','en-CA'], 'reception', 'professional', 'quebec',
   'Bonjour, vous avez bien joint notre entreprise.',
   'Hello, you''ve reached our company.',
   ARRAY['masculine','quebec','professional'], true, false),

  ('21m00Tcm4TlvDq8ikWAM', 'Rachel', 'Rachel',
   'Voix féminine calme idéale pour clinique/médical',
   'Calm female voice ideal for clinic/medical',
   'feminine', 'en-CA', ARRAY['en-US','en-CA'], 'medical', 'calm', 'american',
   'Bonjour, ici la réception, comment puis-je vous aider?',
   'Hello, this is reception, how may I help you?',
   ARRAY['feminine','calm','medical','professional'], true, false),

  ('jBpfuIE2acCO8z3wKNLl', 'Gabriella', 'Gabriella',
   'Voix féminine sophistiquée pour services premium',
   'Sophisticated female voice for premium services',
   'feminine', 'en-CA', ARRAY['en-US','en-CA','it-IT'], 'sales', 'formal', 'sophisticated',
   'Merci d''avoir choisi nos services.',
   'Thank you for choosing our services.',
   ARRAY['feminine','sophisticated','premium','formal'], true, true);

-- ============================================================
-- SEED — Services par défaut (créés à l'onboarding pour chaque PME)
-- ============================================================
-- Ces lignes seront copiées dans services lors de la création d'une company
-- via le module onboarding. Pas d'INSERT direct ici car company_id nécessaire.

-- ============================================================
-- FIN — 5 nouvelles tables ajoutées (total : 32 tables)
-- ============================================================

-- ============================================================
-- AJUSTEMENT : Support multi-accent français
-- ============================================================
-- Permet de choisir entre voix FR-CA (Québec) ou FR-FR (France)
-- selon disponibilité ElevenLabs et préférence du client

-- Étendre la contrainte language sur companies et profiles
ALTER TABLE companies
  DROP CONSTRAINT IF EXISTS companies_preferred_language_check;
ALTER TABLE companies
  ADD CONSTRAINT companies_preferred_language_check
  CHECK (preferred_language IN ('fr-CA','fr-FR','en-CA','en-US'));

ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_preferred_language_check;
ALTER TABLE profiles
  ADD CONSTRAINT profiles_preferred_language_check
  CHECK (preferred_language IN ('fr-CA','fr-FR','en-CA','en-US'));

-- Note : voice_library.language et voice_library.languages_supported
-- supportent déjà n'importe quel code BCP-47 (fr-CA, fr-FR, en-CA, etc.)
-- Aucune modification nécessaire à ces colonnes.

-- Ajout de voix FR-FR au catalogue
INSERT INTO voice_library (external_voice_id, name, display_name, description_fr, description_en,
                            gender, language, languages_supported, category, style, accent,
                            preview_text_fr, preview_text_en, tags, is_active, is_premium)
VALUES
  -- ── Voix FR-FR ──────────────────────────────────────────────
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
   'Hello, you''ve reached our service.',
   ARRAY['masculine','professional','france'], true, false),

  -- ── Voix multilingue (utilisable en FR-FR et FR-CA) ────────
  ('pNInz6obpgDQGcFmaJgB', 'Adam', 'Adam (multilingue)',
   'Voix masculine multilingue de qualité premium',
   'High-quality multilingual male voice',
   'masculine', 'multi', ARRAY['fr-FR','fr-CA','en-US','en-GB','es-ES','de-DE'], 'general', 'conversational', 'neutral',
   'Bonjour, je peux m''adapter à plusieurs langues.',
   'Hello, I can adapt to multiple languages.',
   ARRAY['masculine','multilingual','premium','neutral'], true, true);

-- ============================================================
-- FIN AJUSTEMENT FR-CA / FR-FR
-- ============================================================

-- ============================================================
-- AJOUT : SYSTÈME DE NOTIFICATIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  company_id uuid REFERENCES companies(id),
  type       text DEFAULT 'info' CHECK (type IN ('info','success','warning','error')),
  category   text CHECK (category IN ('ticket','billing','draft','learning','system','mention')),
  title      text NOT NULL,
  body       text,
  link       text,
  read       boolean DEFAULT false,
  read_at    timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id         uuid PRIMARY KEY,
  ticket_email    boolean DEFAULT true,
  billing_email   boolean DEFAULT true,
  draft_email     boolean DEFAULT false,
  learning_email  boolean DEFAULT false,
  system_email    boolean DEFAULT true,
  updated_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, read) WHERE read = false;
CREATE INDEX IF NOT EXISTS idx_notifications_category ON notifications(category);

ALTER TABLE notifications             ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences  ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_owns_notifications ON notifications USING (
  user_id = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid
  OR is_super_admin()
);

CREATE POLICY user_owns_preferences ON notification_preferences USING (
  user_id = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid
  OR is_super_admin()
);

-- TOTAL : 34 tables Supabase

-- ============================================================
-- AJOUT MIGRATION 007 : MULTI-DEVISE
-- Voir infra/migrations/007_multi_currency.sql pour le détail
-- ============================================================
-- companies      : + billing_country, billing_currency (CAD|USD|EUR)
-- subscriptions  : + currency, installation_fee_applicable (CA only),
--                    installation_fee_paid, installation_fee_amount
-- invoices       : + currency, tax_tps, tax_tvq, billing_country
-- plan_pricing   : nouvelle table (prix : 79/159/319/529/949)
--
-- RÈGLES :
--   CA      → CAD + TPS 5% + TVQ 9,975% + installation 319$
--   US      → USD, sans taxe, sans installation
--   EU (27) → EUR, sans taxe, sans installation
--   Monde   → USD, sans taxe, sans installation
-- TOTAL : 35 tables Supabase
