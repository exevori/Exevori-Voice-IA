-- ═══════════════════════════════════════════════════════════
-- EXEVORI VOICE IA — Migration Phase KB+A
-- Tables : knowledge_sources + knowledge_chunks
-- Extension : pgvector (pour KB+B mais on l'active maintenant
--             pour éviter une 2e migration plus tard)
--
-- Validé par Karim : 2026-06-13
-- Idempotent (IF NOT EXISTS partout)
-- ═══════════════════════════════════════════════════════════

-- 1. Extension pgvector (sera utilisée en KB+B, on l'active maintenant)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Table knowledge_sources
CREATE TABLE IF NOT EXISTS knowledge_sources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('upload','url','manual')),
  name          TEXT NOT NULL,                  -- nom fichier ou titre page
  url           TEXT,                            -- pour type=url
  storage_path  TEXT,                            -- pour type=upload (chemin bucket)
  mime_type     TEXT,
  size_bytes    BIGINT,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','ready','error')),
  error_message TEXT,
  chunks_count  INT NOT NULL DEFAULT 0,
  created_by    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ks_company ON knowledge_sources(company_id);
CREATE INDEX IF NOT EXISTS idx_ks_status  ON knowledge_sources(company_id, status);

-- 3. Table knowledge_chunks (avec colonne embedding préparée pour KB+B)
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_id     UUID NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  chunk_index   INT NOT NULL,                    -- ordre dans la source (0-based)
  content       TEXT NOT NULL,
  token_count   INT,
  embedding     vector(1536),                    -- nullable jusqu'à KB+B
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kc_company ON knowledge_chunks(company_id);
CREATE INDEX IF NOT EXISTS idx_kc_source  ON knowledge_chunks(source_id);
-- Index pgvector (KB+B uniquement, non créé maintenant car nécessite données) :
-- CREATE INDEX idx_kc_embedding ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- 4. RLS multi-tenant — pattern aligné sur contacts/calls
ALTER TABLE knowledge_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks  ENABLE ROW LEVEL SECURITY;

-- Policies "company_member_only" : un user voit/édite uniquement les rows
-- dont company_id == son profile.company_id
-- (super_admin a accès via service_role côté backend)
DROP POLICY IF EXISTS ks_company_select ON knowledge_sources;
CREATE POLICY ks_company_select ON knowledge_sources FOR SELECT
  USING (company_id IN (SELECT company_id FROM profiles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS ks_company_insert ON knowledge_sources;
CREATE POLICY ks_company_insert ON knowledge_sources FOR INSERT
  WITH CHECK (company_id IN (SELECT company_id FROM profiles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS ks_company_update ON knowledge_sources;
CREATE POLICY ks_company_update ON knowledge_sources FOR UPDATE
  USING (company_id IN (SELECT company_id FROM profiles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS ks_company_delete ON knowledge_sources;
CREATE POLICY ks_company_delete ON knowledge_sources FOR DELETE
  USING (company_id IN (SELECT company_id FROM profiles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS kc_company_select ON knowledge_chunks;
CREATE POLICY kc_company_select ON knowledge_chunks FOR SELECT
  USING (company_id IN (SELECT company_id FROM profiles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS kc_company_insert ON knowledge_chunks;
CREATE POLICY kc_company_insert ON knowledge_chunks FOR INSERT
  WITH CHECK (company_id IN (SELECT company_id FROM profiles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS kc_company_delete ON knowledge_chunks;
CREATE POLICY kc_company_delete ON knowledge_chunks FOR DELETE
  USING (company_id IN (SELECT company_id FROM profiles WHERE user_id = auth.uid()));

-- 5. Bucket Storage 'kb-uploads' (privé, multi-tenant via path-based RLS)
--    Path layout : <company_id>/<source_id>/<filename>
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'kb-uploads',
  'kb-uploads',
  false,
  26214400,  -- 25 MB
  ARRAY[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'text/plain',
    'text/markdown',
    'text/x-markdown'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS — un user upload/lit/supprime seulement dans son company_id (1er segment du path)
DROP POLICY IF EXISTS kb_uploads_company_read ON storage.objects;
CREATE POLICY kb_uploads_company_read ON storage.objects FOR SELECT
  USING (
    bucket_id = 'kb-uploads'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT company_id FROM profiles WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS kb_uploads_company_insert ON storage.objects;
CREATE POLICY kb_uploads_company_insert ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'kb-uploads'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT company_id FROM profiles WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS kb_uploads_company_delete ON storage.objects;
CREATE POLICY kb_uploads_company_delete ON storage.objects FOR DELETE
  USING (
    bucket_id = 'kb-uploads'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT company_id FROM profiles WHERE user_id = auth.uid()
    )
  );

-- 6. Trigger updated_at auto sur knowledge_sources
CREATE OR REPLACE FUNCTION trg_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ks_set_updated_at ON knowledge_sources;
CREATE TRIGGER ks_set_updated_at BEFORE UPDATE ON knowledge_sources
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- ✓ Migration complète. Vérification suggérée :
--   SELECT COUNT(*) FROM knowledge_sources;       -- doit retourner 0
--   SELECT COUNT(*) FROM knowledge_chunks;        -- doit retourner 0
--   SELECT extname FROM pg_extension WHERE extname='vector';  -- doit retourner 'vector'
--   SELECT id, name FROM storage.buckets WHERE id='kb-uploads';  -- doit retourner 1 ligne
