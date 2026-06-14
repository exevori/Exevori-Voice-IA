-- ═══════════════════════════════════════════════════════════
-- EXEVORI VOICE IA — Migration Phase 8A (2/2)
-- Infrastructure d'appels temps réel.
-- Tables: call_recordings, call_events
-- Extensions: calls (twilio_call_sid, live_status, cost_cents, recording_id)
-- ═══════════════════════════════════════════════════════════

-- ─── 1. Extensions sur la table calls existante ───────────
ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS twilio_call_sid TEXT,
  ADD COLUMN IF NOT EXISTS live_status     TEXT,
  ADD COLUMN IF NOT EXISTS cost_cents      INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recording_id    UUID;

-- Index unique partiel (NULL autorisé pour rétro-compat avec les anciens calls seed)
CREATE UNIQUE INDEX IF NOT EXISTS uq_calls_twilio_sid
  ON calls(twilio_call_sid) WHERE twilio_call_sid IS NOT NULL;

-- Contrainte de valeur sur live_status
DO $$ BEGIN
  ALTER TABLE calls ADD CONSTRAINT calls_live_status_check
    CHECK (live_status IS NULL OR live_status IN (
      'ringing', 'connecting', 'ai_speaking', 'user_speaking',
      'transferring', 'ended', 'failed'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 2. Table call_recordings ──────────────────────────────
CREATE TABLE IF NOT EXISTS call_recordings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  call_id               UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,

  twilio_recording_sid  TEXT UNIQUE,
  url                   TEXT,
  duration_seconds      INTEGER,

  -- Transcript JSONB: [{role:'assistant'|'user', text, ts_ms, confidence?}]
  transcript            JSONB,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_call_recordings_company ON call_recordings(company_id);
CREATE INDEX IF NOT EXISTS idx_call_recordings_call    ON call_recordings(call_id);

ALTER TABLE call_recordings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS call_recordings_isolation ON call_recordings;
CREATE POLICY call_recordings_isolation ON call_recordings
  FOR ALL USING (company_id = current_company_id() OR is_super_admin());

-- ─── 3. Table call_events (logs temps réel) ─────────────────
CREATE TABLE IF NOT EXISTS call_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  call_id     UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,

  event_type  TEXT NOT NULL,
  payload     JSONB,
  ts_ms       BIGINT,        -- ms depuis début appel (NULL pour events globaux)

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Contrainte de valeur sur event_type (extensible plus tard si besoin)
DO $$ BEGIN
  ALTER TABLE call_events ADD CONSTRAINT call_events_type_check
    CHECK (event_type IN (
      'started', 'ringing', 'connecting',
      'ai_first_token', 'ai_speaking', 'tts_first_audio',
      'user_speaking', 'interrupted', 'silence_timeout',
      'transferred', 'transfer_failed',
      'ended', 'error'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_call_events_company ON call_events(company_id);
CREATE INDEX IF NOT EXISTS idx_call_events_call    ON call_events(call_id);
CREATE INDEX IF NOT EXISTS idx_call_events_type    ON call_events(event_type);

ALTER TABLE call_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS call_events_isolation ON call_events;
CREATE POLICY call_events_isolation ON call_events
  FOR ALL USING (company_id = current_company_id() OR is_super_admin());

-- ─── 4. FK différée : calls.recording_id → call_recordings.id ───
DO $$ BEGIN
  ALTER TABLE calls
    ADD CONSTRAINT calls_recording_fk
    FOREIGN KEY (recording_id) REFERENCES call_recordings(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
