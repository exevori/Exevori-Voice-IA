// ============================================================
// VOICEDESK IA — MODULE ONBOARDING
// Workflow 4 étapes pour les nouveaux clients
//   1. Configuration de l'assistante (nom, ton, langue)
//   2. Choix de la voix (parmi le voice_library)
//   3. Services + connaissances de base
//   4. Test d'appel
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

const TOTAL_STEPS = 4;

// Services par défaut créés automatiquement
const DEFAULT_SERVICES = [
  { code: "reception", name_fr: "Réception", name_en: "Reception", icon: "Phone", color: "#3B82F6", display_order: 1 },
  { code: "appointments", name_fr: "Rendez-vous", name_en: "Appointments", icon: "Calendar", color: "#8B5CF6", display_order: 2 },
  { code: "support", name_fr: "Support client", name_en: "Customer support", icon: "MessageCircle", color: "#10B981", display_order: 3 },
  { code: "outbound", name_fr: "Appels sortants", name_en: "Outbound calls", icon: "PhoneOutgoing", color: "#F59E0B", display_order: 4 },
];

// ─────────────────────────────────────────────────────────────
// GET /api/v1/onboarding
// État de progression de l'onboarding
// ─────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const { company_id } = req.query;
  if (!company_id) return res.status(400).json({ error: "company_id requis" });

  try {
    const { data: progress } = await supabase
      .from("onboarding_progress")
      .select("*")
      .eq("company_id", company_id)
      .single();

    const { data: company } = await supabase
      .from("companies")
      .select("*")
      .eq("id", company_id)
      .single();

    const { data: config } = await supabase
      .from("assistant_configs")
      .select("*")
      .eq("company_id", company_id)
      .maybeSingle();

    if (!progress) {
      // Initialiser le progress
      await supabase.from("onboarding_progress").insert({
        company_id,
        current_step: 1,
        completed_steps: [],
      });

      return res.json({
        progress: { current_step: 1, completed_steps: [], total_steps: TOTAL_STEPS },
        company,
        config: null,
        next_action: "Étape 1 — Configurer votre assistante",
      });
    }

    return res.json({
      progress: { ...progress, total_steps: TOTAL_STEPS },
      company,
      config,
      next_action: getNextActionLabel(progress.current_step),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/onboarding/step/1
// Étape 1 — Configuration de base de l'assistante
// ─────────────────────────────────────────────────────────────
router.post("/step/1", async (req, res) => {
  const {
    company_id, assistant_name, assistant_gender = "feminine",
    tone = "professional", preferred_language = "fr-CA",
  } = req.body;

  if (!company_id || !assistant_name) {
    return res.status(400).json({ error: "company_id et assistant_name requis" });
  }

  try {
    // Sauvegarder dans companies
    await supabase
      .from("companies")
      .update({ assistant_name, preferred_language, updated_at: new Date() })
      .eq("id", company_id);

    // Créer/mettre à jour assistant_configs
    const { data: company } = await supabase
      .from("companies")
      .select("name, sector")
      .eq("id", company_id)
      .single();

    const companyName = company?.name || "votre entreprise";
    const pronounFR = assistant_gender === "masculine" ? "il" : assistant_gender === "neutral" ? "iel" : "elle";
    const pronounEN = assistant_gender === "masculine" ? "he" : assistant_gender === "neutral" ? "they" : "she";

    await supabase
      .from("assistant_configs")
      .upsert({
        company_id,
        assistant_name,
        assistant_gender,
        assistant_pronoun_fr: pronounFR,
        assistant_pronoun_en: pronounEN,
        tone,
        language_primary: preferred_language,
        greeting_inbound_fr: `Bonjour, ici ${companyName}. Je suis ${assistant_name}, comment puis-je vous aider?`,
        greeting_inbound_en: `Hello, this is ${companyName}. I'm ${assistant_name}, how may I help you?`,
        updated_at: new Date(),
      }, { onConflict: "company_id" });

    // Avancer dans le workflow
    await markStepComplete(company_id, 1);

    return res.json({
      success: true,
      next_step: 2,
      message: "Configuration de base sauvegardée",
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/onboarding/step/2
// Étape 2 — Choix de la voix
// ─────────────────────────────────────────────────────────────
router.post("/step/2", async (req, res) => {
  const { company_id, voice_library_id, voice_settings } = req.body;

  if (!company_id || !voice_library_id) {
    return res.status(400).json({ error: "company_id et voice_library_id requis" });
  }

  try {
    // Récupérer la voix choisie
    const { data: voice } = await supabase
      .from("voice_library")
      .select("external_voice_id, default_settings")
      .eq("id", voice_library_id)
      .single();

    if (!voice) return res.status(404).json({ error: "Voix introuvable" });

    // Sauvegarder dans assistant_configs
    await supabase
      .from("assistant_configs")
      .update({
        voice_id: voice.external_voice_id,
        voice_stability: voice_settings?.stability || voice.default_settings?.stability || 0.8,
        voice_similarity: voice_settings?.similarity || voice.default_settings?.similarity_boost || 0.9,
        voice_speed: voice_settings?.speed || voice.default_settings?.speed || 1.0,
        updated_at: new Date(),
      })
      .eq("company_id", company_id);

    // Créer les services par défaut + voice_assignments
    await createDefaultServicesAndAssignments(company_id, voice_library_id);

    await markStepComplete(company_id, 2);

    return res.json({ success: true, next_step: 3 });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/onboarding/step/3
// Étape 3 — Services activés + connaissances de base
// ─────────────────────────────────────────────────────────────
router.post("/step/3", async (req, res) => {
  const {
    company_id,
    services_enabled = [],   // Array de codes de services
    knowledge_entries = [],  // Array de {question, answer, category}
  } = req.body;

  try {
    // Activer/désactiver les services
    if (services_enabled.length > 0) {
      const { data: allServices } = await supabase
        .from("services")
        .select("id, code")
        .eq("company_id", company_id);

      for (const service of allServices || []) {
        const enabled = services_enabled.includes(service.code);
        await supabase
          .from("services")
          .update({ is_active: enabled })
          .eq("id", service.id);
      }
    }

    // Importer les connaissances de base
    if (knowledge_entries.length > 0) {
      const records = knowledge_entries
        .filter(e => e.question && e.answer)
        .map(e => ({
          company_id,
          question: e.question,
          answer: e.answer,
          category: e.category || "FAQ",
          status: "active",
          source: "onboarding",
        }));

      if (records.length > 0) {
        await supabase.from("knowledge_base").insert(records);
      }
    }

    await markStepComplete(company_id, 3);
    return res.json({
      success: true,
      next_step: 4,
      services_count: services_enabled.length,
      knowledge_count: knowledge_entries.length,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/onboarding/step/4
// Étape 4 — Test d'appel (déclenchement)
// ─────────────────────────────────────────────────────────────
router.post("/step/4", async (req, res) => {
  const { company_id, test_phone_number, twilio_number } = req.body;

  try {
    // Sauvegarder le numéro Twilio assigné si fourni
    if (twilio_number) {
      await supabase
        .from("assistant_configs")
        .update({ twilio_number, updated_at: new Date() })
        .eq("company_id", company_id);
    }

    // Déclencher un appel test si demandé
    if (test_phone_number) {
      try {
        const callResponse = await fetch(`${process.env.VOICE_OUTBOUND_URL}/outbound/call`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            company_id,
            to_phone: test_phone_number,
            context: "onboarding_test",
            opening_script_fr: "Bonjour, c'est un appel test depuis VoiceDesk. Tout fonctionne correctement!",
          }),
        });
        if (!callResponse.ok) {
          console.warn("[ONBOARDING] Appel test échoué, mais on continue");
        }
      } catch (e) {
        console.warn("[ONBOARDING] Voice server non disponible:", e.message);
      }
    }

    await markStepComplete(company_id, 4);

    // Marquer l'onboarding comme complet
    await supabase
      .from("onboarding_progress")
      .update({ completed_at: new Date() })
      .eq("company_id", company_id);

    return res.json({
      success: true,
      message: "Configuration terminée!",
      onboarding_complete: true,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/onboarding/skip
// Sauter une étape (pour les utilisateurs avancés)
// ─────────────────────────────────────────────────────────────
router.post("/skip", async (req, res) => {
  const { company_id, step } = req.body;
  await markStepComplete(company_id, step);
  return res.json({ success: true, next_step: step + 1 });
});

// ─────────────────────────────────────────────────────────────
// FONCTIONS UTILITAIRES
// ─────────────────────────────────────────────────────────────

async function markStepComplete(company_id, step) {
  const { data: current } = await supabase
    .from("onboarding_progress")
    .select("completed_steps")
    .eq("company_id", company_id)
    .single();

  const completedSteps = current?.completed_steps || [];
  if (!completedSteps.includes(step)) completedSteps.push(step);

  const nextStep = Math.min(step + 1, TOTAL_STEPS);

  await supabase
    .from("onboarding_progress")
    .upsert({
      company_id,
      current_step: nextStep,
      completed_steps: completedSteps,
    }, { onConflict: "company_id" });
}

async function createDefaultServicesAndAssignments(company_id, voice_library_id) {
  // Créer les services par défaut s'ils n'existent pas
  for (const service of DEFAULT_SERVICES) {
    const { data: existing } = await supabase
      .from("services")
      .select("id")
      .eq("company_id", company_id)
      .eq("code", service.code)
      .maybeSingle();

    let serviceId = existing?.id;

    if (!serviceId) {
      const { data: newService } = await supabase
        .from("services")
        .insert({ ...service, company_id, is_active: true })
        .select("id")
        .single();
      serviceId = newService.id;
    }

    // Créer le voice assignment pour ce service
    if (serviceId) {
      const { data: existingAssignment } = await supabase
        .from("voice_assignments")
        .select("id")
        .eq("company_id", company_id)
        .eq("service_id", serviceId)
        .eq("voice_library_id", voice_library_id)
        .eq("language", "fr-CA")
        .maybeSingle();

      if (!existingAssignment) {
        await supabase.from("voice_assignments").insert({
          company_id,
          voice_library_id,
          service_id: serviceId,
          language: "fr-CA",
          is_default: service.code === "reception",
        });
      }
    }
  }
}

function getNextActionLabel(currentStep) {
  const labels = {
    1: "Étape 1 — Configurer votre assistante",
    2: "Étape 2 — Choisir la voix",
    3: "Étape 3 — Services + connaissances",
    4: "Étape 4 — Test d'appel",
  };
  return labels[currentStep] || "Configuration terminée";
}

export default router;
