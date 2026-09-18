import React from "react";
import { cn } from "../../lib/utils.js";

export default function SkeletonLoader({ className, lines = 3, label = "Chargement des données", ...props }) {
  return <div role="status" aria-label={label} className={cn("space-y-4", className)} {...props}>
    <span className="sr-only">{label}</span>
    {Array.from({ length: lines }, (_, i) => <div key={i} aria-hidden="true" className={cn("h-4 rounded-md bg-bg-elevated motion-safe:animate-pulse", i === lines - 1 && "w-2/3")} />)}
  </div>;
}

export function KpiSkeletons({ count = 4 }) {
  return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" role="status" aria-label="Chargement des indicateurs">
    {Array.from({ length: count }, (_, i) => <div key={i} className="rounded-xl border border-border bg-bg-card p-5"><SkeletonLoader lines={3} className="min-h-24" /></div>)}
  </div>;
}
