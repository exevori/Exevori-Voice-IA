import * as React from "react";
import { cn } from "../../lib/utils";

const Textarea = React.forwardRef(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "flex min-h-[80px] w-full rounded-lg border border-border bg-bg-primary/60 px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary",
      "outline-none transition-all focus:border-brand-purple/60 focus:bg-bg-primary focus:ring-2 focus:ring-brand-purple/15",
      "disabled:cursor-not-allowed disabled:opacity-50 resize-y",
      className
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export { Textarea };
