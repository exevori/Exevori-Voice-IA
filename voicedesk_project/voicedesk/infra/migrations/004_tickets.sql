-- ============================================================
-- MIGRATION 004 — Support Tickets
-- Tables : tickets, ticket_messages, ticket_attachments
-- ============================================================

CREATE TABLE IF NOT EXISTS tickets (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid REFERENCES companies(id),
  ticket_number           text UNIQUE,
  subject                 text NOT NULL,
  description             text,
  category                text DEFAULT 'general' CHECK (category IN
                           ('general','billing','technical','feature_request','bug','onboarding')),
  priority                text DEFAULT 'normal' CHECK (priority IN
                           ('low','normal','high','urgent')),
  status                  text DEFAULT 'open' CHECK (status IN
                           ('open','in_progress','waiting_client','resolved','closed')),
  created_by_user_id      uuid,
  created_by_name         text,
  created_by_email        text,
  assigned_to_user_id     uuid,
  assigned_to_name        text,
  tags                    text[],
  sla_first_response_due  timestamptz,
  sla_resolution_due      timestamptz,
  first_response_at       timestamptz,
  resolved_at             timestamptz,
  closed_at               timestamptz,
  resolution_summary      text,
  satisfaction_rating     integer CHECK (satisfaction_rating BETWEEN 1 AND 5),
  internal_notes          text,
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       uuid REFERENCES tickets(id) ON DELETE CASCADE,
  company_id      uuid REFERENCES companies(id),
  author_user_id  uuid,
  author_name     text,
  author_role     text CHECK (author_role IN ('client','exevori_agent','system')),
  body            text,
  is_internal     boolean DEFAULT false,
  attachments     jsonb DEFAULT '[]',
  created_at      timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ticket_attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   uuid REFERENCES tickets(id) ON DELETE CASCADE,
  message_id  uuid REFERENCES ticket_messages(id) ON DELETE CASCADE,
  file_name   text,
  file_size   integer,
  file_url    text,
  mime_type   text,
  uploaded_by uuid,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tickets_company ON tickets(company_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets(priority);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned ON tickets(assigned_to_user_id);
CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id);

ALTER TABLE tickets             ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_messages     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_attachments  ENABLE ROW LEVEL SECURITY;

CREATE POLICY company_isolation ON tickets USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON ticket_messages USING (
  (company_id = current_company_id() AND (NOT is_internal OR is_super_admin())) OR is_super_admin()
);
CREATE POLICY company_isolation ON ticket_attachments USING (
  EXISTS (SELECT 1 FROM tickets WHERE tickets.id = ticket_attachments.ticket_id
          AND (tickets.company_id = current_company_id() OR is_super_admin()))
);
