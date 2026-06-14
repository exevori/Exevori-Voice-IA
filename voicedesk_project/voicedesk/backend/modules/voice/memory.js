// ============================================================
// EXEVORI VOICE IA — Conversation memory (Phase 8B)
//
// Stocke en mémoire la conversation par twilio CallSid:
//   { messages: [{role, content}], startedAt }
// Auto-purge: 30 min après la fin d'appel.
//
// Phase 9 (déploiement multi-worker) → remplacer par Redis.
// ============================================================

const SESSIONS = new Map(); // callSid -> { messages, startedAt, lastTouch }
const TTL_MS = 30 * 60 * 1000;

function purge() {
  const now = Date.now();
  for (const [sid, s] of SESSIONS) {
    if (now - s.lastTouch > TTL_MS) SESSIONS.delete(sid);
  }
}
setInterval(purge, 5 * 60 * 1000).unref();

export function initSession(callSid, systemPrompt) {
  const session = {
    messages: [{ role: "system", content: systemPrompt }],
    startedAt: Date.now(),
    lastTouch: Date.now(),
  };
  SESSIONS.set(callSid, session);
  return session;
}

export function getSession(callSid) {
  const s = SESSIONS.get(callSid);
  if (s) s.lastTouch = Date.now();
  return s;
}

export function appendUser(callSid, content) {
  const s = SESSIONS.get(callSid);
  if (!s) return null;
  s.messages.push({ role: "user", content });
  s.lastTouch = Date.now();
  return s;
}

export function appendAssistant(callSid, content) {
  const s = SESSIONS.get(callSid);
  if (!s) return null;
  s.messages.push({ role: "assistant", content });
  s.lastTouch = Date.now();
  return s;
}

export function endSession(callSid) {
  return SESSIONS.delete(callSid);
}
