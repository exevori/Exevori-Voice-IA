// ============================================================
// VOICEDESK IA — PIPELINE APPELS SORTANTS (MISSIONS)
// Adapté de : github.com/nibodev/elevenlabs-twilio-i-o
//             github.com/twilio-labs/call-gpt
// Modifications : DeepSeek via AI Gateway VoiceDesk
//                 + Script de mission personnalisé
//                 + Sources contacts (calendrier/CRM/CSV/manuel)
//                 + Résultat appel → CRM automatique
// ============================================================

import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import fastifyFormBody from "@fastify/formbody";
import twilio from "twilio";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

// ── CONFIG ────────────────────────────────────────────────────
const PORT = process.env.PORT || 8081;
const DOMAIN = process.env.DOMAIN;
const AI_GATEWAY_URL = process.env.AI_GATEWAY_URL || "http://localhost:3100";

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ElevenLabs voice config
const ELEVENLABS_VOICE = `${process.env.ELEVENLABS_VOICE_ID}-${process.env.ELEVENLABS_MODEL || "flash_v2_5"}-1.0_0.8_0.9`;

const sessions = new Map();

const fastify = Fastify({ logger: false });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// ─────────────────────────────────────────────────────────────
// POST /outbound/call
// Déclenche UN appel sortant pour un contact de mission.
// Appelé depuis le dashboard VoiceDesk quand l'admin clique ▶
// ─────────────────────────────────────────────────────────────
fastify.post("/outbound/call", async (request, reply) => {
  const { mission_id, contact_id, company_id } = request.body;

  if (!mission_id || !contact_id || !company_id) {
    return reply.code(400).send({ error: "mission_id, contact_id, company_id requis" });
  }

  try {
    // Charger mission + contact + config
    const [mission, contact, config] = await Promise.all([
      getMission(company_id, mission_id),
      getContact(company_id, contact_id),
      getAssistantConfig(company_id),
    ]);

    if (!mission || !contact) {
      return reply.code(404).send({ error: "Mission ou contact introuvable" });
    }

    if (!contact.phone) {
      return reply.code(400).send({ error: "Contact sans numéro de téléphone" });
    }

    // Générer le script d'ouverture via DeepSeek
    const openingScript = await generateOpeningScript(mission, contact, config);

    // Créer l'enregistrement d'appel sortant en DB
    const { data: outboundCall } = await supabase
      .from("outbound_calls")
      .insert({
        company_id,
        mission_id,
        contact_id,
        contact_name: contact.full_name,
        contact_phone: contact.phone,
        contact_company: contact.company || "",
        status: "calling",
        mission_subject: mission.subject,
        opening_script_used: openingScript,
        attempt_number: 1,
      })
      .select()
      .single();

    // Déclencher l'appel Twilio
    const call = await twilioClient.calls.create({
      to: contact.phone,
      from: config.outbound_caller_id || process.env.TWILIO_PHONE_NUMBER,
      url: `https://${DOMAIN}/twiml/outbound?callDbId=${outboundCall.id}&companyId=${company_id}`,
      statusCallback: `https://${DOMAIN}/webhooks/outbound/status`,
      statusCallbackMethod: "POST",
      machineDetection: "DetectMessageEnd",
      asyncAmd: "true",
      asyncAmdStatusCallback: `https://${DOMAIN}/webhooks/outbound/amd`,
    });

    // Mettre à jour avec le Twilio Call SID
    await supabase
      .from("outbound_calls")
      .update({ twilio_call_sid: call.sid, called_at: new Date() })
      .eq("id", outboundCall.id);

    console.log(`[OUTBOUND] Call started: ${call.sid} → ${contact.phone}`);

    return reply.send({
      success: true,
      call_sid: call.sid,
      outbound_call_id: outboundCall.id,
      contact_name: contact.full_name,
    });

  } catch (err) {
    console.error("[OUTBOUND] Error:", err);
    return reply.code(500).send({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /twiml/outbound
// Twilio appelle ce endpoint quand l'appel sortant se connecte.
// ─────────────────────────────────────────────────────────────
fastify.all("/twiml/outbound", async (request, reply) => {
  const { callDbId, companyId } = request.query;

  // Récupérer les infos de l'appel depuis la DB
  const { data: outboundCall } = await supabase
    .from("outbound_calls")
    .select("*, missions(*)")
    .eq("id", callDbId)
    .single();

  const welcomeGreeting = outboundCall?.opening_script_used ||
    "Bonjour, je vous appelle au sujet de votre dossier.";

  reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <ConversationRelay
          url="wss://${DOMAIN}/ws/outbound"
          ttsProvider="ElevenLabs"
          voice="${ELEVENLABS_VOICE}"
          elevenlabsTextNormalization="on"
          language="fr-CA"
          transcriptionLanguage="fr-CA"
          welcomeGreeting="${welcomeGreeting}"
        >
          <Parameter name="callDbId" value="${callDbId}" />
          <Parameter name="companyId" value="${companyId}" />
          <Parameter name="direction" value="outbound" />
        </ConversationRelay>
      </Connect>
    </Response>`);
});

// ─────────────────────────────────────────────────────────────
// WEBSOCKET /ws/outbound
// ─────────────────────────────────────────────────────────────
fastify.register(async function (fastify) {
  fastify.get("/ws/outbound", { websocket: true }, (ws) => {

    ws.on("message", async (data) => {
      const message = JSON.parse(data);

      if (message.type === "setup") {
        const { callSid, customParameters = {} } = message;
        ws.callSid = callSid;

        const { callDbId, companyId } = customParameters;

        const [outboundCall, config, knowledgeBase] = await Promise.all([
          getOutboundCall(callDbId),
          getAssistantConfig(companyId),
          getKnowledgeBase(companyId),
        ]);

        sessions.set(callSid, {
          callDbId,
          companyId,
          outboundCall,
          config,
          knowledgeBase,
          conversation: buildOutboundSystemPrompt(config, outboundCall),
          language: "fr-CA",
          startedAt: new Date(),
          transcript: [],
        });

        // Marquer l'appel comme répondu
        await supabase
          .from("outbound_calls")
          .update({ answered_at: new Date(), status: "in_progress" })
          .eq("id", callDbId);

        console.log(`[OUTBOUND] Connected: ${callSid} — ${outboundCall?.contact_name}`);
      }

      if (message.type === "prompt" && message.last) {
        const session = sessions.get(ws.callSid);
        if (!session) return;

        const userText = message.voicePrompt;
        session.transcript.push({ role: "user", text: userText, ts: new Date() });

        // Détecter langue
        const detectedLang = detectLangSimple(userText, session);
        if (detectedLang !== session.language) {
          session.language = detectedLang;
          ws.send(JSON.stringify({ type: "language", transcriptionLanguage: detectedLang }));
        }

        // Appel AI Gateway
        const kbContext = searchKnowledgeBase(userText, session.knowledgeBase);
        const aiResponse = await callAIGateway({
          task: "outbound_conversation",
          userText,
          conversation: session.conversation,
          kbContext,
          language: session.language,
          companyId: session.companyId,
          mission: session.outboundCall?.missions,
        });

        await streamResponse(ws, aiResponse);

        session.conversation.push({ role: "user", content: userText });
        session.conversation.push({ role: "assistant", content: aiResponse });
        session.transcript.push({ role: "assistant", text: aiResponse, ts: new Date() });
      }

      if (message.type === "interrupt") {
        console.log(`[OUTBOUND] Interrupted: ${ws.callSid}`);
      }
    });

    ws.on("close", async () => {
      const session = sessions.get(ws.callSid);
      if (!session) return;

      const duration = Math.round((new Date() - session.startedAt) / 1000);

      try {
        // Analyser le résultat de l'appel sortant via DeepSeek
        const analysis = await callAIGateway({
          task: "analyze_outbound_result",
          conversation: session.conversation,
          language: session.language,
          companyId: session.companyId,
        });

        // Mettre à jour l'enregistrement d'appel
        await supabase
          .from("outbound_calls")
          .update({
            status: "completed",
            ended_at: new Date(),
            duration_seconds: duration,
            ai_summary: analysis?.summary || "",
            outcome: analysis?.outcome || "completed",
            next_action: analysis?.next_action || "",
            next_action_date: analysis?.next_action_date || null,
            appointment_booked: analysis?.appointment_booked || false,
            language_used: session.language,
            transcript: session.transcript.map(t => `${t.role}: ${t.text}`).join("\n"),
          })
          .eq("id", session.callDbId);

        // Mettre à jour le statut du contact dans le CRM
        if (analysis?.crm_status) {
          await supabase
            .from("contacts")
            .update({
              status: analysis.crm_status,
              next_action: analysis.next_action || "",
              last_interaction_at: new Date(),
            })
            .eq("id", session.outboundCall?.contact_id);
        }

        // Note CRM
        await supabase.from("contact_notes").insert({
          company_id: session.companyId,
          contact_id: session.outboundCall?.contact_id,
          direction: "outbound",
          note: analysis?.summary || "",
          next_action: analysis?.next_action || "",
          created_by: "lea_ai",
        });

        console.log(`[OUTBOUND] Saved: ${ws.callSid} — ${duration}s — ${analysis?.outcome}`);
      } catch (err) {
        console.error(`[OUTBOUND] Error saving ${ws.callSid}:`, err);
      }

      sessions.delete(ws.callSid);
    });
  });
});

// ─────────────────────────────────────────────────────────────
// WEBHOOK /webhooks/outbound/amd
// Répondeur automatique détecté → Laisser un message vocal
// ─────────────────────────────────────────────────────────────
fastify.post("/webhooks/outbound/amd", async (request, reply) => {
  const { CallSid, AnsweredBy } = request.body;

  if (AnsweredBy === "machine_start" || AnsweredBy === "machine_end_beep") {
    // Trouver l'appel et laisser un message
    const { data: outboundCall } = await supabase
      .from("outbound_calls")
      .select("*, missions(*)")
      .eq("twilio_call_sid", CallSid)
      .single();

    const voicemailMsg = outboundCall?.config?.voicemail_message_fr ||
      `Bonjour, vous avez un message de ${outboundCall?.missions?.company_name || 'notre équipe'}. N'hésitez pas à nous rappeler. Bonne journée.`;

    await supabase
      .from("outbound_calls")
      .update({ status: "voicemail", outcome: "voicemail" })
      .eq("twilio_call_sid", CallSid);
  }

  reply.send({ received: true });
});

// ─────────────────────────────────────────────────────────────
// FONCTIONS UTILITAIRES
// ─────────────────────────────────────────────────────────────

async function getMission(companyId, missionId) {
  const { data } = await supabase
    .from("missions")
    .select("*")
    .eq("company_id", companyId)
    .eq("id", missionId)
    .single();
  return data;
}

async function getContact(companyId, contactId) {
  const { data } = await supabase
    .from("contacts")
    .select("*")
    .eq("company_id", companyId)
    .eq("id", contactId)
    .single();
  return data;
}

async function getOutboundCall(callDbId) {
  const { data } = await supabase
    .from("outbound_calls")
    .select("*, missions(*)")
    .eq("id", callDbId)
    .single();
  return data;
}

async function getAssistantConfig(companyId) {
  const { data } = await supabase
    .from("assistant_configs")
    .select("*")
    .eq("company_id", companyId)
    .single();
  return data || {};
}

async function getKnowledgeBase(companyId) {
  const { data } = await supabase
    .from("knowledge_base")
    .select("question, answer")
    .eq("company_id", companyId)
    .eq("status", "active")
    .limit(30);
  return data || [];
}

async function generateOpeningScript(mission, contact, config) {
  try {
    const response = await callAIGateway({
      task: "generate_outbound_script",
      companyId: config.company_id,
      language: "fr-CA",
      mission,
      contact,
    });
    return response;
  } catch {
    return `Bonjour ${contact.first_name || contact.full_name || 'Monsieur/Madame'}, je vous appelle de la part de ${config.company_name || 'notre équipe'}.`;
  }
}

function buildOutboundSystemPrompt(config, outboundCall) {
  const mission = outboundCall?.missions;
  const systemPrompt = config.system_prompt_outbound_fr ||
    `Tu es ${config.assistant_name || 'Assistant'}, agente IA de ${config.company_name || 'cette entreprise'}.
Tu fais un appel sortant à ${outboundCall?.contact_name || 'ce contact'}.

OBJECTIF DE L'APPEL: ${mission?.objective || 'Suivre ce contact'}
SUJET: ${mission?.subject || ''}

INSTRUCTIONS:
- Sois professionnelle et naturelle
- Commence par vérifier que tu as la bonne personne
- Présente-toi et l'entreprise en 1 phrase
- Explique l'objet de l'appel en 1-2 phrases max
- Écoute la réponse et adapte-toi
- Si intérêt → propose un RDV via Calendly
- Si pas intéressé → remercie poliment et note la raison
- Jamais plus de 3 phrases à la fois`;

  return [{ role: "system", content: systemPrompt }];
}

function detectLangSimple(text, session) {
  const englishWords = ['hello', 'hi', 'yes', 'no', 'please', 'speak', 'english'];
  const textLower = text.toLowerCase();
  if (englishWords.some(w => textLower.includes(w))) {
    session.englishCount = (session.englishCount || 0) + 1;
    if (session.englishCount >= 2) return "en-US";
  } else {
    session.englishCount = 0;
  }
  return session.language;
}

function searchKnowledgeBase(userText, knowledgeBase) {
  const text = userText.toLowerCase();
  const matches = knowledgeBase.filter(entry => {
    const words = text.split(" ").filter(w => w.length > 3);
    return words.some(w => (entry.question || "").toLowerCase().includes(w));
  });
  return matches.slice(0, 2).map(m => `Q: ${m.question}\nR: ${m.answer}`).join("\n\n");
}

async function callAIGateway({ task, userText, conversation, kbContext, language, companyId, mission, contact }) {
  try {
    const response = await fetch(`${AI_GATEWAY_URL}/api/ai/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task,
        company_id: companyId,
        language: language || "fr-CA",
        user_text: userText,
        conversation: conversation || [],
        kb_context: kbContext || "",
        mission: mission || null,
        contact: contact || null,
      }),
    });
    if (!response.ok) throw new Error(`AI Gateway ${response.status}`);
    const data = await response.json();
    return data.response || data.text || data.summary || data.script || "";
  } catch (err) {
    console.error("[AI Gateway] Error:", err);
    return language === "en-US"
      ? "I'm having a technical issue. Could you hold on?"
      : "J'ai un petit problème technique. Pouvez-vous patienter un instant?";
  }
}

async function streamResponse(ws, text) {
  if (!text) return;
  const words = text.split(" ");
  for (let i = 0; i < words.length; i++) {
    ws.send(JSON.stringify({
      type: "text",
      token: i < words.length - 1 ? words[i] + " " : words[i],
      last: i === words.length - 1,
    }));
    if (i % 5 === 0 && i > 0) await new Promise(r => setTimeout(r, 8));
  }
}

// ── DÉMARRAGE ─────────────────────────────────────────────────
try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`✅ VoiceDesk IA — Outbound server on port ${PORT}`);
  console.log(`   TwiML    : https://${DOMAIN}/twiml/outbound`);
  console.log(`   WebSocket: wss://${DOMAIN}/ws/outbound`);
  console.log(`   Trigger  : POST https://${DOMAIN}/outbound/call`);
} catch (err) {
  console.error("❌ Server error:", err);
  process.exit(1);
}
