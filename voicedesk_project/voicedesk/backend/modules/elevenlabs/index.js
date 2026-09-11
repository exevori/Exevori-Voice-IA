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
import rateLimit from "express-rate-limit";
import { supabase } from "../voice/lifecycle.js";
import { searchSimilarChunks } from "../kb/rag.js";
import { assistantIdentity } from "../config/identity.js";
import { streamChat } from "../voice/llm.js";
import { resolveInboundPolicy } from "../voice/inboundPolicy.js";
import {
  findConsentTerminationToolName,
  isRecordingConsentRefusal,
  prefixConsentSystemRuleFr,
} from "../privacy/consent.js";
import { createCustomLlmAuthMiddleware } from "./customLlmAuth.js";
import { buildOutboundMissionPrompt } from "./outboundMission.js";
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
const customLlmRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => String(
    req.customLlmAgentId
      || req.headers?.["x-elevenlabs-agent-id"]
      || "authenticated-agent"
  ).slice(0, 200),
  message: { error: "custom_llm_rate_limited" },
});

function extractLastUserText(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  const lastUser = [...arr].reverse().find(m => m && m.role === "user");
  return typeof lastUser?.content === "string"
    ? lastUser.content.trim()
    : "";
}

function validateCustomLlmBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "invalid_body";
  }
  if (body.model !== undefined && typeof body.model !== "string") {
    return "invalid_model";
  }
  if (!Array.isArray(body.messages) || body.messages.length > 200) {
    return "invalid_messages";
  }
  let contentLength = 0;
  for (const message of body.messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return "invalid_message";
    }
    if (message.content !== null && message.content !== undefined) {
      if (typeof message.content !== "string") return "invalid_message_content";
      contentLength += message.content.length;
      if (contentLength > 250_000) return "messages_too_large";
    }
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 64)) {
    return "invalid_tools";
  }
  return null;
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
  const validationError = validateCustomLlmBody(body);
  if (validationError) {
    return res.status(400).json({ error: { message: validationError } });
  }
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
    direction,
    outboundQueueId,
    outboundAttemptId,
  } = extractCustomLlmTenantHints(req);
  let company;
  try {
    company = await resolveElevenLabsCompany({
      supabase,
      agentId,
      calledNumber,
      direction,
      outboundQueueId,
      outboundAttemptId,
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
    .select("assistant_name, tone, system_prompt_voice_fr, system_prompt_fr, rag_min_similarity")
    .eq("company_id", companyId)
    .maybeSingle();

  const assistantName = cfg?.assistant_name || "Léa";
  let systemPrompt = cfg?.system_prompt_voice_fr || cfg?.system_prompt_fr
    || `Tu es ${assistantName}, assistante vocale d'une PME québécoise. Réponds en français du Québec, ton chaleureux et professionnel, phrases courtes adaptées à l'audio.`;
  systemPrompt = prefixConsentSystemRuleFr(systemPrompt + assistantIdentity(cfg || {}));

  if (direction === "outbound") {
    let missionPrompt;
    try {
      missionPrompt = await buildOutboundMissionPrompt({
        supabase,
        companyId,
        queueId: outboundQueueId,
        attemptId: outboundAttemptId,
      });
    } catch {
      console.warn("[elevenlabs] outbound mission lookup unavailable");
      return res.status(503).json({
        error: { message: "Outbound mission unavailable" },
      });
    }
    if (!missionPrompt) {
      console.warn("[elevenlabs] outbound mission correlation failed");
      return res.status(503).json({
        error: { message: "Outbound mission unavailable" },
      });
    }
    systemPrompt += missionPrompt;
  } else {
    const contactCtx = await buildContactContext(fromNumber, companyId);
    if (contactCtx) systemPrompt += contactCtx;
  }

  // Les appels entrants respectent les horaires du tenant. L'indicateur
  // outbound vient exclusivement des dynamic_variables injectées par notre
  // worker sortant; en son absence, la politique la plus sûre est inbound.
  // Une panne de configuration ne coupe pas un appel déjà connecté.
  try {
    const inboundPolicy = await resolveInboundPolicy({
      supabase,
      companyId,
      direction,
    });
    if (inboundPolicy.promptSuffix) {
      systemPrompt += `\n\n${inboundPolicy.promptSuffix}`;
    }
  } catch {
    console.warn("[elevenlabs] inbound business-hours policy unavailable");
  }

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
        minSimilarity: cfg?.rag_min_similarity ?? 0.25,
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

const safeLlmHandler = (req, res, next) => {
  Promise.resolve(llmHandler(req, res)).catch(next);
};

router.post("/llm", requireCustomLlmAuth, customLlmRateLimiter, express.json({ limit: "1mb" }), safeLlmHandler);
router.post("/llm/chat/completions", requireCustomLlmAuth, customLlmRateLimiter, express.json({ limit: "1mb" }), safeLlmHandler);
router.post("/chat/completions", requireCustomLlmAuth, customLlmRateLimiter, express.json({ limit: "1mb" }), safeLlmHandler);

export default router;
