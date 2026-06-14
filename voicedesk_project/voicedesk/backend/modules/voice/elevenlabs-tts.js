// ============================================================
// EXEVORI VOICE IA — ElevenLabs streaming TTS client (Phase 8D)
//
// WebSocket: /v1/text-to-speech/{voice_id}/stream-input
//   query: model_id=eleven_flash_v2_5 & output_format=ulaw_8000
//
// On envoie du texte token-par-token, ElevenLabs renvoie de l'audio
// μ-law 8kHz base64 prêt à forwarder vers Twilio Media Streams.
//
// Events émis :
//   "open"             → connexion établie
//   "audio"  (Buffer)  → frame μ-law décodée (à envoyer à Twilio)
//   "done"             → flag isFinal reçu (TTS terminé)
//   "error"  (err)
//   "close"
// ============================================================

import WebSocket from "ws";
import { EventEmitter } from "node:events";

export class ElevenLabsTTS extends EventEmitter {
  constructor({ voiceId, stability = 0.5, similarity = 0.75 } = {}) {
    super();
    this.voiceId = voiceId || process.env.ELEVENLABS_VOICE_ID || "WW0JfNPk5DgcQdM0d6X6";
    this.stability = stability;
    this.similarity = similarity;
    this.ws = null;
    this.closed = false;
    this.openPromise = null;
  }

  connect() {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey || apiKey.startsWith("placeholder")) {
      this.emit("error", new Error("ELEVENLABS_API_KEY missing"));
      return Promise.reject(new Error("ELEVENLABS_API_KEY missing"));
    }

    const url =
      `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voiceId)}/stream-input` +
      `?model_id=eleven_flash_v2_5&output_format=ulaw_8000&auto_mode=true`;

    this.ws = new WebSocket(url, {
      headers: { "xi-api-key": apiKey },
    });

    this.openPromise = new Promise((resolve, reject) => {
      this.ws.once("open", () => {
        // BOS — config initiale (voice_settings + generation_config)
        const bos = {
          text: " ", // ElevenLabs exige un text non-vide au BOS (sinon erreur)
          voice_settings: {
            stability: this.stability,
            similarity_boost: this.similarity,
            use_speaker_boost: true,
          },
          generation_config: {
            chunk_length_schedule: [80, 160, 250],
          },
          xi_api_key: process.env.ELEVENLABS_API_KEY,
        };
        try { this.ws.send(JSON.stringify(bos)); } catch (_) {}
        this.emit("open");
        resolve();
      });
      this.ws.once("error", (err) => {
        this.emit("error", err);
        reject(err);
      });
    });

    this.ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch (_) { return; }

      if (msg.audio) {
        // audio base64 (μ-law 8kHz raw bytes)
        const buf = Buffer.from(msg.audio, "base64");
        this.emit("audio", buf);
      }
      if (msg.isFinal) {
        this.emit("done");
      }
      if (msg.error) {
        this.emit("error", new Error(msg.error?.message || JSON.stringify(msg.error)));
      }
    });

    this.ws.on("close", (code, reason) => {
      this.closed = true;
      this.emit("close", code, reason?.toString?.());
    });

    return this.openPromise;
  }

  /** Push un fragment de texte. ElevenLabs commence l'audio dès qu'il y a assez. */
  appendText(text) {
    if (this.closed || !text) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const payload = { text, try_trigger_generation: true };
      try { this.ws.send(JSON.stringify(payload)); } catch (_) {}
    }
  }

  /** Signal fin de texte → ElevenLabs flush et émet done. */
  finish() {
    if (this.closed) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ text: "" })); } catch (_) {}
    }
  }

  /** Hard close (barge-in). */
  abort() {
    if (this.closed) return;
    this.closed = true;
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
    }
  }
}
