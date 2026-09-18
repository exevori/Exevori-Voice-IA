import React from "react";
import { Inbox } from "lucide-react";
import { cn } from "../../lib/utils.js";

export default function EmptyState({ icon: Icon = Inbox, title = "Aucun résultat", description, action, className }) {
  return <div className={cn("flex flex-col items-center justify-center gap-3 px-5 py-12 text-center", className)}>
    <Icon size={48} strokeWidth={1.25} className="mb-1 text-text-tertiary" aria-hidden="true" />
    <p className="font-medium text-text-secondary">{title}</p>
    {description && <p className="max-w-md text-sm leading-relaxed text-text-tertiary">{description}</p>}
    {action && <div className="mt-2">{action}</div>}
  </div>;
}
