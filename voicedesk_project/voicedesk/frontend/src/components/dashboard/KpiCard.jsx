// ============================================================
// EXEVORI VOICE IA — KPI CARD avec sparkline
// Tailwind + recharts
// ============================================================

import React from "react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { cn } from "../../lib/utils";

const COLOR_MAP = {
  blue:   { stroke: "#3B82F6", fill: "rgba(59,130,246,0.2)",  glow: "shadow-[0_0_24px_-8px_rgba(59,130,246,0.45)]", icon: "bg-brand/15 text-brand" },
  cyan:   { stroke: "#06B6D4", fill: "rgba(6,182,212,0.2)",   glow: "shadow-[0_0_24px_-8px_rgba(6,182,212,0.45)]",  icon: "bg-brand-cyan/15 text-brand-cyan" },
  purple: { stroke: "#8B5CF6", fill: "rgba(139,92,246,0.2)",  glow: "shadow-[0_0_24px_-8px_rgba(139,92,246,0.45)]", icon: "bg-brand-purple/15 text-brand-purple" },
  green:  { stroke: "#10B981", fill: "rgba(16,185,129,0.2)",  glow: "shadow-[0_0_24px_-8px_rgba(16,185,129,0.45)]", icon: "bg-brand-green/15 text-brand-green" },
  orange: { stroke: "#F59E0B", fill: "rgba(245,158,11,0.2)",  glow: "shadow-[0_0_24px_-8px_rgba(245,158,11,0.45)]", icon: "bg-brand-orange/15 text-brand-orange" },
  pink:   { stroke: "#EC4899", fill: "rgba(236,72,153,0.2)",  glow: "shadow-[0_0_24px_-8px_rgba(236,72,153,0.45)]", icon: "bg-brand-pink/15 text-brand-pink" },
  red:    { stroke: "#EF4444", fill: "rgba(239,68,68,0.2)",   glow: "shadow-[0_0_24px_-8px_rgba(239,68,68,0.45)]",  icon: "bg-brand-red/15 text-brand-red" },
};

// Génère une courbe synthétique stable basée sur un seed (Phase 2A — Phase 2B = vraies data)
function syntheticSeries(seed = 1, value = 50, points = 12) {
  const arr = [];
  let prev = value * 0.6;
  for (let i = 0; i < points; i++) {
    const noise = ((Math.sin(seed * i * 1.7) + Math.cos(seed * 0.31 + i)) * 0.5 + Math.random() * 0.3) * value * 0.18;
    prev = Math.max(0, prev + noise + (value - prev) * 0.12);
    arr.push({ idx: i, v: Math.round(prev) });
  }
  // Force last point ≈ value
  arr[arr.length - 1] = { idx: points - 1, v: value };
  return arr;
}

export default function KpiCard({
  testId,
  icon: Icon,
  label,
  value,
  delta,        // ex : "+18%" or "-4%"
  deltaTrend,   // "up" | "down" | "flat"
  color = "blue",
  seed,
  data,         // optionnel — sinon synthetic
  unit,         // ex : "min"
}) {
  const c = COLOR_MAP[color] || COLOR_MAP.blue;
  const series = data && data.length > 1 ? data : syntheticSeries(seed || 1, Number(value) || 50);

  const TrendIcon = deltaTrend === "up" ? TrendingUp : deltaTrend === "down" ? TrendingDown : Minus;
  const trendCls =
    deltaTrend === "up"   ? "text-brand-green"
  : deltaTrend === "down" ? "text-brand-red"
  : "text-text-tertiary";

  return (
    <div
      data-testid={testId}
      className={cn(
        "group relative overflow-hidden rounded-xl border border-border bg-bg-card p-5 transition-all duration-300",
        "hover:border-border-strong hover:-translate-y-0.5",
        c.glow
      )}
    >
      {/* Top row: icon + label */}
      <div className="flex items-start justify-between">
        <div className={cn("flex h-9 w-9 items-center justify-center rounded-lg", c.icon)}>
          {Icon && <Icon size={16} />}
        </div>
        {delta != null && (
          <div className={cn("flex items-center gap-1 text-[11px] font-medium", trendCls)}>
            <TrendIcon size={12} />
            <span>{delta}</span>
          </div>
        )}
      </div>

      {/* Value */}
      <div className="mt-3 flex items-baseline gap-1">
        <span className="text-3xl font-bold text-text-primary tracking-tight tabular-nums">
          {value ?? "—"}
        </span>
        {unit && <span className="text-xs text-text-tertiary font-medium">{unit}</span>}
      </div>

      {/* Label */}
      <div className="mt-0.5 text-[12px] text-text-secondary">{label}</div>

      {/* Sparkline */}
      <div className="mt-4 -mx-2 h-12">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={`gradient-${color}-${seed || 0}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={c.stroke} stopOpacity={0.45} />
                <stop offset="95%" stopColor={c.stroke} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area
              type="monotone"
              dataKey="v"
              stroke={c.stroke}
              strokeWidth={1.75}
              fill={`url(#gradient-${color}-${seed || 0})`}
              dot={false}
              isAnimationActive
              animationDuration={900}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
