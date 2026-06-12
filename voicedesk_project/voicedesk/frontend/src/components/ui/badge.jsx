import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-brand/15 text-brand",
        purple: "border-transparent bg-brand-purple/15 text-brand-purple",
        green: "border-transparent bg-brand-green/15 text-brand-green",
        orange: "border-transparent bg-brand-orange/15 text-brand-orange",
        red: "border-transparent bg-brand-red/15 text-brand-red",
        cyan: "border-transparent bg-brand-cyan/15 text-brand-cyan",
        pink: "border-transparent bg-brand-pink/15 text-brand-pink",
        outline: "border-border text-text-secondary bg-transparent",
        ghost: "border-transparent bg-white/5 text-text-secondary",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

function Badge({ className, variant, ...props }) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
