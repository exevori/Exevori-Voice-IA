import express from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

import { requireRole } from "../../middleware/auth.js";
import { createRagService } from "../kb/rag.js";
import { createKnowledgeService } from "../kb/service.js";

dotenv.config();

const AI_GATEWAY_URL = process.env.AI_GATEWAY_URL || "http://localhost:3100";
const REVIEW_ROLES = requireRole("company_admin", "super_admin");

function isSuperAdmin(req) {
  return req.user?.role === "super_admin";
}

function resolveCompanyId(req, requestedCompanyId) {
  if (isSuperAdmin(req)) return requestedCompanyId || null;
  if (requestedCompanyId && requestedCompanyId !== req.user?.company_id) return false;
  return req.user?.company_id || null;
}

function clean(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

async function callAIGateway(payload, { fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${AI_GATEWAY_URL}/api/ai/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) throw new Error(`ai_gateway_http_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function approveLearningSuggestion({
  supabase,
  ragService,
  knowledgeService,
  suggestion,
  question,
  answer,
  category = "FAQ",
  approvedBy,
  createdBy = null,
}) {
  const finalQuestion = clean(question || suggestion.question_detected, 20_000);
  const finalAnswer = clean(answer || suggestion.suggested_answer, 100_000);
  if (finalQuestion.length < 5 || finalAnswer.length < 3) {
    const error = new Error("learning_question_or_answer_invalid");
    error.status = 400;
    throw error;
  }

  try {
    const ragResult = await knowledgeService.createQaSource({
      companyId: suggestion.company_id,
      type: "learning",
      question: finalQuestion,
      answer: finalAnswer,
      category,
      originKey: `learning:${suggestion.id}`,
      createdBy,
      metadata: {
        suggestion_id: suggestion.id,
        approved_by: approvedBy,
        source: "learning_validated",
      },
    });

    const matches = await ragService.searchSimilarChunks({
      company_id: suggestion.company_id,
      query: finalQuestion,
      topK: 5,
      minSimilarity: 0,
    });
    const ownMatch = matches.find(match => match.source_id === ragResult.source.id);
    if (!ownMatch) {
      const error = new Error("learning_rag_test_did_not_find_approved_source");
      error.code = "learning_rag_test_failed";
      throw error;
    }

    const approvedAt = new Date().toISOString();
    const { data: updated, error: updateError } = await supabase
      .from("learning_suggestions")
      .update({
        status: "approved",
        approved_at: approvedAt,
        approved_by: approvedBy,
        final_question: finalQuestion,
        final_answer: finalAnswer,
        knowledge_source_id: ragResult.source.id,
        rag_status: "ready",
        rag_test_source_id: ownMatch.source_id,
        rag_test_similarity: ownMatch.similarity,
        rag_error: null,
      })
      .eq("id", suggestion.id)
      .eq("company_id", suggestion.company_id)
      .select()
      .single();
    if (updateError) throw updateError;

    return {
      suggestion: updated,
      knowledge_source: ragResult.source,
      rag_test: {
        passed: true,
        source_id: ownMatch.source_id,
        source_name: ownMatch.source_name,
        source_type: ownMatch.source_type,
        similarity: ownMatch.similarity,
        chunk_id: ownMatch.chunk_id,
      },
    };
  } catch (error) {
    await supabase
      .from("learning_suggestions")
      .update({
        rag_status: "error",
        rag_error: clean(error?.message || error, 2_000),
      })
      .eq("id", suggestion.id)
      .eq("company_id", suggestion.company_id);
    throw error;
  }
}

async function detectPatternsForCompany({ supabase, companyId, fetchImpl }) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [calls, emails, knowledge, suggestions] = await Promise.all([
    supabase
      .from("calls")
      .select("id, ai_summary, intent, transcript")
      .eq("company_id", companyId)
      .gte("created_at", since)
      .limit(50),
    supabase
      .from("emails")
      .select("id, subject, body, intent")
      .eq("company_id", companyId)
      .gte("received_at", since)
      .limit(50),
    supabase
      .from("knowledge_sources")
      .select("question, name")
      .eq("company_id", companyId)
      .eq("status", "ready")
      .not("question", "is", null)
      .limit(500),
    supabase
      .from("learning_suggestions")
      .select("question_detected")
      .eq("company_id", companyId)
      .in("status", ["pending", "approved"])
      .limit(500),
  ]);
  for (const result of [calls, emails, knowledge, suggestions]) {
    if (result.error) throw result.error;
  }
  if (!calls.data?.length && !emails.data?.length) return 0;

  const detected = await callAIGateway({
    task: "detect_learning_patterns",
    company_id: companyId,
    calls: calls.data || [],
    emails: emails.data || [],
    existing_knowledge: (knowledge.data || []).map(row => row.question || row.name),
    existing_suggestions: (suggestions.data || []).map(row => row.question_detected),
  }, { fetchImpl });

  let inserted = 0;
  for (const pattern of detected?.patterns || []) {
    if (Number(pattern.occurrences) < 2 || pattern.is_duplicate) continue;
    const proposed = await callAIGateway({
      task: "generate_suggested_answer",
      company_id: companyId,
      question: pattern.question,
      context: pattern.context,
      existing_knowledge: knowledge.data || [],
    }, { fetchImpl });
    const { error } = await supabase.from("learning_suggestions").insert({
      company_id: companyId,
      type: pattern.type || "frequently_asked",
      question_detected: clean(pattern.question, 20_000),
      suggested_answer: clean(proposed?.answer, 100_000),
      source_summary: clean(pattern.source_summary, 20_000),
      detected_from: pattern.detected_from || "calls",
      occurrences: Number(pattern.occurrences) || 2,
      source_ids: Array.isArray(pattern.source_ids) ? pattern.source_ids : [],
      confidence_score: Number(proposed?.confidence) || 70,
      status: "pending",
      rag_status: "pending",
    });
    if (error) throw error;
    inserted += 1;
  }
  return inserted;
}

export function createLearningModule({
  supabase,
  ragService,
  knowledgeService,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!supabase?.from) throw new TypeError("supabase.from est requis");
  const rag = ragService || createRagService({ supabase });
  const knowledge = knowledgeService || createKnowledgeService({ supabase, ragService: rag });
  const router = express.Router();

  async function suggestionForRequest(req, res) {
    let query = supabase
      .from("learning_suggestions")
      .select("*")
      .eq("id", req.params.id);
    if (!isSuperAdmin(req)) query = query.eq("company_id", req.user.company_id);
    const { data, error } = await query.maybeSingle();
    if (error) {
      res.status(500).json({ error: "suggestion_read_failed" });
      return null;
    }
    if (!data) {
      if (!isSuperAdmin(req)) {
        const { data: exists } = await supabase
          .from("learning_suggestions")
          .select("id")
          .eq("id", req.params.id)
          .maybeSingle();
        if (exists) {
          res.status(403).json({ error: "forbidden_cross_tenant" });
          return null;
        }
      }
      res.status(404).json({ error: "suggestion_not_found" });
      return null;
    }
    return data;
  }

  router.get("/suggestions", async (req, res) => {
    const companyId = resolveCompanyId(req, req.query.company_id);
    if (companyId === false) return res.status(403).json({ error: "forbidden_cross_tenant" });
    if (!companyId) return res.status(400).json({ error: "company_id_required" });
    let query = supabase
      .from("learning_suggestions")
      .select("*")
      .eq("company_id", companyId);
    if (req.query.status && req.query.status !== "all") {
      query = query.eq("status", req.query.status);
    }
    const { data, error } = await query.order("confidence_score", { ascending: false });
    if (error) return res.status(500).json({ error: "suggestions_read_failed" });
    return res.json({ suggestions: data || [] });
  });

  router.post("/suggestions/:id/approve", REVIEW_ROLES, async (req, res) => {
    const suggestion = await suggestionForRequest(req, res);
    if (!suggestion) return;
    try {
      const result = await approveLearningSuggestion({
        supabase,
        ragService: rag,
        knowledgeService: knowledge,
        suggestion,
        question: req.body?.edited_question,
        answer: req.body?.edited_answer,
        category: req.body?.category || "FAQ",
        approvedBy: req.user.id,
        createdBy: req.user?.profile?.id || null,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      return res.status(error.status || 500).json({
        error: error.code || "learning_approval_failed",
        message: error.status && error.status < 500 ? error.message : "Validation RAG échouée",
      });
    }
  });

  router.post("/suggestions/:id/reject", REVIEW_ROLES, async (req, res) => {
    const suggestion = await suggestionForRequest(req, res);
    if (!suggestion) return;
    const { data, error } = await supabase
      .from("learning_suggestions")
      .update({
        status: "rejected",
        rejected_at: new Date().toISOString(),
        rejected_by: req.user.id,
        rejection_reason: clean(req.body?.reason || "Refusé sans motif", 2_000),
      })
      .eq("id", suggestion.id)
      .eq("company_id", suggestion.company_id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: "suggestion_reject_failed" });
    return res.json({ success: true, suggestion: data });
  });

  router.post("/suggestions/:id/modify", REVIEW_ROLES, async (req, res) => {
    const suggestion = await suggestionForRequest(req, res);
    if (!suggestion) return;
    const question = clean(req.body?.new_question, 20_000);
    const answer = clean(req.body?.new_answer, 100_000);
    if (question.length < 5 || answer.length < 3) {
      return res.status(400).json({ error: "learning_question_or_answer_invalid" });
    }
    const { data, error } = await supabase
      .from("learning_suggestions")
      .update({
        question_detected: question,
        suggested_answer: answer,
        modified_by: req.user.id,
        modified_at: new Date().toISOString(),
        rag_status: "pending",
        rag_error: null,
      })
      .eq("id", suggestion.id)
      .eq("company_id", suggestion.company_id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: "suggestion_modify_failed" });
    return res.json({ success: true, suggestion: data });
  });

  router.get("/stats", async (req, res) => {
    const companyId = resolveCompanyId(req, req.query.company_id);
    if (companyId === false) return res.status(403).json({ error: "forbidden_cross_tenant" });
    if (!companyId) return res.status(400).json({ error: "company_id_required" });
    const [suggestions, knowledgeCount] = await Promise.all([
      supabase
        .from("learning_suggestions")
        .select("status")
        .eq("company_id", companyId),
      supabase
        .from("knowledge_sources")
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId)
        .eq("status", "ready"),
    ]);
    if (suggestions.error || knowledgeCount.error) {
      return res.status(500).json({ error: "learning_stats_failed" });
    }
    const rows = suggestions.data || [];
    return res.json({
      pending: rows.filter(row => row.status === "pending").length,
      approved: rows.filter(row => row.status === "approved").length,
      rejected: rows.filter(row => row.status === "rejected").length,
      total: rows.length,
      knowledge_base_size: knowledgeCount.count || 0,
    });
  });

  router.post("/manual", REVIEW_ROLES, async (req, res) => {
    const companyId = resolveCompanyId(req, req.body?.company_id);
    if (companyId === false) return res.status(403).json({ error: "forbidden_cross_tenant" });
    if (!companyId) return res.status(400).json({ error: "company_id_required" });
    try {
      const result = await knowledge.createQaSource({
        companyId,
        type: "manual",
        question: req.body?.question,
        answer: req.body?.answer,
        category: req.body?.category || "FAQ",
        createdBy: req.user?.profile?.id || null,
        metadata: { created_via: "learning_manual", approved_by: req.user.id },
      });
      return res.status(201).json({ success: true, knowledge_source_id: result.source.id, ...result });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.code || "learning_manual_failed" });
    }
  });

  async function detectAllCompanies() {
    const { data: companies, error } = await supabase
      .from("companies")
      .select("id, name")
      .eq("status", "active");
    if (error) throw error;
    let inserted = 0;
    for (const company of companies || []) {
      try {
        inserted += await detectPatternsForCompany({
          supabase,
          companyId: company.id,
          fetchImpl,
        });
      } catch (errorForCompany) {
        console.error(`[LEARNING] ${company.id}:`, errorForCompany.message);
      }
    }
    return inserted;
  }

  return { router, detectAllCompanies };
}

let defaultModule;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  const ragService = createRagService({ supabase });
  const knowledgeService = createKnowledgeService({ supabase, ragService });
  defaultModule = createLearningModule({ supabase, ragService, knowledgeService });
} else {
  defaultModule = { router: express.Router(), detectAllCompanies: async () => 0 };
  defaultModule.router.use((_req, res) => res.status(503).json({ error: "learning_not_configured" }));
}

export function detectPatternsForAllCompanies() {
  return defaultModule.detectAllCompanies();
}

export default defaultModule.router;
