-- ============================================================================
-- EXEVORI VOICE IA — Migration 014
-- Base de connaissances RAG + apprentissage contrôlé unifiés
--
-- IMPORTANT
--   * Cette migration est préparée pour déploiement, mais n'est pas exécutée ici.
--   * La table legacy public.knowledge_base est conservée pour rollback/audit.
--     Le code applicatif cesse toutefois de l'utiliser après cette migration.
--   * Les embeddings restent en vector(1536). Le backend demande explicitement
--     1536 dimensions au fournisseur Fireworks.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

-- --------------------------------------------------------------------------
-- 1. Modèle RAG canonique
-- --------------------------------------------------------------------------

ALTER TABLE public.knowledge_sources
  ADD COLUMN IF NOT EXISTS question text,
  ADD COLUMN IF NOT EXISTS answer text,
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'FAQ',
  ADD COLUMN IF NOT EXISTS origin_key text,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;

ALTER TABLE public.knowledge_chunks
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS embedding_model text;

-- La migration 001 limitait le type à upload/url/manual alors que l'application
-- utilise déjà qa. On remplace explicitement cette contrainte.
ALTER TABLE public.knowledge_sources
  DROP CONSTRAINT IF EXISTS knowledge_sources_type_check;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.knowledge_sources'::regclass
      AND conname = 'knowledge_sources_type_check_v2'
  ) THEN
    ALTER TABLE public.knowledge_sources
      ADD CONSTRAINT knowledge_sources_type_check_v2
      CHECK (type IN (
        'upload', 'url', 'manual', 'qa', 'onboarding', 'learning', 'legacy'
      ));
  END IF;
END
$migration$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_sources_company_origin
  ON public.knowledge_sources(company_id, origin_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_sources_id_company
  ON public.knowledge_sources(id, company_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_sources_question
  ON public.knowledge_sources(company_id, category, created_at DESC)
  WHERE question IS NOT NULL;

-- Garantit que source et chunk appartiennent au même tenant, sans faire échouer
-- le déploiement si des données historiques incohérentes doivent être nettoyées.
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.knowledge_chunks'::regclass
      AND conname = 'knowledge_chunks_source_company_fk'
  ) THEN
    ALTER TABLE public.knowledge_chunks
      ADD CONSTRAINT knowledge_chunks_source_company_fk
      FOREIGN KEY (source_id, company_id)
      REFERENCES public.knowledge_sources(id, company_id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END
$migration$;

-- --------------------------------------------------------------------------
-- 2. File durable de traitement (documents, URL et ré-embedding)
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.knowledge_processing_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  source_id         uuid NOT NULL,
  job_type          text NOT NULL
                    CHECK (job_type IN ('extract_upload', 'scrape_url', 'embed_source')),
  idempotency_key   text NOT NULL,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'retry', 'completed', 'failed')),
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts      integer NOT NULL DEFAULT 4 CHECK (max_attempts BETWEEN 1 AND 10),
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  locked_at         timestamptz,
  locked_by         text,
  error_message     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  CONSTRAINT knowledge_processing_jobs_source_company_fk
    FOREIGN KEY (source_id, company_id)
    REFERENCES public.knowledge_sources(id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT knowledge_processing_jobs_company_idempotency_unique
    UNIQUE (company_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_kb_jobs_claim
  ON public.knowledge_processing_jobs(status, next_attempt_at, created_at)
  WHERE status IN ('pending', 'retry', 'processing');

CREATE INDEX IF NOT EXISTS idx_kb_jobs_source
  ON public.knowledge_processing_jobs(company_id, source_id, created_at DESC);

ALTER TABLE public.knowledge_processing_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_processing_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_chunks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_bypass ON public.knowledge_processing_jobs;
CREATE POLICY service_role_bypass
  ON public.knowledge_processing_jobs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE public.knowledge_processing_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.knowledge_processing_jobs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.knowledge_sources TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.knowledge_chunks TO service_role;

-- Claim atomique : SKIP LOCKED évite qu'un même job soit traité par deux workers.
CREATE OR REPLACE FUNCTION public.claim_kb_processing_jobs(
  p_worker_id text,
  p_limit integer DEFAULT 2,
  p_lease_seconds integer DEFAULT 120
)
RETURNS SETOF public.knowledge_processing_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF nullif(btrim(p_worker_id), '') IS NULL THEN
    RAISE EXCEPTION 'worker_id_required';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT job.id
    FROM public.knowledge_processing_jobs AS job
    WHERE (
      (job.status IN ('pending', 'retry') AND job.next_attempt_at <= now())
      OR (
        job.status = 'processing'
        AND job.locked_at < now() - make_interval(secs => greatest(p_lease_seconds, 30))
      )
    )
    ORDER BY job.next_attempt_at, job.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT greatest(1, least(coalesce(p_limit, 2), 10))
  )
  UPDATE public.knowledge_processing_jobs AS job
  SET status = 'processing',
      attempts = job.attempts + 1,
      locked_at = now(),
      locked_by = p_worker_id,
      error_message = NULL,
      updated_at = now()
  FROM candidates
  WHERE job.id = candidates.id
  RETURNING job.*;
END
$function$;

CREATE OR REPLACE FUNCTION public.complete_kb_processing_job(
  p_job_id uuid,
  p_worker_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  affected integer;
BEGIN
  UPDATE public.knowledge_processing_jobs
  SET status = 'completed',
      payload = '{}'::jsonb,
      locked_at = NULL,
      locked_by = NULL,
      error_message = NULL,
      completed_at = now(),
      updated_at = now()
  WHERE id = p_job_id
    AND status = 'processing'
    AND locked_by = p_worker_id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END
$function$;

CREATE OR REPLACE FUNCTION public.fail_kb_processing_job(
  p_job_id uuid,
  p_worker_id text,
  p_error text,
  p_retry_delay_seconds integer DEFAULT 30
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  next_status text;
BEGIN
  UPDATE public.knowledge_processing_jobs AS job
  SET status = CASE WHEN job.attempts < job.max_attempts THEN 'retry' ELSE 'failed' END,
      next_attempt_at = CASE
        WHEN job.attempts < job.max_attempts
          THEN now() + make_interval(secs => greatest(coalesce(p_retry_delay_seconds, 30), 1))
        ELSE job.next_attempt_at
      END,
      locked_at = NULL,
      locked_by = NULL,
      error_message = left(coalesce(p_error, 'processing_failed'), 2000),
      completed_at = CASE WHEN job.attempts >= job.max_attempts THEN now() ELSE NULL END,
      updated_at = now()
  WHERE job.id = p_job_id
    AND job.status = 'processing'
    AND job.locked_by = p_worker_id
  RETURNING job.status INTO next_status;

  RETURN next_status;
END
$function$;

REVOKE ALL ON FUNCTION public.claim_kb_processing_jobs(text, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_kb_processing_job(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_kb_processing_job(uuid, text, text, integer)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_kb_processing_jobs(text, integer, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_kb_processing_job(uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_kb_processing_job(uuid, text, text, integer)
  TO service_role;

-- --------------------------------------------------------------------------
-- 3. Recherche vectorielle canonique, tenant-scopée et non exposée aux JWT
-- --------------------------------------------------------------------------

-- Les colonnes OUT changent par rapport à la migration 002 : PostgreSQL exige
-- un DROP explicite avant de recréer la même signature.
DROP FUNCTION IF EXISTS public.match_kb_chunks(
  uuid, vector, integer, double precision
);

CREATE OR REPLACE FUNCTION public.match_kb_chunks(
  p_company_id uuid,
  p_query_embed vector(1536),
  p_match_count integer DEFAULT 3,
  p_min_similarity double precision DEFAULT 0.0
)
RETURNS TABLE (
  chunk_id uuid,
  source_id uuid,
  source_name text,
  source_type text,
  source_question text,
  source_category text,
  chunk_index integer,
  content text,
  similarity double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    chunk.id,
    chunk.source_id,
    source.name,
    source.type,
    source.question,
    source.category,
    chunk.chunk_index,
    chunk.content,
    1 - (chunk.embedding <=> p_query_embed) AS similarity
  FROM public.knowledge_chunks AS chunk
  JOIN public.knowledge_sources AS source
    ON source.id = chunk.source_id
   AND source.company_id = chunk.company_id
  WHERE chunk.company_id = p_company_id
    AND chunk.embedding IS NOT NULL
    AND source.status = 'ready'
    AND (1 - (chunk.embedding <=> p_query_embed)) >= p_min_similarity
  ORDER BY chunk.embedding <=> p_query_embed
  LIMIT greatest(1, least(coalesce(p_match_count, 3), 20));
$function$;

REVOKE ALL ON FUNCTION public.match_kb_chunks(
  uuid, vector, integer, double precision
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_kb_chunks(
  uuid, vector, integer, double precision
) TO service_role;

-- --------------------------------------------------------------------------
-- 4. Learning pointe désormais vers la source RAG et conserve le résultat du
--    test automatique effectué immédiatement après approbation.
-- --------------------------------------------------------------------------

ALTER TABLE public.learning_suggestions
  ADD COLUMN IF NOT EXISTS knowledge_source_id uuid
    REFERENCES public.knowledge_sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rag_status text NOT NULL DEFAULT 'pending'
    CHECK (rag_status IN ('pending', 'processing', 'ready', 'error')),
  ADD COLUMN IF NOT EXISTS rag_test_source_id uuid
    REFERENCES public.knowledge_sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rag_test_similarity double precision,
  ADD COLUMN IF NOT EXISTS rag_error text;

CREATE INDEX IF NOT EXISTS idx_learning_suggestions_rag
  ON public.learning_suggestions(company_id, rag_status, created_at DESC);

-- --------------------------------------------------------------------------
-- 5. Reprise idempotente de la base historique vers le RAG.
--    Les anciennes lignes restent intactes pour audit/rollback.
-- --------------------------------------------------------------------------

DO $migration$
BEGIN
  IF to_regclass('public.knowledge_base') IS NOT NULL THEN
    INSERT INTO public.knowledge_sources (
      company_id,
      type,
      name,
      question,
      answer,
      category,
      origin_key,
      metadata,
      status,
      size_bytes,
      created_at,
      updated_at
    )
    SELECT
      legacy.company_id,
      'legacy',
      left(coalesce(legacy.question, 'FAQ historique'), 200),
      legacy.question,
      legacy.answer,
      coalesce(legacy.category, 'FAQ'),
      'legacy:' || legacy.id::text,
      jsonb_build_object(
        'legacy_id', legacy.id,
        'legacy_source', coalesce(legacy.source, 'unknown')
      ),
      'pending',
      octet_length(coalesce(legacy.question, '') || E'\n' || coalesce(legacy.answer, '')),
      coalesce(legacy.created_at, now()),
      coalesce(legacy.updated_at, legacy.created_at, now())
    FROM public.knowledge_base AS legacy
    WHERE legacy.company_id IS NOT NULL
      AND legacy.status = 'active'
    ON CONFLICT (company_id, origin_key) DO NOTHING;

    INSERT INTO public.knowledge_chunks (
      company_id,
      source_id,
      chunk_index,
      content,
      token_count,
      metadata
    )
    SELECT
      source.company_id,
      source.id,
      0,
      'Question : ' || source.question || E'\nRéponse : ' || source.answer,
      NULL,
      jsonb_build_object('kind', 'legacy_qa')
    FROM public.knowledge_sources AS source
    WHERE source.type = 'legacy'
      AND source.origin_key LIKE 'legacy:%'
      AND NOT EXISTS (
        SELECT 1
        FROM public.knowledge_chunks AS chunk
        WHERE chunk.source_id = source.id
          AND chunk.company_id = source.company_id
      );

    INSERT INTO public.knowledge_processing_jobs (
      company_id,
      source_id,
      job_type,
      idempotency_key,
      payload
    )
    SELECT
      source.company_id,
      source.id,
      'embed_source',
      'legacy-embed:' || source.id::text,
      '{}'::jsonb
    FROM public.knowledge_sources AS source
    WHERE source.type = 'legacy'
      AND source.status = 'pending'
    ON CONFLICT (company_id, idempotency_key) DO NOTHING;

    -- Le FK historique est conservé, mais les suggestions peuvent désormais
    -- retrouver leur source canonique RAG.
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'learning_suggestions'
        AND column_name = 'knowledge_base_id'
    ) THEN
      UPDATE public.learning_suggestions AS suggestion
      SET knowledge_source_id = source.id,
          rag_status = CASE WHEN source.status = 'ready' THEN 'ready' ELSE 'pending' END
      FROM public.knowledge_sources AS source
      WHERE suggestion.knowledge_base_id IS NOT NULL
        AND source.company_id = suggestion.company_id
        AND source.origin_key = 'legacy:' || suggestion.knowledge_base_id::text
        AND suggestion.knowledge_source_id IS NULL;
    END IF;

    EXECUTE 'COMMENT ON TABLE public.knowledge_base IS '
      || quote_literal(
        'LEGACY après migration 014 : conservée pour audit/rollback, ne plus écrire depuis le runtime.'
      );
  END IF;
END
$migration$;

COMMENT ON TABLE public.knowledge_processing_jobs IS
  'File durable service-role-only pour extraction, scraping et embeddings RAG.';
COMMENT ON COLUMN public.knowledge_sources.origin_key IS
  'Clé d’idempotence fonctionnelle par tenant (onboarding, learning, legacy).';

-- Vérifications après exécution manuelle :
-- SELECT type, status, count(*) FROM public.knowledge_sources GROUP BY 1,2;
-- SELECT status, count(*) FROM public.knowledge_processing_jobs GROUP BY 1;
-- SELECT routine_name, security_type FROM information_schema.routines
--   WHERE routine_schema='public' AND routine_name LIKE '%kb%';
-- SELECT grantee, table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE table_schema='public'
--     AND table_name IN ('knowledge_sources','knowledge_chunks','knowledge_processing_jobs')
--   ORDER BY table_name, grantee, privilege_type;

COMMIT;
