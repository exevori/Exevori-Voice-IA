// ============================================================
// EXEVORI VOICE IA — Service de provisioning automatique
// Fichier : backend/modules/onboarding/provision_service.js
//
// Responsabilités :
//   1. Acheter un numéro Twilio au Canada (+1 418 ou +1 581)
//   2. Créer un agent ElevenLabs (copie de l'agent maître)
//   3. Importer le numéro Twilio dans ElevenLabs
//   4. Lier le numéro à l'agent ElevenLabs
//   5. Configurer le post-call webhook
//   6. Sauvegarder tout dans Supabase (twilio_configs + phone_numbers)
// ============================================================

import twilio from "twilio";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Credentials Twilio MAÎTRE (compte Exevori — pas le client)
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const ELEVENLABS_API   = "https://api.elevenlabs.io";
const ELEVENLABS_KEY   = process.env.ELEVENLABS_API_KEY;
// ID de l'agent maître Léa — template utilisé pour créer les agents clients
const ELEVENLABS_MASTER_AGENT_ID = process.env.ELEVENLABS_MASTER_AGENT_ID;
// URL du post-call webhook pour TOUS les clients
const POSTCALL_WEBHOOK_URL = process.env.APP_PUBLIC_URL
  ? `${process.env.APP_PUBLIC_URL}/api/voice/call-complete`
  : null;

// ─────────────────────────────────────────────────────────────
// FONCTION PRINCIPALE — Provisionner un nouveau client
// ─────────────────────────────────────────────────────────────
export async function provisionNewClient({ companyId, assistantName, voiceId, systemPrompt, areaCode = "581" }) {
  const log = [];
  const results = {};

  try {
    // ── ÉTAPE 1 : Acheter un numéro Twilio ──────────────────
    log.push("Recherche d'un numéro Twilio disponible...");
    const availableNumbers = await twilioClient
      .availablePhoneNumbers("CA")
      .local.list({
        areaCode,
        voiceEnabled: true,
        smsEnabled: false,
        limit: 5,
      });

    if (!availableNumbers.length) {
      // Fallback : essayer le code régional 418 (Québec)
      const fallback = await twilioClient
        .availablePhoneNumbers("CA")
        .local.list({ areaCode: "418", voiceEnabled: true, limit: 5 });
      if (!fallback.length) throw new Error("Aucun numéro disponible au Québec (581 et 418)");
      availableNumbers.push(...fallback);
    }

    const chosenNumber = availableNumbers[0].phoneNumber;
    log.push(`Numéro disponible trouvé : ${chosenNumber}`);

    // Acheter le numéro
    const purchasedNumber = await twilioClient.incomingPhoneNumbers.create({
      phoneNumber: chosenNumber,
      friendlyName: `VoiceDesk — ${assistantName} (${companyId.slice(0, 8)})`,
    });

    results.twilioPhoneNumber = purchasedNumber.phoneNumber;
    results.twilioPhoneSid    = purchasedNumber.sid;
    log.push(`Numéro acheté : ${purchasedNumber.phoneNumber} (SID: ${purchasedNumber.sid})`);

    // ── ÉTAPE 2 : Créer un agent ElevenLabs ────────────────
    log.push("Création de l'agent ElevenLabs...");

    // Récupérer la config de l'agent maître
    const masterConfig = await elevenLabsGet(`/v1/convai/agents/${ELEVENLABS_MASTER_AGENT_ID}`);

    // Créer un nouvel agent basé sur le maître
    const newAgent = await elevenLabsPost("/v1/convai/agents/create", {
      name: `VoiceDesk — ${assistantName}`,
      conversation_config: {
        ...masterConfig.conversation_config,
        agent: {
          ...masterConfig.conversation_config?.agent,
          prompt: {
            prompt: systemPrompt || masterConfig.conversation_config?.agent?.prompt?.prompt || "",
          },
          first_message: `Bonjour, je suis ${assistantName}. Comment puis-je vous aider aujourd'hui ?`,
          language: "fr",
        },
        tts: {
          ...masterConfig.conversation_config?.tts,
          voice_id: voiceId || masterConfig.conversation_config?.tts?.voice_id,
        },
      },
      platform_settings: {
        ...masterConfig.platform_settings,
        // Post-call webhook pour ce client — transmet company_id via meta
        webhook: POSTCALL_WEBHOOK_URL ? {
          url: POSTCALL_WEBHOOK_URL,
          headers: { "x-company-id": companyId },
        } : undefined,
      },
    });

    results.elevenLabsAgentId = newAgent.agent_id;
    log.push(`Agent ElevenLabs créé : ${newAgent.agent_id}`);

    // ── ÉTAPE 3 : Importer le numéro Twilio dans ElevenLabs ─
    log.push("Import du numéro Twilio dans ElevenLabs...");

    const importedNumber = await elevenLabsPost("/v1/convai/phone-numbers/import", {
      phone_number: purchasedNumber.phoneNumber,
      label: `${assistantName} — ${companyId.slice(0, 8)}`,
      sid_account: process.env.TWILIO_ACCOUNT_SID,
    });

    results.elevenLabsPhoneNumberId = importedNumber.phone_number_id;
    log.push(`Numéro importé dans ElevenLabs : ${importedNumber.phone_number_id}`);

    // ── ÉTAPE 4 : Lier le numéro à l'agent ─────────────────
    log.push("Liaison numéro → agent ElevenLabs...");

    await elevenLabsPatch(`/v1/convai/phone-numbers/${importedNumber.phone_number_id}`, {
      agent_id: newAgent.agent_id,
    });

    log.push("Numéro lié à l'agent avec succès");

    // ── ÉTAPE 5 : Sauvegarder dans Supabase ────────────────
    log.push("Sauvegarde dans Supabase...");

    // Table twilio_configs (pour la téléphonie)
    await supabase.from("twilio_configs").upsert({
      company_id:           companyId,
      account_sid:          process.env.TWILIO_ACCOUNT_SID,
      phone_number:         purchasedNumber.phoneNumber,
      phone_number_sid:     purchasedNumber.sid,
      status:               "active",
      last_test_ok:         true,
      twilio_account_name:  "Exevori VoiceDesk (maître)",
      updated_at:           new Date().toISOString(),
    }, { onConflict: "company_id" });

    // Table assistant_configs (agent ElevenLabs)
    await supabase.from("assistant_configs").update({
      twilio_number:         purchasedNumber.phoneNumber,
      elevenlabs_agent_id:   newAgent.agent_id,
      updated_at:            new Date().toISOString(),
    }).eq("company_id", companyId);

    // Table phone_numbers (routing multi-tenant)
    await supabase.from("phone_numbers").upsert({
      phone_number:              purchasedNumber.phoneNumber,
      company_id:                companyId,
      elevenlabs_agent_id:       newAgent.agent_id,
      elevenlabs_phone_number_id: importedNumber.phone_number_id,
      twilio_phone_sid:          purchasedNumber.sid,
      status:                    "active",
      created_at:                new Date().toISOString(),
    }, { onConflict: "phone_number" });

    log.push("Provisioning terminé avec succès !");

    return {
      success: true,
      phone_number:             purchasedNumber.phoneNumber,
      twilio_phone_sid:         purchasedNumber.sid,
      elevenlabs_agent_id:      newAgent.agent_id,
      elevenlabs_phone_id:      importedNumber.phone_number_id,
      log,
    };

  } catch (err) {
    log.push(`ERREUR : ${err.message}`);
    console.error("[provision] Erreur:", err);

    // Rollback partiel si le numéro a été acheté mais que la suite a échoué
    if (results.twilioPhoneSid) {
      try {
        await twilioClient.incomingPhoneNumbers(results.twilioPhoneSid).remove();
        log.push(`Rollback : numéro Twilio ${results.twilioPhoneNumber} libéré`);
      } catch (rbErr) {
        log.push(`Rollback échoué : ${rbErr.message} — libérer manuellement ${results.twilioPhoneSid}`);
      }
    }

    return { success: false, error: err.message, log };
  }
}

// ─────────────────────────────────────────────────────────────
// HELPERS ElevenLabs API
// ─────────────────────────────────────────────────────────────
async function elevenLabsGet(path) {
  const res = await fetch(`${ELEVENLABS_API}${path}`, {
    headers: { "xi-api-key": ELEVENLABS_KEY },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ElevenLabs GET ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

async function elevenLabsPost(path, body) {
  const res = await fetch(`${ELEVENLABS_API}${path}`, {
    method: "POST",
    headers: { "xi-api-key": ELEVENLABS_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ElevenLabs POST ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function elevenLabsPatch(path, body) {
  const res = await fetch(`${ELEVENLABS_API}${path}`, {
    method: "PATCH",
    headers: { "xi-api-key": ELEVENLABS_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ElevenLabs PATCH ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}
