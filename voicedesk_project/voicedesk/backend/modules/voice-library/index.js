// ============================================================
// VOICEDESK IA — MODULE VOICE LIBRARY (Multi-voix)
//
// Architecture flexible permettant à Exevori de gérer les voix
// ElevenLabs sans limites codées en dur.
//
// Inspiré du SDK officiel @elevenlabs/elevenlabs-js
//
// Fonctionnalités :
//   1. Catalogue de voix gérables par l'admin Exevori
//   2. Attribution voix → service par entreprise
//   3. Voix par scénario, par agent IA (extensible)
//   4. Limites gérées par les forfaits (plan_limits)
//   5. Sync avec ElevenLabs (récupération automatique)
//   6. Préparation pour clonage et voix custom
// ============================================================

import express from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ELEVENLABS_API = "https://api.elevenlabs.io/v1";
const router = express.Router();

// ─────────────────────────────────────────────────────────────
// CATALOGUE DE VOIX (Admin Exevori)
// ─────────────────────────────────────────────────────────────

// GET /api/v1/voice-library
// Liste toutes les voix du catalogue (filtrable)
router.get("/", async (req, res) => {
  const { category, language, accent, gender, is_premium, search } = req.query;

  try {
    let query = supabase
      .from("voice_library")
      .select("*")
      .eq("is_active", true);

    if (category) query = query.eq("category", category);
    // language peut être 'fr-CA', 'fr-FR', 'fr' (matche tout français), 'en', etc.
    if (language) {
      if (language === "fr") {
        // Toutes les voix françaises (FR-CA, FR-FR, multilingue)
        query = query.or("language.eq.fr-CA,language.eq.fr-FR,language.eq.multi,languages_supported.cs.{fr-CA},languages_supported.cs.{fr-FR}");
      } else if (language === "en") {
        query = query.or("language.eq.en-CA,language.eq.en-US,language.eq.multi,languages_supported.cs.{en-CA},languages_supported.cs.{en-US}");
      } else {
        query = query.contains("languages_supported", [language]);
      }
    }
    if (accent) query = query.eq("accent", accent);
    if (gender) query = query.eq("gender", gender);
    if (is_premium !== undefined) query = query.eq("is_premium", is_premium === "true");
    if (search) {
      query = query.or(`name.ilike.%${search}%,description_fr.ilike.%${search}%,description_en.ilike.%${search}%`);
    }

    const { data, error } = await query.order("display_name");
    if (error) throw error;

    // Grouper par accent pour faciliter le rendu UI
    const grouped = {
      quebec: [],
      france: [],
      multilingual: [],
      other: [],
    };
    (data || []).forEach(v => {
      if (v.accent === "quebec") grouped.quebec.push(v);
      else if (v.accent === "france") grouped.france.push(v);
      else if (v.language === "multi") grouped.multilingual.push(v);
      else grouped.other.push(v);
    });

    return res.json({ voices: data || [], grouped });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/voice-library/:id
router.get("/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("voice_library")
    .select("*")
    .eq("id", req.params.id)
    .single();

  if (error) return res.status(404).json({ error: "Voix introuvable" });
  return res.json({ voice: data });
});

// POST /api/v1/voice-library  (Admin only)
// Ajouter une nouvelle voix au catalogue
router.post("/", async (req, res) => {
  const {
    external_voice_id, provider = "elevenlabs", name, display_name,
    description_fr, description_en, gender, language = "fr-CA",
    languages_supported, category = "general", style, accent,
    preview_url, preview_text_fr, preview_text_en,
    default_settings, tags, is_premium = false, required_plan,
    added_by, notes_admin,
  } = req.body;

  if (!external_voice_id || !name) {
    return res.status(400).json({ error: "external_voice_id et name requis" });
  }

  try {
    const { data, error } = await supabase
      .from("voice_library")
      .insert({
        external_voice_id, provider, name, display_name: display_name || name,
        description_fr, description_en, gender, language, languages_supported,
        category, style, accent, preview_url, preview_text_fr, preview_text_en,
        default_settings, tags, is_premium, required_plan, added_by, notes_admin,
      })
      .select()
      .single();

    if (error) throw error;
    return res.json({ success: true, voice: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/v1/voice-library/:id  (Admin only)
router.patch("/:id", async (req, res) => {
  const updates = { ...req.body, updated_at: new Date() };
  delete updates.id;

  try {
    const { data, error } = await supabase
      .from("voice_library")
      .update(updates)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw error;
    return res.json({ success: true, voice: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/voice-library/:id/deactivate  (Admin only)
router.post("/:id/deactivate", async (req, res) => {
  await supabase
    .from("voice_library")
    .update({ is_active: false, updated_at: new Date() })
    .eq("id", req.params.id);
  return res.json({ success: true });
});

// POST /api/v1/voice-library/sync-elevenlabs  (Admin only)
// Récupère toutes les voix disponibles dans le compte ElevenLabs
router.post("/sync-elevenlabs", async (req, res) => {
  try {
    const response = await fetch(`${ELEVENLABS_API}/voices`, {
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
    });

    if (!response.ok) throw new Error("Erreur API ElevenLabs");
    const { voices } = await response.json();

    let added = 0, skipped = 0;
    for (const v of voices) {
      // Vérifier si déjà dans le catalogue
      const { data: existing } = await supabase
        .from("voice_library")
        .select("id")
        .eq("external_voice_id", v.voice_id)
        .maybeSingle();

      if (existing) { skipped++; continue; }

      // Ajouter au catalogue avec status inactif (admin doit valider)
      await supabase.from("voice_library").insert({
        external_voice_id: v.voice_id,
        provider: "elevenlabs",
        name: v.name,
        display_name: v.name,
        description_en: v.description || "",
        gender: v.labels?.gender || "neutral",
        category: v.category || "general",
        accent: v.labels?.accent || null,
        preview_url: v.preview_url,
        languages_supported: ["en-US"],
        is_active: false,  // Admin doit valider et activer
        notes_admin: "Importé automatiquement depuis ElevenLabs - à valider",
      });
      added++;
    }

    return res.json({ success: true, added, skipped, total: voices.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/voice-library/:id/test
// Tester une voix avec un texte personnalisé
router.post("/:id/test", async (req, res) => {
  const { id } = req.params;
  const { text, language = "fr-CA" } = req.body;

  try {
    const { data: voice } = await supabase
      .from("voice_library")
      .select("*")
      .eq("id", id)
      .single();

    if (!voice) return res.status(404).json({ error: "Voix introuvable" });

    const testText = text || (language === "en-CA" ? voice.preview_text_en : voice.preview_text_fr) ||
                     "Bonjour, c'est un test de voix.";

    const ttsResponse = await fetch(
      `${ELEVENLABS_API}/text-to-speech/${voice.external_voice_id}/stream`,
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: testText,
          model_id: "eleven_flash_v2_5",
          voice_settings: voice.default_settings,
        }),
      }
    );

    if (!ttsResponse.ok) throw new Error("ElevenLabs TTS error");
    res.setHeader("Content-Type", "audio/mpeg");
    ttsResponse.body.pipe(res);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// SERVICES (Configurables par entreprise)
// ─────────────────────────────────────────────────────────────

// GET /api/v1/services?company_id=...
router.get("/services/list", async (req, res) => {
  const { company_id } = req.query;

  const { data, error } = await supabase
    .from("services")
    .select("*")
    .eq("company_id", company_id)
    .order("display_order");

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ services: data || [] });
});

// POST /api/v1/services
router.post("/services/create", async (req, res) => {
  const {
    company_id, code, name_fr, name_en, description_fr, description_en,
    icon, color, scenario_triggers, business_hours, transfer_phone,
  } = req.body;

  if (!company_id || !code || !name_fr) {
    return res.status(400).json({ error: "company_id, code, name_fr requis" });
  }

  try {
    // Vérifier limite forfait
    await checkPlanLimit(company_id, "max_services", "services");

    const { data, error } = await supabase
      .from("services")
      .insert({
        company_id, code, name_fr, name_en, description_fr, description_en,
        icon, color, scenario_triggers, business_hours, transfer_phone,
      })
      .select()
      .single();

    if (error) throw error;
    return res.json({ success: true, service: data });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// PATCH /api/v1/services/:id
router.patch("/services/:id", async (req, res) => {
  const updates = { ...req.body, updated_at: new Date() };
  delete updates.id;
  delete updates.company_id;

  const { data, error } = await supabase
    .from("services")
    .update(updates)
    .eq("id", req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true, service: data });
});

// DELETE /api/v1/services/:id  (soft delete)
router.delete("/services/:id", async (req, res) => {
  await supabase
    .from("services")
    .update({ is_active: false })
    .eq("id", req.params.id);
  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// VOICE ASSIGNMENTS (Lien voix → service)
// ─────────────────────────────────────────────────────────────

// GET /api/v1/voice-assignments?company_id=...
router.get("/assignments/list", async (req, res) => {
  const { company_id, service_id } = req.query;

  let query = supabase
    .from("voice_assignments")
    .select("*, voice_library(*), services(*)")
    .eq("company_id", company_id);

  if (service_id) query = query.eq("service_id", service_id);

  const { data, error } = await query.order("display_order");
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ assignments: data || [] });
});

// POST /api/v1/voice-assignments
router.post("/assignments/create", async (req, res) => {
  const {
    company_id, voice_library_id, service_id, scenario, agent_profile_id,
    language = "fr-CA", custom_settings, custom_name, is_default = false,
  } = req.body;

  if (!company_id || !voice_library_id || !service_id) {
    return res.status(400).json({ error: "company_id, voice_library_id, service_id requis" });
  }

  try {
    // Vérifier limite forfait
    await checkPlanLimit(company_id, "max_voices", "voice_assignments");

    // Vérifier que la voix est accessible au forfait
    const { data: voice } = await supabase
      .from("voice_library")
      .select("is_premium")
      .eq("id", voice_library_id)
      .single();

    if (voice?.is_premium) {
      const { data: limits } = await getPlanLimitsForCompany(company_id);
      if (!limits?.premium_voices_enabled) {
        return res.status(403).json({
          error: "premium_voice_locked",
          message: "Cette voix premium nécessite un forfait supérieur",
        });
      }
    }

    // Si is_default = true, désactiver les autres defaults du même service
    if (is_default) {
      await supabase
        .from("voice_assignments")
        .update({ is_default: false })
        .eq("company_id", company_id)
        .eq("service_id", service_id)
        .eq("language", language);
    }

    const { data, error } = await supabase
      .from("voice_assignments")
      .insert({
        company_id, voice_library_id, service_id, scenario, agent_profile_id,
        language, custom_settings, custom_name, is_default,
      })
      .select("*, voice_library(*), services(*)")
      .single();

    if (error) throw error;
    return res.json({ success: true, assignment: data });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /api/v1/voice-assignments/:id
router.delete("/assignments/:id", async (req, res) => {
  await supabase
    .from("voice_assignments")
    .delete()
    .eq("id", req.params.id);
  return res.json({ success: true });
});

// GET /api/v1/voice-assignments/resolve
// Trouver quelle voix utiliser pour un contexte donné
// Utilisé par voice/inbound.js et voice/outbound.js
router.get("/assignments/resolve", async (req, res) => {
  const { company_id, service_code, scenario, language = "fr-CA" } = req.query;

  try {
    // 1. Si scenario fourni, chercher d'abord par scenario
    let query = supabase
      .from("voice_assignments")
      .select("*, voice_library(*), services(*)")
      .eq("company_id", company_id)
      .eq("language", language);

    if (service_code) {
      const { data: service } = await supabase
        .from("services")
        .select("id")
        .eq("company_id", company_id)
        .eq("code", service_code)
        .single();

      if (service) query = query.eq("service_id", service.id);
    }

    // Préférer le scénario si correspondance
    if (scenario) {
      const withScenario = await query.eq("scenario", scenario).maybeSingle();
      if (withScenario.data) return res.json({ assignment: withScenario.data });
    }

    // Sinon, prendre le default
    const { data, error } = await query.eq("is_default", true).maybeSingle();

    // Fallback : première voix assignée
    if (!data) {
      const { data: fallback } = await supabase
        .from("voice_assignments")
        .select("*, voice_library(*)")
        .eq("company_id", company_id)
        .eq("language", language)
        .limit(1)
        .maybeSingle();

      return res.json({ assignment: fallback, fallback: true });
    }

    return res.json({ assignment: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PLAN LIMITS (Gestion des limites par forfait)
// ─────────────────────────────────────────────────────────────

// GET /api/v1/voice-library/plan-limits/:company_id
router.get("/plan-limits/:company_id", async (req, res) => {
  const limits = await getPlanLimitsForCompany(req.params.company_id);
  return res.json({ limits: limits.data });
});

// GET /api/v1/voice-library/plan-limits-admin (Admin Exevori only)
router.get("/plan-limits-admin/list", async (req, res) => {
  const { data, error } = await supabase
    .from("plan_limits")
    .select("*")
    .order("plan_name");

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ plans: data || [] });
});

// PATCH /api/v1/voice-library/plan-limits/:plan_name (Admin only)
router.patch("/plan-limits-admin/:plan_name", async (req, res) => {
  const updates = { ...req.body, updated_at: new Date() };

  const { data, error } = await supabase
    .from("plan_limits")
    .update(updates)
    .eq("plan_name", req.params.plan_name)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true, plan: data });
});

// ─────────────────────────────────────────────────────────────
// FONCTIONS UTILITAIRES
// ─────────────────────────────────────────────────────────────

async function getPlanLimitsForCompany(company_id) {
  const { data: company } = await supabase
    .from("companies")
    .select("plan")
    .eq("id", company_id)
    .single();

  if (!company) return { data: null };

  return await supabase
    .from("plan_limits")
    .select("*")
    .eq("plan_name", company.plan)
    .single();
}

async function checkPlanLimit(company_id, limit_field, count_table) {
  const { data: limits } = await getPlanLimitsForCompany(company_id);
  if (!limits) return; // Pas de limite

  const max = limits[limit_field];
  if (max === null || max >= 99) return; // Illimité

  const { count } = await supabase
    .from(count_table)
    .select("*", { count: "exact", head: true })
    .eq("company_id", company_id);

  if (count >= max) {
    const err = new Error(`Limite atteinte pour votre forfait : ${max} ${limit_field}`);
    err.status = 403;
    err.code = "plan_limit_reached";
    throw err;
  }
}

export default router;
