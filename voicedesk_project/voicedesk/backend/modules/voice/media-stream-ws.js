// ============================================================
// EXEVORI VOICE IA — Twilio Media Streams orchestrator (Phase 8D)
//
// Path WS: /api/voice/media-stream
//
// Flux temps réel par appel :
//   Twilio ─audio in μ-law 8k─▶ Deepgram (STT FR-CA streaming)
//   Deepgram ─final transcript─▶ DeepSeek V4 Flash (Fireworks LLM streaming)
//   DeepSeek ─tokens─▶ ElevenLabs Flash v2.5 (TTS WS streaming ulaw_8000)
//   ElevenLabs ─audio μ-law 8k─▶ Twilio (media outbound + clear pour barge-in)
//
// Barge-in : si Deepgram détecte de la voix utilisateur pendant que
// Léa parle → on stoppe le LLM, on close l'ElevenLabs WS, on envoie un
// "clear" à Twilio pour flusher l'audio bufferisé côté Twilio.
// ============================================================

import { consumeWsToken } from "./inbound.js";
import { logEvent, setLiveStatus, endCall } from "./lifecycle.js";
import { streamChat } from "./llm.js";
import { initSession, getSession, appendUser, appendAssistant, endSession } from "./memory.js";
import { DeepgramClient } from "./deepgram-client.js";
import { ElevenLabsTTS } from "./elevenlabs-tts.js";

const GREETING_DEFAULT = "Bonjour, ici Léa d'Exevori. Comment puis-je vous aider ?";

export function attachMediaStreamWS(wss) {
  wss.on("connection", (ws, req) => {
    console.log("[voice/media-stream] connection opened:", req.url);

    /** @type {object|null} */
    let session = null;
    let streamSid = null;
    let callSid = null;
    let outboundSeq = 0;
    let outboundChunk = 0;

    /** @type {DeepgramClient|null} */
    let dg = null;
    /** @type {ElevenLabsTTS|null} */
    let tts = null;
    /** @type {AbortController|null} */
    let llmAbort = null;
    let ttsActive = false;
    let firstTokenLogged = false;

    // Buffer texte LLM → flush à ElevenLabs par groupes courts pour démarrer
    // l'audio le plus tôt possible sans saturer le WS.
    let ttsTextBuffer = "";

    // ───────── Helpers Twilio Media Stream ─────────
    function sendOutboundAudio(ulawBuffer) {
      if (!streamSid || ws.readyState !== ws.OPEN) return;
      outboundSeq += 1;
      outboundChunk += 1;
      const msg = {
        event: "media",
        sequenceNumber: String(outboundSeq),
        streamSid,
        media: {
          track: "outbound",
          chunk: String(outboundChunk),
          timestamp: "0",
          payload: ulawBuffer.toString("base64"),
        },
      };
      try { ws.send(JSON.stringify(msg)); } catch (_) {}
    }

    function sendClear() {
      if (!streamSid || ws.readyState !== ws.OPEN) return;
      outboundSeq += 1;
      try {
        ws.send(JSON.stringify({
          event: "clear",
          sequenceNumber: String(outboundSeq),
          streamSid,
        }));
      } catch (_) {}
    }

    function sendMark(name) {
      if (!streamSid || ws.readyState !== ws.OPEN) return;
      outboundSeq += 1;
      try {
        ws.send(JSON.stringify({
          event: "mark",
          sequenceNumber: String(outboundSeq),
          streamSid,
          mark: { name },
        }));
      } catch (_) {}
    }

    // ───────── Barge-in ─────────
    async function handleBargeIn(reason) {
      if (!ttsActive) return;
      ttsActive = false;
      ttsTextBuffer = "";
      if (llmAbort) { try { llmAbort.abort(); } catch (_) {} llmAbort = null; }
      if (tts) { try { tts.abort(); } catch (_) {} tts = null; }
      sendClear();
      if (session) {
        await logEvent({
          company_id: session.companyId, call_id: session.callId,
          event_type: "interrupted", payload: { reason },
          ts_ms: Date.now() - session.startedAtMs,
        }).catch(() => {});
      }
    }

    // ───────── Lance un cycle LLM + TTS pour une utterance ─────────
    async function runAssistantTurn(userText) {
      if (!session) return;

      // Si une TTS tournait, on coupe (barge-in implicite)
      if (ttsActive) await handleBargeIn("new_user_turn");

      appendUser(session.callSid, userText);
      const conv = getSession(session.callSid);
      if (!conv) return;

      await logEvent({
        company_id: session.companyId, call_id: session.callId,
        event_type: "user_speaking",
        payload: { transcript: userText },
        ts_ms: Date.now() - session.startedAtMs,
      }).catch(() => {});
      await setLiveStatus(session.callId, "user_speaking").catch(() => {});

      // Ouvre une nouvelle session TTS ElevenLabs
      tts = new ElevenLabsTTS({ voiceId: session.voiceId });
      ttsActive = true;
      firstTokenLogged = false;
      ttsTextBuffer = "";

      tts.on("audio", (buf) => sendOutboundAudio(buf));
      tts.on("error", (err) => {
        console.error("[media-stream] ElevenLabs error:", err.message);
      });
      tts.on("done", () => {
        sendMark("tts_done");
      });

      try {
        await tts.connect();
      } catch (err) {
        console.error("[media-stream] ElevenLabs connect failed:", err.message);
        ttsActive = false;
        return;
      }

      await setLiveStatus(session.callId, "ai_speaking").catch(() => {});

      llmAbort = new AbortController();
      let assistantText = "";

      try {
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
              }).catch(() => {});
            }
            // Stratégie : flush au TTS sur ponctuation ou >= 25 chars accumulés
            ttsTextBuffer += delta;
            const shouldFlush =
              ttsTextBuffer.length >= 25 ||
              /[\.\!\?\,\;\:\n]/.test(delta);
            if (shouldFlush && tts && ttsActive) {
              tts.appendText(ttsTextBuffer);
              ttsTextBuffer = "";
            }
          },
          { signal: llmAbort.signal, temperature: 0.6, max_tokens: 1024 }
        );

        // Flush résidu buffer + signal fin
        if (ttsActive && tts) {
          if (ttsTextBuffer) { tts.appendText(ttsTextBuffer); ttsTextBuffer = ""; }
          tts.finish();
        }

        if (result.text) {
          appendAssistant(session.callSid, result.text);
          await logEvent({
            company_id: session.companyId, call_id: session.callId,
            event_type: "ai_speaking",
            payload: {
              text: result.text,
              first_token_ms: result.firstTokenMs,
              total_ms: result.totalMs,
              reasoning_chars: result.reasoningChars || 0,
            },
            ts_ms: Date.now() - session.startedAtMs,
          }).catch(() => {});
        } else {
          // Safety net si LLM vide
          if (tts && ttsActive) {
            tts.appendText("Pardon, je n'ai pas saisi. Pouvez-vous reformuler ?");
            tts.finish();
          }
        }
      } catch (err) {
        if (err.name !== "AbortError") {
          console.error("[media-stream] LLM error:", err.message);
          await logEvent({
            company_id: session.companyId, call_id: session.callId,
            event_type: "error", payload: { llm_error: err.message },
            ts_ms: Date.now() - session.startedAtMs,
          }).catch(() => {});
          if (tts && ttsActive) {
            tts.appendText("Désolée, problème technique. Veuillez rappeler.");
            tts.finish();
          }
        }
      } finally {
        llmAbort = null;
      }
    }

    // ───────── Greeting initial via ElevenLabs ─────────
    async function playGreeting(greetingText) {
      tts = new ElevenLabsTTS({ voiceId: session.voiceId });
      ttsActive = true;
      tts.on("audio", (buf) => sendOutboundAudio(buf));
      tts.on("error", (err) => console.error("[media-stream] greeting TTS error:", err.message));
      tts.on("done", () => {
        sendMark("greeting_done");
      });
      try {
        await tts.connect();
        tts.appendText(greetingText);
        tts.finish();
      } catch (err) {
        console.error("[media-stream] greeting failed:", err.message);
        ttsActive = false;
      }
    }

    // ───────── Handler messages Twilio ─────────
    ws.on("message", async (raw) => {
      let evt;
      try { evt = JSON.parse(raw.toString()); } catch (_) { return; }

      const type = evt.event;

      if (type === "start") {
        streamSid = evt.start?.streamSid;
        callSid = evt.start?.callSid;

        // Récupère les customParameters (wsAuthToken + greeting + voiceId)
        const params = evt.start?.customParameters || {};
        const tokenFromTwilio = params.wsAuthToken;
        const entry = tokenFromTwilio ? consumeWsToken(tokenFromTwilio) : null;

        if (!entry || entry.callSid !== callSid) {
          console.warn("[media-stream] auth failed", { callSid, hasToken: !!tokenFromTwilio });
          try { ws.close(); } catch (_) {}
          return;
        }

        session = {
          callSid,
          callId: entry.callId,
          companyId: entry.companyId,
          accountSid: entry.accountSid,
          startedAtMs: Date.now(),
          systemPrompt: entry.systemPrompt || "",
          assistantName: entry.assistantName || "Léa",
          voiceId: entry.voiceId || params.voiceId || process.env.ELEVENLABS_VOICE_ID,
          greeting: entry.greeting || params.greeting || GREETING_DEFAULT,
        };
        initSession(session.callSid, session.systemPrompt);

        await logEvent({
          company_id: session.companyId, call_id: session.callId,
          event_type: "connecting",
          payload: { transport: "media_streams", streamSid },
          ts_ms: 0,
        }).catch(() => {});
        await setLiveStatus(session.callId, "ai_speaking").catch(() => {});

        // Init Deepgram
        dg = new DeepgramClient();
        dg.on("open", () => console.log("[media-stream] Deepgram opened"));
        dg.on("error", (err) => console.error("[media-stream] Deepgram error:", err.message));
        dg.on("interim", (text) => {
          // Barge-in : si l'utilisateur parle pendant que Léa parle
          if (ttsActive && text.length >= 2) {
            handleBargeIn("interim_detected").catch(() => {});
          }
        });
        dg.on("final", (text) => {
          // Déclenche un tour assistant (LLM + TTS)
          runAssistantTurn(text).catch((e) =>
            console.error("[media-stream] runAssistantTurn:", e.message)
          );
        });
        dg.connect();

        // Joue le greeting initial
        playGreeting(session.greeting).catch(() => {});
      }

      else if (type === "media") {
        // Twilio envoie l'audio caller en μ-law base64 → forward à Deepgram
        if (evt.media?.track !== "inbound") return;
        const payload = evt.media?.payload;
        if (!payload || !dg) return;
        const audio = Buffer.from(payload, "base64");
        dg.send(audio);
      }

      else if (type === "stop") {
        console.log("[media-stream] Twilio stop event", { streamSid });
        try { ws.close(); } catch (_) {}
      }

      else if (type === "mark") {
        // Acknowledgement Twilio que notre mark a été joué — utile pour timing
      }

      else if (type === "connected") {
        // protocol handshake
      }
    });

    ws.on("close", async () => {
      console.log("[media-stream] connection closed", { callSid });
      if (llmAbort) { try { llmAbort.abort(); } catch (_) {} }
      if (tts) { try { tts.abort(); } catch (_) {} }
      if (dg) { try { dg.finish(); } catch (_) {} }
      if (session) {
        await logEvent({
          company_id: session.companyId, call_id: session.callId,
          event_type: "ended",
          payload: { reason: "media_stream_closed" },
          ts_ms: Date.now() - session.startedAtMs,
        }).catch(() => {});
        await endCall(session.callId).catch(() => {});
        endSession(session.callSid);
      }
    });

    ws.on("error", (e) => console.error("[media-stream] socket error:", e.message));
  });
}
