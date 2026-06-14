// ============================================================
// EXEVORI VOICE IA — Voice module entry (Phase 8A)
// Exporte le router HTTP + l'attacher WebSocket.
// ============================================================

export { default as voiceWebhookRouter } from "./inbound.js";
export { attachVoiceRelayWS } from "./relay-ws.js";
export { attachMediaStreamWS } from "./media-stream-ws.js";
