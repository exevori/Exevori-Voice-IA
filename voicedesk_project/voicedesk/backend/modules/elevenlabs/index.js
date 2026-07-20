// ============================================================
// EXEVORI VOICE IA — ELEVENLABS CONVERSATIONAL AI (Custom LLM)
//
// Endpoint public (sans JWT — ElevenLabs ne peut pas s'authentifier autrement) :
//   POST /api/v1/elevenlabs/llm
//
// Format reçu d'ElevenLabs : compatible OpenAI Chat Completions
//   {
//     "model": "custom",
//     "messages": [{ role, content }, ...],
//     "stream": true
//   }
//
// Headers ElevenLabs (selon l'agent configuré) :
//   x-elevenlabs-agent-id
//   x-elevenlabs-call-id
//   x-elevenlabs-called-number    → numéro Twilio appelé (→ PME)
//   x-elevenlabs-caller-number    → numéro appelant
//
// Pipeline interne :
//   1. called-number → PME (findCompanyByTwilioNumber)
//   2. assistant_configs (system prompt)
//   3. RAG (searchSimilarChunks) sur la KB de la PME
//   4. LLM streaming (Groq primary, fallback fireworks via streamChat)
//   5. Réponse SSE format OpenAI : data: {...}\n\n ... data: [DONE]\n\n
// ============================================================

import express from "express";
import { findCompanyByTwilioNumber, supabase } from "../voice/lifecycle.js";
import { searchSimilarChunks } from "../kb/rag.js";
import { streamChat } from "../voice/llm.js";

const router = express.Router();

function extractLastUserText(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  const lastUser = [...arr].reverse().find(m => m && m.role === "user");
  return lastUser?.content?.trim() || "";
}

async function resolveCompany(toNumber) {
  if (toNumber) {
    const { data: pn } = await supabase
      .from("phone_numbers")
      .select("company_id")
      .eq("phone_number", toNumber)
      .eq("status", "active")
      .single();
    if (pn?.company_id) {
      console.log(`[elevenlabs] tenant via phone_numbers: ${toNumber} → ${pn.company_id}`);
      return { company_id: pn.company_id };
    }
  }
  if (toNumber) {
    const { data: tc } = await supabase
      .from("twilio_configs")
      .select("company_id")
      .eq("phone_number", toNumber)
      .single();
    if (tc?.company_id) {
      console.log(`[elevenlabs] tenant via twilio_configs: ${toNumber} → ${tc.company_id}`);
      return { company_id: tc.company_id };
    }
  }
  const defaultId = process.env.ELEVENLABS_DEFAULT_COMPANY_ID;
  if (defaultId) {
    const { data: co } = await supabase
      .from("companies").select("id").eq("id", defaultId).single();
    if (co) {
      console.log(`[elevenlabs] fallback ELEVENLABS_DEFAULT_COMPANY_ID (to_number="${toNumber || "none"}")`);
      return { company_id: defaultId };
    }
  }
  return null;
}

async function buildContactContext(fromNumber, companyId) {
  if (!fromNumber || !companyId) return "";
  const { data: contact } = await supabase
    .from("contacts")
    .select("full_name, main_need, status, notes")
    .eq("company_id", companyId)
    .eq("phone", fromNumber)
    .maybeSingle();
  if (!contact) return "";
  const { data: lastCall } = await supabase
    .from("calls")
    .select("ai_summary, created_at")
    .eq("company_id", companyId)
    .eq("caller_phone", fromNumber)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const lines = [
    `\n\n═══ HISTORIQUE CLIENT ═══`,
    `Nom : ${contact.full_name}`,
    contact.status    ? `Statut : ${contact.status}` : null,
    contact.main_need ? `Besoin connu : ${contact.main_need}` : null,
    contact.notes     ? `Notes : ${contact.notes}` : null,
    lastCall?.ai_summary
      ? `Dernier appel (${new Date(lastCall.created_at).toLocaleDateString("fr-CA")}) : ${lastCall.ai_summary}`
      : null,
    `═══════════════════════`,
  ].filter(Boolean);
  return lines.join("\n");
}

const llmHandler = async (req, res) => {
  const t0 = Date.now();
  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];

  // 1. Numéro appelé → PME
  const toNumber = String(
    req.headers["x-elevenlabs-called-number"]
    || req.headers["x-elevenlabs-to-number"]
    || ""
  ).trim();
  const fromNumber = String(req.headers["x-elevenlabs-caller-number"] || "").trim();
  const elAgentId = req.headers["x-elevenlabs-agent-id"] || "";
  const elCallId = req.headers["x-elevenlabs-call-id"] || "";

  // Log forensique : ElevenLabs ne documente pas tous les headers / payload
  // qu'il envoie. On dump UNE FOIS pour comprendre, puis on raffinera la
  // logique de résolution multi-tenant.
  if (!toNumber) {
    try {
      const safeBody = { ...body };
      if (Array.isArray(safeBody.messages)) {
        safeBody.messages = safeBody.messages.map(m => ({
          role: m.role,
          content: typeof m.content === "string" ? m.content.slice(0, 200) : m.content,
        }));
      }
      console.log("[elevenlabs] FORENSIC headers=", JSON.stringify({
        "x-elevenlabs-called-number": req.headers["x-elevenlabs-called-number"],
        "x-elevenlabs-caller-number": req.headers["x-elevenlabs-caller-number"],
        "x-elevenlabs-agent-id":      req.headers["x-elevenlabs-agent-id"],
        "x-elevenlabs-call-id":       req.headers["x-elevenlabs-call-id"],
        "x-elevenlabs-conversation-id": req.headers["x-elevenlabs-conversation-id"],
        "user-agent":                 req.headers["user-agent"],
        "x-source":                   req.headers["x-source"],
        "authorization":              req.headers["authorization"] ? "[present]" : undefined,
      }));
      console.log("[elevenlabs] FORENSIC body=", JSON.stringify(safeBody).slice(0, 800));
    } catch (_) {}
  }

  const company = await resolveCompany(toNumber);

  if (!company) {
    console.warn(`[elevenlabs] PME introuvable: to_number="${toNumber}" et pas de ELEVENLABS_DEFAULT_COMPANY_ID utilisable`);
    return res.status(404).json({ error: { message: `Company not configured (to_number=${toNumber || "none"})` } });
  }
  const companyId = company.company_id;

  // 2. Config assistante
  const { data: cfg } = await supabase
    .from("assistant_configs")
    .select("assistant_name, system_prompt_voice_fr, system_prompt_fr")
    .eq("company_id", companyId)
    .maybeSingle();

  const assistantName = cfg?.assistant_name || "Léa";
  let systemPrompt = cfg?.system_prompt_voice_fr || cfg?.system_prompt_fr
    || `Tu es ${assistantName}, assistante vocale d'une PME québécoise. Réponds en français du Québec, ton chaleureux et professionnel, phrases courtes adaptées à l'audio.`;

  const contactCtx = await buildContactContext(fromNumber, companyId);
  if (contactCtx) systemPrompt += contactCtx;

  // 3. RAG sur le dernier message utilisateur
  const userText = extractLastUserText(messages);
  let ragContext = "";
  let ragChunks = 0;
  if (userText) {
    try {
      const chunks = await searchSimilarChunks({
        company_id: companyId,
        query: userText,
        topK: 3,
        minSimilarity: 0.25,
      });
      ragChunks = (chunks || []).length;
      if (ragChunks > 0) {
        ragContext = chunks.map((c, i) =>
          `[Source ${i + 1}] ${c.content || c.text_content || ""}`
        ).join("\n\n");
      }
    } catch (e) {
      console.warn(`[elevenlabs] RAG error: ${e.message}`);
    }
  }

  // 4. Construction des messages LLM
  // On INJECTE notre system prompt (avec RAG) en remplacement de celui d'ElevenLabs
  // pour garantir RAG + ton PME, mais on conserve l'historique conversation.
  const systemBlocks = [systemPrompt];
  if (ragContext) {
    systemBlocks.push(
      `Connaissances de l'entreprise (utilise UNIQUEMENT ces informations pour répondre aux questions factuelles. Si la réponse n'y figure pas, dis que tu vas faire suivre la question à l'équipe.) :\n\n${ragContext}`
    );
  }
  const llmMessages = [
    { role: "system", content: systemBlocks.join("\n\n---\n\n") },
    ...messages.filter(m => m && m.role && m.role !== "system" && typeof m.content === "string"),
  ];

  // 5. Streaming SSE format OpenAI Chat Completions
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const chunkId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model || "custom";

  const writeChunk = (delta, finishReason = null) => {
    const payload = {
      id: chunkId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: delta ? { content: delta } : {},
          finish_reason: finishReason,
        },
      ],
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  // Premier chunk : rôle assistant
  res.write(`data: ${JSON.stringify({
    id: chunkId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  })}\n\n`);

  // Client disconnect → abort LLM
  const abortCtrl = new AbortController();
  req.on("close", () => { try { abortCtrl.abort(); } catch (_) {} });

  try {
    const result = await streamChat(llmMessages, (delta) => {
      try { writeChunk(delta); } catch (_) {}
    }, {
      signal: abortCtrl.signal,
      temperature: 0.4,
      max_tokens: 150,
    });

    // Si LLM n'a rien produit, envoyer un fallback parlé
    if (!result.text) {
      writeChunk("Pardon, je n'ai pas saisi. Pouvez-vous reformuler ?");
    }

    // Final chunk : finish_reason="stop"
    writeChunk(null, "stop");
    res.write("data: [DONE]\n\n");
    res.end();

    console.log(
      `[elevenlabs] company=${companyId} from=${fromNumber} `
      + `el_agent=${elAgentId} el_call=${elCallId} rag_chunks=${ragChunks} `
      + `first_token_ms=${result.firstTokenMs} total_ms=${result.totalMs} `
      + `pipeline_ms=${Date.now() - t0} provider=${process.env.LLM_PROVIDER || "?"}`
    );
  } catch (err) {
    console.error("[elevenlabs] LLM error:", err.message);
    try {
      writeChunk("Désolée, problème technique. Veuillez reformuler.");
      writeChunk(null, "stop");
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (_) {}
  }
};

router.post("/llm",                 express.json({ limit: "1mb" }), llmHandler);
router.post("/llm/chat/completions", express.json({ limit: "1mb" }), llmHandler);
router.post("/chat/completions",     express.json({ limit: "1mb" }), llmHandler);

export default router;
