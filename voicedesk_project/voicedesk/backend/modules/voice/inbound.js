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
  // (Conservé pour compat ConversationRelay éventuelle — non utilisé en flow Retell)
  const wsAuthToken = crypto.randomBytes(24).toString("base64url");
  wsTokens.set(wsAuthToken, {
    callSid: CallSid,
    callId: call?.id,
    companyId: company.company_id,
    accountSid: AccountSid,
    assistantName: assistantConfig?.assistant_name || "Léa",
    systemPrompt: assistantConfig?.system_prompt_voice_fr || assistantConfig?.system_prompt_fr || "",
    voiceId: assistantConfig?.voice_id || process.env.ELEVENLABS_VOICE_ID || "WW0JfNPk5DgcQdM0d6X6",
    greeting: assistantConfig?.greeting_inbound_fr || `Bonjour, ici ${assistantConfig?.assistant_name || "Léa"}. Comment puis-je vous aider ?`,
    prerollEnabled: assistantConfig?.voice_preroll_enabled ?? (process.env.VOICE_PREROLL_ENABLED === "true"),
    expiresAt: Date.now() + 60_000,
  });

  // ──────────────────────────────────────────────────────────
  // Phase Retell : on bascule Twilio → Retell via register-call
  //   1. POST https://api.retellai.com/register-call  { agent_id, ... }
  //   2. Retell renvoie { call_id, access_token, ... }
  //   3. On retourne à Twilio :
  //      <Connect><Stream url="wss://api.retellai.com/audio-websocket/{access_token}"/></Connect>
  // ──────────────────────────────────────────────────────────
  const retellApiKey = process.env.RETELL_API_KEY;
  const retellAgentId = process.env.RETELL_AGENT_ID;
  if (!retellApiKey || !retellAgentId) {
    console.error("[voice/inbound] RETELL_API_KEY ou RETELL_AGENT_ID manquant dans .env");
    vr.say({ language: "fr-CA" },
      "Désolée, problème technique. Veuillez rappeler dans quelques instants.");
    vr.hangup();
    return res.type("text/xml").send(vr.toString());
  }

  let retellCallId = null;
  try {
    const regResp = await fetch("https://api.retellai.com/v2/register-phone-call", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${retellApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent_id: retellAgentId,
        from_number: From || "",
        to_number: To || "",
        audio_websocket_protocol: "twilio",
        audio_encoding: "mulaw",
        sample_rate: 8000,
        // Métadonnées remontées dans Retell pour traçabilité
        metadata: {
          twilio_call_sid: CallSid,
          company_id: company.company_id,
          call_id: call?.id,
        },
      }),
    });
    const regBody = await regResp.json().catch(() => ({}));
    if (!regResp.ok) {
      console.error(`[voice/inbound] Retell register-phone-call ${regResp.status}:`, JSON.stringify(regBody));
      vr.say({ language: "fr-CA" },
        "Désolée, problème technique. Veuillez rappeler dans quelques instants.");
      vr.hangup();
      return res.type("text/xml").send(vr.toString());
    }
    retellCallId = regBody.call_id;
    if (!retellCallId) {
      console.error("[voice/inbound] Retell register-phone-call OK mais call_id manquant:", JSON.stringify(regBody));
      vr.say({ language: "fr-CA" },
        "Désolée, problème technique. Veuillez rappeler dans quelques instants.");
      vr.hangup();
      return res.type("text/xml").send(vr.toString());
    }
    console.log(`[voice/inbound] Retell call registered: retell_call_id=${retellCallId} twilio_sid=${CallSid}`);
  } catch (err) {
    console.error("[voice/inbound] Retell register-phone-call error:", err.message);
    vr.say({ language: "fr-CA" },
      "Désolée, problème technique. Veuillez rappeler dans quelques instants.");
    vr.hangup();
    return res.type("text/xml").send(vr.toString());
  }

  // TwiML <Connect><Stream url="wss://api.retellai.com/audio-websocket/{call_id}"/></Connect>
  const connect = vr.connect();
  connect.stream({ url: `wss://api.retellai.com/audio-websocket/${retellCallId}` });

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
