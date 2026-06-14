// ============================================================
// EXEVORI VOICE IA — Inbound voice webhook (Phase 8A)
//
// POST /webhooks/voice/inbound
//   Reçu de Twilio quand un appel entre.
//   Retourne du TwiML <Connect><ConversationRelay url="wss://..." />
//
// POST /webhooks/voice/status
//   Reçu pour chaque changement de status (initiated, ringing,
//   answered, completed). Met à jour calls.live_status + call_events.
//
// Sécurité : signature Twilio HMAC vérifiée (bypass dev si token absent).
// ============================================================

import express from "express";
import twilio from "twilio";
import crypto from "node:crypto";
import { verifyTwilioSignature } from "./signature.js";
import {
  supabase,
  findCompanyByTwilioNumber,
  getOrCreateCall,
  setLiveStatus,
  endCall,
  logEvent,
} from "./lifecycle.js";

const router = express.Router();

// Twilio envoie en application/x-www-form-urlencoded
router.use(express.urlencoded({ extended: false }));

// In-memory: callSid -> per-call WebSocket auth token (Phase 8A simple impl)
// Phase 8E pourra le remplacer par Redis si on déploie plusieurs workers.
const wsTokens = new Map();
export function consumeWsToken(token) {
  const entry = wsTokens.get(token);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) { wsTokens.delete(token); return null; }
  wsTokens.delete(token);
  return entry; // { callSid, companyId, callId, accountSid }
}

// ─────────────────────────────────────────────────────────────
// POST /webhooks/voice/inbound
// ─────────────────────────────────────────────────────────────
router.post("/inbound", verifyTwilioSignature, async (req, res) => {
  const { CallSid, From, To, AccountSid } = req.body || {};

  const vr = new twilio.twiml.VoiceResponse();

  // Trouver la PME associée à ce numéro Twilio + sa config assistant
  let company = null;
  let assistantConfig = null;
  try {
    company = await findCompanyByTwilioNumber(To);
    if (company) {
      // Tente la requête avec voice_preroll_enabled (migration 007). Si la colonne
      // n'existe pas encore, retry sans (graceful degradation).
      let { data, error } = await supabase
        .from("assistant_configs")
        .select("assistant_name, voice_id, voice_speed, voice_stability, voice_similarity, voice_preroll_enabled, greeting_inbound_fr, system_prompt_voice_fr, system_prompt_fr")
        .eq("company_id", company.company_id)
        .maybeSingle();
      if (error && /voice_preroll_enabled/.test(error.message || "")) {
        const r2 = await supabase
          .from("assistant_configs")
          .select("assistant_name, voice_id, voice_speed, voice_stability, voice_similarity, greeting_inbound_fr, system_prompt_voice_fr, system_prompt_fr")
          .eq("company_id", company.company_id)
          .maybeSingle();
        data = r2.data;
      }
      assistantConfig = data || null;
    }
  } catch (_) {}

  if (!company) {
    // Numéro non reconnu : fallback voicemail simple
    vr.say({ language: "fr-CA" },
      "Désolée, ce numéro n'est pas encore configuré. Au revoir.");
    vr.hangup();
    return res.type("text/xml").send(vr.toString());
  }

  // Créer la ligne calls + log event 'started' (fail-fast si DB KO)
  let call;
  try {
    call = await getOrCreateCall({
      twilio_call_sid: CallSid,
      company_id: company.company_id,
      from: From,
    });
    await logEvent({
      company_id: company.company_id,
      call_id: call.id,
      event_type: "started",
      payload: { from: From, to: To, account_sid: AccountSid },
      ts_ms: 0,
    });
  } catch (err) {
    console.error("[voice/inbound] DB error:", err.message);
    // Fail-fast: pas de ConversationRelay si on n'a pas pu créer la ligne calls
    vr.say({ language: "fr-CA" },
      "Désolée, problème technique. Veuillez rappeler dans quelques instants.");
    vr.hangup();
    return res.type("text/xml").send(vr.toString());
  }

  // Génère un token éphémère qui authentifie la WS associée à CET appel
  const wsAuthToken = crypto.randomBytes(24).toString("base64url");
  wsTokens.set(wsAuthToken, {
    callSid: CallSid,
    callId: call?.id,
    companyId: company.company_id,
    accountSid: AccountSid,
    // Snapshot de la config assistant pour la WS (évite un round-trip DB)
    assistantName: assistantConfig?.assistant_name || "Léa",
    systemPrompt: assistantConfig?.system_prompt_voice_fr || assistantConfig?.system_prompt_fr || "",
    prerollEnabled: assistantConfig?.voice_preroll_enabled ?? (process.env.VOICE_PREROLL_ENABLED === "true"),
    expiresAt: Date.now() + 60_000, // 60s pour que Twilio se connecte
  });

  // Construction de l'URL WSS publique
  const proto = req.header("X-Forwarded-Proto") || "https";
  const host  = req.header("X-Forwarded-Host")  || req.header("host");
  const wsUrl = `wss://${host}/webhooks/voice/relay/ws`;

  // Greeting depuis assistant_configs (sinon fallback générique)
  const welcomeGreeting = assistantConfig?.greeting_inbound_fr
    || `Bonjour, ici ${assistantConfig?.assistant_name || "Léa"}. Comment puis-je vous aider ?`;

  // ──────────────────────────────────────────────────────────
  // TwiML <Connect><ConversationRelay> avec voix ElevenLabs
  // ──────────────────────────────────────────────────────────
  const connect = vr.connect({
    action: `${proto}://${host}/webhooks/voice/relay-action`,
  });

  const relayAttrs = {
    url: wsUrl,
    welcomeGreeting,
    welcomeGreetingInterruptible: false,
    language: "fr-FR",
    transcriptionProvider: "Deepgram",
    speechModel: "nova-2-general",
  };

  // ElevenLabs TTS (Phase 8C-1) — Twilio ConversationRelay supporte ttsProvider externe
  const elevenKey   = process.env.ELEVENLABS_API_KEY;
  const elevenVoice = assistantConfig?.voice_id || process.env.ELEVENLABS_DEFAULT_VOICE_ID;
  const elevenModel = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";
  if (elevenKey && elevenVoice && !elevenKey.startsWith("placeholder")) {
    relayAttrs.ttsProvider = "ElevenLabs";
    relayAttrs.voice = `${elevenVoice}-${elevenModel}`;
    // Note: la clé ElevenLabs doit être stockée comme "API Key" dans la console Twilio
    // (Console > Voice > API Keys). Sinon ConversationRelay utilise la clé compte par défaut.
    // Pour V1, on passe via attribut ttsApiKey si Twilio l'accepte; sinon fallback voix Google.
  }

  connect.conversationRelay(relayAttrs)
    .parameter({ name: "wsAuthToken", value: wsAuthToken });

  return res.type("text/xml").send(vr.toString());
});

// ─────────────────────────────────────────────────────────────
// POST /webhooks/voice/status
//   CallStatusCallback : initiated / ringing / answered / completed
// ─────────────────────────────────────────────────────────────
router.post("/status", verifyTwilioSignature, async (req, res) => {
  const { CallSid, CallStatus, CallDuration, From, To } = req.body || {};

  try {
    // Lookup call par CallSid via le client partagé
    const { data: call } = await supabase
      .from("calls").select("id, company_id").eq("twilio_call_sid", CallSid).maybeSingle();

    if (call) {
      if (CallStatus === "completed") {
        await endCall(call.id, { duration_seconds: parseInt(CallDuration || "0", 10) });
        await logEvent({
          company_id: call.company_id, call_id: call.id,
          event_type: "ended",
          payload: { call_status: CallStatus, duration: CallDuration },
        });
      } else if (CallStatus === "ringing") {
        await setLiveStatus(call.id, "ringing");
      } else if (CallStatus === "in-progress" || CallStatus === "answered") {
        await setLiveStatus(call.id, "connecting");
      } else if (CallStatus === "failed" || CallStatus === "busy" || CallStatus === "no-answer") {
        await endCall(call.id, { status: "abandoned" });
        await logEvent({
          company_id: call.company_id, call_id: call.id,
          event_type: "error",
          payload: { call_status: CallStatus },
        });
      }
    }
  } catch (err) {
    console.error("[voice/status] error:", err.message);
  }

  return res.sendStatus(200);
});

// ─────────────────────────────────────────────────────────────
// POST /webhooks/voice/relay-action
//   Reçu par Twilio quand ConversationRelay termine (timeout, hangup
//   from WS, etc). Permet de renvoyer du TwiML pour Dial / Voicemail
//   en cas de transfert humain.
// ─────────────────────────────────────────────────────────────
router.post("/relay-action", verifyTwilioSignature, async (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();
  vr.hangup();
  return res.type("text/xml").send(vr.toString());
});

export default router;
