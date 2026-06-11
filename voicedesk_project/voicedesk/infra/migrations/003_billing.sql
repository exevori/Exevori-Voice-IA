-- ============================================================
-- MIGRATION 003 — Billing (Stripe + usage metering)
-- Tables : payment_methods, usage_records, invoices,
--          credit_grants, stripe_webhook_events
-- ============================================================

CREATE TABLE IF NOT EXISTS payment_methods (
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

CREATE TABLE IF NOT EXISTS usage_records (
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

CREATE TABLE IF NOT EXISTS invoices (
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

CREATE TABLE IF NOT EXISTS credit_grants (
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

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id text UNIQUE,
  event_type      text,
  payload         jsonb,
  processed       boolean DEFAULT false,
  error           text,
  processed_at    timestamptz,
  created_at      timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_payment_methods_company ON payment_methods(company_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_company ON usage_records(company_id, period_start);
CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_credit_grants_company ON credit_grants(company_id, status);
CREATE INDEX IF NOT EXISTS idx_webhook_events_processed ON stripe_webhook_events(processed);

-- RLS
ALTER TABLE payment_methods       ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_records         ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices              ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_grants         ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY company_isolation ON payment_methods USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON usage_records USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON invoices USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY company_isolation ON credit_grants USING (company_id = current_company_id() OR is_super_admin());
CREATE POLICY admin_only_webhooks ON stripe_webhook_events USING (is_super_admin());
