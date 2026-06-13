-- ═══════════════════════════════════════════════════════════
-- EXEVORI VOICE IA — Migration Phase KB+B (Embeddings)
--
-- Préreq : Migration 001_kb_plus_a.sql exécutée
--   → colonne `knowledge_chunks.embedding vector(1536)` existe déjà
--   → extension `vector` activée
--
-- Ce que cette migration fait :
--   1. Colonne knowledge_sources.embeddings_ready_at (timestamp)
--      pour distinguer "chunks générés" vs "embeddings générés"
--   2. Index ivfflat (cosine) sur knowledge_chunks.embedding
--      pour accélérer la recherche par similarité
--   3. Fonction match_kb_chunks(company_id, query_embedding, k, threshold)
--      → réutilisable depuis backend Node ET Phase 8 (Léa via Supabase RPC)
--
-- Idempotent (IF NOT EXISTS / OR REPLACE partout)
-- Validation : Karim, 2026-06-13
-- ═══════════════════════════════════════════════════════════

-- 1. Colonne pour tracer quand les embeddings ont été générés
ALTER TABLE knowledge_sources
  ADD COLUMN IF NOT EXISTS embeddings_ready_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ks_emb_ready
  ON knowledge_sources(company_id, embeddings_ready_at);

-- 2. Index ivfflat cosine sur embedding (lists=100 = sweet spot pour 1k-100k chunks)
--    Note pgvector: avec moins de 1000 rows, le planner peut préférer un seq scan.
CREATE INDEX IF NOT EXISTS idx_kc_embedding_ivfflat
  ON knowledge_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 3. Fonction Postgres match_kb_chunks
--    Args: company_id, query embedding, top-K, similarity min (0..1)
--    Returns: (chunk_id, source_id, source_name, source_type, chunk_index, content, similarity)
--    → Utilisée par backend Node ET prête pour Phase 8 (Léa)
CREATE OR REPLACE FUNCTION match_kb_chunks(
  p_company_id      UUID,
  p_query_embed     vector(1536),
  p_match_count     INT   DEFAULT 3,
  p_min_similarity  FLOAT DEFAULT 0.0
)
RETURNS TABLE (
  chunk_id      UUID,
  source_id     UUID,
  source_name   TEXT,
  source_type   TEXT,
  chunk_index   INT,
  content       TEXT,
  similarity    FLOAT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    kc.id              AS chunk_id,
    kc.source_id       AS source_id,
    ks.name            AS source_name,
    ks.type            AS source_type,
    kc.chunk_index     AS chunk_index,
    kc.content         AS content,
    1 - (kc.embedding <=> p_query_embed) AS similarity
  FROM knowledge_chunks kc
  JOIN knowledge_sources ks ON ks.id = kc.source_id
  WHERE kc.company_id = p_company_id
    AND kc.embedding IS NOT NULL
    AND ks.status = 'ready'
    AND (1 - (kc.embedding <=> p_query_embed)) >= p_min_similarity
  ORDER BY kc.embedding <=> p_query_embed
  LIMIT p_match_count;
$$;

-- 4. Vérification :
--    SELECT indexname FROM pg_indexes WHERE tablename='knowledge_chunks';
--      → doit inclure idx_kc_embedding_ivfflat
--    SELECT proname FROM pg_proc WHERE proname='match_kb_chunks';
--      → doit retourner 1 ligne
