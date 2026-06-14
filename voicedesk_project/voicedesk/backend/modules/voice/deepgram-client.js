// ============================================================
// EXEVORI VOICE IA — Deepgram streaming STT client (Phase 8D)
//
// Reçoit du μ-law 8kHz brut (forwardé depuis Twilio Media Streams)
// → renvoie des transcripts FR-CA en streaming.
//
// Events émis :
//   "open"             → connexion établie
//   "interim"  (text)  → résultat intermédiaire (utilisé pour barge-in)
//   "final"    (text)  → utterance finale (déclenche le LLM)
//   "utteranceEnd"     → silence détecté par endpointing
//   "error"    (err)
//   "close"    (code, reason)
// ============================================================

import WebSocket from "ws";
import { EventEmitter } from "node:events";

const DG_URL = (
  "wss://api.deepgram.com/v1/listen" +
  "?model=nova-3" +
  "&language=fr-CA" +
  "&encoding=mulaw" +
  "&sample_rate=8000" +
  "&channels=1" +
  "&punctuate=true" +
  "&smart_format=true" +
  "&interim_results=true" +
  "&endpointing=300" +
  "&utterance_end_ms=1000" +
  "&vad_events=true"
);

export class DeepgramClient extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.closed = false;
    this.lastInterim = "";
  }

  connect() {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey || apiKey.startsWith("placeholder")) {
      this.emit("error", new Error("DEEPGRAM_API_KEY missing"));
      return;
    }

    this.ws = new WebSocket(DG_URL, {
      headers: { Authorization: `Token ${apiKey}` },
    });

    this.ws.on("open", () => this.emit("open"));

    this.ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch (_) { return; }

      const type = msg.type;
      if (type === "Results") {
        const transcript = msg.channel?.alternatives?.[0]?.transcript || "";
        if (!transcript.trim()) return;
        if (msg.is_final) {
          this.lastInterim = "";
          this.emit("final", transcript.trim(), msg);
        } else {
          this.lastInterim = transcript;
          this.emit("interim", transcript.trim(), msg);
        }
      } else if (type === "UtteranceEnd") {
        this.emit("utteranceEnd", msg);
      } else if (type === "SpeechStarted") {
        this.emit("speechStarted", msg);
      } else if (type === "Metadata") {
        // ignore
      }
    });

    this.ws.on("error", (err) => this.emit("error", err));
    this.ws.on("close", (code, reason) => {
      this.closed = true;
      this.emit("close", code, reason?.toString?.());
    });
  }

  /** Forwarde du μ-law brut (Buffer) vers Deepgram. */
  send(audioBuffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(audioBuffer); } catch (_) {}
    }
  }

  /** Termine proprement (CloseStream JSON puis ws.close). */
  finish() {
    if (this.closed) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: "CloseStream" })); } catch (_) {}
      try { this.ws.close(); } catch (_) {}
    }
  }
}
