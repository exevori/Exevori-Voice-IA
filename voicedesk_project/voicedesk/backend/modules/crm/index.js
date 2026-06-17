// ============================================================
// VOICEDESK IA — MODULE CRM
// Gestion des contacts + notes + historique
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
// GET /api/v1/contacts
// Liste des contacts avec filtres
// ─────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const {
    company_id,
    status,
    source,
    urgency,
    search,
    tag,
    sort = "last_interaction_at",
    order = "desc",
    limit = 50,
    offset = 0,
  } = req.query;

  try {
    let query = supabase
      .from("contacts")
      .select("*", { count: "exact" })
      .eq("company_id", company_id);

    if (status) query = query.eq("status", status);
    if (source) query = query.eq("source", source);
    if (urgency) query = query.eq("urgency", urgency);
    if (tag) query = query.contains("tags", [tag]);
    if (search) {
      query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%,company.ilike.%${search}%`);
    }

    const { data, error, count } = await query
      .order(sort, { ascending: order === "asc" })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (error) throw error;
    return res.json({ contacts: data || [], total: count, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/contacts
// Créer un contact
// ─────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  const {
    company_id, full_name, first_name, last_name, email, phone,
    company, status = "new", source = "manual", main_need, budget,
    urgency = "normal", tags, notes, next_action,
  } = req.body;

  if (!company_id || !full_name) {
    return res.status(400).json({ error: "company_id et full_name requis" });
  }

  try {
    // Vérifier les doublons par téléphone ou email
    if (phone || email) {
      const orFilter = [];
      if (phone) orFilter.push(`phone.eq.${phone}`);
      if (email) orFilter.push(`email.eq.${email}`);

      const { data: existing } = await supabase
        .from("contacts")
        .select("id, full_name")
        .eq("company_id", company_id)
        .or(orFilter.join(","))
        .limit(1)
        .maybeSingle();

      if (existing) {
        return res.status(409).json({
          error: "duplicate_contact",
          message: "Un contact existe déjà avec ce téléphone ou courriel",
          existing_contact: existing,
        });
      }
    }

    const { data, error } = await supabase
      .from("contacts")
      .insert({
        company_id, full_name, first_name, last_name, email, phone,
        company, status, source, main_need, budget, urgency,
        tags, notes, next_action,
      })
      .select()
      .single();

    if (error) throw error;
    return res.json({ success: true, contact: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/contacts/:id
// Détail complet d'un contact + tout son historique
// ─────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const [contact, notes, calls, outboundCalls, emails, appointments] = await Promise.all([
      supabase.from("contacts").select("*").eq("id", id).single(),
      supabase.from("contact_notes").select("*").eq("contact_id", id).order("created_at", { ascending: false }),
      supabase.from("calls").select("*").eq("contact_id", id).order("created_at", { ascending: false }),
      supabase.from("outbound_calls").select("*").eq("contact_id", id).order("created_at", { ascending: false }),
      supabase.from("emails").select("*").eq("contact_id", id).order("received_at", { ascending: false }),
      supabase.from("appointments").select("*").eq("contact_id", id).order("date", { ascending: false }),
    ]);

    if (!contact.data) return res.status(404).json({ error: "Contact introuvable" });

    // Hésitations IA liées aux appels de ce contact (source = "call:<call_id>")
    const callIds = (calls.data || []).map((c) => c.id).filter(Boolean);
    let learningSuggestions = [];
    if (callIds.length > 0) {
      const sources = callIds.map((cid) => `call:${cid}`);
      const { data: ls } = await supabase
        .from("learning_suggestions")
        .select("*")
        .eq("company_id", contact.data.company_id)
        .in("source", sources)
        .order("detected_at", { ascending: false });
      learningSuggestions = ls || [];
    }

    return res.json({
      contact: contact.data,
      history: {
        notes: notes.data || [],
        calls: calls.data || [],
        outbound_calls: outboundCalls.data || [],
        emails: emails.data || [],
        appointments: appointments.data || [],
        learning_suggestions: learningSuggestions,
      },
      stats: {
        total_interactions:
          (notes.data?.length || 0) +
          (calls.data?.length || 0) +
          (outboundCalls.data?.length || 0) +
          (emails.data?.length || 0),
        total_appointments: appointments.data?.length || 0,
        pending_learning_suggestions: learningSuggestions.filter((s) => s.status === "pending").length,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/v1/contacts/:id
// Modifier un contact
// ─────────────────────────────────────────────────────────────
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const updates = { ...req.body, updated_at: new Date() };
  delete updates.id;
  delete updates.created_at;
  delete updates.company_id; // company_id ne change jamais

  try {
    const { data, error } = await supabase
      .from("contacts")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    return res.json({ success: true, contact: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/v1/contacts/:id
// Supprimer (soft delete recommandé en prod)
// ─────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabase.from("contacts").delete().eq("id", id);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/contacts/lookup
// Recherche par téléphone ou email (utilisé par voice/inbound)
// ─────────────────────────────────────────────────────────────
router.get("/lookup/find", async (req, res) => {
  const { company_id, phone, email } = req.query;

  if (!company_id || (!phone && !email)) {
    return res.status(400).json({ error: "company_id + phone ou email requis" });
  }

  try {
    let query = supabase.from("contacts").select("*").eq("company_id", company_id);
    if (phone) query = query.eq("phone", phone);
    else if (email) query = query.eq("email", email);

    const { data } = await query.maybeSingle();
    return res.json({ contact: data || null, found: !!data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/contacts/:id/notes
// Ajouter une note manuelle à un contact
// ─────────────────────────────────────────────────────────────
router.post("/:id/notes", async (req, res) => {
  const { id } = req.params;
  const { company_id, note, next_action, created_by, direction = "manual" } = req.body;

  try {
    const { data, error } = await supabase
      .from("contact_notes")
      .insert({
        company_id,
        contact_id: id,
        direction,
        note,
        next_action,
        created_by: created_by || "manual",
      })
      .select()
      .single();

    if (error) throw error;

    // Mettre à jour le contact (last_interaction_at + next_action)
    await supabase
      .from("contacts")
      .update({
        last_interaction_at: new Date(),
        next_action: next_action || undefined,
      })
      .eq("id", id);

    return res.json({ success: true, note: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/contacts/stats/overview
// Statistiques CRM pour le dashboard
// ─────────────────────────────────────────────────────────────
router.get("/stats/overview", async (req, res) => {
  const { company_id } = req.query;

  try {
    const { data } = await supabase
      .from("contacts")
      .select("status, source, urgency")
      .eq("company_id", company_id);

    const stats = {
      total: data?.length || 0,
      by_status: {},
      by_source: {},
      by_urgency: { high: 0, normal: 0, low: 0 },
      hot_leads: 0,
      to_callback: 0,
      appointments_set: 0,
      new_this_week: 0,
    };

    (data || []).forEach(c => {
      stats.by_status[c.status] = (stats.by_status[c.status] || 0) + 1;
      stats.by_source[c.source] = (stats.by_source[c.source] || 0) + 1;
      if (c.urgency) stats.by_urgency[c.urgency] = (stats.by_urgency[c.urgency] || 0) + 1;
      if (c.status === "hot_lead") stats.hot_leads++;
      if (c.status === "callback_required") stats.to_callback++;
      if (c.status === "appointment_set") stats.appointments_set++;
    });

    return res.json(stats);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
