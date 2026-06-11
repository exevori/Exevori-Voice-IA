// ============================================================
// VOICEDESK IA — MODULE KNOWLEDGE BASE
// CRUD des connaissances officielles de la PME
// Utilisé par voice/inbound.js (lecture) + admin (gestion)
// ============================================================

import express from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const router = express.Router();

const VALID_CATEGORIES = [
  "FAQ", "services", "pricing", "hours", "policies",
  "contact", "team", "products", "shipping", "returns",
];

// ─────────────────────────────────────────────────────────────
// GET /api/v1/knowledge
// Liste les connaissances actives d'une PME
// ─────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const { company_id, category, status = "active", search, limit = 100 } = req.query;

  if (!company_id) return res.status(400).json({ error: "company_id requis" });

  try {
    let query = supabase
      .from("knowledge_base")
      .select("*", { count: "exact" })
      .eq("company_id", company_id);

    if (status !== "all") query = query.eq("status", status);
    if (category) query = query.eq("category", category);
    if (search) {
      query = query.or(`question.ilike.%${search}%,answer.ilike.%${search}%`);
    }

    const { data, error, count } = await query
      .order("category")
      .order("question")
      .limit(parseInt(limit));

    if (error) throw error;

    // Grouper par catégorie pour faciliter l'affichage
    const grouped = {};
    (data || []).forEach(entry => {
      const cat = entry.category || "Autres";
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(entry);
    });

    return res.json({
      entries: data || [],
      grouped,
      total: count || 0,
      categories: VALID_CATEGORIES,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/knowledge/:id
// Détail d'une entrée
// ─────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("knowledge_base")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (error) return res.status(404).json({ error: "Entrée introuvable" });
    return res.json({ entry: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/knowledge
// Ajouter une entrée manuellement
// ─────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  const { company_id, question, answer, category = "FAQ", approved_by } = req.body;

  if (!company_id || !question || !answer) {
    return res.status(400).json({ error: "company_id, question, answer requis" });
  }

  try {
    // Détection de doublons
    const { data: existing } = await supabase
      .from("knowledge_base")
      .select("id, question")
      .eq("company_id", company_id)
      .eq("status", "active")
      .ilike("question", `%${question.substring(0, 30)}%`)
      .limit(3);

    const { data, error } = await supabase
      .from("knowledge_base")
      .insert({
        company_id,
        question,
        answer,
        category,
        status: "active",
        source: "manual",
        approved_by,
      })
      .select()
      .single();

    if (error) throw error;

    return res.json({
      success: true,
      entry: data,
      similar_entries: existing?.length > 0 ? existing : null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/v1/knowledge/:id
// Modifier une entrée
// ─────────────────────────────────────────────────────────────
router.patch("/:id", async (req, res) => {
  const updates = { ...req.body, updated_at: new Date() };
  delete updates.id;
  delete updates.company_id;
  delete updates.created_at;

  try {
    const { data, error } = await supabase
      .from("knowledge_base")
      .update(updates)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw error;
    return res.json({ success: true, entry: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/v1/knowledge/:id
// Désactiver une entrée (soft delete)
// ─────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  await supabase
    .from("knowledge_base")
    .update({ status: "archived", updated_at: new Date() })
    .eq("id", req.params.id);
  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/knowledge/bulk-import
// Import en masse (utilisé par onboarding ou import CSV)
// ─────────────────────────────────────────────────────────────
router.post("/bulk-import", async (req, res) => {
  const { company_id, entries, approved_by } = req.body;

  if (!company_id || !Array.isArray(entries)) {
    return res.status(400).json({ error: "company_id et entries (array) requis" });
  }

  try {
    const records = entries
      .filter(e => e.question && e.answer)
      .map(e => ({
        company_id,
        question: e.question,
        answer: e.answer,
        category: e.category || "FAQ",
        status: "active",
        source: e.source || "bulk_import",
        approved_by,
      }));

    if (records.length === 0) {
      return res.status(400).json({ error: "Aucune entrée valide" });
    }

    const { data, error } = await supabase
      .from("knowledge_base")
      .insert(records)
      .select();

    if (error) throw error;
    return res.json({ success: true, imported: data.length, entries: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/knowledge/search/semantic
// Recherche pour voice/inbound.js (rapide, contextuelle)
// ─────────────────────────────────────────────────────────────
router.get("/search/semantic", async (req, res) => {
  const { company_id, query, limit = 5 } = req.query;

  if (!company_id || !query) {
    return res.status(400).json({ error: "company_id et query requis" });
  }

  try {
    // V0 : SQL text search (Phase 2 : pgvector)
    const keywords = query.toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3)
      .slice(0, 5);

    let supabaseQuery = supabase
      .from("knowledge_base")
      .select("id, question, answer, category")
      .eq("company_id", company_id)
      .eq("status", "active");

    if (keywords.length > 0) {
      const orConditions = keywords.map(k =>
        `question.ilike.%${k}%,answer.ilike.%${k}%`
      ).join(",");
      supabaseQuery = supabaseQuery.or(orConditions);
    }

    const { data, error } = await supabaseQuery.limit(parseInt(limit));
    if (error) throw error;

    return res.json({ matches: data || [], query, keywords });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/knowledge/stats
// Statistiques pour dashboard
// ─────────────────────────────────────────────────────────────
router.get("/stats/overview", async (req, res) => {
  const { company_id } = req.query;

  try {
    const { data } = await supabase
      .from("knowledge_base")
      .select("category, source, status")
      .eq("company_id", company_id);

    const stats = {
      total_active: 0,
      total_archived: 0,
      by_category: {},
      by_source: { manual: 0, learning_validated: 0, bulk_import: 0 },
    };

    (data || []).forEach(e => {
      if (e.status === "active") stats.total_active++;
      else if (e.status === "archived") stats.total_archived++;
      stats.by_category[e.category] = (stats.by_category[e.category] || 0) + 1;
      stats.by_source[e.source] = (stats.by_source[e.source] || 0) + 1;
    });

    return res.json(stats);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
