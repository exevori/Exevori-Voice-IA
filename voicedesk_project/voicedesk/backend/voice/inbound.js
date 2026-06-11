// ============================================================
// VOICEDESK IA — PIPELINE APPELS ENTRANTS
// Adapté de : github.com/twilio-samples/conversationrelay-elevenlabs-openai
// Modifications : OpenAI → DeepSeek via AI Gateway VoiceDesk
//                 + Bilinguisme FR/EN auto-détection
//                 + Recherche base de connaissances
//                 + Notes CRM automatiques
//                 + Transfert humain configurable
// ============================================================

import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import fastifyFormBody from "@fastify/formbody";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

// ── CONFIGURATION SERVEUR ─────────────────────────────────────
const PORT = process.env.PORT || 8080;
const DOMAIN = process.env.DOMAIN;
const WS_URL = `wss://${DOMAIN}/ws/inbound`;

// ── CONFIGURATION ELEVENLABS (flash_v2_5 — latence 75ms) ─────
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL || "flash_v2_5";
const ELEVENLABS_SPEED = process.env.ELEVENLABS_SPEED || "1.0";
const ELEVENLABS_STABILITY = process.env.ELEVENLABS_STABILITY || "0.8";
const ELEVENLABS_SIMILARITY = process.env.ELEVENLABS_SIMILARITY || "0.9";
const ELEVENLABS_VOICE = `${ELEVENLABS_VOICE_ID}-${ELEVENLABS_MODEL}-${ELEVENLABS_SPEED}_${ELEVENLABS_STABILITY}_${ELEVENLABS_SIMILARITY}`;

// ── AI GATEWAY VOICEDESK (DeepSeek via Fireworks.ai) ──────────
const AI_GATEWAY_URL = process.env.AI_GATEWAY_URL || "http://localhost:3100";

// ── SUPABASE ──────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── SESSIONS ACTIVES ──────────────────────────────────────────
// Map callSid → état de session complet
const sessions = new Map();

// ── SERVEUR FASTIFY ───────────────────────────────────────────
const fastify = Fastify({ logger: false });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// ─────────────────────────────────────────────────────────────
// ENDPOINT /twiml/inbound
// Twilio appelle ce endpoint quand un appel entre.
// Retourne le TwiML qui connecte ConversationRelay.
// ─────────────────────────────────────────────────────────────
fastify.all("/twiml/inbound", async (request, reply) => {
  const { From: callerPhone, To: twilioNumber } = request.body || {};

  // Récupérer la config de l'entreprise via le numéro Twilio
  const company = await getCompanyByTwilioNumber(twilioNumber);
  if (!company) {
    reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
      <Response><Say language="fr-CA">Service temporairement indisponible.</Say></Response>`);
    return;
  }

  // Salutation personnalisée de l'assistante
  const assistantName = company.assistant_name || "Assistant";
  const companyName = company.name || "";
  const welcomeGreeting = company.greeting_inbound_fr ||
    `Bonjour, vous avez rejoint ${companyName}. Je suis ${assistantName}, comment puis-je vous aider?`;

  reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <ConversationRelay
          url="${WS_URL}"
          ttsProvider="ElevenLabs"
          voice="${ELEVENLABS_VOICE}"
          elevenlabsTextNormalization="on"
          language="fr-CA"
          transcriptionLanguage="fr-CA"
          welcomeGreeting="${welcomeGreeting}"
          interruptByDtmf="true"
        >
          <Parameter name="companyId" value="${company.id}" />
          <Parameter name="callerPhone" value="${callerPhone || ''}" />
          <Parameter name="twilioNumber" value="${twilioNumber || ''}" />
          <Parameter name="direction" value="inbound" />
        </ConversationRelay>
      </Connect>
    </Response>`);
});

// ─────────────────────────────────────────────────────────────
// WEBSOCKET /ws/inbound
// Gère la conversation en temps réel avec Twilio ConversationRelay
// ─────────────────────────────────────────────────────────────
fastify.register(async function (fastify) {
  fastify.get("/ws/inbound", { websocket: true }, (ws) => {

    ws.on("message", async (data) => {
      const message = JSON.parse(data);

      // ── SETUP : Initialisation de la session ─────────────────
      if (message.type === "setup") {
        const { callSid, customParameters = {} } = message;
        ws.callSid = callSid;

        const companyId = customParameters.companyId;
        const callerPhone = customParameters.callerPhone;

        // Charger la config entreprise et le contexte appelant
        const [config, contact, knowledgeBase] = await Promise.all([
          getAssistantConfig(companyId),
          lookupContact(companyId, callerPhone),
          getKnowledgeBase(companyId),
        ]);

        sessions.set(callSid, {
          companyId,
          callerPhone,
          config,
          contact,
          knowledgeBase,
          conversation: buildSystemPrompt(config, contact, knowledgeBase),
          language: "fr-CA",
          englishExchangeCount: 0,
          startedAt: new Date(),
          transcript: [],
        });

        console.log(`[INBOUND] Call ${callSid} — ${companyId} — ${callerPhone || 'unknown'}`);
      }

      // ── PROMPT : L'appelant a parlé ───────────────────────────
      if (message.type === "prompt" && message.last) {
        const session = sessions.get(ws.callSid);
        if (!session) return;

        const userText = message.voicePrompt;
        session.transcript.push({ role: "user", text: userText, ts: new Date() });

        // 1. Détecter la langue et switcher si nécessaire
        const detectedLang = await detectLanguage(userText, session);
        if (detectedLang !== session.language) {
          await switchLanguage(ws, session, detectedLang);
        }

        // 2. Vérifier si transfert humain requis
        if (shouldTransferToHuman(userText, session)) {
          await handleHumanTransfer(ws, session);
          return;
        }

        // 3. Recherche contextuelle dans la KB
        const kbContext = searchKnowledgeBase(userText, session.knowledgeBase);

        // 4. Appel AI Gateway DeepSeek
        const aiResponse = await callAIGateway({
          task: "conversation",
          userText,
          conversation: session.conversation,
          kbContext,
          language: session.language,
          companyId: session.companyId,
        });

        // 5. Streamer la réponse token par token vers Twilio
        await streamResponse(ws, aiResponse);

        // 6. Mettre à jour l'historique de conversation
        session.conversation.push({ role: "user", content: userText });
        session.conversation.push({ role: "assistant", content: aiResponse });
        session.transcript.push({ role: "assistant", text: aiResponse, ts: new Date() });

        console.log(`[INBOUND] ${ws.callSid} | User: ${userText.substring(0, 50)}...`);
        console.log(`[INBOUND] ${ws.callSid} | AI: ${aiResponse.substring(0, 50)}...`);
      }

      // ── INTERRUPT : L'appelant coupe l'assistant ──────────────────────
      if (message.type === "interrupt") {
        console.log(`[INBOUND] Interrupted: ${ws.callSid}`);
      }
    });

    // ── FIN D'APPEL : Sauvegarder dans Supabase ─────────────────
    ws.on("close", async () => {
      const session = sessions.get(ws.callSid);
      if (!session) return;

      const duration = Math.round((new Date() - session.startedAt) / 1000);

      try {
        // Générer le résumé IA
        const summary = await callAIGateway({
          task: "summarize_call",
          conversation: session.conversation,
          language: session.language,
          companyId: session.companyId,
        });

        // Sauvegarder l'appel dans Supabase
        const { data: call } = await supabase
          .from("calls")
          .insert({
            company_id: session.companyId,
            caller_phone: session.callerPhone,
            contact_id: session.contact?.id || null,
            direction: "inbound",
            duration_seconds: duration,
            language_used: session.language,
            transcript: session.transcript.map(t => `${t.role}: ${t.text}`).join("\n"),
            ai_summary: summary?.summary || "",
            intent: summary?.intent || "",
            outcome: summary?.outcome || "completed",
            next_action: summary?.next_action || "",
            status: "completed",
          })
          .select()
          .single();

        // Sauvegarder la note CRM
        if (call && session.companyId) {
          await supabase.from("contact_notes").insert({
            company_id: session.companyId,
            contact_id: session.contact?.id || null,
            call_id: call.id,
            direction: "inbound",
            note: summary?.summary || "",
            next_action: summary?.next_action || "",
            created_by: "lea_ai",
          });
        }

        // Détecter si suggestion d'apprentissage
        if (summary?.knowledge_gap) {
          await supabase.from("learning_suggestions").insert({
            company_id: session.companyId,
            question_detected: summary.knowledge_gap.question,
            suggested_answer: summary.knowledge_gap.suggested_answer,
            source_call_id: call?.id,
            confidence_score: summary.knowledge_gap.confidence || 70,
            status: "pending",
          });
        }

        console.log(`[INBOUND] Call saved: ${ws.callSid} — ${duration}s`);
      } catch (err) {
        console.error(`[INBOUND] Error saving call ${ws.callSid}:`, err);
      }

      sessions.delete(ws.callSid);
    });
  });
});

// ─────────────────────────────────────────────────────────────
// FONCTIONS UTILITAIRES
// ─────────────────────────────────────────────────────────────

async function getCompanyByTwilioNumber(twilioNumber) {
  if (!twilioNumber) return null;
  const { data } = await supabase
    .from("assistant_configs")
    .select("*, companies(*)")
    .eq("twilio_number", twilioNumber)
    .single();
  return data ? { ...data.companies, ...data, id: data.company_id } : null;
}

async function getAssistantConfig(companyId) {
  const { data } = await supabase
    .from("assistant_configs")
    .select("*")
    .eq("company_id", companyId)
    .single();
  return data || {};
}

async function lookupContact(companyId, phone) {
  if (!phone) return null;
  const { data } = await supabase
    .from("contacts")
    .select("*")
    .eq("company_id", companyId)
    .eq("phone", phone)
    .single();
  return data || null;
}

async function getKnowledgeBase(companyId) {
  const { data } = await supabase
    .from("knowledge_base")
    .select("question, answer, category")
    .eq("company_id", companyId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(50);
  return data || [];
}

function searchKnowledgeBase(userText, knowledgeBase) {
  const text = userText.toLowerCase();
  const matches = knowledgeBase.filter(entry => {
    const q = (entry.question || "").toLowerCase();
    const words = text.split(" ").filter(w => w.length > 3);
    return words.some(w => q.includes(w));
  });
  return matches.slice(0, 3).map(m => `Q: ${m.question}\nR: ${m.answer}`).join("\n\n");
}

function buildSystemPrompt(config, contact, knowledgeBase) {
  const kbText = knowledgeBase.slice(0, 10)
    .map(k => `- ${k.question}: ${k.answer}`)
    .join("\n");

  const contactContext = contact
    ? `\nTu parles avec ${contact.full_name || 'un client connu'}. Historique: ${contact.main_need || 'aucun'}.`
    : "";

  const systemPrompt = config.system_prompt_fr ||
    `Tu es ${config.assistant_name || 'Assistant'}, réceptionniste IA de ${config.company_name || 'cette entreprise'}.
Tu réponds en français québécois naturel et professionnel.
Sois concise, chaleureuse et efficace.
${contactContext}

CONNAISSANCES DE L'ENTREPRISE:
${kbText}

RÈGLES:
- Jamais plus de 2-3 phrases par réponse
- Si tu ne sais pas → note le message et promets un suivi
- Propose de prendre un RDV via Calendly si pertinent
- Aucun emoji dans les réponses vocales`;

  return [{ role: "system", content: systemPrompt }];
}

async function detectLanguage(text, session) {
  const englishWords = ['hello', 'hi', 'yes', 'no', 'please', 'thank', 'thanks',
    'speak', 'english', 'want', 'need', 'help', 'can', 'you', 'how', 'what', 'when', 'where'];
  const textLower = text.toLowerCase();
  const hasEnglish = englishWords.some(w => textLower.includes(w));
  const hasFrench = /[àâäéèêëîïôùûü]/.test(text) || textLower.includes('je ') ||
    textLower.includes('vous ') || textLower.includes('bonjour');

  if (hasEnglish && !hasFrench) {
    session.englishExchangeCount = (session.englishExchangeCount || 0) + 1;
    if (session.englishExchangeCount >= 2) return "en-US";
  } else {
    session.englishExchangeCount = 0;
  }
  return session.language;
}

async function switchLanguage(ws, session, newLang) {
  session.language = newLang;
  session.englishExchangeCount = 0;

  // Switcher STT + TTS via ConversationRelay
  ws.send(JSON.stringify({ type: "language", transcriptionLanguage: newLang }));
  ws.send(JSON.stringify({ type: "language", ttsLanguage: newLang === "en-US" ? "en-US" : "fr-CA" }));

  // Mettre à jour le system prompt en anglais
  if (newLang === "en-US" && session.config.system_prompt_en) {
    session.conversation[0] = { role: "system", content: session.config.system_prompt_en };
  }

  console.log(`[INBOUND] Language switched to ${newLang} for ${ws.callSid}`);
}

function shouldTransferToHuman(text, session) {
  const transferTriggers = session.config.transfer_triggers || [
    "parler à quelqu'un", "un humain", "un vrai", "votre responsable",
    "speak to someone", "real person", "human", "manager",
    "pas satisfait", "urgent", "urgence",
  ];
  const textLower = text.toLowerCase();
  return transferTriggers.some(trigger => textLower.includes(trigger.toLowerCase()));
}

async function handleHumanTransfer(ws, session) {
  const lang = session.language;
  const transferMsg = lang === "en-US"
    ? "Of course. I'm transferring you to our team right away. Please hold."
    : "Bien sûr. Je vous transfère à notre équipe immédiatement. Un instant s'il vous plaît.";

  // Envoyer le message de transfert
  ws.send(JSON.stringify({ type: "text", token: transferMsg, last: true }));

  // Créer le brief pour l'agent humain
  const brief = session.conversation
    .filter(m => m.role !== "system")
    .slice(-4)
    .map(m => `${m.role === "user" ? "Client" : (session.config?.assistant_name || "Assistant")}: ${m.content}`)
    .join("\n");

  // Déclencher le transfert via Twilio (numéro de transfert configuré)
  const transferNumber = session.config.transfer_phone;
  if (transferNumber) {
    ws.send(JSON.stringify({
      type: "end",
      handoffData: JSON.stringify({
        reasonCode: "human_transfer",
        brief,
        transferTo: transferNumber,
        companyId: session.companyId,
      }),
    }));
  } else {
    // Pas de numéro de transfert → prendre un message
    const noTransferMsg = lang === "en-US"
      ? "Our team is currently unavailable. I'll take your message and ensure someone calls you back."
      : "Notre équipe n'est pas disponible en ce moment. Je vais noter votre message et m'assurer qu'on vous rappelle.";
    ws.send(JSON.stringify({ type: "text", token: noTransferMsg, last: true }));
  }
}

async function callAIGateway({ task, userText, conversation, kbContext, language, companyId }) {
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
      }),
    });

    if (!response.ok) throw new Error(`AI Gateway error: ${response.status}`);
    const data = await response.json();
    return data.response || data.text || data.summary || "";
  } catch (err) {
    console.error("[AI Gateway] Error:", err);
    return language === "en-US"
      ? "I'm having a technical issue. Could you repeat that?"
      : "J'ai un petit problème technique. Pourriez-vous répéter?";
  }
}

async function streamResponse(ws, text) {
  if (!text) return;
  // Streamer mot par mot pour une expérience naturelle
  const words = text.split(" ");
  for (let i = 0; i < words.length; i++) {
    const token = i < words.length - 1 ? words[i] + " " : words[i];
    ws.send(JSON.stringify({ type: "text", token, last: i === words.length - 1 }));
    // Micro-délai pour simuler la génération naturelle
    if (i % 5 === 0 && i > 0) await new Promise(r => setTimeout(r, 10));
  }
}

// ── DÉMARRAGE ─────────────────────────────────────────────────
try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`✅ VoiceDesk IA — Inbound server on port ${PORT}`);
  console.log(`   TwiML    : https://${DOMAIN}/twiml/inbound`);
  console.log(`   WebSocket: wss://${DOMAIN}/ws/inbound`);
  console.log(`   Voice    : ${ELEVENLABS_VOICE}`);
} catch (err) {
  console.error("❌ Server error:", err);
  process.exit(1);
}
