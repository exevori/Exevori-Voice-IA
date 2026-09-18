import React from "react";
import { cn } from "../../lib/utils.js";

const colors = ["bg-brand/15 text-brand", "bg-brand-purple/15 text-brand-purple", "bg-brand-cyan/15 text-brand-cyan", "bg-brand-green/15 text-brand-green", "bg-brand-pink/15 text-brand-pink"];
export default function InitialAvatar({ name = "", className }) {
  const text = String(name || "?").trim();
  const initials = text.split(/\s+/).slice(0, 2).map(word => word[0]).join("").toUpperCase();
  return <span aria-hidden="true" className={cn("inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xs font-semibold ring-1 ring-inset ring-white/5", colors[text.toUpperCase().codePointAt(0) % colors.length], className)}>{initials}</span>;
}
