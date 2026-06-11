// ============================================================
// VOICEDESK IA — SYSTÈME D'APPRENTISSAGE CONTRÔLÉ
//
// Concept unique à VoiceDesk (aucun équivalent open source direct) :
//   1. Détection de patterns dans appels + courriels
//   2. Proposition de réponse complète avec score de confiance
//   3. Workflow validation humaine (approuver/modifier/refuser)
//   4. Une fois approuvé → intégré dans la KB officielle
//
// Différencie VoiceDesk de Goodcall (qui détecte les gaps mais
// ne propose pas de réponse) et de Bland (gaps detection only).
// ============================================================

import express from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const AI_GATEWAY_URL = process.env.AI_GATEWAY_URL || "http://localhost:3100";

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// CRON / SCHEDULED JOB
// À exécuter toutes les 6 heures pour détecter de nouveaux patterns
// ─────────────────────────────────────────────────────────────
export async function detectPatternsForAllCompanies() {
  console.log("[LEARNING] Démarrage détection patterns...");

  const { data: companies } = await supabase
    .from("companies")
    .select("id, name")
    .eq("status", "active");

  for (const company of companies || []) {
    try {
      await detectPatternsForCompany(company.id);
    } catch (err) {
      console.error(`[LEARNING] Erreur pour ${company.name}:`, err);
    }
  }

  console.log("[LEARNING] Détection terminée.");
}

// ─────────────────────────────────────────────────────────────
// Détection des patterns pour UNE entreprise
// ─────────────────────────────────────────────────────────────
async function detectPatternsForCompany(companyId) {
  // 1. Récupérer les 50 derniers appels + courriels des 7 derniers jours
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const [calls, emails, knowledgeBase, existingSuggestions] = await Promise.all([
    supabase
      .from("calls")
      .select("id, ai_summary, intent, transcript")
      .eq("company_id", companyId)
      .gte("created_at", sevenDaysAgo.toISOString())
      .limit(50),
    supabase
      .from("emails")
      .select("id, subject, body, intent")
      .eq("company_id", companyId)
      .gte("received_at", sevenDaysAgo.toISOString())
      .limit(50),
    supabase
      .from("knowledge_base")
      .select("question")
      .eq("company_id", companyId)
      .eq("status", "active"),
    supabase
      .from("learning_suggestions")
      .select("question_detected")
      .eq("company_id", companyId)
      .in("status", ["pending", "approved"]),
  ]);

  if (!calls.data?.length && !emails.data?.length) return;

  // 2. Demander à DeepSeek d'identifier les patterns récurrents
  const detectedPatterns = await callAIGateway({
    task: "detect_learning_patterns",
    company_id: companyId,
    calls: calls.data || [],
    emails: emails.data || [],
    existing_knowledge: knowledgeBase.data?.map(k => k.question) || [],
    existing_suggestions: existingSuggestions.data?.map(s => s.question_detected) || [],
  });

  // 3. Pour chaque pattern détecté, générer une réponse proposée
  for (const pattern of detectedPatterns?.patterns || []) {
    if (pattern.occurrences < 2) continue; // Pattern doit apparaître au moins 2x
    if (pattern.is_duplicate) continue;     // Déjà connu

    // Générer la réponse proposée
    const proposedAnswer = await callAIGateway({
      task: "generate_suggested_answer",
      company_id: companyId,
      question: pattern.question,
      context: pattern.context,
      existing_knowledge: knowledgeBase.data || [],
    });

    // Sauvegarder la suggestion
    await supabase.from("learning_suggestions").insert({
      company_id: companyId,
      type: pattern.type || "frequently_asked",
      question_detected: pattern.question,
      suggested_answer: proposedAnswer?.answer || "",
      source_summary: pattern.source_summary,
      detected_from: pattern.detected_from, // 'calls' | 'emails' | 'mixed'
      occurrences: pattern.occurrences,
      source_ids: pattern.source_ids || [],
      confidence_score: proposedAnswer?.confidence || 70,
      status: "pending",
    });
  }

  console.log(`[LEARNING] ${detectedPatterns?.patterns?.length || 0} patterns détectés pour company ${companyId}`);
}

// ─────────────────────────────────────────────────────────────
// GET /api/v1/learning/suggestions
// Liste les suggestions pour validation
// ─────────────────────────────────────────────────────────────
router.get("/suggestions", async (req, res) => {
  const { company_id, status = "pending" } = req.query;

  const { data, error } = await supabase
    .from("learning_suggestions")
    .select("*")
    .eq("company_id", company_id)
    .eq("status", status)
    .order("confidence_score", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ suggestions: data });
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/learning/suggestions/:id/approve
// Approuver une suggestion → l'ajouter à la KB
// ─────────────────────────────────────────────────────────────
router.post("/suggestions/:id/approve", async (req, res) => {
  const { id } = req.params;
  const { edited_question, edited_answer, category = "FAQ", approved_by } = req.body;

  try {
    const { data: suggestion } = await supabase
      .from("learning_suggestions")
      .select("*")
      .eq("id", id)
      .single();

    if (!suggestion) return res.status(404).json({ error: "suggestion introuvable" });

    const finalQuestion = edited_question || suggestion.question_detected;
    const finalAnswer = edited_answer || suggestion.suggested_answer;

    // 1. Ajouter à la base de connaissances officielle
    const { data: kbEntry } = await supabase
      .from("knowledge_base")
      .insert({
        company_id: suggestion.company_id,
        question: finalQuestion,
        answer: finalAnswer,
        category,
        status: "active",
        source: "learning_validated",
        source_suggestion_id: id,
        approved_by,
      })
      .select()
      .single();

    // 2. Marquer la suggestion comme approuvée
    await supabase
      .from("learning_suggestions")
      .update({
        status: "approved",
        approved_at: new Date(),
        approved_by,
        knowledge_base_id: kbEntry.id,
        final_question: finalQuestion,
        final_answer: finalAnswer,
      })
      .eq("id", id);

    return res.json({ success: true, knowledge_base_id: kbEntry.id });
  } catch (err) {
    console.error("[LEARNING] Approve error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/learning/suggestions/:id/reject
// ─────────────────────────────────────────────────────────────
router.post("/suggestions/:id/reject", async (req, res) => {
  const { id } = req.params;
  const { reason, rejected_by } = req.body;

  await supabase
    .from("learning_suggestions")
    .update({
      status: "rejected",
      rejected_at: new Date(),
      rejected_by,
      rejection_reason: reason || "Refusé sans motif",
    })
    .eq("id", id);

  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/learning/suggestions/:id/modify
// Modifier la réponse proposée puis approuver
// ─────────────────────────────────────────────────────────────
router.post("/suggestions/:id/modify", async (req, res) => {
  const { id } = req.params;
  const { new_question, new_answer, modified_by } = req.body;

  const { data: suggestion } = await supabase
    .from("learning_suggestions")
    .update({
      question_detected: new_question,
      suggested_answer: new_answer,
      modified_by,
      modified_at: new Date(),
    })
    .eq("id", id)
    .select()
    .single();

  return res.json({ success: true, suggestion });
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/learning/stats
// Statistiques d'apprentissage pour le dashboard
// ─────────────────────────────────────────────────────────────
router.get("/stats", async (req, res) => {
  const { company_id } = req.query;

  const { data } = await supabase
    .from("learning_suggestions")
    .select("status")
    .eq("company_id", company_id);

  const stats = {
    pending: data?.filter(s => s.status === "pending").length || 0,
    approved: data?.filter(s => s.status === "approved").length || 0,
    rejected: data?.filter(s => s.status === "rejected").length || 0,
    total: data?.length || 0,
  };

  // KB totale
  const { count: kbTotal } = await supabase
    .from("knowledge_base")
    .select("*", { count: "exact", head: true })
    .eq("company_id", company_id)
    .eq("status", "active");

  stats.knowledge_base_size = kbTotal || 0;

  return res.json(stats);
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/learning/manual
// Admin ajoute manuellement une entrée à la KB (sans passer par détection)
// ─────────────────────────────────────────────────────────────
router.post("/manual", async (req, res) => {
  const { company_id, question, answer, category, created_by } = req.body;

  const { data } = await supabase
    .from("knowledge_base")
    .insert({
      company_id,
      question,
      answer,
      category: category || "FAQ",
      status: "active",
      source: "manual",
      approved_by: created_by,
    })
    .select()
    .single();

  return res.json({ success: true, knowledge_base_id: data?.id });
});

async function callAIGateway(payload) {
  try {
    const response = await fetch(`${AI_GATEWAY_URL}/api/ai/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`AI Gateway ${response.status}`);
    return await response.json();
  } catch (err) {
    console.error("[AI Gateway] Error:", err);
    return null;
  }
}

export default router;
