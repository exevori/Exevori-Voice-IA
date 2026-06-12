// ============================================================
// EXEVORI VOICE IA — UTILS
// cn() : helper shadcn pour combiner classes Tailwind
// ============================================================

import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
