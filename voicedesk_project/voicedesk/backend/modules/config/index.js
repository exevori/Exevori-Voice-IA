// ============================================================
// VOICEDESK IA — MODULE CONFIG ASSISTANTE
// Configuration personnalisée par PME (nom, voix, ton, etc.)
// LE différenciateur multi-tenant
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

// Voix ElevenLabs recommandées par défaut
// Note : la liste complète et configurable est dans voice_library (Supabase)
// Ce tableau ne sert que de fallback minimal si voice_library n'est pas disponible
const RECOMMENDED_VOICES = [
  {
    id: "WW0JfNPk5DgcQdM0d6X6",
    name: "Léa",
    gender: "feminine",
    language: "fr-CA",
    accent: "québécois"
  },
  {
    id: "UJCi4DDncuo0VJDSIegj",
    name: "Sophie",
    gender: "feminine",
    language: "fr-CA",
    accent: "québécois"
  },
  {
    id: "4FLkNETtL5THnClfpjpb",
    name: "Alexandre",
    gender: "masculine",
    language: "fr-CA",
    accent: "québécois"
  },
  {
    id: "RTFg9niKcgGLDwa3RFlz",
    name: "Marc",
    gender: "masculine",
    language: "fr-CA",
    accent: "québécois"
  },
  {
    id: "uIZsnBL0YK1S5j69bAih",
    name: "Emma",
    gender: "feminine",
    language: "en-CA",
    accent: "neutral"
  },
  {
    id: "3IwIPyXc0WRkgKBE8KXP",
    name: "James",
    gender: "masculine",
    language: "en-CA",
    accent: "neutral"
  },
];

// Tones disponibles
const TONES = {
  professional: { label_fr: "Professionnel",        label_en: "Professional",   description: "Formel et courtois" },
  warm:         { label_fr: "Chaleureux",           label_en: "Warm",            description: "Amical et accueillant" },
  casual:       { label_fr: "Décontracté",          label_en: "Casual",          description: "Naturel et relax" },
  formal:       { label_fr: "Très formel",          label_en: "Very formal",     description: "Cabinet d'avocat, clinique" },
};

// ─────────────────────────────────────────────────────────────
// GET /api/v1/config
// Récupérer la configuration actuelle de l'assistante
// ─────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const { company_id } = req.query;

  try {
    const { data, error } = await supabase
      .from("assistant_configs")
      .select("*")
      .eq("company_id", company_id)
      .single();

    if (error && error.code !== "PGRST116") throw error;

    // Si pas de config, retourner un template vide
    if (!data) {
      return res.json({
        config: null,
        available_voices: RECOMMENDED_VOICES,
        available_tones: TONES,
      });
    }

    return res.json({
      config: data,
      available_voices: RECOMMENDED_VOICES,
      available_tones: TONES,
    });
  } catch (err) {
    console.error("[CONFIG] Get error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/config
// Créer la configuration initiale (pendant onboarding)
// ─────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  const {
    company_id,
    assistant_name,
    assistant_gender = "feminine",
    voice_id,
    tone = "professional",
    greeting_inbound_fr,
    greeting_inbound_en,
    greeting_outbound_fr,
    voicemail_message_fr,
    signature_email_fr,
    email_from,
    phone_mode = "both",
    twilio_number,
    transfer_phone,
    transfer_triggers,
  } = req.body;

  if (!company_id || !assistant_name) {
    return res.status(400).json({ error: "company_id et assistant_name requis" });
  }

  try {
    // Charger le nom de l'entreprise pour les prompts par défaut
    const { data: company } = await supabase
      .from("companies")
      .select("name, sector")
      .eq("id", company_id)
      .single();

    const companyName = company?.name || "votre entreprise";

    // Générer les prompts système par défaut si non fournis
    const defaultGreetingFR = greeting_inbound_fr ||
      `Bonjour, vous avez rejoint ${companyName}. Je suis ${assistant_name}, comment puis-je vous aider?`;

    const defaultGreetingEN = greeting_inbound_en ||
      `Hello, you've reached ${companyName}. This is ${assistant_name}, how may I help you?`;

    const pronounFR = assistant_gender === "masculine" ? "il" : assistant_gender === "neutral" ? "iel" : "elle";
    const pronounEN = assistant_gender === "masculine" ? "he" : assistant_gender === "neutral" ? "they" : "she";

    const defaultSystemPromptFR = `Tu es ${assistant_name}, l'assistant(e) IA de ${companyName}.
Tu réponds en français québécois naturel et professionnel.
Sois ${tone === "warm" ? "chaleureux et accueillant" : tone === "casual" ? "naturel et relax" : "professionnel et courtois"}.
Réponds en 2-3 phrases maximum.
Si tu ne sais pas quelque chose, dis-le honnêtement et propose de prendre un message.
Propose un rendez-vous si pertinent.`;

    const defaultSystemPromptEN = `You are ${assistant_name}, the AI assistant for ${companyName}.
Respond in natural professional English.
Be ${tone === "warm" ? "warm and welcoming" : tone === "casual" ? "natural and relaxed" : "professional and courteous"}.
Keep responses to 2-3 sentences maximum.
If you don't know something, say so honestly and offer to take a message.
Suggest scheduling a meeting if relevant.`;

    const { data, error } = await supabase
      .from("assistant_configs")
      .upsert({
        company_id,
        assistant_name,
        assistant_gender,
        assistant_pronoun_fr: pronounFR,
        assistant_pronoun_en: pronounEN,
        voice_id: voice_id || RECOMMENDED_VOICES[0].id,
        voice_model: "flash_v2_5",
        voice_stability: 0.8,
        voice_similarity: 0.9,
        voice_speed: 1.0,
        tone,
        language_primary: "fr-CA",
        greeting_inbound_fr: defaultGreetingFR,
        greeting_inbound_en: defaultGreetingEN,
        greeting_outbound_fr: greeting_outbound_fr || `Bonjour, je suis ${assistant_name} de ${companyName}.`,
        voicemail_message_fr: voicemail_message_fr || `Bonjour, vous avez un message de ${companyName}. N'hésitez pas à nous rappeler.`,
        signature_email_fr: signature_email_fr || `${assistant_name}\n${companyName}`,
        email_from: email_from || `${assistant_name.toLowerCase().replace(/\s+/g, "-")}@${companyName.toLowerCase().replace(/\s+/g, "-")}.ca`,
        email_auto_send_threshold: 85,
        twilio_number,
        phone_mode,
        transfer_phone,
        transfer_triggers: transfer_triggers || ["parler à quelqu'un", "un humain", "speak to someone"],
        system_prompt_fr: defaultSystemPromptFR,
        system_prompt_en: defaultSystemPromptEN,
        updated_at: new Date(),
      }, { onConflict: "company_id" })
      .select()
      .single();

    if (error) throw error;

    return res.json({ success: true, config: data });
  } catch (err) {
    console.error("[CONFIG] Create error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/v1/config
// Mettre à jour la configuration partiellement
// ─────────────────────────────────────────────────────────────
router.patch("/", async (req, res) => {
  const { company_id, ...updates } = req.body;

  if (!company_id) return res.status(400).json({ error: "company_id requis" });

  try {
    // Filtrer les champs interdits
    delete updates.id;
    delete updates.created_at;
    updates.updated_at = new Date();

    const { data, error } = await supabase
      .from("assistant_configs")
      .update(updates)
      .eq("company_id", company_id)
      .select()
      .single();

    if (error) throw error;
    return res.json({ success: true, config: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/config/voices
// Liste des voix disponibles (depuis voice_library)
// Filtres : ?language=fr (toutes FR) ou fr-CA ou fr-FR ou en
//           &accent=quebec|france|neutral|american
// ─────────────────────────────────────────────────────────────
router.get("/voices", async (req, res) => {
  const { language, accent } = req.query;

  try {
    let query = supabase.from("voice_library").select("*").eq("is_active", true);

    if (language === "fr") {
      query = query.or("language.eq.fr-CA,language.eq.fr-FR,language.eq.multi");
    } else if (language === "en") {
      query = query.or("language.eq.en-CA,language.eq.en-US,language.eq.multi");
    } else if (language) {
      query = query.eq("language", language);
    }
    if (accent) query = query.eq("accent", accent);

    const { data, error } = await query.order("display_name");

    if (error || !data || data.length === 0) {
      // Fallback sur la liste codée si voice_library vide
      return res.json({ voices: RECOMMENDED_VOICES, fallback: true });
    }

    return res.json({ voices: data, fallback: false });
  } catch (err) {
    return res.json({ voices: RECOMMENDED_VOICES, fallback: true });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/config/tones
// Tones disponibles
// ─────────────────────────────────────────────────────────────
router.get("/tones", (req, res) => {
  res.json({ tones: TONES });
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/config/test-voice
// Tester la voix avec un texte personnalisé
// ─────────────────────────────────────────────────────────────
router.post("/test-voice", async (req, res) => {
  const { voice_id, text = "Bonjour, comment puis-je vous aider aujourd'hui?" } = req.body;

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice_id}/stream`,
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_flash_v2_5",
          voice_settings: { stability: 0.8, similarity_boost: 0.9 },
        }),
      }
    );

    if (!response.ok) throw new Error("ElevenLabs API error");

    res.setHeader("Content-Type", "audio/mpeg");
    response.body.pipe(res);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
