// ============================================================
// EXEVORI VOICE IA — RETELL AI WEBHOOK (Phase Retell)
//
// Endpoint public (pas d'auth JWT — appelé par Retell directement) :
//   POST /api/v1/retell/llm-webhook
//
// Payload Retell :
//   {
//     call: { from_number, to_number, ... },
//     transcript: "...",
//     interaction_type: "response_required" | "reminder_required" | "call_details"
//   }
//
// Pipeline :
//   1. Identifie la PME via to_number → twilio_configs.phone_number
//   2. Charge assistant_configs (system_prompt_voice_fr, voice_id)
//   3. RAG : searchSimilarChunks(transcript) sur la KB de la PME
//   4. LLM : streamChat(messages) → Cerebras (fallback Groq)
//   5. Renvoie : { "response": "..." }
// ============================================================

import express from "express";
import { findCompanyByTwilioNumber, supabase } from "../voice/lifecycle.js";
import { searchSimilarChunks } from "../kb/rag.js";
import { streamChat } from "../voice/llm.js";

const router = express.Router();

router.post("/llm-webhook", express.json({ limit: "1mb" }), async (req, res) => {
  const t0 = Date.now();
  const body = req.body || {};
  const call = body.call || {};
  const fromNumber = call.from_number || "";
  const toNumber = call.to_number || "";
  const transcript = String(body.transcript || "").trim();
  const interactionType = body.interaction_type || "response_required";

  // Retell envoie plusieurs types d'événements. On ne répond que pour response_required.
  if (interactionType !== "response_required") {
    return res.json({ response: "" });
  }

  if (!toNumber) {
    return res.status(400).json({ response: "", error: "to_number requis" });
  }

  try {
    // 1. PME via numéro Twilio appelé
    const company = await findCompanyByTwilioNumber(toNumber);
    if (!company) {
      console.warn(`[retell] PME introuvable pour to_number=${toNumber}`);
      return res.json({
        response: "Désolée, ce numéro n'est pas encore configuré. Au revoir.",
      });
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

    // 3. RAG (best-effort — si rien trouvé, on continue sans contexte)
    let ragContext = "";
    let ragChunks = 0;
    if (transcript) {
      try {
        const chunks = await searchSimilarChunks({
          company_id: companyId,
          query: transcript,
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

    // 4. Construction des messages LLM
    const systemBlocks = [systemPrompt];
    if (ragContext) {
      systemBlocks.push(
        `Connaissances de l'entreprise (utilise UNIQUEMENT ces informations pour répondre aux questions factuelles. Si la réponse n'y figure pas, dis que tu vas faire suivre la question à l'équipe.) :\n\n${ragContext}`
      );
    }
    const messages = [
      { role: "system", content: systemBlocks.join("\n\n---\n\n") },
      { role: "user", content: transcript || "Bonjour" },
    ];

    // 5. LLM (non-streaming côté Retell : on attend la réponse complète)
    const result = await streamChat(messages, () => {}, {
      temperature: 0.6,
      max_tokens: 200,
    });

    const responseText = (result.text || "").trim()
      || "Pardon, je n'ai pas bien saisi. Pouvez-vous reformuler ?";

    console.log(
      `[retell] company=${companyId} from=${fromNumber} rag_chunks=${ragChunks} `
      + `first_token_ms=${result.firstTokenMs} total_ms=${result.totalMs} `
      + `pipeline_ms=${Date.now() - t0} provider=cerebras+fallback`
    );

    return res.json({ response: responseText });
  } catch (err) {
    console.error("[retell] error:", err.message);
    return res.status(500).json({
      response: "Désolée, problème technique. Veuillez rappeler dans quelques instants.",
      error: err.message,
    });
  }
});

export default router;
