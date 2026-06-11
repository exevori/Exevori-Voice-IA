-- ============================================================
-- MIGRATION 006 — Notifications System
-- Tables : notifications, notification_preferences
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
