import React from "react";
import { cn } from "../../lib/utils.js";

export default function StatusDot({ status = "unknown", label, pulse = false }) {
  const color = { healthy: "bg-brand-green", success: "bg-brand-green", active: "bg-brand-green", error: "bg-brand-red", degraded: "bg-brand-orange", unknown: "bg-text-tertiary" }[status] || "bg-text-tertiary";
  return <span className="inline-flex items-center gap-2 text-xs text-text-secondary"><span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full", color, pulse && "motion-safe:animate-pulse")} />{label || <span className="sr-only">{status}</span>}</span>;
}
