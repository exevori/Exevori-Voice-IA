// ============================================================
// EXEVORI VOICE IA — Fireworks AI / DeepSeek streaming (Phase 8B)
//
// Modèle: accounts/fireworks/models/deepseek-v4-flash
// API: OpenAI-compatible Chat Completions endpoint
//   POST https://api.fireworks.ai/inference/v1/chat/completions
//
// Streaming SSE token-par-token pour minimiser la latence
// first-token (~500ms cible).
// ============================================================

import dotenv from "dotenv";
dotenv.config();

const FIREWORKS_URL = "https://api.fireworks.ai/inference/v1/chat/completions";
const DEFAULT_MODEL = process.env.FIREWORKS_MODEL || "accounts/fireworks/models/deepseek-v4-flash";

/**
 * Stream une complétion DeepSeek. Appelle onToken(text) pour chaque
 * delta reçu. Retourne le texte complet à la fin.
 *
 * @param {Array<{role,content}>} messages
 * @param {(token:string)=>void} onToken
 * @param {object} opts {temperature, max_tokens, model, signal}
 * @returns {Promise<{text:string, firstTokenMs:number, totalMs:number}>}
 */
export async function streamChat(messages, onToken, opts = {}) {
  const apiKey = process.env.FIREWORKS_API_KEY;
  if (!apiKey || apiKey.startsWith("fw-placeholder")) {
    throw new Error("FIREWORKS_API_KEY missing or placeholder");
  }

  const body = {
    model: opts.model || DEFAULT_MODEL,
    messages,
    stream: true,
    temperature: opts.temperature ?? 0.6,
    // DeepSeek V4 Flash est un reasoning model : il émet delta.reasoning_content
    // (silenced ici) AVANT delta.content. Il faut un max_tokens large pour laisser
    // le reasoning se faire ET garder du budget pour la réponse parlée.
    max_tokens: opts.max_tokens ?? 1024,
  };

  const startMs = Date.now();
  let firstTokenMs = null;
  let fullText = "";
  let reasoningChars = 0;

  const res = await fetch(FIREWORKS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Fireworks HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  if (!res.body) throw new Error("Fireworks: no response body");

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
      // Reasoning model: on accumule la longueur du reasoning mais on NE forward PAS
      // au TTS — il ne doit pas parler son raisonnement interne.
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
  // Flush trailing buffer (last frame sans newline final)
  if (buffer.trim()) consume(buffer.trim());

  return {
    text: fullText.trim(),
    firstTokenMs: firstTokenMs ?? Date.now() - startMs,
    totalMs: Date.now() - startMs,
    reasoningChars,
  };
}
