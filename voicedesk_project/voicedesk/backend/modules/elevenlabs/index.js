// ============================================================
// EXEVORI VOICE IA — ELEVENLABS CONVERSATIONAL AI (Custom LLM)
//
// Endpoint sans JWT, protégé par un secret partagé configuré dans ElevenLabs :
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
//   x-elevenlabs-custom-llm-secret → secret partagé obligatoire
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
import { supabase } from "../voice/lifecycle.js";
import { searchSimilarChunks } from "../kb/rag.js";
import { streamChat } from "../voice/llm.js";
import {
  findConsentTerminationToolName,
  isRecordingConsentRefusal,
  prefixConsentSystemRuleFr,
} from "../privacy/consent.js";
import { createCustomLlmAuthMiddleware } from "./customLlmAuth.js";
import {
  extractCustomLlmTenantHints,
  resolveElevenLabsCompany,
} from "./tenantResolver.js";

export {
  createCustomLlmAuthMiddleware,
  verifyCustomLlmSecret,
} from "./customLlmAuth.js";

const router = express.Router();
const requireCustomLlmAuth = createCustomLlmAuthMiddleware();

function extractLastUserText(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  const lastUser = [...arr].reverse().find(m => m && m.role === "user");
  return lastUser?.content?.trim() || "";
}

function normalizeConversationMessage(message) {
  if (!message || typeof message !== "object") return null;
  if (
    !["assistant", "user", "tool"].includes(message.role)
  ) {
    return null;
  }

  const normalized = { role: message.role };
  if (typeof message.content === "string" || message.content === null) {
    normalized.content = message.content;
  }
  if (typeof message.name === "string") normalized.name = message.name;
  if (typeof message.tool_call_id === "string") {
    normalized.tool_call_id = message.tool_call_id;
  }
  if (Array.isArray(message.tool_calls)) {
    normalized.tool_calls = message.tool_calls
      .filter(toolCall => toolCall && typeof toolCall === "object")
      .map(toolCall => ({
        id: typeof toolCall.id === "string" ? toolCall.id : "",
        type: "function",
        function: {
          name:
            typeof toolCall.function?.name === "string"
              ? toolCall.function.name
              : "",
          arguments:
            typeof toolCall.function?.arguments === "string"
              ? toolCall.function.arguments
              : "",
        },
      }));
  }
  return normalized;
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

function sendForcedConsentTermination(res, body, toolName) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const id = `chatcmpl-consent-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model || "custom";
  const writeChunk = (delta, finishReason = null) => {
    res.write(`data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason,
      }],
    })}\n\n`);
  };

  writeChunk({ role: "assistant" });
  writeChunk({
    content:
      "Je respecte votre choix. Je mets fin à l’appel maintenant.",
  });
  writeChunk({
    tool_calls: [{
      index: 0,
      id: `call_consent_${Math.random().toString(36).slice(2, 12)}`,
      type: "function",
      function: {
        name: toolName,
        arguments: "{}",
      },
    }],
  });
  writeChunk({}, "tool_calls");
  res.write("data: [DONE]\n\n");
  res.end();
}

const llmHandler = async (req, res) => {
  const t0 = Date.now();
  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUserText = extractLastUserText(messages);
  const userMessageCount = messages.filter(
    message => message?.role === "user"
  ).length;
  if (
    isRecordingConsentRefusal(lastUserText, {
      allowBareRefusal: userMessageCount <= 1,
    })
  ) {
    const terminationTool = findConsentTerminationToolName(body.tools);
    if (!terminationTool) {
      console.error("[elevenlabs] consent termination tool unavailable");
      return res.status(503).json({
        error: { message: "Consent termination unavailable" },
      });
    }
    sendForcedConsentTermination(res, body, terminationTool);
    console.log("[elevenlabs] consent refusal enforced");
    return;
  }

  // 1. Agent et numéro appelé → PME, sans tenant global de secours.
  const {
    agentId,
    calledNumber,
    callerNumber: fromNumber,
  } = extractCustomLlmTenantHints(req);
  let company;
  try {
    company = await resolveElevenLabsCompany({
      supabase,
      agentId,
      calledNumber,
    });
  } catch {
    console.warn("[elevenlabs] tenant lookup unavailable");
    return res.status(503).json({
      error: { message: "Tenant lookup unavailable" },
    });
  }

  if (!company) {
    console.warn("[elevenlabs] tenant resolution failed");
    return res.status(404).json({ error: { message: "Company not configured" } });
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
  systemPrompt = prefixConsentSystemRuleFr(systemPrompt);

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
    } catch {
      console.warn("[elevenlabs] RAG lookup failed");
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
    ...messages.map(normalizeConversationMessage).filter(Boolean),
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

  const writeChunk = (delta = {}, finishReason = null) => {
    const payload = {
      id: chunkId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta,
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
      try { writeChunk({ content: delta }); } catch (_) {}
    }, {
      signal: abortCtrl.signal,
      temperature: 0.4,
      max_tokens: 150,
      tools: Array.isArray(body.tools) ? body.tools : undefined,
      tool_choice: body.tool_choice,
      parallel_tool_calls: body.parallel_tool_calls,
      onToolCallDelta: toolCalls => {
        try { writeChunk({ tool_calls: toolCalls }); } catch (_) {}
      },
    });

    // Si LLM n'a rien produit, envoyer un fallback parlé
    if (!result.text && result.toolCalls.length === 0) {
      writeChunk({
        content: "Pardon, je n'ai pas saisi. Pouvez-vous reformuler ?",
      });
    }

    const finishReason =
      result.toolCalls.length > 0 ? "tool_calls" : result.finishReason;
    writeChunk({}, finishReason || "stop");
    res.write("data: [DONE]\n\n");
    res.end();

    console.log(
      `[elevenlabs] completed rag_chunks=${ragChunks} `
      + `first_token_ms=${result.firstTokenMs} total_ms=${result.totalMs} `
      + `pipeline_ms=${Date.now() - t0} provider=${process.env.LLM_PROVIDER || "?"}`
    );
  } catch {
    console.error("[elevenlabs] LLM request failed");
    try {
      writeChunk({
        content: "Désolée, problème technique. Veuillez reformuler.",
      });
      writeChunk({}, "stop");
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (_) {}
  }
};

router.post("/llm", requireCustomLlmAuth, express.json({ limit: "1mb" }), llmHandler);
router.post("/llm/chat/completions", requireCustomLlmAuth, express.json({ limit: "1mb" }), llmHandler);
router.post("/chat/completions", requireCustomLlmAuth, express.json({ limit: "1mb" }), llmHandler);

export default router;
