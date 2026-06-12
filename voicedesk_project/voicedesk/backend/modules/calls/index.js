// ============================================================
// EXEVORI VOICE IA — MODULE CALLS
// GET /api/v1/calls            (liste filtrée)
// GET /api/v1/calls/:id        (détail + transcript + contact)
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

// ─────────────────────────────────────────────────────────────
// GET /api/v1/calls
// Filtres: status, intent, search, date_from, date_to, limit, offset
// ─────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const {
    company_id,
    status,
    intent,
    search,
    date_from,
    date_to,
    sort = "created_at",
    order = "desc",
    limit = 50,
    offset = 0,
  } = req.query;

  if (!company_id) {
    return res.status(400).json({ error: "company_id requis" });
  }

  try {
    let query = supabase
      .from("calls")
      .select("*", { count: "exact" })
      .eq("company_id", company_id);

    if (status) query = query.eq("status", status);
    if (intent) query = query.eq("intent", intent);
    if (date_from) query = query.gte("created_at", date_from);
    if (date_to)   query = query.lte("created_at", date_to);
    if (search) {
      query = query.or(
        `caller_name.ilike.%${search}%,caller_phone.ilike.%${search}%,ai_summary.ilike.%${search}%,intent.ilike.%${search}%`
      );
    }

    const { data, error, count } = await query
      .order(sort, { ascending: order === "asc" })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (error) throw error;

    // Enrichir avec full_name du contact (best-effort)
    const contactIds = [...new Set((data || []).map((c) => c.contact_id).filter(Boolean))];
    let contactMap = {};
    if (contactIds.length > 0) {
      const { data: contacts } = await supabase
        .from("contacts")
        .select("id, full_name, status")
        .in("id", contactIds);
      contactMap = Object.fromEntries((contacts || []).map((c) => [c.id, c]));
    }
    const enriched = (data || []).map((c) => ({
      ...c,
      contact: c.contact_id ? contactMap[c.contact_id] || null : null,
    }));

    return res.json({
      calls: enriched,
      total: count,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/calls/stats
// Mini-stats (counts par status) pour les filter-bars
// ─────────────────────────────────────────────────────────────
router.get("/stats", async (req, res) => {
  const { company_id } = req.query;
  if (!company_id) return res.status(400).json({ error: "company_id requis" });

  try {
    const { data, error } = await supabase
      .from("calls")
      .select("status, intent")
      .eq("company_id", company_id);
    if (error) throw error;

    const stats = {
      total: data?.length || 0,
      by_status: {},
      by_intent: {},
    };
    (data || []).forEach((c) => {
      if (c.status) stats.by_status[c.status] = (stats.by_status[c.status] || 0) + 1;
      if (c.intent) stats.by_intent[c.intent] = (stats.by_intent[c.intent] || 0) + 1;
    });
    return res.json(stats);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/calls/:id
// Détail complet + contact + parse transcript
// ─────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const { data: call, error } = await supabase
      .from("calls")
      .select("*")
      .eq("id", id)
      .single();
    if (error || !call) {
      return res.status(404).json({ error: "Appel introuvable" });
    }

    let contact = null;
    if (call.contact_id) {
      const { data: c } = await supabase
        .from("contacts")
        .select("id, full_name, email, phone, company, status, urgency")
        .eq("id", call.contact_id)
        .maybeSingle();
      contact = c || null;
    }

    // Parse défensif du transcript :
    //  - tableau JSON  → [{role, text, ts}]
    //  - string JSON   → parser puis idem
    //  - texte brut    → un seul bloc { role: "transcript", text }
    //  - null          → []
    const transcript = parseTranscript(call.ai_transcript);

    return res.json({
      call: { ...call, contact },
      transcript,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

function parseTranscript(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") return [raw];
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        // fallthrough : texte brut
      }
    }
    return [{ role: "transcript", text: trimmed }];
  }
  return [];
}

export default router;
