// ============================================================
// EXEVORI VOICE IA — FILTER BAR (composant réutilisable)
// Search input + chips de filtres
// ============================================================

import React from "react";
import { Search, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { Input } from "../ui/input";

/**
 * Props:
 *  - searchValue, onSearchChange
 *  - searchPlaceholder
 *  - filters: [{ key, label, options: [{value, label, color?, count?}], current }]
 *  - onFilterChange: (key, value) => void
 *  - rightSlot: ReactNode (boutons "Importer", "+ Nouveau", etc.)
 *  - testId
 */
export default function FilterBar({
  searchValue = "",
  onSearchChange,
  searchPlaceholder = "Rechercher…",
  filters = [],
  onFilterChange,
  rightSlot,
  testId = "filter-bar",
}) {
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between" data-testid={testId}>
      <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center">
        {/* Search */}
        <div className="relative w-full sm:max-w-xs">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input
            value={searchValue}
            onChange={(e) => onSearchChange && onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            data-testid={`${testId}-search`}
            className="pl-9 pr-8"
          />
          {searchValue && (
            <button
              onClick={() => onSearchChange("")}
              data-testid={`${testId}-clear`}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-text-tertiary hover:text-text-primary hover:bg-white/5"
            >
              <X size={12} />
            </button>
          )}
        </div>

        {/* Filter chips */}
        {filters.map((f) => (
          <FilterChipGroup
            key={f.key}
            label={f.label}
            options={f.options}
            current={f.current}
            onChange={(v) => onFilterChange && onFilterChange(f.key, v)}
            testId={`${testId}-${f.key}`}
          />
        ))}
      </div>

      {rightSlot && <div className="flex items-center gap-2">{rightSlot}</div>}
    </div>
  );
}

function FilterChipGroup({ label, options, current, onChange, testId }) {
  return (
    <div className="flex items-center gap-1.5" data-testid={testId}>
      {label && <span className="text-[11px] uppercase tracking-wider text-text-tertiary mr-1">{label}</span>}
      {options.map((opt) => {
        const active = current === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(active ? null : opt.value)}
            data-testid={`${testId}-${opt.value}`}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-all",
              active
                ? "border-brand-purple/40 bg-brand-purple/10 text-brand-purple"
                : "border-border bg-bg-card text-text-secondary hover:text-text-primary hover:border-border-strong"
            )}
          >
            {opt.color && (
              <span className={cn("inline-block h-1.5 w-1.5 rounded-full", opt.color)} />
            )}
            <span>{opt.label}</span>
            {opt.count != null && (
              <span className="text-[10px] tabular-nums text-text-tertiary">{opt.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
