// ============================================================
// EXEVORI VOICE IA — PAGE ADMIN (super_admin uniquement)
// Liste des tenants (PMEs) + impersonation + stats rapides
// ============================================================

import React, { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Building2, Users, Phone, BookOpen, Brain,
  LogIn, RefreshCw, AlertCircle, CheckCircle2, Loader2,
  BarChart3, Mail, Zap,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { Button } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { cn } from "../lib/utils.js";

const API = import.meta.env.VITE_API_URL || "";

export default function Admin() {
  const { t } = useTranslation();
  const { token, profile, impersonateCompany, impersonatedCompany } = useAuth();
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const isSuperAdmin = profile?.role === "super_admin";

  const loadCompanies = useCallback(async () => {
    if (!token || !isSuperAdmin) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${API}/api/v1/admin/companies`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setCompanies(d.companies || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token, isSuperAdmin]);

  useEffect(() => { loadCompanies(); }, [loadCompanies]);

  if (!isSuperAdmin) {
    return (
      <div className="flex items-center justify-center h-64 text-text-tertiary">
        <AlertCircle size={20} className="mr-2" />
        Accès réservé aux super_admins.
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in" data-testid="admin-page">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-tertiary mb-1">
          <Brain size={11} /> Administration
        </div>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">
              Tableau de bord Admin
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Gérez les tenants et impersonnifiez une PME pour accéder à ses données.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={loadCompanies}
            disabled={loading}
            data-testid="refresh-companies-btn"
          >
            <RefreshCw size={14} className={cn("mr-2", loading && "animate-spin")} />
            Rafraîchir
          </Button>
        </div>
      </div>

      {/* Stats globales */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Tenants actifs", value: companies.length, icon: Building2, color: "text-brand-purple" },
          { label: "Total appels", value: companies.reduce((s, c) => s + (c.calls_count || 0), 0), icon: Phone, color: "text-brand-blue" },
          { label: "Sources KB", value: companies.reduce((s, c) => s + (c.kb_sources_count || 0), 0), icon: BookOpen, color: "text-brand-cyan" },
          { label: "Utilisateurs", value: companies.reduce((s, c) => s + (c.members_count || 0), 0), icon: Users, color: "text-green-400" },
        ].map((stat) => (
          <div
            key={stat.label}
            className="rounded-xl border border-border bg-bg-card/60 p-4 backdrop-blur-sm"
          >
            <div className="flex items-center gap-2 mb-2">
              <stat.icon size={15} className={stat.color} />
              <span className="text-xs text-text-tertiary">{stat.label}</span>
            </div>
            <div className="text-2xl font-bold text-text-primary">{stat.value}</div>
          </div>
        ))}
      </div>

      {/* Impersonation active */}
      {impersonatedCompany && (
        <div className="rounded-xl border border-brand-purple/30 bg-brand-purple/10 p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-full bg-brand-purple/20 flex items-center justify-center">
              <Building2 size={16} className="text-brand-purple" />
            </div>
            <div>
              <div className="text-xs text-brand-purple font-semibold uppercase tracking-wider mb-0.5">
                Impersonation active
              </div>
              <div className="text-sm font-medium text-text-primary">
                {impersonatedCompany.name}
              </div>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => impersonateCompany(null)}
            data-testid="stop-impersonation-btn"
          >
            Quitter l'impersonation
          </Button>
        </div>
      )}

      {/* Liste des tenants */}
      <div className="rounded-xl border border-border bg-bg-card/60 backdrop-blur-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">
            PMEs & Clients ({companies.length})
          </h2>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-16 text-text-tertiary gap-2">
            <Loader2 size={18} className="animate-spin" />
            Chargement des tenants...
          </div>
        )}

        {error && !loading && (
          <div className="flex items-center justify-center py-12 text-red-400 gap-2">
            <AlertCircle size={16} />
            {error}
          </div>
        )}

        {!loading && !error && companies.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-text-tertiary gap-2">
            <Building2 size={28} className="mb-2" />
            <div className="text-sm font-medium">Aucun tenant trouvé</div>
            <div className="text-xs">Vérifiez la connexion à Supabase</div>
          </div>
        )}

        {!loading && companies.length > 0 && (
          <div className="divide-y divide-border">
            {companies.map((company) => (
              <CompanyRow
                key={company.id}
                company={company}
                isActive={impersonatedCompany?.id === company.id}
                onImpersonate={() => impersonateCompany(company)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// CompanyRow — une ligne du tableau des tenants
// ─────────────────────────────────────────────────────────────
function CompanyRow({ company, isActive, onImpersonate }) {
  return (
    <div
      className={cn(
        "flex items-center gap-4 px-5 py-4 transition-colors",
        isActive ? "bg-brand-purple/8" : "hover:bg-white/3"
      )}
      data-testid={`company-row-${company.id}`}
    >
      {/* Avatar */}
      <div className="h-10 w-10 rounded-full gradient-brand flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
        {(company.name || "?")[0].toUpperCase()}
      </div>

      {/* Infos */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-semibold text-text-primary truncate">
            {company.name}
          </span>
          {isActive && (
            <Badge variant="purple" className="text-[9px] px-1.5 py-0">
              Vue active
            </Badge>
          )}
          <Badge
            variant={company.status === "active" ? "green" : "ghost"}
            className="text-[9px] px-1.5 py-0"
          >
            {company.status || "active"}
          </Badge>
        </div>
        <div className="text-xs text-text-tertiary truncate">
          {company.city || "—"} · {company.sector || "PME"}
          {company.assistant_name && ` · Assistante : ${company.assistant_name}`}
        </div>
      </div>

      {/* Stats rapides */}
      <div className="hidden md:flex items-center gap-5 text-xs text-text-tertiary">
        <span className="flex items-center gap-1">
          <Phone size={11} /> {company.calls_count ?? "—"}
        </span>
        <span className="flex items-center gap-1">
          <Mail size={11} /> {company.emails_count ?? "—"}
        </span>
        <span className="flex items-center gap-1">
          <BookOpen size={11} /> {company.kb_sources_count ?? "—"}
        </span>
        <span className="flex items-center gap-1">
          <Users size={11} /> {company.members_count ?? "—"}
        </span>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {isActive ? (
          <Badge variant="purple" className="text-[10px] px-2 py-0.5 flex items-center gap-1">
            <CheckCircle2 size={10} /> En vue
          </Badge>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={onImpersonate}
            data-testid={`impersonate-btn-${company.id}`}
            className="text-xs h-7 px-3"
          >
            <LogIn size={12} className="mr-1.5" />
            Accéder
          </Button>
        )}
      </div>
    </div>
  );
}
