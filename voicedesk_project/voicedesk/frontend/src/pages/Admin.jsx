// ============================================================
// EXEVORI VOICE IA — Page Admin Pro (super_admin uniquement)
// Remplace : frontend/src/pages/Admin.jsx
//
// AVANT : liste clients + impersonation seulement
// APRÈS : KPIs revenus, marges, alertes, liste clients enrichie,
//         actions rapides (suspendre, réactiver, créditer)
// ============================================================

import React, { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Building2, Users, Phone, BookOpen, LogIn, RefreshCw,
  AlertCircle, CheckCircle2, Loader2, TrendingUp, DollarSign,
  LifeBuoy, Zap, AlertTriangle, ChevronRight, BarChart3,
  ShieldOff, ShieldCheck, CreditCard, Activity,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { Button } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { cn } from "../lib/utils.js";

const API = import.meta.env.VITE_API_URL || "";

const STATUS_META = {
  active:    { label: "Actif",      variant: "green"   },
  trial:     { label: "Essai",      variant: "cyan"    },
  overdue:   { label: "En retard",  variant: "red"     },
  suspended: { label: "Suspendu",   variant: "default" },
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
    alerts.trials_ending_soon > 0 && { msg: `${alerts.trials_ending_soon} essai(s) se terminent dans 3 jours`, color: "text-brand-orange border-brand-orange/20 bg-brand-orange/5" },
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
function CompanyRow({ company, isActive, onImpersonate, onSuspend, onReactivate, token }) {
  const [expanded, setExpanded] = useState(false);
  const [profitability, setProfitability] = useState(null);
  const [loadingProfit, setLoadingProfit] = useState(false);

  const loadProfitability = async () => {
    if (profitability) { setExpanded(e => !e); return; }
    setExpanded(true);
    setLoadingProfit(true);
    try {
      const res = await fetch(`${API}/api/v1/admin/companies/${company.id}/profitability`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setProfitability((await res.json()));
    } catch {}
    setLoadingProfit(false);
  };

  const sMeta = STATUS_META[company.status] || STATUS_META.active;

  return (
    <div className={cn("border-b border-border transition-colors", isActive ? "bg-brand/5" : "hover:bg-bg-hover")}>
      <div className="flex items-center gap-3 px-4 py-3.5">
        {/* Avatar */}
        <div className="h-9 w-9 rounded-full gradient-brand flex items-center justify-center text-white font-bold text-sm shrink-0">
          {(company.name || "?")[0].toUpperCase()}
        </div>

        {/* Infos */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-text-primary">{company.name}</span>
            {isActive && <Badge variant="purple" className="text-[9px]">Vue active</Badge>}
            <Badge variant={sMeta.variant} className="text-[9px]">{sMeta.label}</Badge>
            {company.plan && <span className="text-[10px] text-text-tertiary font-mono">{company.plan}</span>}
          </div>
          <div className="text-xs text-text-tertiary truncate mt-0.5">
            {company.city || "—"} · {company.assistant_name || "Assistante non configurée"}
          </div>
        </div>

        {/* Stats */}
        <div className="hidden lg:flex items-center gap-4 text-xs text-text-tertiary">
          <span className="flex items-center gap-1"><Phone size={11}/>{company.calls_count ?? 0}</span>
          <span className="flex items-center gap-1"><BookOpen size={11}/>{company.kb_sources_count ?? 0}</span>
          <span className="flex items-center gap-1"><Users size={11}/>{company.members_count ?? 0}</span>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button onClick={loadProfitability}
            className="text-[10px] px-2 py-1 rounded border border-border text-text-tertiary hover:border-brand hover:text-brand transition-colors">
            <BarChart3 size={11} />
          </button>
          {company.status === "active" || company.status === "trial" ? (
            <button onClick={() => onSuspend(company.id)}
              className="text-[10px] px-2 py-1 rounded border border-border text-text-tertiary hover:border-brand-red hover:text-brand-red transition-colors">
              <ShieldOff size={11} />
            </button>
          ) : (
            <button onClick={() => onReactivate(company.id)}
              className="text-[10px] px-2 py-1 rounded border border-border text-text-tertiary hover:border-brand-green hover:text-brand-green transition-colors">
              <ShieldCheck size={11} />
            </button>
          )}
          {isActive ? (
            <Badge variant="purple" className="text-[9px] px-2">En vue</Badge>
          ) : (
            <Button variant="outline" size="sm" onClick={onImpersonate} className="text-xs h-7 px-2.5">
              <LogIn size={11} className="mr-1" /> Accéder
            </Button>
          )}
        </div>
      </div>

      {/* Profitability panel */}
      {expanded && (
        <div className="px-4 pb-3 pt-0 border-t border-border bg-bg-secondary/50">
          {loadingProfit ? (
            <div className="flex items-center gap-2 py-3 text-xs text-text-tertiary">
              <Loader2 size={12} className="animate-spin"/> Chargement de la rentabilité...
            </div>
          ) : profitability ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 py-3">
              {[
                { label: "Revenu/mois", value: `${profitability.monthly_revenue?.toFixed(0) || 0}$` },
                { label: "Coût infra", value: `${profitability.infra_cost_usd?.toFixed(2) || 0} USD` },
                { label: "Marge brute", value: `${profitability.gross_margin_percent?.toFixed(0) || 0}%` },
                { label: "Appels ce mois", value: profitability.calls_this_month || 0 },
              ].map(item => (
                <div key={item.label} className="bg-bg-card rounded-lg p-2.5 border border-border">
                  <p className="text-[10px] text-text-tertiary">{item.label}</p>
                  <p className="text-sm font-bold text-text-primary mt-0.5">{item.value}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-text-tertiary py-3">Données non disponibles</p>
          )}
        </div>
      )}
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
  const [actionLoading, setActionLoading] = useState(null);

  const load = useCallback(async () => {
    if (!token || !isSuperAdmin) return;
    setLoading(true);
    setError(null);
    try {
      const [compRes, dashRes] = await Promise.all([
        fetch(`${API}/api/v1/admin/companies`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API}/api/v1/admin/dashboard`,  { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (compRes.ok) {
        const d = await compRes.json();
        setCompanies(d.companies || []);
      }
      if (dashRes.ok) {
        setDashboard(await dashRes.json());
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token, isSuperAdmin]);

  useEffect(() => { load(); }, [load]);

  const doAction = async (url, method = "POST") => {
    setActionLoading(url);
    try {
      await fetch(`${API}${url}`, { method, headers: { Authorization: `Bearer ${token}` } });
      await load();
    } catch {}
    setActionLoading(null);
  };

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
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard
              label="MRR Total" icon={DollarSign} color="text-brand-green"
              bg="bg-brand-green/5" trend={5}
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
      )}

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
              token={token}
              onImpersonate={() => impersonateCompany(company)}
              onSuspend={(id) => doAction(`/api/v1/admin/companies/${id}/suspend`)}
              onReactivate={(id) => doAction(`/api/v1/admin/companies/${id}/reactivate`)}
            />
          ))
        )}
      </div>
    </div>
  );
}
