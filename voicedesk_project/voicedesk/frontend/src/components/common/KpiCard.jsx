import React from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { Card, CardContent } from "../ui/card.jsx";
import { cn } from "../../lib/utils.js";

const tones = { blue: "bg-brand/10 text-brand", purple: "bg-brand-purple/10 text-brand-purple", green: "bg-brand-green/10 text-brand-green", orange: "bg-brand-orange/10 text-brand-orange", cyan: "bg-brand-cyan/10 text-brand-cyan", pink: "bg-brand-pink/10 text-brand-pink" };
export default function KpiCard({ label, value, detail, icon: Icon, tone = "blue", trend, trendLabel, className, testId }) {
  // Trends must come from actual data; never infer a comparison from one period.
  const hasTrend = typeof trend === "number" && Number.isFinite(trend);
  const Arrow = trend < 0 ? ArrowDownRight : ArrowUpRight;
  return <Card className={cn("premium-surface h-full", className)} data-testid={testId}>
    <CardContent className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><p className="text-sm text-text-tertiary">{label}</p><p className="mt-2 text-3xl font-bold tracking-tight text-text-primary tabular-nums">{value ?? "—"}</p></div>
        {Icon && <div className={cn("flex h-12 w-12 shrink-0 items-center justify-center rounded-xl", tones[tone] || tones.blue)}><Icon size={22} aria-hidden="true" /></div>}
      </div>
      {detail && <p className="mt-3 text-xs leading-5 text-text-secondary">{detail}</p>}
      {hasTrend && <p className={cn("mt-3 flex items-center gap-1 text-xs", trend < 0 ? "text-brand-red" : "text-brand-green")}><Arrow size={14} />{trend > 0 ? "+" : ""}{trend}% <span className="text-text-tertiary">{trendLabel}</span></p>}
    </CardContent>
  </Card>;
}
