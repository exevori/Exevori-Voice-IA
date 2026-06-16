// ============================================================
// EXEVORI VOICE IA — RETELL AI INTEGRATION (Phase Retell)
//
// Expose deux interfaces vers Retell :
//
//  A. HTTP POST  /api/v1/retell/llm-webhook   (mode webhook simple)
//     - Retell envoie le payload, on répond { response: "..." }
//
//  B. WebSocket  /api/v1/retell/llm-ws         (mode Custom LLM officiel)
//     - Retell ouvre un WS pour toute la durée de l'appel
//     - Retell envoie : { interaction_type, response_id, transcript, call }
//     - On répond     : { response_type: "response", response_id, content,
//                         content_complete: true, end_call: false }
//
// Pipeline interne identique pour les 2 :
//   1. to_number    → PME via twilio_configs
//   2. assistant_configs (system prompt)
//   3. RAG (searchSimilarChunks) sur la KB de la PME
//   4. LLM (Groq primary, fallback fireworks via streamChat)
// ============================================================

import express from "express";
import { findCompanyByTwilioNumber, supabase } from "../voice/lifecycle.js";
import { searchSimilarChunks } from "../kb/rag.js";
import { streamChat } from "../voice/llm.js";

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function extractLastUserText(transcript) {
  const arr = Array.isArray(transcript) ? transcript : [];
  const lastUser = [...arr].reverse().find(m => m && m.role === "user");
  return lastUser?.content?.trim() || "";
}

/**
 * Pipeline complet PME → RAG → LLM.
 * @returns {Promise<{responseText: string, ragChunks: number,
 *                    firstTokenMs: number, totalMs: number,
 *                    pipelineMs: number, companyId: string|null}>}
 */
async function runPipeline({ toNumber, fromNumber, userText }) {
  const t0 = Date.now();

  // 1. PME via numéro Twilio appelé
  const company = await findCompanyByTwilioNumber(toNumber);
  if (!company) {
    console.warn(`[retell] PME introuvable pour to_number=${toNumber}`);
    return {
      responseText: "Désolée, ce numéro n'est pas encore configuré. Au revoir.",
      ragChunks: 0,
      firstTokenMs: 0,
      totalMs: 0,
      pipelineMs: Date.now() - t0,
      companyId: null,
    };
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

  // 3. RAG (best-effort)
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
      console.warn(`[retell] RAG error: ${e.message}`);
    }
  }

  // 4. Messages LLM
  const systemBlocks = [systemPrompt];
  if (ragContext) {
    systemBlocks.push(
      `Connaissances de l'entreprise (utilise UNIQUEMENT ces informations pour répondre aux questions factuelles. Si la réponse n'y figure pas, dis que tu vas faire suivre la question à l'équipe.) :\n\n${ragContext}`
    );
  }
  const messages = [
    { role: "system", content: systemBlocks.join("\n\n---\n\n") },
    { role: "user", content: userText || "Bonjour" },
  ];

  // 5. LLM
  const result = await streamChat(messages, () => {}, {
    temperature: 0.6,
    max_tokens: 200,
  });

  const responseText = (result.text || "").trim()
    || "Pardon, je n'ai pas bien saisi. Pouvez-vous reformuler ?";

  const pipelineMs = Date.now() - t0;
  console.log(
    `[retell] company=${companyId} from=${fromNumber} rag_chunks=${ragChunks} `
    + `first_token_ms=${result.firstTokenMs} total_ms=${result.totalMs} `
    + `pipeline_ms=${pipelineMs} provider=${process.env.LLM_PROVIDER || "?"}`
  );

  return {
    responseText,
    ragChunks,
    firstTokenMs: result.firstTokenMs,
    totalMs: result.totalMs,
    pipelineMs,
    companyId,
  };
}

// ─────────────────────────────────────────────────────────────
// A. HTTP webhook (mode simple)
// ─────────────────────────────────────────────────────────────

router.post("/llm-webhook", express.json({ limit: "1mb" }), async (req, res) => {
  const body = req.body || {};
  const call = body.call || {};
  const fromNumber = call.from_number || "";
  const toNumber = call.to_number || "";
  const userText = extractLastUserText(body.transcript);
  const interactionType = body.interaction_type || "response_required";

  if (interactionType !== "response_required") {
    return res.json({ response: "" });
  }
  if (!toNumber) {
    return res.status(400).json({ response: "", error: "to_number requis" });
  }

  try {
    const r = await runPipeline({ toNumber, fromNumber, userText });
    return res.json({ response: r.responseText });
  } catch (err) {
    console.error("[retell] webhook error:", err.message);
    return res.status(500).json({
      response: "Désolée, problème technique. Veuillez rappeler dans quelques instants.",
      error: err.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────
// B. WebSocket handler — Retell Custom LLM officiel
//   - Retell sets up the WS at start of call
//   - Sends a `call_details` message d'abord (info appel)
//   - Puis des `response_required` (et `update_only` qu'on ignore)
//   - On répond par { response_type, response_id, content, content_complete }
// ─────────────────────────────────────────────────────────────

export function attachRetellWS(wss) {
  wss.on("connection", (ws, req) => {
    console.log(`[retell/ws] connection opened: ${req.url}`);
    let callInfo = { from_number: "", to_number: "" };

    // Retell Custom LLM protocol : le serveur DOIT envoyer un message "config"
    // dès l'ouverture de la WebSocket, sinon Retell timeout et ferme.
    try {
      ws.send(JSON.stringify({
        response_type: "config",
        config: {
          auto_reconnect: true,
          call_details: true,
        },
        response_id: 1,
      }));
    } catch (e) {
      console.error("[retell/ws] failed to send init config:", e.message);
    }

    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch (e) {
        console.warn(`[retell/ws] non-JSON message: ${e.message}`);
        return;
      }

      // Met à jour les infos d'appel dès qu'on les reçoit (call_details ou response_required)
      if (msg.call) {
        if (msg.call.from_number) callInfo.from_number = msg.call.from_number;
        if (msg.call.to_number)   callInfo.to_number   = msg.call.to_number;
      }

      const type = msg.interaction_type;
      // Retell envoie aussi "update_only" (transcript intermédiaire) — on ignore.
      // "call_details" arrive en premier — on n'a rien à dire.
      if (type !== "response_required" && type !== "reminder_required") {
        return;
      }

      const userText = extractLastUserText(msg.transcript);
      const responseId = typeof msg.response_id === "number" ? msg.response_id : 0;

      try {
        const r = await runPipeline({
          toNumber: callInfo.to_number,
          fromNumber: callInfo.from_number,
          userText,
        });

        ws.send(JSON.stringify({
          response_type: "response",
          response_id: responseId,
          content: r.responseText,
          content_complete: true,
          end_call: false,
        }));
      } catch (err) {
        console.error("[retell/ws] pipeline error:", err.message);
        try {
          ws.send(JSON.stringify({
            response_type: "response",
            response_id: responseId,
            content: "Désolée, problème technique. Veuillez rappeler.",
            content_complete: true,
            end_call: true,
          }));
        } catch (_) {}
      }
    });

    ws.on("close", () => {
      console.log(`[retell/ws] connection closed from=${callInfo.from_number} to=${callInfo.to_number}`);
    });

    ws.on("error", (err) => {
      console.error("[retell/ws] error:", err.message);
    });
  });
}

export default router;
