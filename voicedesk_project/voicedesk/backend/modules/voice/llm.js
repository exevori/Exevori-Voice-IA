// ============================================================
// EXEVORI VOICE IA — Multi-provider LLM streaming (Phase 8C-4)
//
// Providers supportés (toggle via env LLM_PROVIDER):
//   - "groq"      → Groq Llama 3.3 70B Versatile (first-token ~150-300ms)
//                   endpoint: https://api.groq.com/openai/v1/chat/completions
//   - "fireworks" → Fireworks DeepSeek V4 Flash (reasoning model, ~500-1000ms)
//                   endpoint: https://api.fireworks.ai/inference/v1/chat/completions
//
// Tous deux exposent une API OpenAI-compatible chat-completions avec SSE
// stream → on a un seul code-path. La seule différence : DeepSeek émet du
// "reasoning_content" qu'on silence.
//
// Fallback automatique : si le primary échoue (HTTP 5xx/network), on retry
// 1 fois sur le secondary. Définit LLM_FALLBACK_PROVIDER pour activer.
// ============================================================

import dotenv from "dotenv";
dotenv.config();

const PROVIDERS = {
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    apiKeyEnv: "GROQ_API_KEY",
    defaultModel: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  },
  cerebras: {
    url: "https://api.cerebras.ai/v1/chat/completions",
    apiKeyEnv: "CEREBRAS_API_KEY",
    defaultModel: process.env.CEREBRAS_MODEL || "llama-3.3-70b",
  },
  fireworks: {
    url: "https://api.fireworks.ai/inference/v1/chat/completions",
    apiKeyEnv: "FIREWORKS_API_KEY",
    defaultModel: process.env.FIREWORKS_MODEL || "accounts/fireworks/models/deepseek-v4-flash",
  },
};

function providerConfig(name) {
  const cfg = PROVIDERS[name];
  if (!cfg) throw new Error(`Unknown LLM provider: ${name}`);
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey || apiKey.startsWith("placeholder") || apiKey.startsWith("fw-placeholder") || apiKey.startsWith("gsk-placeholder")) {
    throw new Error(`${cfg.apiKeyEnv} missing or placeholder`);
  }
  return { ...cfg, apiKey };
}

/**
 * Stream une complétion LLM via le provider primary, avec fallback automatique
 * sur le secondary si défini.
 *
 * @param {Array<{role,content}>} messages
 * @param {(token:string)=>void} onToken
 * @param {object} opts {temperature, max_tokens, model, signal, provider}
 * @returns {Promise<{text:string, firstTokenMs:number, totalMs:number, provider:string, reasoningChars:number}>}
 */
export async function streamChat(messages, onToken, opts = {}) {
  const primary  = opts.provider || process.env.LLM_PROVIDER || "fireworks";
  const fallback = process.env.LLM_FALLBACK_PROVIDER || (primary === "groq" ? "fireworks" : null);

  try {
    return await streamChatSingle(primary, messages, onToken, opts);
  } catch (err) {
    if (err.name === "AbortError") throw err;
    if (!fallback || fallback === primary) throw err;
    console.warn(`[llm] primary=${primary} failed (${err.message}). Fallback=${fallback}.`);
    return await streamChatSingle(fallback, messages, onToken, opts);
  }
}

async function streamChatSingle(providerName, messages, onToken, opts) {
  const cfg = providerConfig(providerName);
  const body = {
    model: opts.model || cfg.defaultModel,
    messages,
    stream: true,
    temperature: opts.temperature ?? 0.6,
    max_tokens: opts.max_tokens ?? 200,
  };

  const startMs = Date.now();
  let firstTokenMs = null;
  let fullText = "";
  let reasoningChars = 0;

  const res = await fetch(cfg.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${providerName} HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  if (!res.body) throw new Error(`${providerName}: no response body`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const consume = (line) => {
    if (!line || !line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") return;
    try {
      const json = JSON.parse(payload);
      const delta = json.choices?.[0]?.delta || {};
      // DeepSeek/Fireworks émet du reasoning_content (silenced — Léa ne doit pas
      // parler son raisonnement). Groq Llama n'en émet pas.
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        reasoningChars += delta.reasoning_content.length;
      }
      if (typeof delta.content === "string" && delta.content) {
        if (firstTokenMs === null) firstTokenMs = Date.now() - startMs;
        fullText += delta.content;
        try { onToken(delta.content); } catch (_) {}
      }
    } catch (_) {
      // ignore malformed SSE chunk
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      consume(line);
    }
  }
  if (buffer.trim()) consume(buffer.trim());

  return {
    text: fullText.trim(),
    firstTokenMs: firstTokenMs ?? Date.now() - startMs,
    totalMs: Date.now() - startMs,
    reasoningChars,
    provider: providerName,
  };
}
