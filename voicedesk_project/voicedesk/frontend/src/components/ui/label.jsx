import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "../../lib/utils";

const Label = React.forwardRef(({ className, required, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      "text-[11px] font-semibold uppercase tracking-wider text-text-secondary",
      "peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
      className
    )}
    {...props}
  >
    {props.children}
    {required && <span className="ml-1 text-brand-red">*</span>}
  </LabelPrimitive.Root>
));
Label.displayName = "Label";

export { Label };
