// ============================================================
// EXEVORI VOICE IA — DASHBOARD (Phase 2A + 2B light)
// ============================================================

import React, { useEffect, useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Phone, Mail, Calendar, Users, BookOpen, Sparkles, Clock,
  ShieldCheck, AlertTriangle, ArrowRight, Activity, Mic,
  CheckCircle2, AlertCircle, FlameKindling, Eye, Lightbulb,
  PieChart, Building2, Zap,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Card, CardContent } from "../components/ui/card.jsx";
import KpiCard from "../components/dashboard/KpiCard.jsx";
import { cn } from "../lib/utils.js";

const API = import.meta.env.VITE_API_URL || "";

// ────────────────────────────────────────────────────────────────
//  ROOT
// ────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { t } = useTranslation();
  const { token, profile, effectiveCompanyId, impersonatedCompany } = useAuth();

  const [stats, setStats] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [config, setConfig] = useState(null);
  const [activity, setActivity] = useState([]);
  const [appointments, setAppointments] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [knowledge, setKnowledge] = useState([]);
  const [period, setPeriod] = useState("today");
  const [loading, setLoading] = useState(true);

  const isSuperAdmin = profile?.role === "super_admin";
  const isAdminConsole = isSuperAdmin && !impersonatedCompany;

  const companyName = impersonatedCompany?.name || profile?.company?.name;
  const companyCity = impersonatedCompany?.city || profile?.company?.city;
  const assistantName =
    config?.assistant_name ||
    impersonatedCompany?.assistant_name ||
    profile?.company?.assistant_name ||
    t("dashboard.assistant_fallback", "Votre assistante");

  useEffect(() => {
    if (!token || isAdminConsole) { setLoading(false); return; }
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, period, effectiveCompanyId, isAdminConsole]);

  async function loadAll() {
    if (!effectiveCompanyId) return;
    setLoading(true);
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const cid = effectiveCompanyId;
      const [sRes, aRes, cRes, actRes, apRes, ctRes, kbRes] = await Promise.all([
        fetch(`${API}/api/v1/dashboard/stats?company_id=${cid}&period=${period}`, { headers }),
        fetch(`${API}/api/v1/dashboard/alerts?company_id=${cid}`, { headers }),
        fetch(`${API}/api/v1/config?company_id=${cid}`, { headers }),
        fetch(`${API}/api/v1/dashboard/activity?company_id=${cid}&limit=20`, { headers }),
        fetch(`${API}/api/v1/calendar/appointments?company_id=${cid}&upcoming=true&limit=4`, { headers }),
        fetch(`${API}/api/v1/crm?company_id=${cid}&limit=50`, { headers }),
        fetch(`${API}/api/v1/knowledge?company_id=${cid}&limit=100`, { headers }),
      ]);
      if (sRes.ok)   setStats((await sRes.json()).kpis || null);
      if (aRes.ok)   setAlerts((await aRes.json()).alerts || []);
      if (cRes.ok)   setConfig((await cRes.json()).config || null);
      if (actRes.ok) setActivity((await actRes.json()).activities || []);
      if (apRes.ok)  {
        const d = await apRes.json();
        setAppointments(d.appointments || d.data || d || []);
      }
      if (ctRes.ok)  {
        const d = await ctRes.json();
        setContacts(d.contacts || d.data || []);
      }
      if (kbRes.ok)  {
        const d = await kbRes.json();
        setKnowledge(d.knowledge || d.entries || d.data || []);
      }
    } catch (e) {
      console.error("[Dashboard] load error:", e);
    } finally {
      setLoading(false);
    }
  }

  if (isAdminConsole) return <AdminConsole profile={profile} t={t} />;

  return (
    <div className="space-y-6 animate-fade-in" data-testid="dashboard-pme">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-tertiary mb-1.5">
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

      {alerts.length > 0 && (
        <div className="space-y-2" data-testid="alerts-section">
          {alerts.map((a, i) => <AlertBanner key={i} alert={a} />)}
        </div>
      )}

      {/* KPI Grid (Phase 2A) */}
      <KpiGrid stats={stats} loading={loading} t={t} />

      {/* === PHASE 2B Row 1 : Assistant Profile + Live Calls + Upcoming Appointments === */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3" data-testid="row-2b-1">
        <AssistantProfileCard config={config} assistantName={assistantName} stats={stats} />
        <LiveCallsCard activity={activity} stats={stats} t={t} />
        <UpcomingAppointmentsCard appointments={appointments} t={t} />
      </div>

      {/* === PHASE 2B Row 2 : Email Handling + CRM Snapshot + Business Memory === */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3" data-testid="row-2b-2">
        <EmailHandlingCard stats={stats} activity={activity} t={t} />
        <CrmSnapshotCard contacts={contacts} t={t} />
        <BusinessMemoryCard knowledge={knowledge} t={t} />
      </div>

      {/* === PHASE 2B Row 3 : Learning + Analytics placeholders === */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" data-testid="row-2b-3">
        <LearningSuggestionsCard count={stats?.learning_suggestions_pending || 0} t={t} />
        <AnalyticsPlaceholderCard stats={stats} t={t} />
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
//  HEADER ELEMENTS
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
          className={cn(
            "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
            value === o.v ? "bg-white/8 text-text-primary shadow-sm" : "text-text-secondary hover:text-text-primary"
          )}
        >{o.label}</button>
      ))}
    </div>
  );
}

function KpiGrid({ stats, loading, t }) {
  const cards = useMemo(() => {
    const s = stats || {};
    return [
      { testId: "kpi-calls", icon: Phone, label: t("dashboard.kpis.calls_today", "Appels traités"), value: (s.inbound_calls ?? 0) + (s.outbound_calls ?? 0), seed: 11, color: "blue",   delta: "+18%", deltaTrend: "up" },
      { testId: "kpi-appointments", icon: Calendar, label: t("dashboard.kpis.appointments", "Rendez-vous"), value: s.appointments_upcoming ?? 0, seed: 23, color: "pink", delta: "+26%", deltaTrend: "up" },
      { testId: "kpi-emails", icon: Mail, label: t("dashboard.kpis.emails_processed", "Courriels traités"), value: s.emails_received ?? 0, seed: 7,  color: "purple", delta: "+12%", deltaTrend: "up" },
      { testId: "kpi-leads", icon: Users, label: t("dashboard.kpis.hot_leads", "Leads chauds"), value: s.hot_leads ?? 0, seed: 17, color: "green", delta: "+30%", deltaTrend: "up" },
    ];
  }, [stats, t]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="kpi-grid-loading">
        {[0,1,2,3].map((i) => <div key={i} className="h-[180px] animate-pulse rounded-xl border border-border bg-bg-card" />)}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="kpi-grid">
      {cards.map((c) => <KpiCard key={c.testId} {...c} />)}
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
    <div data-testid={`alert-${alert.severity || "low"}`} className={cn("flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-sm", sevMap[alert.severity] || sevMap.low)}>
      <div className="flex items-center gap-2.5"><AlertTriangle size={16} /><span>{alert.title}</span></div>
      {alert.link && <a href={alert.link} className="flex items-center gap-1 text-xs font-medium hover:underline">{alert.action || "Voir"}<ArrowRight size={12} /></a>}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
//  CARD WRAPPER
// ────────────────────────────────────────────────────────────────
function DashCard({ title, icon: Icon, accent = "purple", children, action, testId, className }) {
  const accentMap = {
    purple: "text-brand-purple", blue: "text-brand", green: "text-brand-green",
    cyan: "text-brand-cyan", orange: "text-brand-orange", pink: "text-brand-pink",
  };
  return (
    <Card className={cn("flex flex-col", className)} data-testid={testId}>
      <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
        <div className="flex items-center gap-2">
          {Icon && <Icon size={15} className={accentMap[accent]} />}
          <h3 className="text-[13px] font-semibold text-text-primary">{title}</h3>
        </div>
        {action}
      </div>
      <CardContent className="flex-1 p-5">{children}</CardContent>
    </Card>
  );
}

function EmptyState({ label }) {
  return <div className="flex h-full min-h-[80px] items-center justify-center text-xs text-text-tertiary">{label}</div>;
}

// ────────────────────────────────────────────────────────────────
//  6 CARDS — PHASE 2B LIGHT
// ────────────────────────────────────────────────────────────────

// 1. ASSISTANT PROFILE (anneau gradient simple CSS)
function AssistantProfileCard({ config, assistantName, stats }) {
  const initial = (assistantName?.[0] || "A").toUpperCase();
  const voice = config?.voice_id || "—";
  const tone = (config?.tone || "professional").replace(/_/g, " ");
  const lang = config?.language_primary || "fr-CA";

  return (
    <DashCard title="Profil de l'assistante" icon={Mic} accent="purple" testId="card-assistant-profile">
      <div className="flex flex-col items-center text-center">
        {/* Anneau gradient conic CSS (Aceternity light alternative) */}
        <div
          className="relative h-24 w-24 rounded-full p-[3px] animate-[ring-spin_18s_linear_infinite]"
          style={{ background: "conic-gradient(from 0deg, #3B82F6, #8B5CF6, #EC4899, #06B6D4, #3B82F6)" }}
        >
          <div className="flex h-full w-full items-center justify-center rounded-full bg-bg-card text-2xl font-bold text-text-primary">
            {initial}
          </div>
        </div>

        <div className="mt-3 text-lg font-bold text-text-primary" data-testid="assistant-name">
          {assistantName}
        </div>
        <div className="text-[11px] text-text-tertiary">{lang === "fr-CA" ? "Bilingue FR-CA / EN-CA" : "Bilingual EN-CA / FR-CA"}</div>

        <div className="mt-4 flex w-full items-center gap-2">
          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-brand-green animate-pulse-dot" />
          <span className="text-[11px] uppercase tracking-wider text-brand-green font-semibold">En ligne</span>
        </div>

        <div className="mt-4 grid w-full grid-cols-2 gap-2">
          <div className="rounded-lg border border-border bg-white/3 px-2.5 py-2">
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary">Voix</div>
            <div className="mt-0.5 text-sm font-medium text-text-primary capitalize">{voice}</div>
          </div>
          <div className="rounded-lg border border-border bg-white/3 px-2.5 py-2">
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary">Ton</div>
            <div className="mt-0.5 text-sm font-medium text-text-primary capitalize">{tone}</div>
          </div>
        </div>

        <div className="mt-3 w-full rounded-lg border border-border bg-white/3 px-2.5 py-2">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary">Minutes utilisées</div>
          <div className="mt-0.5 text-sm font-medium text-text-primary">
            {Math.round(stats?.total_minutes ?? 0)} min <span className="text-text-tertiary">/ 1 000 incluses</span>
          </div>
          <div className="mt-1.5 h-1 w-full rounded-full bg-white/5 overflow-hidden">
            <div
              className="h-full rounded-full gradient-brand"
              style={{ width: `${Math.min(100, ((stats?.total_minutes ?? 0) / 10))}%` }}
            />
          </div>
        </div>
      </div>
    </DashCard>
  );
}

// 2. LIVE CALLS
function LiveCallsCard({ activity, stats, t }) {
  const calls = activity.filter((a) => a.type === "call_inbound" || a.type === "call_outbound").slice(0, 4);
  const active = stats?.inbound_calls && calls.length > 0;
  return (
    <DashCard
      title="Appels"
      icon={Phone}
      accent="blue"
      testId="card-live-calls"
      action={active && (
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-brand-green">
          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-brand-green animate-pulse-dot" />
          {calls.length} en activité
        </span>
      )}
    >
      {calls.length === 0 ? (
        <EmptyState label="Aucun appel récent" />
      ) : (
        <ul className="space-y-2" data-testid="live-calls-list">
          {calls.map((c, i) => (
            <li key={i} className="flex items-center gap-3 rounded-lg border border-border bg-white/3 px-3 py-2 hover:bg-white/5 transition-colors">
              <div className={cn(
                "flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold",
                c.type === "call_inbound" ? "bg-brand/15 text-brand" : "bg-brand-purple/15 text-brand-purple"
              )}>
                {c.type === "call_inbound" ? "📞" : "↗"}
              </div>
              <div className="flex-1 min-w-0">
                <div className="truncate text-xs font-medium text-text-primary">{c.title?.replace(/^Appel (entrant|sortant) — /, "")}</div>
                {c.description && <div className="truncate text-[11px] text-text-secondary">{c.description}</div>}
              </div>
              <Badge variant={c.outcome === "appointment_booked" ? "green" : c.outcome === "transferred" ? "orange" : "ghost"} className="shrink-0">
                {c.outcome === "appointment_booked" ? "RDV" :
                 c.outcome === "transferred" ? "Transféré" :
                 c.outcome === "in_progress" ? "En cours" :
                 c.outcome || "—"}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </DashCard>
  );
}

// 3. UPCOMING APPOINTMENTS
function UpcomingAppointmentsCard({ appointments, t }) {
  return (
    <DashCard title="Prochains rendez-vous" icon={Calendar} accent="pink" testId="card-appointments">
      {appointments.length === 0 ? (
        <EmptyState label="Aucun RDV planifié" />
      ) : (
        <ul className="space-y-2" data-testid="appointments-list">
          {appointments.slice(0, 4).map((apt, i) => {
            const d = apt.date ? new Date(apt.date + (apt.time ? "T" + apt.time : "T00:00")) : null;
            const dateStr = d ? d.toLocaleDateString("fr-CA", { day: "numeric", month: "short" }) : "—";
            const timeStr = apt.time || "—";
            const statusVariant = apt.status === "confirmed" ? "green" : apt.status === "pending" ? "orange" : "ghost";
            return (
              <li key={apt.id || i} className="flex items-start gap-3 rounded-lg border border-border bg-white/3 px-3 py-2.5">
                <div className="flex flex-col items-center justify-center rounded-md gradient-brand px-2 py-1.5 text-white shrink-0 min-w-[52px]">
                  <div className="text-[9px] uppercase tracking-wider font-semibold opacity-80">{dateStr.split(" ")[1]}</div>
                  <div className="text-base font-bold leading-none">{dateStr.split(" ")[0]}</div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="truncate text-xs font-medium text-text-primary">
                    {apt.contact?.full_name || apt.contacts?.full_name || apt.type || "RDV"}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-text-secondary">
                    <Clock size={10} /> <span>{timeStr}</span>
                    <span className="text-text-tertiary">•</span>
                    <span className="truncate">{apt.type}</span>
                  </div>
                </div>
                <Badge variant={statusVariant} className="shrink-0 text-[10px]">
                  {apt.status === "confirmed" ? "Confirmé" : apt.status === "pending" ? "En attente" : apt.status}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
    </DashCard>
  );
}

// 4. EMAIL HANDLING
function EmailHandlingCard({ stats, activity, t }) {
  const received = stats?.emails_received ?? 0;
  const pending = stats?.drafts_pending ?? 0;
  const recent = activity.filter((a) => a.type === "email").slice(0, 3);

  return (
    <DashCard title="Gestion des courriels" icon={Mail} accent="purple" testId="card-emails">
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="rounded-lg border border-border bg-white/3 px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary">Reçus</div>
          <div className="mt-1 text-xl font-bold text-text-primary">{received}</div>
        </div>
        <div className={cn(
          "rounded-lg border px-3 py-2.5",
          pending > 0 ? "border-brand-orange/30 bg-brand-orange/10" : "border-border bg-white/3"
        )}>
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary">À valider</div>
          <div className={cn("mt-1 text-xl font-bold", pending > 0 ? "text-brand-orange" : "text-text-primary")}>{pending}</div>
        </div>
      </div>
      {recent.length === 0 ? (
        <EmptyState label="Aucun courriel récent" />
      ) : (
        <ul className="space-y-1.5" data-testid="emails-list">
          {recent.map((e, i) => (
            <li key={i} className="rounded-md border border-border bg-white/3 px-2.5 py-2">
              <div className="truncate text-xs font-medium text-text-primary">{e.description || e.title}</div>
              <div className="mt-0.5 truncate text-[10px] text-text-tertiary">{e.title}</div>
            </li>
          ))}
        </ul>
      )}
    </DashCard>
  );
}

// 5. CRM SNAPSHOT (hot/warm/customer/new)
function CrmSnapshotCard({ contacts, t }) {
  const counts = useMemo(() => {
    const c = { hot: 0, warm: 0, cold: 0, customer: 0, new: 0 };
    (contacts || []).forEach((ct) => {
      const k = (ct.status || "new").toLowerCase();
      if (k in c) c[k]++; else c.new++;
    });
    return c;
  }, [contacts]);

  const segments = [
    { key: "hot",      label: "Chauds",   value: counts.hot,      color: "bg-brand-red"    },
    { key: "warm",     label: "Tièdes",   value: counts.warm,     color: "bg-brand-orange" },
    { key: "customer", label: "Clients",  value: counts.customer, color: "bg-brand-green"  },
    { key: "new",      label: "Nouveaux", value: counts.new,      color: "bg-brand"        },
    { key: "cold",     label: "Froids",   value: counts.cold,     color: "bg-text-tertiary" },
  ];
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;

  return (
    <DashCard title="Pipeline CRM" icon={Users} accent="green" testId="card-crm">
      <div className="text-xs text-text-secondary mb-2">Total : <span className="font-semibold text-text-primary">{total} contacts</span></div>

      {/* Stacked bar */}
      <div className="mb-3 flex h-2 w-full overflow-hidden rounded-full bg-white/5" data-testid="crm-bar">
        {segments.map((s) => s.value > 0 && (
          <div key={s.key} className={cn("h-full", s.color)} style={{ width: `${(s.value / total) * 100}%` }} title={`${s.label}: ${s.value}`} />
        ))}
      </div>

      <ul className="space-y-1.5" data-testid="crm-segments">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <span className={cn("inline-block h-2 w-2 rounded-full", s.color)} />
              <span className="text-text-secondary">{s.label}</span>
            </div>
            <span className="font-semibold text-text-primary tabular-nums">{s.value}</span>
          </li>
        ))}
      </ul>
    </DashCard>
  );
}

// 6. BUSINESS MEMORY 2×2
function BusinessMemoryCard({ knowledge, t }) {
  const groups = useMemo(() => {
    const g = {};
    (knowledge || []).forEach((k) => {
      const cat = (k.category || "FAQ").toLowerCase();
      g[cat] = (g[cat] || 0) + 1;
    });
    return g;
  }, [knowledge]);

  const tiles = [
    { key: "horaires",   label: "Horaires",   icon: Clock,       color: "blue" },
    { key: "tarifs",     label: "Tarifs",     icon: Zap,         color: "green" },
    { key: "services",   label: "Services",   icon: Sparkles,    color: "purple" },
    { key: "paiement",   label: "Paiement",   icon: BookOpen,    color: "pink" },
  ];
  const tileColors = {
    blue:   "bg-brand/10 text-brand border-brand/20",
    green:  "bg-brand-green/10 text-brand-green border-brand-green/20",
    purple: "bg-brand-purple/10 text-brand-purple border-brand-purple/20",
    pink:   "bg-brand-pink/10 text-brand-pink border-brand-pink/20",
  };

  return (
    <DashCard title="Mémoire d'affaires" icon={Building2} accent="cyan" testId="card-memory">
      <div className="grid grid-cols-2 gap-2" data-testid="memory-grid">
        {tiles.map((tile) => (
          <div key={tile.key} className={cn("rounded-lg border p-3 text-center", tileColors[tile.color])}>
            <tile.icon size={14} className="mx-auto mb-1.5" />
            <div className="text-xl font-bold tabular-nums">{groups[tile.key] || 0}</div>
            <div className="text-[10px] uppercase tracking-wider mt-0.5 opacity-80">{tile.label}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 text-center text-[11px] text-text-tertiary">
        Total entrées validées : <span className="font-semibold text-text-primary">{knowledge?.length || 0}</span>
      </div>
    </DashCard>
  );
}

// 7. LEARNING SUGGESTIONS placeholder
function LearningSuggestionsCard({ count, t }) {
  return (
    <DashCard title="Suggestions d'apprentissage" icon={Lightbulb} accent="orange" testId="card-learning">
      <div className="flex h-full items-center gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-orange/15 text-brand-orange shrink-0">
          <Lightbulb size={22} />
        </div>
        <div className="flex-1">
          <div className="text-2xl font-bold text-text-primary">{count}</div>
          <div className="text-xs text-text-secondary">nouvelles questions détectées par votre assistante</div>
          <div className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-text-tertiary">
            <Eye size={11} />
            <span>Vue détaillée — Phase 9 (validation en lot)</span>
          </div>
        </div>
      </div>
    </DashCard>
  );
}

// 8. ANALYTICS placeholder
function AnalyticsPlaceholderCard({ stats, t }) {
  const s = stats || {};
  const total = (s.inbound_calls ?? 0) + (s.outbound_calls ?? 0) + (s.emails_received ?? 0) + (s.appointments_upcoming ?? 0);
  return (
    <DashCard title="Statistiques globales" icon={PieChart} accent="cyan" testId="card-analytics">
      <div className="flex h-full items-center justify-between gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary">Total interactions</div>
          <div className="text-3xl font-bold text-text-primary tabular-nums">{total}</div>
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-brand-green">
            <span>+21%</span>
            <span className="text-text-tertiary">vs période précédente</span>
          </div>
          <div className="mt-3 inline-flex items-center gap-1.5 text-[11px] text-text-tertiary">
            <PieChart size={11} />
            <span>Graphique détaillé — Phase 9</span>
          </div>
        </div>

        {/* Mini donut (CSS only) */}
        <div className="relative h-24 w-24 shrink-0">
          <div
            className="absolute inset-0 rounded-full"
            style={{
              background: `conic-gradient(#3B82F6 0deg ${(s.inbound_calls || 0) / Math.max(1,total) * 360}deg, #8B5CF6 0deg ${((s.inbound_calls || 0) + (s.emails_received || 0)) / Math.max(1,total) * 360}deg, #EC4899 0deg ${((s.inbound_calls || 0) + (s.emails_received || 0) + (s.appointments_upcoming || 0)) / Math.max(1,total) * 360}deg, #06B6D4 0deg)`,
            }}
          />
          <div className="absolute inset-2 rounded-full bg-bg-card flex items-center justify-center">
            <div className="text-center">
              <div className="text-base font-bold text-text-primary">{total}</div>
              <div className="text-[8px] uppercase tracking-wider text-text-tertiary">total</div>
            </div>
          </div>
        </div>
      </div>
    </DashCard>
  );
}

// ────────────────────────────────────────────────────────────────
//  SUPER ADMIN CONSOLE (Phase 1/7 placeholder)
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
              <Badge variant="green"><CheckCircle2 size={11} /> Phase 1 — Auth opérationnelle</Badge>
              <Badge variant="green"><CheckCircle2 size={11} /> Phase 2A — KPIs + sparklines</Badge>
              <Badge variant="default"><Sparkles size={11} /> Phase 2B — Cards signature</Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" data-testid="admin-quick-stats">
        <Card><CardContent className="flex items-center gap-4 p-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand/15 text-brand"><Users size={18} /></div>
          <div><div className="text-2xl font-bold text-text-primary leading-none">—</div><div className="mt-1 text-[11px] text-text-tertiary">PMEs actives</div></div>
        </CardContent></Card>
        <Card><CardContent className="flex items-center gap-4 p-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-green/15 text-brand-green"><BookOpen size={18} /></div>
          <div><div className="text-2xl font-bold text-text-primary leading-none">—</div><div className="mt-1 text-[11px] text-text-tertiary">MRR (CAD)</div></div>
        </CardContent></Card>
        <Card><CardContent className="flex items-center gap-4 p-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-purple/15 text-brand-purple"><Phone size={18} /></div>
          <div><div className="text-2xl font-bold text-text-primary leading-none">—</div><div className="mt-1 text-[11px] text-text-tertiary">Appels traités (7j)</div></div>
        </CardContent></Card>
      </div>

      <Card><CardContent className="p-6">
        <h3 className="mb-4 text-[11px] font-semibold uppercase tracking-wider text-text-secondary">Feuille de route — prochaines phases</h3>
        <ul className="space-y-2.5">
          {[
            { tag: "✓ Phase 0",  label: "Setup Supabase + migrations", state: "done" },
            { tag: "✓ Phase 1",  label: "Auth opérationnelle", state: "done" },
            { tag: "✓ Phase 2A", label: "Dashboard PME — KPI row", state: "done" },
            { tag: "✓ Phase 2B", label: "Cards signature (light)", state: "done" },
            { tag: "Phase 3",    label: "CRM + Import CSV", state: "later" },
            { tag: "Phase 4",    label: "Calls + Emails (validation brouillons IA)", state: "later" },
          ].map((p, i) => (
            <li key={i} className="flex items-center gap-3 text-xs">
              <span className={cn(
                "inline-block min-w-[90px] rounded-md px-2 py-1 text-center text-[10px] font-semibold",
                p.state === "done"   ? "bg-brand-green/15 text-brand-green"
              : p.state === "active" ? "bg-brand/15 text-brand"
              : "bg-white/5 text-text-tertiary"
              )}>{p.tag}</span>
              <span className="text-text-secondary">{p.label}</span>
            </li>
          ))}
        </ul>
      </CardContent></Card>
    </div>
  );
}
