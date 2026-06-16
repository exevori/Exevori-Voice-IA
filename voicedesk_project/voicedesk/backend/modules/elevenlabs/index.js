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

router.post("/llm", express.json({ limit: "1mb" }), async (req, res) => {
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

  if (!toNumber) {
    return res.status(400).json({ error: { message: "x-elevenlabs-called-number header missing" } });
  }

  const company = await findCompanyByTwilioNumber(toNumber);
  if (!company) {
    console.warn(`[elevenlabs] PME introuvable pour to_number=${toNumber}`);
    return res.status(404).json({ error: { message: `Company not configured for ${toNumber}` } });
  }
  const companyId = company.company_id;

  // 2. Config assistante
  const { data: cfg } = await supabase
    .from("assistant_configs")
    .select("assistant_name, system_prompt_voice_fr, system_prompt_fr")
    .eq("company_id", companyId)
    .maybeSingle();

  const assistantName = cfg?.assistant_name || "Léa";
  const systemPrompt = cfg?.system_prompt_voice_fr || cfg?.system_prompt_fr
    || `Tu es ${assistantName}, assistante vocale d'une PME québécoise. Réponds en français du Québec, ton chaleureux et professionnel, phrases courtes adaptées à l'audio.`;

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
});

export default router;
