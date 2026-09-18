import React, { useEffect } from "react";
import { CheckCircle2, AlertCircle, X } from "lucide-react";
import { cn } from "../../lib/utils.js";

export default function Toast({ message, type = "success", onClose, duration = 5000 }) {
  useEffect(() => { if (!message || !onClose) return; const id = setTimeout(onClose, duration); return () => clearTimeout(id); }, [message, onClose, duration]);
  if (!message) return null;
  const error = type === "error";
  const Icon = error ? AlertCircle : CheckCircle2;
  return <div data-testid="toast" role={error ? "alert" : "status"} className={cn("fixed bottom-6 right-6 z-[100] flex max-w-[calc(100vw-3rem)] items-start gap-3 rounded-xl border bg-bg-elevated p-5 shadow-xl motion-safe:animate-fade-in", error ? "border-brand-red/30" : "border-brand-green/30")}>
    <Icon size={20} className={cn("shrink-0", error ? "text-brand-red" : "text-brand-green")} />
    <p className="text-sm text-text-primary">{message}</p><button type="button" onClick={onClose} aria-label="Fermer la notification" className="text-text-secondary hover:text-text-primary"><X size={16} /></button>
  </div>;
}
