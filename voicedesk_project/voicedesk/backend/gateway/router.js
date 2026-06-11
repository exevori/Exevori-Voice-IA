// ============================================================
// VOICEDESK IA — AI GATEWAY ROUTER v3 FINAL
// Provider : DeepSeek V3 via Fireworks.ai (seul en V0)
// Fallbacks Gemini/GPT : Phase 2
// ============================================================

import { DeepSeekAdapter } from "./adapters/deepseek.js";

const PROVIDERS = {
  deepseek: new DeepSeekAdapter(),
};

// V0 : DeepSeek seulement
// V1 : Ajouter gemini et openai ici sans changer VoiceDesk
const PRIMARY_PROVIDER = "deepseek";

const TASK_CONFIG = {
  // ── ENTRANT (voix) ──────────────────────────────────────────
  conversation:               { max_tokens: 400, temperature: 0.7, model_hint: "fast",    note: "Réponse vocale entrant" },
  summarize_call:             { max_tokens: 300, temperature: 0.3, model_hint: "fast",    note: "Résumé appel entrant → JSON" },
  classify_intent:            { max_tokens: 100, temperature: 0.1, model_hint: "fast",    note: "Classification intention → JSON" },

  // ── SORTANT (voix + missions) ───────────────────────────────
  outbound_conversation:      { max_tokens: 400, temperature: 0.7, model_hint: "fast",    note: "Réponse vocale sortant" },
  generate_outbound_script:   { max_tokens: 600, temperature: 0.5, model_hint: "quality", note: "Génère script mission → JSON" },
  analyze_outbound_result:    { max_tokens: 300, temperature: 0.2, model_hint: "fast",    note: "Résultat appel sortant → JSON" },

  // ── COURRIELS ───────────────────────────────────────────────
  classify_email:             { max_tokens: 150, temperature: 0.1, model_hint: "fast",    note: "Niveau 1 ou 2 → JSON" },
  generate_email_draft:       { max_tokens: 800, temperature: 0.5, model_hint: "quality", note: "Brouillon courriel niveau 2 → JSON" },
  regenerate_email_draft:     { max_tokens: 800, temperature: 0.6, model_hint: "quality", note: "Régénérer avec instruction admin" },

  // ── APPRENTISSAGE ───────────────────────────────────────────
  detect_learning_patterns:   { max_tokens: 1500, temperature: 0.4, model_hint: "quality", note: "Détection patterns récurrents → JSON" },
  generate_suggested_answer:  { max_tokens: 600, temperature: 0.5, model_hint: "quality", note: "Proposer réponse → JSON" },

  // ── DIVERS ──────────────────────────────────────────────────
  parse_import:               { max_tokens: 1000, temperature: 0.1, model_hint: "quality", note: "Analyse CSV → JSON" },
  detect_language:            { max_tokens: 10,  temperature: 0.0, model_hint: "fast",    note: "fr-CA ou en-CA → JSON" },
};

const stats = {
  total_requests: 0, total_tokens: 0, total_cost_usd: 0, errors: 0,
  by_task: {},
};

export const router = {
  async route(payload) {
    const { task, context, input, options = {} } = payload;
    const config = TASK_CONFIG[task] || TASK_CONFIG.conversation;

    stats.total_requests++;
    stats.by_task[task] = (stats.by_task[task] || 0) + 1;

    const provider = PROVIDERS[PRIMARY_PROVIDER];
    if (!provider?.isAvailable()) {
      throw new Error("DeepSeek non disponible — vérifier FIREWORKS_API_KEY");
    }

    try {
      const result = await provider.call({
        task, input, context,
        max_tokens:  options.max_tokens  || config.max_tokens,
        temperature: options.temperature ?? config.temperature,
        language:    context?.language   || "fr-CA",
        model_hint:  config.model_hint,
      });

      stats.total_tokens   += result.tokens_used || 0;
      stats.total_cost_usd += result.cost_usd    || 0;

      return { ...result, provider: PRIMARY_PROVIDER };
    } catch (err) {
      stats.errors++;
      throw err;
    }
  },

  async healthCheck() {
    const ping = await PROVIDERS[PRIMARY_PROVIDER].ping();
    return {
      status:   ping.ok ? "ok" : "down",
      provider: PRIMARY_PROVIDER,
      model:    process.env.DEEPSEEK_MODEL || "accounts/fireworks/models/deepseek-v3",
      note:     "Fallbacks Gemini/GPT ajoutés en Phase 2 sans modifier VoiceDesk",
    };
  },

  getStats() {
    return {
      ...stats,
      avg_cost_per_request: stats.total_requests > 0
        ? (stats.total_cost_usd / stats.total_requests).toFixed(6) : 0,
    };
  },
};

export { TASK_CONFIG };
