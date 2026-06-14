// ============================================================
// EXEVORI VOICE IA — KB RAG HELPER (Phase KB+B)
//
// Helpers réutilisables pour embeddings + semantic search.
// Used by:
//   - kb/index.js  (post-chunking → embedBatch sur les chunks)
//   - kb/index.js  POST /sources/search  (widget Knowledge)
//   - kb/index.js  POST /sources/:id/reembed
//   - Phase 8 (à venir) — Léa appelle searchSimilarChunks() pendant un appel
//
// Modèle: text-embedding-3-small (1536 dims, 0.02 USD / 1M tokens)
// Provider: OpenAI direct via fetch (clé OPENAI_API_KEY)
// Pas de SDK pour rester léger (fetch natif Node 22).
// ============================================================

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const EMBED_MODEL     = "text-embedding-3-small"; // 1536 dims
const BATCH_SIZE      = 96;  // safe sous la limite OpenAI (max 2048)
const MAX_RETRIES     = 3;

// ─────────────────────────────────────────────────────────────
// embedRaw — appel HTTP OpenAI bas niveau avec retry exponentiel
// ─────────────────────────────────────────────────────────────
async function embedRaw(inputs) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY manquant dans .env");
  if (!Array.isArray(inputs) || inputs.length === 0) return [];

  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const r = await fetch(`${OPENAI_BASE_URL}/embeddings`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: EMBED_MODEL, input: inputs }),
      });
      if (!r.ok) {
        const body = await r.text();
        // 429 / 5xx → retry
        if ((r.status === 429 || r.status >= 500) && attempt < MAX_RETRIES - 1) {
          const wait = 500 * Math.pow(2, attempt);
          await new Promise((res) => setTimeout(res, wait));
          continue;
        }
        throw new Error(`OpenAI ${r.status}: ${body.slice(0, 300)}`);
      }
      const data = await r.json();
      // OpenAI retourne data triés par index, mais on force le tri par sécurité
      return data.data
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((res) => setTimeout(res, 500 * Math.pow(2, attempt)));
        continue;
      }
    }
  }
  throw lastErr || new Error("embedRaw failed");
}

// ─────────────────────────────────────────────────────────────
// embedText — embed un seul string → vector(1536)
// ─────────────────────────────────────────────────────────────
export async function embedText(text) {
  if (!text || typeof text !== "string" || !text.trim()) {
    throw new Error("embedText: text non-vide requis");
  }
  const [v] = await embedRaw([text.trim()]);
  return v;
}

// ─────────────────────────────────────────────────────────────
// embedBatch — embed un array de strings, batché par BATCH_SIZE
// Retourne un array dans le même ordre que l'input
// ─────────────────────────────────────────────────────────────
export async function embedBatch(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const cleaned = texts.map((t) => (t || "").trim()).filter(Boolean);
  if (cleaned.length === 0) return [];

  const out = [];
  for (let i = 0; i < cleaned.length; i += BATCH_SIZE) {
    const batch = cleaned.slice(i, i + BATCH_SIZE);
    const vectors = await embedRaw(batch);
    out.push(...vectors);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// searchSimilarChunks — semantic search via JS-side cosine similarity
//
// Phase 8C-3 : on bypass la RPC Postgres `match_kb_chunks` qui présente
// un bug (retourne 0 résultats pour la plupart des queries même avec
// min_similarity=-10). On fetch tous les chunks de la company (petit
// volume par tenant, <1000 typique) et on calcule la cosine côté Node.
//
// Args:
//   company_id    : UUID (isolation tenant — REQUIS)
//   query         : string (la question utilisateur)
//   topK          : int (default 3)
//   minSimilarity : float [0..1] (filter chunks below)
//
// Returns: [{chunk_id, source_id, source_name, source_type, chunk_index, content, similarity}]
// ─────────────────────────────────────────────────────────────
export async function searchSimilarChunks({ company_id, query, topK = 3, minSimilarity = 0.0 }) {
  if (!company_id) throw new Error("searchSimilarChunks: company_id requis");
  if (!query || !query.trim()) throw new Error("searchSimilarChunks: query non-vide requis");

  // 1. Embed query
  const queryEmbed = await embedText(query);

  // 2. Fetch all embedded chunks for this company (joined with source name)
  const { data: chunks, error } = await supabase
    .from("knowledge_chunks")
    .select(`
      id, source_id, chunk_index, content, embedding,
      knowledge_sources!inner ( id, name, type )
    `)
    .eq("company_id", company_id)
    .not("embedding", "is", null);
  if (error) throw new Error(`fetch chunks: ${error.message}`);
  if (!chunks || chunks.length === 0) return [];

  // 3. Compute cosine similarity in JS
  //    pgvector serialize embeddings as '[v1,v2,...]' string when fetched via REST
  const parseEmb = (e) => {
    if (Array.isArray(e)) return e;
    if (typeof e === "string") {
      try { return JSON.parse(e); } catch (_) { return null; }
    }
    return null;
  };

  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  const norm = (a) => Math.sqrt(dot(a, a));
  const qNorm = norm(queryEmbed);

  const scored = [];
  for (const c of chunks) {
    const emb = parseEmb(c.embedding);
    if (!emb || emb.length !== queryEmbed.length) continue;
    const sim = dot(queryEmbed, emb) / (qNorm * norm(emb));
    if (sim >= minSimilarity) {
      scored.push({
        chunk_id: c.id,
        source_id: c.source_id,
        source_name: c.knowledge_sources?.name || null,
        source_type: c.knowledge_sources?.type || null,
        chunk_index: c.chunk_index,
        content: c.content,
        similarity: sim,
      });
    }
  }

  // 4. Sort by similarity DESC, take topK
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, topK);
}

// ─────────────────────────────────────────────────────────────
// embedChunksOfSource — embed tous les chunks d'une source + maj DB
// Utilisé par upload, scrape, et /reembed
//
// Args:
//   source_id   : UUID
//   company_id  : UUID (sanity check)
// Returns: { embedded_count, total_chunks, source }
// ─────────────────────────────────────────────────────────────
export async function embedChunksOfSource({ source_id, company_id }) {
  // 1. Récupérer tous les chunks (TOUS, pas seulement ceux sans embedding,
  //    pour permettre un re-embed propre)
  const { data: chunks, error: cErr } = await supabase
    .from("knowledge_chunks")
    .select("id, content")
    .eq("source_id", source_id)
    .eq("company_id", company_id)
    .order("chunk_index", { ascending: true });
  if (cErr) throw new Error(`fetch chunks: ${cErr.message}`);
  if (!chunks || chunks.length === 0) {
    return { embedded_count: 0, total_chunks: 0 };
  }

  // 2. Embed batch
  const vectors = await embedBatch(chunks.map((c) => c.content));
  if (vectors.length !== chunks.length) {
    throw new Error(`embedBatch mismatch: ${vectors.length} vs ${chunks.length}`);
  }

  // 3. Update chaque chunk (Supabase ne supporte pas bulk update avec vectors
  //    facilement → on fait une boucle, c'est OK pour N<200)
  for (let i = 0; i < chunks.length; i++) {
    const { error: uErr } = await supabase
      .from("knowledge_chunks")
      .update({ embedding: vectors[i] })
      .eq("id", chunks[i].id);
    if (uErr) throw new Error(`update chunk ${chunks[i].id}: ${uErr.message}`);
  }

  // 4. Tag la source comme "embeddings ready"
  const nowIso = new Date().toISOString();
  await supabase
    .from("knowledge_sources")
    .update({ embeddings_ready_at: nowIso })
    .eq("id", source_id);

  return { embedded_count: chunks.length, total_chunks: chunks.length, embeddings_ready_at: nowIso };
}
