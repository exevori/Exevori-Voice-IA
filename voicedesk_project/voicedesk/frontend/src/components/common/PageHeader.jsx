import React from "react";

export default function PageHeader({ title, description, eyebrow, icon: Icon, actions, testId }) {
  return <header className="flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-end sm:justify-between">
    <div>{eyebrow && <p className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">{Icon && <Icon size={13} aria-hidden="true" />}{eyebrow}</p>}
      <h1 className="text-xl font-semibold tracking-tight text-text-primary" data-testid={testId}>{title}</h1>
      {description && <p className="mt-2 max-w-3xl text-sm leading-relaxed text-text-tertiary">{description}</p>}
    </div>{actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
  </header>;
}
