// ============================================================
// VOICEDESK IA — AI GATEWAY v3 FINAL
// Provider unique : DeepSeek V3 via Fireworks.ai
// Fallbacks Gemini/GPT : Phase 2
// VoiceDesk appelle UNIQUEMENT : POST /api/ai/respond
// ============================================================

import express from "express";
import { router }      from "./router.js";
import { logger, rateLimiter, validator, costTracker } from "./middleware/index.js";

const app = express();
app.use(express.json());
app.use(logger);
app.use(rateLimiter);

// ── SEULE ROUTE QUE VOICEDESK CONNAÎT ────────────────────────
app.post("/api/ai/respond", validator, costTracker, async (req, res) => {
  const start = Date.now();
  try {
    const result = await router.route(req.body);
    return res.json({
      success:          true,
      provider:         result.provider,
      model:            result.model,
      response:         result.response,
      confidence_score: result.confidence_score,
      tokens_used:      result.tokens_used,
      cost_usd:         result.cost_usd,
      latency_ms:       Date.now() - start,
      task:             req.body.task,
    });
  } catch (err) {
    console.error("[Gateway] Fatal:", err.message);
    const lang = req.body?.context?.language || "fr-CA";
    return res.status(500).json({
      success: false,
      error:   "AI Gateway indisponible",
      fallback_response: lang === "en-CA"
        ? "I'm experiencing a technical issue. Let me transfer you to a team member."
        : "Je rencontre un problème technique. Je vous transfère à notre équipe.",
    });
  }
});

app.get("/api/ai/health", async (_req, res) => res.json(await router.healthCheck()));
app.get("/api/ai/stats",  async (_req, res) => res.json(router.getStats()));

const PORT = process.env.AI_GATEWAY_PORT || 3100;
app.listen(PORT, () => {
  console.log(`[AI Gateway] Port ${PORT} — Provider: DeepSeek V3 via Fireworks.ai`);
});

export default app;
