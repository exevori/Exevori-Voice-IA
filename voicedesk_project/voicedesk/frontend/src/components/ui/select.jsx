import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

/**
 * Select natif léger — pour usages simples (form contact: status, source, urgency).
 * Pour des selects riches avec search, on utilisera Radix Select plus tard.
 *
 * Props: value, onValueChange, options: [{value,label}], placeholder, disabled, testId
 */
const Select = React.forwardRef(({ value, onValueChange, options = [], placeholder = "—", disabled, className, testId, ...props }, ref) => (
  <div className="relative">
    <select
      ref={ref}
      value={value || ""}
      onChange={(e) => onValueChange && onValueChange(e.target.value)}
      disabled={disabled}
      data-testid={testId}
      className={cn(
        "h-9 w-full appearance-none rounded-lg border border-border bg-bg-primary/60 px-3 pr-8 text-sm text-text-primary outline-none transition-all",
        "focus:border-brand-purple/60 focus:bg-bg-primary focus:ring-2 focus:ring-brand-purple/15",
        "disabled:cursor-not-allowed disabled:opacity-50",
        !value && "text-text-tertiary",
        className
      )}
      {...props}
    >
      {placeholder && <option value="" disabled>{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-bg-primary text-text-primary">
          {o.label}
        </option>
      ))}
    </select>
    <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
  </div>
));
Select.displayName = "Select";

export { Select };
