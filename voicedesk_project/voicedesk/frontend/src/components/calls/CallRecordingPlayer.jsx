// ============================================================
// EXEVORI VOICE IA — Composant lecteur audio enregistrements
// Fichier : frontend/src/components/calls/CallRecordingPlayer.jsx
//
// Usage dans CallDetailSheet (Calls.jsx) :
//   import CallRecordingPlayer from "../components/calls/CallRecordingPlayer.jsx";
//   // Ajouter dans le sheet après la section "Résumé IA" :
//   <CallRecordingPlayer callId={c.id} token={token} hasExternalId={!!c.external_id} />
// ============================================================

import React, { useState, useRef, useEffect } from "react";
import { Play, Pause, Volume2, Loader2, MicOff } from "lucide-react";

const API = import.meta.env.VITE_API_URL || "";

export default function CallRecordingPlayer({ callId, token, hasExternalId }) {
  const [state, setState] = useState("idle"); // idle | loading | ready | playing | paused | error | unavailable
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const audioRef = useRef(null);

  // Si pas de conversation_id ElevenLabs — inutile d'essayer
  useEffect(() => {
    if (!hasExternalId) setState("unavailable");
  }, [hasExternalId]);

  const loadAndPlay = () => {
    if (state === "unavailable") return;

    // Si l'audio est déjà chargé — play/pause toggle
    if (audioRef.current && (state === "ready" || state === "paused")) {
      audioRef.current.play();
      setState("playing");
      return;
    }
    if (state === "playing") {
      audioRef.current?.pause();
      setState("paused");
      return;
    }

    // Premier chargement
    setState("loading");
    const audio = new Audio();
    audioRef.current = audio;

    audio.src = `${API}/api/v1/calls/${callId}/recording`;
    // Le header Authorization doit être envoyé — on utilise un Blob pour contourner
    // la limitation des balises <audio> qui ne supportent pas les headers custom.
    fetch(`${API}/api/v1/calls/${callId}/recording`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (!res.ok) {
          if (res.status === 404) { setState("unavailable"); return; }
          throw new Error(`HTTP ${res.status}`);
        }
        return res.blob();
      })
      .then((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        audio.src = url;
        audio.onloadedmetadata = () => {
          setDuration(audio.duration);
          setState("ready");
          audio.play();
          setState("playing");
        };
        audio.ontimeupdate = () => {
          setCurrentTime(audio.currentTime);
          setProgress(audio.duration ? (audio.currentTime / audio.duration) * 100 : 0);
        };
        audio.onended = () => {
          setState("ready");
          setProgress(0);
          setCurrentTime(0);
        };
        audio.onerror = () => setState("error");
      })
      .catch(() => setState("error"));
  };

  const seek = (e) => {
    if (!audioRef.current || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    audioRef.current.currentTime = ratio * duration;
    setProgress(ratio * 100);
  };

  const fmt = (s) => {
    if (!s || isNaN(s)) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  };

  // ─── Unavailable state ───────────────────────────────────
  if (state === "unavailable") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-white/3 px-3 py-2.5 text-xs text-text-tertiary">
        <MicOff size={13} />
        <span>Aucun enregistrement disponible pour cet appel.</span>
      </div>
    );
  }

  const isPlaying = state === "playing";
  const isLoading = state === "loading";

  return (
    <div
      className="rounded-lg border border-border bg-white/3 p-3 space-y-2"
      data-testid="call-recording-player"
    >
      {/* Header */}
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
        <Volume2 size={11} />
        Enregistrement de l'appel
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3">
        {/* Play/Pause button */}
        <button
          onClick={loadAndPlay}
          disabled={isLoading || state === "error"}
          className={[
            "flex h-8 w-8 items-center justify-center rounded-full transition-colors shrink-0",
            isLoading || state === "error"
              ? "bg-white/5 text-text-tertiary cursor-not-allowed"
              : "bg-brand text-white hover:bg-brand/80 active:scale-95",
          ].join(" ")}
          aria-label={isPlaying ? "Mettre en pause" : "Écouter l'enregistrement"}
          data-testid="recording-play-btn"
        >
          {isLoading
            ? <Loader2 size={14} className="animate-spin" />
            : isPlaying
              ? <Pause size={14} />
              : <Play size={14} className="ml-0.5" />
          }
        </button>

        {/* Progress bar */}
        <div className="flex-1 space-y-1">
          <div
            className="relative h-1.5 w-full cursor-pointer rounded-full bg-white/10"
            onClick={seek}
            role="slider"
            aria-label="Position dans l'enregistrement"
            aria-valuenow={Math.round(progress)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-brand transition-all"
              style={{ width: `${progress}%` }}
            />
            {/* Thumb */}
            {(isPlaying || state === "paused") && (
              <div
                className="absolute top-1/2 -translate-y-1/2 h-3 w-3 rounded-full bg-brand border-2 border-white shadow"
                style={{ left: `calc(${progress}% - 6px)` }}
              />
            )}
          </div>

          {/* Time */}
          <div className="flex justify-between text-[10px] text-text-tertiary tabular-nums">
            <span>{fmt(currentTime)}</span>
            <span>{fmt(duration)}</span>
          </div>
        </div>
      </div>

      {/* Error state */}
      {state === "error" && (
        <p className="text-[11px] text-brand-red">
          Impossible de charger l'enregistrement. Réessayez plus tard.
        </p>
      )}

      {/* Loading hint */}
      {state === "idle" && (
        <p className="text-[10px] text-text-tertiary">
          Cliquez sur lecture pour écouter l'appel.
        </p>
      )}
    </div>
  );
}
