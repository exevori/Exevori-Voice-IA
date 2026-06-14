// ============================================================
// EXEVORI VOICE IA — ConversationRelay WebSocket handler (Phase 8B)
//
// 8A: hardcoded text response after every user turn.
// 8B: DeepSeek V4 Flash streaming via Fireworks → text tokens
//     sent live to ConversationRelay as we receive them.
//
// Message types reçus (inbound from Twilio):
//   setup, prompt, interrupt, dtmf, error
//
// Message types envoyés (outbound to Twilio):
//   text: {token, last, interruptible, preemptible}
//   end:  raccrocher
// ============================================================

import { consumeWsToken } from "./inbound.js";
import { logEvent, setLiveStatus, endCall } from "./lifecycle.js";
import { streamChat } from "./llm.js";
import { initSession, getSession, appendUser, appendAssistant, endSession } from "./memory.js";

export function attachVoiceRelayWS(wss) {
  wss.on("connection", (ws, req) => {
    console.log("[voice/relay-ws] connection opened:", req.url);

    let session = null;        // { callSid, callId, companyId, startedAtMs, systemPrompt, assistantName }
    let promptBuffer = "";     // accumulates partial STT until last=true
    let llmAbort = null;       // AbortController pour interrompre un stream LLM en cours

    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch (e) {
        console.error("[voice/relay-ws] non-JSON message", e.message);
        return;
      }

      switch (msg.type) {
        case "setup":     await handleSetup(msg); break;
        case "prompt":    await handlePrompt(msg); break;
        case "interrupt": await handleInterrupt(msg); break;
        case "dtmf":      await handleDtmf(msg); break;
        case "error":
          console.error("[voice/relay-ws] Twilio error:", msg);
          if (session) await logEvent({
            company_id: session.companyId, call_id: session.callId,
            event_type: "error", payload: msg,
            ts_ms: Date.now() - session.startedAtMs,
          });
          break;
        default:
          console.log("[voice/relay-ws] unknown type:", msg.type);
      }
    });

    ws.on("close", async () => {
      console.log("[voice/relay-ws] connection closed", session?.callSid);
      if (llmAbort) llmAbort.abort();
      if (session) {
        await logEvent({
          company_id: session.companyId, call_id: session.callId,
          event_type: "ended", payload: { reason: "ws_closed" },
          ts_ms: Date.now() - session.startedAtMs,
        });
        await endCall(session.callId).catch(() => {});
        endSession(session.callSid);
      }
    });

    ws.on("error", (e) => console.error("[voice/relay-ws] socket error:", e.message));

    // ─────────────────────────────────────────────────────────
    async function handleSetup(msg) {
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
        callSid:      msg.callSid,
        callId:       entry.callId,
        companyId:    entry.companyId,
        accountSid:   entry.accountSid,
        startedAtMs:  Date.now(),
        systemPrompt: entry.systemPrompt || "",
        assistantName: entry.assistantName || "Léa",
      };

      initSession(session.callSid, session.systemPrompt);

      await logEvent({
        company_id: session.companyId, call_id: session.callId,
        event_type: "connecting", payload: { setup: { from: msg.from, to: msg.to } }, ts_ms: 0,
      });
      await setLiveStatus(session.callId, "ai_speaking");
    }

    async function handlePrompt(msg) {
      if (!session) return;
      const piece = msg.voicePrompt || "";
      promptBuffer += piece;

      if (!msg.last) return;

      // L'utilisateur a fini de parler. Log + génère réponse LLM streaming.
      const userText = promptBuffer.trim();
      promptBuffer = "";

      await logEvent({
        company_id: session.companyId, call_id: session.callId,
        event_type: "user_speaking",
        payload: { transcript: userText, lang: msg.lang },
        ts_ms: Date.now() - session.startedAtMs,
      });
      await setLiveStatus(session.callId, "user_speaking");

      appendUser(session.callSid, userText);
      const conv = getSession(session.callSid);
      if (!conv) return;

      // Annule un éventuel stream LLM en cours (cas rare de prompts qui se chevauchent)
      if (llmAbort) { try { llmAbort.abort(); } catch (_) {} }
      llmAbort = new AbortController();
      let firstTokenLogged = false;
      let assistantText = "";

      try {
        await setLiveStatus(session.callId, "ai_speaking");
        const result = await streamChat(
          conv.messages,
          (delta) => {
            assistantText += delta;
            if (!firstTokenLogged) {
              firstTokenLogged = true;
              logEvent({
                company_id: session.companyId, call_id: session.callId,
                event_type: "ai_first_token", payload: {},
                ts_ms: Date.now() - session.startedAtMs,
              });
            }
            // Envoie chaque delta à ConversationRelay (streaming TTS)
            try {
              ws.send(JSON.stringify({
                type: "text", token: delta, last: false, interruptible: true, preemptible: true,
              }));
            } catch (_) {}
          },
          { signal: llmAbort.signal, temperature: 0.6, max_tokens: 1024 }
        );

        // Safety net: si le LLM n'a émis aucun token (ex: reasoning a consommé max_tokens),
        // on envoie un fallback parlé au lieu de laisser un silence mort.
        if (!result.text) {
          const fallback = "Pardon, je n'ai pas saisi. Pouvez-vous reformuler votre question ?";
          try { ws.send(JSON.stringify({ type: "text", token: fallback, last: true, interruptible: true })); } catch (_) {}
          await logEvent({
            company_id: session.companyId, call_id: session.callId,
            event_type: "error",
            payload: { empty_llm_response: true, reasoning_chars: result.reasoningChars || 0 },
            ts_ms: Date.now() - session.startedAtMs,
          });
          appendAssistant(session.callSid, fallback);
        } else {
          // Marquer la fin du tour (last=true sans token additionnel)
          try { ws.send(JSON.stringify({ type: "text", token: "", last: true, interruptible: true })); } catch (_) {}
          appendAssistant(session.callSid, result.text);
          await logEvent({
            company_id: session.companyId, call_id: session.callId,
            event_type: "ai_speaking",
            payload: { text: result.text, first_token_ms: result.firstTokenMs, total_ms: result.totalMs, reasoning_chars: result.reasoningChars || 0 },
            ts_ms: Date.now() - session.startedAtMs,
          });
        }
      } catch (err) {
        if (err.name !== "AbortError") {
          console.error("[voice/relay-ws] LLM error:", err.message);
          await logEvent({
            company_id: session.companyId, call_id: session.callId,
            event_type: "error", payload: { llm_error: err.message },
            ts_ms: Date.now() - session.startedAtMs,
          });
          // Fallback message + raccroche
          try {
            ws.send(JSON.stringify({
              type: "text",
              token: "Désolée, problème technique. Je vous transfère à notre équipe. Au revoir.",
              last: true,
            }));
            ws.send(JSON.stringify({ type: "end" }));
          } catch (_) {}
        }
      } finally {
        llmAbort = null;
      }
    }

    async function handleInterrupt(msg) {
      if (!session) return;
      if (llmAbort) { try { llmAbort.abort(); } catch (_) {} }
      await logEvent({
        company_id: session.companyId, call_id: session.callId,
        event_type: "interrupted", payload: msg,
        ts_ms: Date.now() - session.startedAtMs,
      });
    }

    async function handleDtmf(msg) {
      if (!session) return;
      await logEvent({
        company_id: session.companyId, call_id: session.callId,
        event_type: "user_speaking",
        payload: { dtmf: msg.digit },
        ts_ms: Date.now() - session.startedAtMs,
      });
    }
  });
}
