// ============================================================
// EXEVORI VOICE IA — Page Admin Pro (super_admin uniquement)
// Remplace : frontend/src/pages/Admin.jsx
//
// AVANT : liste clients + impersonation seulement
// APRÈS : KPIs revenus, marges, alertes, liste clients enrichie,
//         actions rapides (suspendre, réactiver, créditer)
// ============================================================

import React, { useEffect, useState, useCallback } from "react";
import {
  Building2, Users, Phone, BookOpen, RefreshCw,
  AlertCircle, Loader2, TrendingUp, DollarSign,
  LifeBuoy, AlertTriangle, ChevronRight, Activity,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { Button } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { cn } from "../lib/utils.js";
import CompanyDetailSheet from "../components/admin/CompanyDetailSheet.jsx";
import { requestAdminJson } from "../utils/admin-company.js";

const API = import.meta.env.VITE_API_URL || "";

const STATUS_META = {
  active:    { label: "Actif",      variant: "green"   },
  trial:     { label: "Essai",      variant: "cyan"    },
  overdue:   { label: "En retard",  variant: "red"     },
  suspended: { label: "Suspendu",   variant: "default" },
  suspended_overage: { label: "Quota dépassé", variant: "orange" },
  cancelled: { label: "Annulé",     variant: "ghost"   },
};

// ── KPI Card ─────────────────────────────────────────────────
function KpiCard({ label, value, sub, icon: Icon, color, bg, trend }) {
  return (
    <div className={`rounded-xl border border-border p-4 ${bg} flex items-start gap-3`}>
      <div className={`rounded-lg p-2 bg-white/10 shrink-0`}>
        <Icon size={18} className={color} />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-text-tertiary">{label}</p>
        <p className={`text-xl font-bold ${color} mt-0.5`}>{value}</p>
        {sub && <p className="text-[11px] text-text-tertiary mt-0.5">{sub}</p>}
        {trend && (
          <p className={`text-[11px] mt-0.5 flex items-center gap-0.5 ${trend > 0 ? "text-brand-green" : "text-brand-red"}`}>
            <TrendingUp size={10} /> {trend > 0 ? "+" : ""}{trend}%
          </p>
        )}
      </div>
    </div>
  );
}

// ── Alert Banner ──────────────────────────────────────────────
function AlertBanner({ alerts }) {
  if (!alerts) return null;
  const items = [
    alerts.clients_overdue > 0 && { msg: `${alerts.clients_overdue} client(s) en retard de paiement`, color: "text-brand-red border-brand-red/20 bg-brand-red/5" },
    alerts.trials_ending_soon > 0 && { msg: `${alerts.trials_ending_soon} essai(s) se terminent dans les 7 jours`, color: "text-brand-orange border-brand-orange/20 bg-brand-orange/5" },
    alerts.sla_breached > 0 && { msg: `${alerts.sla_breached} ticket(s) ont dépassé leur SLA`, color: "text-brand-orange border-brand-orange/20 bg-brand-orange/5" },
  ].filter(Boolean);

  if (!items.length) return null;

  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium ${item.color}`}>
          <AlertTriangle size={13} /> {item.msg}
        </div>
      ))}
    </div>
  );
}

// ── Company Row ───────────────────────────────────────────────
function CompanyRow({ company, isActive, onOpen }) {
  const meta = STATUS_META[company.status] || { label: "État inconnu", variant: "orange" };
  return (
    <div className={cn("flex flex-wrap items-center gap-3 border-b border-border px-4 py-3.5", isActive && "bg-brand/5")}>
      <div className="flex-1 min-w-0">
        <button type="button" onClick={onOpen} className="text-left text-sm font-semibold text-text-primary hover:text-brand">{company.name}</button>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Badge variant={meta.variant}>{meta.label}</Badge>
          {isActive && <Badge variant="purple">Vue active</Badge>}
          <span className="text-xs text-text-tertiary">{company.city || "—"} · {company.plan || "Forfait non défini"}</span>
        </div>
      </div>
      <div className="hidden items-center gap-3 text-xs text-text-tertiary lg:flex">
        <span className="flex items-center gap-1" title="Appels enregistrés"><Phone size={12} />{company.calls_count}</span>
        <span className="flex items-center gap-1" title="Sources de connaissances"><BookOpen size={12} />{company.kb_sources_count}</span>
        <span className="flex items-center gap-1" title="Membres"><Users size={12} />{company.members_count}</span>
      </div>
      <Button variant="outline" size="sm" onClick={onOpen}>Voir la fiche <ChevronRight size={13} /></Button>
    </div>
  );
}

// ── PAGE PRINCIPALE ───────────────────────────────────────────
export default function Admin() {
  const { token, profile, impersonateCompany, impersonatedCompany } = useAuth();
  const isSuperAdmin = profile?.role === "super_admin";

  const [companies, setCompanies] = useState([]);
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState(null);
  const [selectedCompany, setSelectedCompany] = useState(null);

  const load = useCallback(async () => {
    if (!token || !isSuperAdmin) return;
    setLoading(true);
    setError(null);
    try {
      const [companyData, dashboardData] = await Promise.all([
        requestAdminJson(`${API}/api/v1/admin/companies`, { token }),
        requestAdminJson(`${API}/api/v1/admin/dashboard`, { token }),
      ]);
      setCompanies(companyData.companies || []);
      setDashboard(dashboardData);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token, isSuperAdmin]);

  useEffect(() => { load(); }, [load]);

  const filtered = companies.filter(c => {
    const matchSearch = !search || c.name?.toLowerCase().includes(search.toLowerCase()) || c.city?.toLowerCase().includes(search.toLowerCase());
    const matchStatus = !statusFilter || c.status === statusFilter;
    return matchSearch && matchStatus;
  });

  if (!isSuperAdmin) {
    return (
      <div className="flex items-center justify-center h-64 text-text-tertiary">
        <AlertCircle size={20} className="mr-2"/> Accès réservé aux super_admins.
      </div>
    );
  }

  const rev = dashboard?.revenue;
  const cli = dashboard?.clients;
  const mrg = dashboard?.margins;
  const tkt = dashboard?.tickets;

  return (
    <div className="space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-text-tertiary mb-1 flex items-center gap-1.5">
            <Activity size={11}/> Panneau administrateur
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Dashboard Exevori</h1>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-2">
          <RefreshCw size={13} className={loading ? "animate-spin" : ""}/> Actualiser
        </Button>
      </div>

      {/* Alertes */}
      {dashboard?.alerts && <AlertBanner alerts={dashboard.alerts} />}

      {/* KPIs revenus */}
      {loading ? (
        <div className="flex items-center gap-2 text-text-tertiary text-sm py-6">
          <Loader2 size={15} className="animate-spin"/> Chargement...
        </div>
      ) : dashboard ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard
              label="MRR Total" icon={DollarSign} color="text-brand-green"
              bg="bg-brand-green/5"
              value={`${rev?.mrr_total?.toFixed(0) || 0}$`}
              sub={`ARR estimé ${((rev?.arr_estimated || 0)).toFixed(0)}$`}
            />
            <KpiCard
              label="Clients actifs" icon={Building2} color="text-brand"
              bg="bg-brand/5"
              value={cli?.active || 0}
              sub={`${cli?.trial || 0} en essai · ${cli?.total || 0} total`}
            />
            <KpiCard
              label="Marge brute" icon={TrendingUp} color="text-brand-purple"
              bg="bg-brand-purple/5"
              value={`${mrg?.margin_percent || 0}%`}
              sub={`Profit ${mrg?.gross_profit?.toFixed(0) || 0}$`}
            />
            <KpiCard
              label="Tickets SLA" icon={LifeBuoy} color="text-brand-orange"
              bg="bg-brand-orange/5"
              value={tkt?.open || 0}
              sub={`${tkt?.sla_breached || 0} SLA dépassés`}
            />
          </div>

          {/* MRR breakdown */}
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: "MRR actif payé",  value: `${rev?.mrr_active_paid?.toFixed(0) || 0}$`,   color: "text-brand-green" },
              { label: "MRR essai",        value: `${rev?.mrr_trial?.toFixed(0) || 0}$`,          color: "text-brand" },
              { label: "MRR en retard",    value: `${rev?.mrr_overdue?.toFixed(0) || 0}$`,        color: "text-brand-red" },
            ].map(k => (
              <div key={k.label} className="rounded-lg border border-border bg-bg-card p-3">
                <p className="text-[10px] text-text-tertiary">{k.label}</p>
                <p className={`text-base font-bold ${k.color}`}>{k.value}</p>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {/* Liste clients */}
      <div className="rounded-xl border border-border bg-bg-card overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border flex-wrap">
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Chercher un client..."
            className="rounded-lg border border-border bg-bg-input px-3 py-1.5 text-sm text-text-primary outline-none focus:border-brand w-44"
          />
          <div className="flex gap-1">
            {[null, "active", "trial", "overdue", "suspended"].map(s => (
              <button key={s ?? "all"}
                onClick={() => setStatusFilter(s)}
                className={`px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
                  statusFilter === s ? "bg-brand text-white" : "border border-border text-text-secondary hover:border-brand/50"
                }`}>
                {s ? STATUS_META[s]?.label : "Tous"}
              </button>
            ))}
          </div>
          <span className="ml-auto text-xs text-text-tertiary">{filtered.length} client(s)</span>
        </div>

        {/* Rows */}
        {error ? (
          <div className="flex items-center gap-2 p-6 text-sm text-brand-red">
            <AlertCircle size={16}/> {error}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-text-tertiary gap-2">
            <Building2 size={24}/>
            <p className="text-sm">{search ? "Aucun client correspondant" : "Aucun client"}</p>
          </div>
        ) : (
          filtered.map(company => (
            <CompanyRow
              key={company.id}
              company={company}
              isActive={impersonatedCompany?.id === company.id}
              onOpen={() => setSelectedCompany(company)}
            />
          ))
        )}
      </div>
      {selectedCompany && <CompanyDetailSheet
        key={selectedCompany.id}
        company={selectedCompany}
        token={token}
        onClose={() => setSelectedCompany(null)}
        onChanged={() => void load()}
        onImpersonate={impersonateCompany}
      />}
    </div>
  );
}
