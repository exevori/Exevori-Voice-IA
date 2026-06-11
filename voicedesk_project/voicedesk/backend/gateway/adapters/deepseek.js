// ============================================================
// VOICEDESK IA — AI GATEWAY — ADAPTATEUR DEEPSEEK
// Provider principal — DeepSeek V3 via Fireworks.ai
// Modèle : accounts/fireworks/models/deepseek-v3
// Context : 1M tokens
// ============================================================

import { buildSystemPrompt } from "../prompts.js";

// Prix Fireworks.ai — DeepSeek V3 (mai 2025)
const PRICING = {
  input_per_million:  0.90,   // USD
  output_per_million: 0.90,   // USD
};

// Modèles disponibles selon le hint de performance
const MODELS = {
  fast:    "accounts/fireworks/models/deepseek-v3",
  quality: "accounts/fireworks/models/deepseek-v3",
  // Quand DeepSeek R1 est nécessaire (raisonnement complexe) :
  reasoning: "accounts/fireworks/models/deepseek-r1",
};

export class DeepSeekAdapter {

  constructor() {
    this.name       = "deepseek";
    this.baseURL    = "https://api.fireworks.ai/inference/v1";
    this.apiKey     = process.env.FIREWORKS_API_KEY;
    this._available = true;
  }

  isAvailable() {
    return this._available && !!this.apiKey;
  }

  // ── Appel principal ─────────────────────────────────────
  async call(request) {
    const { task, input, context, max_tokens, temperature, language, model_hint } = request;

    const model         = MODELS[model_hint] || MODELS.fast;
    const systemPrompt  = buildSystemPrompt(task, context, language);
    const messages      = this._buildMessages(task, systemPrompt, input, context);

    const payload = {
      model,
      messages,
      max_tokens:  Math.min(max_tokens, 2000),
      temperature: temperature ?? 0.7,
    };

    // Forcer une réponse JSON pour les tâches structurées
    if (this._isStructuredTask(task)) {
      payload.response_format = { type: "json_object" };
    }

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000), // 8s max pour un appel voix
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`DeepSeek API error ${response.status}: ${err}`);
    }

    const data   = await response.json();
    const choice = data.choices?.[0];

    if (!choice) throw new Error("DeepSeek: réponse vide");

    const rawText        = choice.message?.content || "";
    const tokensIn       = data.usage?.prompt_tokens     || 0;
    const tokensOut      = data.usage?.completion_tokens || 0;
    const totalTokens    = tokensIn + tokensOut;

    const costUSD = (
      (tokensIn  / 1_000_000) * PRICING.input_per_million +
      (tokensOut / 1_000_000) * PRICING.output_per_million
    );

    return {
      model,
      response:         this._parseResponse(task, rawText),
      raw:              rawText,
      confidence_score: this._estimateConfidence(rawText, task),
      tokens_used:      totalTokens,
      tokens_in:        tokensIn,
      tokens_out:       tokensOut,
      cost_usd:         parseFloat(costUSD.toFixed(6)),
    };
  }

  // ── Construction des messages ───────────────────────────
  _buildMessages(task, systemPrompt, input, context) {
    const messages = [{ role: "system", content: systemPrompt }];

    // Historique de conversation pour les tâches conversationnelles
    if (context?.conversation_history?.length) {
      for (const msg of context.conversation_history.slice(-10)) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    messages.push({ role: "user", content: input });
    return messages;
  }

  // ── Parse la réponse selon la tâche ────────────────────
  _parseResponse(task, rawText) {
    if (this._isStructuredTask(task)) {
      try {
        return JSON.parse(rawText.replace(/```json\n?|\n?```/g, "").trim());
      } catch {
        return rawText; // Fallback si parsing JSON échoue
      }
    }
    return rawText.trim();
  }

  // ── Tâches qui nécessitent une réponse JSON ─────────────
  _isStructuredTask(task) {
    return [
      "summarize_call",
      "classify_intent",
      "suggest_learning",
      "parse_import",
      "detect_language",
    ].includes(task);
  }

  // ── Estimation du score de confiance ────────────────────
  _estimateConfidence(text, task) {
    if (!text || text.length < 10) return 30;

    // Indicateurs de faible confiance dans la réponse
    const lowConfidenceSignals = [
      "je ne sais pas",
      "je n'ai pas l'information",
      "je ne suis pas certain",
      "i don't know",
      "i'm not sure",
      "transmettre à l'équipe",
    ];

    const textLower = text.toLowerCase();
    const hasLowSignal = lowConfidenceSignals.some(s => textLower.includes(s));

    if (hasLowSignal) return 45;
    if (task === "classify_intent" && text.length < 30) return 90; // Court = précis
    if (task === "conversation" && text.length > 50) return 82;
    return 78;
  }

  // ── Ping de santé ───────────────────────────────────────
  async ping() {
    try {
      const resp = await fetch(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model:      MODELS.fast,
          messages:   [{ role: "user", content: "ping" }],
          max_tokens: 5,
        }),
        signal: AbortSignal.timeout(3000),
      });
      return { ok: resp.ok, status: resp.status, provider: "deepseek" };
    } catch (err) {
      return { ok: false, error: err.message, provider: "deepseek" };
    }
  }
}
