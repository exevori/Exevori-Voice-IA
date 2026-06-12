// ============================================================
// EXEVORI VOICE IA — IMPERSONATION SWITCHER
// Permet au super_admin de "View as PME" pour les démos
// ============================================================

import React, { useEffect, useState } from "react";
import { Building2, Eye, X, ChevronDown } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext.jsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu.jsx";

export default function ImpersonationSwitcher() {
  const { token, impersonatedCompany, impersonateCompany } = useAuth();
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    fetch("/api/v1/admin/companies", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((d) => setCompanies(d.companies || []))
      .catch(() => setCompanies([]))
      .finally(() => setLoading(false));
  }, [token]);

  const handleSelect = (c) => {
    impersonateCompany(c);
    // soft reload pour rafraîchir les data du dashboard
    window.location.href = "/dashboard";
  };

  const handleExit = () => {
    impersonateCompany(null);
    window.location.href = "/admin";
  };

  if (impersonatedCompany) {
    return (
      <div
        className="flex items-center gap-2 rounded-lg border border-brand-purple/30 bg-brand-purple/10 px-3 py-1.5 text-xs"
        data-testid="impersonation-active"
      >
        <Eye size={14} className="text-brand-purple" />
        <span className="text-text-secondary">Vue PME :</span>
        <span className="font-medium text-text-primary">{impersonatedCompany.name}</span>
        <button
          onClick={handleExit}
          className="ml-1 rounded p-0.5 text-text-tertiary hover:text-text-primary hover:bg-white/5 transition-colors"
          title="Quitter le mode démo"
          data-testid="impersonation-exit"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          data-testid="impersonation-trigger"
          className="flex items-center gap-2 rounded-lg border border-border bg-white/3 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary hover:border-border-strong transition-all"
        >
          <Building2 size={14} />
          <span>Voir comme PME</span>
          <ChevronDown size={12} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>PMEs démo</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {loading && (
          <div className="px-3 py-2 text-xs text-text-tertiary">Chargement…</div>
        )}
        {!loading && companies.length === 0 && (
          <div className="px-3 py-2 text-xs text-text-tertiary">Aucune PME enregistrée</div>
        )}
        {!loading &&
          companies.map((c) => (
            <DropdownMenuItem
              key={c.id}
              onSelect={() => handleSelect(c)}
              data-testid={`impersonation-option-${c.id}`}
              className="cursor-pointer"
            >
              <Building2 size={14} className="text-brand-purple" />
              <div className="flex-1">
                <div className="font-medium text-text-primary">{c.name}</div>
                <div className="text-[10px] text-text-tertiary">
                  {[c.city, c.country].filter(Boolean).join(", ")} • {c.plan || "—"}
                </div>
              </div>
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
