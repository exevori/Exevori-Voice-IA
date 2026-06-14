// ============================================================
// EXEVORI VOICE IA — ConversationRelay WebSocket handler (Phase 8A)
//
// Twilio ConversationRelay ouvre une WebSocket vers nous quand
// la TwiML <ConversationRelay url="wss://..."> est rendue.
//
// Message types reçus (inbound from Twilio):
//   - setup        : metadata d'appel (callSid, from, to, customParameters)
//   - prompt       : voicePrompt (texte STT), last (boolean = phrase finale)
//   - dtmf         : digit (touche du clavier)
//   - interrupt    : barge-in (utilisateur a coupé Léa)
//   - error        : erreur Twilio
//
// Message types envoyés (outbound to Twilio):
//   - text         : {token: "...", last: true|false, interruptible: true}
//   - end          : raccrocher
//   - language     : changer langue (ex: switch fr → en)
//   - play         : jouer un fichier audio (URL .mp3)
//
// Phase 8A : on répond avec un texte hardcodé puis on raccroche.
//            Pas d'AI encore. Phase 8B branchera DeepSeek streaming.
// ============================================================

import { consumeWsToken } from "./inbound.js";
import { logEvent, setLiveStatus, endCall } from "./lifecycle.js";

export function attachVoiceRelayWS(wss) {
  wss.on("connection", (ws, req) => {
    const url = req.url || "";
    console.log("[voice/relay-ws] connection opened:", url);

    let session = null;        // { callSid, callId, companyId, accountSid, startedAtMs }
    let promptBuffer = "";     // STT partial transcripts accumulés

    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch (e) {
        console.error("[voice/relay-ws] non-JSON message", e.message);
        return;
      }

      switch (msg.type) {
        case "setup":
          await handleSetup(ws, msg);
          break;
        case "prompt":
          await handlePrompt(ws, msg);
          break;
        case "interrupt":
          await handleInterrupt(ws, msg);
          break;
        case "dtmf":
          await handleDtmf(ws, msg);
          break;
        case "error":
          console.error("[voice/relay-ws] Twilio error:", msg);
          if (session) {
            await logEvent({
              company_id: session.companyId, call_id: session.callId,
              event_type: "error", payload: msg,
              ts_ms: Date.now() - session.startedAtMs,
            });
          }
          break;
        default:
          console.log("[voice/relay-ws] unknown type:", msg.type);
      }
    });

    ws.on("close", async () => {
      console.log("[voice/relay-ws] connection closed", session?.callSid);
      if (session) {
        await logEvent({
          company_id: session.companyId, call_id: session.callId,
          event_type: "ended", payload: { reason: "ws_closed" },
          ts_ms: Date.now() - session.startedAtMs,
        });
        await endCall(session.callId).catch(() => {});
      }
    });

    ws.on("error", (e) => console.error("[voice/relay-ws] socket error:", e.message));

    // ─────────────────────────────────────────────────────────
    // Handlers
    // ─────────────────────────────────────────────────────────

    async function handleSetup(ws, msg) {
      // Auth : vérifier le wsAuthToken passé via <Parameter>
      const tokenFromTwilio = msg.customParameters?.wsAuthToken;
      const entry = tokenFromTwilio ? consumeWsToken(tokenFromTwilio) : null;

      if (!entry || entry.callSid !== msg.callSid) {
        console.warn("[voice/relay-ws] auth failed — closing", { callSid: msg.callSid });
        ws.send(JSON.stringify({ type: "text", token: "Erreur de configuration. Au revoir.", last: true }));
        ws.send(JSON.stringify({ type: "end" }));
        setTimeout(() => ws.close(), 500);
        return;
      }

      session = {
        callSid: msg.callSid,
        callId: entry.callId,
        companyId: entry.companyId,
        accountSid: entry.accountSid,
        startedAtMs: Date.now(),
      };

      await logEvent({
        company_id: session.companyId, call_id: session.callId,
        event_type: "connecting", payload: { setup: msg }, ts_ms: 0,
      });
      await setLiveStatus(session.callId, "ai_speaking");

      // Phase 8A : message d'accueil minimal après le welcomeGreeting.
      // Le welcomeGreeting est déjà joué par ConversationRelay au moment
      // du Connect (cf. inbound.js). On laisse l'utilisateur parler.
      // (Phase 8B branchera l'LLM ici.)
    }

    async function handlePrompt(ws, msg) {
      if (!session) return;

      const piece = msg.voicePrompt || "";
      promptBuffer += piece;

      // Log partial transcript (best-effort, on log que le 'last')
      if (msg.last) {
        const tsMs = Date.now() - session.startedAtMs;
        await logEvent({
          company_id: session.companyId, call_id: session.callId,
          event_type: "user_speaking",
          payload: { transcript: promptBuffer, lang: msg.lang },
          ts_ms: tsMs,
        });

        // Phase 8A : réponse hardcodée pour valider la plomberie.
        // Cette réponse simule ce que Phase 8B fera avec DeepSeek streaming.
        const reply =
          "Parfait ! Je vous remercie pour votre appel. Notre équipe vous rappellera très bientôt. Au revoir.";
        // Envoi en 1 seul token (Phase 8B streamera token par token).
        ws.send(JSON.stringify({
          type: "text",
          token: reply,
          last: true,
          interruptible: true,
        }));

        await logEvent({
          company_id: session.companyId, call_id: session.callId,
          event_type: "ai_speaking", payload: { reply },
          ts_ms: Date.now() - session.startedAtMs,
        });

        // Raccroche après la réponse
        ws.send(JSON.stringify({ type: "end", handoffData: JSON.stringify({ reason: "phase_8a_demo_end" }) }));
        promptBuffer = "";
      }
    }

    async function handleInterrupt(ws, msg) {
      if (!session) return;
      const tsMs = Date.now() - session.startedAtMs;
      await logEvent({
        company_id: session.companyId, call_id: session.callId,
        event_type: "interrupted", payload: msg, ts_ms: tsMs,
      });
    }

    async function handleDtmf(ws, msg) {
      if (!session) return;
      const tsMs = Date.now() - session.startedAtMs;
      await logEvent({
        company_id: session.companyId, call_id: session.callId,
        event_type: "user_speaking", payload: { dtmf: msg.digit }, ts_ms: tsMs,
      });
    }
  });
}
