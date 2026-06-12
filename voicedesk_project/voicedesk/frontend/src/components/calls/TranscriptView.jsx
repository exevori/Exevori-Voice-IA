// ============================================================
// EXEVORI VOICE IA — TRANSCRIPT VIEW
// Affichage chat-style des transcripts d'appels (assistant / caller / transfer)
// Réutilisable Phase 8 (outbound calls)
// ============================================================

import React from "react";
import { Bot, User, ArrowRightLeft } from "lucide-react";
import { cn } from "../../lib/utils.js";

/**
 * @param {Object} props
 * @param {Array<{role: string, text: string, ts?: number}> | string | null} props.transcript
 * @param {string} props.assistantName — nom de l'assistante (depuis assistant_configs.name)
 * @param {string} props.callerName — nom de l'appelant (depuis call.caller_name ou contact.full_name)
 */
export default function TranscriptView({ transcript, assistantName = "Assistante", callerName = "Appelant" }) {
  const turns = normalize(transcript);

  if (turns.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-white/3 p-6 text-center text-xs text-text-tertiary" data-testid="transcript-empty">
        Aucun transcript disponible pour cet appel.
      </div>
    );
  }

  return (
    <ul className="space-y-2.5" data-testid="transcript-list">
      {turns.map((turn, i) => (
        <TranscriptTurn
          key={i}
          turn={turn}
          assistantName={assistantName}
          callerName={callerName}
        />
      ))}
    </ul>
  );
}

function TranscriptTurn({ turn, assistantName, callerName }) {
  const role = (turn.role || "").toLowerCase();
  const isAssistant = role === "assistant" || role === "bot" || role === "ai";
  const isTransfer  = role === "transfer" || role === "system";

  if (isTransfer) {
    return (
      <li className="flex items-center gap-2 my-3" data-testid="turn-transfer">
        <div className="flex-1 h-px bg-border" />
        <span className="flex items-center gap-1.5 rounded-full border border-brand-orange/30 bg-brand-orange/10 px-3 py-1 text-[10px] uppercase tracking-wider text-amber-200">
          <ArrowRightLeft size={10} />
          {turn.text || "Transfert"}
        </span>
        <div className="flex-1 h-px bg-border" />
      </li>
    );
  }

  return (
    <li
      data-testid={isAssistant ? "turn-assistant" : "turn-caller"}
      className={cn("flex items-start gap-2.5", isAssistant ? "justify-start" : "justify-end flex-row-reverse")}
    >
      <div
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-full shrink-0",
          isAssistant
            ? "bg-brand-purple/15 text-brand-purple"
            : "bg-brand/15 text-brand"
        )}
      >
        {isAssistant ? <Bot size={13} /> : <User size={13} />}
      </div>
      <div className={cn("max-w-[78%]", isAssistant ? "items-start" : "items-end")}>
        <div className={cn(
          "flex items-baseline gap-2 mb-1",
          isAssistant ? "justify-start" : "justify-end"
        )}>
          <span className="text-[10px] uppercase tracking-wider text-text-tertiary">
            {isAssistant ? assistantName : callerName}
          </span>
          {turn.ts != null && (
            <span className="font-mono text-[9px] text-text-tertiary tabular-nums">
              {formatTs(turn.ts)}
            </span>
          )}
        </div>
        <div
          className={cn(
            "rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap",
            isAssistant
              ? "rounded-tl-sm border border-brand-purple/20 bg-brand-purple/8 text-text-primary"
              : "rounded-tr-sm border border-brand/20 bg-brand/8 text-text-primary"
          )}
        >
          {turn.text || "—"}
        </div>
      </div>
    </li>
  );
}

// Accepte: array, string-JSON, string-brut, null → toujours retourner un array
function normalize(transcript) {
  if (!transcript) return [];
  if (Array.isArray(transcript)) return transcript;
  if (typeof transcript === "object") return [transcript];
  if (typeof transcript === "string") {
    const trimmed = transcript.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch { /* fallthrough */ }
    }
    // Texte brut : un seul "bloc transcript"
    return [{ role: "transcript", text: trimmed }];
  }
  return [];
}

function formatTs(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}
