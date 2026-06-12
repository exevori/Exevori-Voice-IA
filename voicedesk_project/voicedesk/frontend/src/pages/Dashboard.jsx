// ============================================================
// EXEVORI VOICE IA — DASHBOARD (Phase 2A)
// - Super admin (no impersonation) : console admin placeholder
// - Super admin (impersonating)    : dashboard PME complet
// - PME user                       : dashboard PME complet
// ============================================================

import React, { useEffect, useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Phone, Mail, Calendar, Users, BookOpen, Sparkles, Clock,
  ShieldCheck, AlertTriangle, ArrowRight, Activity,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { Button } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Card, CardContent } from "../components/ui/card.jsx";
import KpiCard from "../components/dashboard/KpiCard.jsx";

const API = import.meta.env.VITE_API_URL || "";

export default function Dashboard() {
  const { t } = useTranslation();
  const { token, profile, effectiveCompanyId, impersonatedCompany } = useAuth();

  const [stats, setStats] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [period, setPeriod] = useState("today");
  const [loading, setLoading] = useState(true);

  const isSuperAdmin = profile?.role === "super_admin";
  const isAdminConsole = isSuperAdmin && !impersonatedCompany;
  const companyName = impersonatedCompany?.name || profile?.company?.name;
  const companyCity = impersonatedCompany?.city || profile?.company?.city;
  const assistantName = impersonatedCompany?.assistant_name || profile?.company?.assistant_name || t("dashboard.assistant_fallback", "votre assistante");

  useEffect(() => {
    if (!token || isAdminConsole) { setLoading(false); return; }
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, period, effectiveCompanyId, isAdminConsole]);

  async function loadData() {
    if (!effectiveCompanyId) return;
    setLoading(true);
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const q = new URLSearchParams({ company_id: effectiveCompanyId, period }).toString();
      const [sRes, aRes] = await Promise.all([
        fetch(`${API}/api/v1/dashboard/stats?${q}`, { headers }),
        fetch(`${API}/api/v1/dashboard/alerts?company_id=${effectiveCompanyId}`, { headers }),
      ]);
      if (sRes.ok) {
        const s = await sRes.json();
        setStats(s.kpis || null);
      }
      if (aRes.ok) {
        const a = await aRes.json();
        setAlerts(a.alerts || []);
      }
    } catch (e) {
      console.error("[Dashboard] load error:", e);
    } finally {
      setLoading(false);
    }
  }

  // ─── SUPER ADMIN console placeholder ─────────────────────────
  if (isAdminConsole) {
    return <AdminConsole profile={profile} t={t} />;
  }

  // ─── DASHBOARD PME ───────────────────────────────────────────
  return (
    <div className="space-y-6 animate-fade-in" data-testid="dashboard-pme">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-tertiary mb-1">
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-brand-green animate-pulse-dot" />
            {companyName} {companyCity && `— ${companyCity}`}
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary" data-testid="dashboard-title">
            {t("dashboard.greeting", { name: assistantName, defaultValue: "{{name}} est à l'écoute" })}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            {t("dashboard.subtitle", "Vue d'ensemble de l'activité de votre assistante IA")}
          </p>
        </div>

        <PeriodSelector value={period} onChange={setPeriod} t={t} />
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="space-y-2" data-testid="alerts-section">
          {alerts.map((a, i) => (
            <AlertBanner key={i} alert={a} />
          ))}
        </div>
      )}

      {/* KPI Grid */}
      <KpiGrid stats={stats} loading={loading} t={t} />

      {/* Phase 2B placeholder (sera rempli après validation 2A) */}
      <Phase2BPlaceholder t={t} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// SOUS-COMPOSANTS
// ────────────────────────────────────────────────────────────────

function PeriodSelector({ value, onChange, t }) {
  const options = [
    { v: "today", label: t("common.today", "Aujourd'hui") },
    { v: "week",  label: t("common.thisWeek", "Semaine") },
    { v: "month", label: t("common.thisMonth", "Mois") },
  ];
  return (
    <div className="inline-flex rounded-lg border border-border bg-bg-card p-0.5" data-testid="period-selector">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          data-testid={`period-btn-${o.v}`}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            value === o.v
              ? "bg-white/8 text-text-primary shadow-sm"
              : "text-text-secondary hover:text-text-primary"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function KpiGrid({ stats, loading, t }) {
  const cards = useMemo(() => {
    const s = stats || {};
    return [
      {
        testId: "kpi-calls",
        icon: Phone,
        label: t("dashboard.kpis.calls_today", "Appels traités"),
        value: (s.inbound_calls ?? 0) + (s.outbound_calls ?? 0),
        seed: 11,
        color: "blue",
        delta: "+18%",
        deltaTrend: "up",
      },
      {
        testId: "kpi-appointments",
        icon: Calendar,
        label: t("dashboard.kpis.appointments", "Rendez-vous"),
        value: s.appointments_upcoming ?? 0,
        seed: 23,
        color: "pink",
        delta: "+26%",
        deltaTrend: "up",
      },
      {
        testId: "kpi-emails",
        icon: Mail,
        label: t("dashboard.kpis.emails_processed", "Courriels traités"),
        value: s.emails_received ?? 0,
        seed: 7,
        color: "purple",
        delta: "+12%",
        deltaTrend: "up",
      },
      {
        testId: "kpi-leads",
        icon: Users,
        label: t("dashboard.kpis.hot_leads", "Leads chauds"),
        value: s.hot_leads ?? 0,
        seed: 17,
        color: "green",
        delta: "+30%",
        deltaTrend: "up",
      },
    ];
  }, [stats, t]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="kpi-grid-loading">
        {[0,1,2,3].map((i) => (
          <div key={i} className="h-[180px] animate-pulse rounded-xl border border-border bg-bg-card" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="kpi-grid">
      {cards.map((c) => (
        <KpiCard key={c.testId} {...c} />
      ))}
    </div>
  );
}

function AlertBanner({ alert }) {
  const sevMap = {
    high:   "border-brand-red/30    bg-brand-red/10    text-red-300",
    medium: "border-brand-orange/30 bg-brand-orange/10 text-orange-300",
    low:    "border-brand/30        bg-brand/10        text-blue-300",
  };
  return (
    <div
      data-testid={`alert-${alert.severity || "low"}`}
      className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-sm ${sevMap[alert.severity] || sevMap.low}`}
    >
      <div className="flex items-center gap-2.5">
        <AlertTriangle size={16} />
        <span>{alert.title}</span>
      </div>
      {alert.link && (
        <a href={alert.link} className="flex items-center gap-1 text-xs font-medium hover:underline">
          {alert.action || "Voir"}
          <ArrowRight size={12} />
        </a>
      )}
    </div>
  );
}

function Phase2BPlaceholder({ t }) {
  return (
    <div
      className="rounded-xl border border-dashed border-border bg-bg-card/30 p-8 text-center"
      data-testid="phase2b-placeholder"
    >
      <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-brand-purple/10 text-brand-purple">
        <Activity size={18} />
      </div>
      <h3 className="text-sm font-semibold text-text-primary">
        Phase 2B — Assistant Profile + cards opérationnelles
      </h3>
      <p className="mx-auto mt-1 max-w-md text-xs text-text-secondary">
        Cette zone accueillera bientôt le portrait de l'assistante (anneau gradient + dropdowns voix/ton), les Live Calls, les Upcoming Appointments, l'Email Handling, le CRM, la Business Memory et le donut Analytics.
      </p>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// SUPER ADMIN CONSOLE — placeholder Phase 1/7
// ────────────────────────────────────────────────────────────────

function AdminConsole({ profile, t }) {
  return (
    <div className="space-y-6 animate-fade-in" data-testid="dashboard-super-admin">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-text-primary">
          {t("navigation.admin_dashboard", "Console Admin")}
        </h1>
        <p className="mt-1 text-sm text-text-secondary">
          {t("admin.subtitle", "Vue d'ensemble Exevori")} — {profile?.email}
        </p>
      </div>

      {/* Welcome card */}
      <Card className="relative overflow-hidden border-brand-purple/20 bg-gradient-to-br from-brand/8 to-brand-purple/8" data-testid="admin-welcome-card">
        <div className="pointer-events-none absolute -top-12 -right-12 h-48 w-48 rounded-full bg-brand-purple/15 blur-3xl" />
        <CardContent className="relative flex items-start gap-5 p-6">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl gradient-brand shadow-glow-purple text-white">
            <ShieldCheck size={26} />
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-bold text-text-primary">
              Bienvenue, {profile?.full_name || "Super Admin"}
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-text-secondary">
              Vous êtes connecté en tant que <strong className="text-text-primary">super_admin</strong>.
              Pour voir le dashboard d'une PME démo (Garage Tremblay), utilisez le bouton{" "}
              <Badge variant="purple" className="mx-0.5">Voir comme PME</Badge> en haut.
              La console d'administration complète arrivera en Phase 7.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge variant="purple"><Sparkles size={11} /> Phase 1 — Auth opérationnelle</Badge>
              <Badge variant="default"><Clock size={11} /> Phase 2A — Dashboard PME KPIs ✓</Badge>
              <Badge variant="outline">Phase 2B — Cards signature à venir</Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Quick stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" data-testid="admin-quick-stats">
        <Card data-testid="quick-stat-companies">
          <CardContent className="flex items-center gap-4 p-5">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand/15 text-brand">
              <Users size={18} />
            </div>
            <div>
              <div className="text-2xl font-bold text-text-primary leading-none">—</div>
              <div className="mt-1 text-[11px] text-text-tertiary">PMEs actives</div>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="quick-stat-revenue">
          <CardContent className="flex items-center gap-4 p-5">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-green/15 text-brand-green">
              <BookOpen size={18} />
            </div>
            <div>
              <div className="text-2xl font-bold text-text-primary leading-none">—</div>
              <div className="mt-1 text-[11px] text-text-tertiary">MRR (CAD)</div>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="quick-stat-calls">
          <CardContent className="flex items-center gap-4 p-5">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-purple/15 text-brand-purple">
              <Phone size={18} />
            </div>
            <div>
              <div className="text-2xl font-bold text-text-primary leading-none">—</div>
              <div className="mt-1 text-[11px] text-text-tertiary">Appels traités (7j)</div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Roadmap */}
      <Card data-testid="admin-roadmap">
        <CardContent className="p-6">
          <h3 className="mb-4 text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
            Feuille de route — prochaines phases
          </h3>
          <ul className="space-y-2.5">
            {[
              { tag: "✓ Phase 0", label: "Setup Supabase + migrations", state: "done" },
              { tag: "✓ Phase 1", label: "Auth opérationnelle", state: "done" },
              { tag: "→ Phase 2A", label: "Dashboard PME — KPI row (en cours)", state: "active" },
              { tag: "Phase 2B",  label: "Assistant Profile + cards signature", state: "next" },
              { tag: "Phase 3",   label: "CRM + Import CSV", state: "later" },
              { tag: "Phase 4",   label: "Calls + Emails (validation brouillons IA)", state: "later" },
            ].map((p, i) => (
              <li key={i} className="flex items-center gap-3 text-xs">
                <span className={`inline-block min-w-[90px] rounded-md px-2 py-1 text-center text-[10px] font-semibold ${
                  p.state === "done"   ? "bg-brand-green/15 text-brand-green"
                : p.state === "active" ? "bg-brand/15 text-brand"
                : "bg-white/5 text-text-tertiary"
                }`}>{p.tag}</span>
                <span className="text-text-secondary">{p.label}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
