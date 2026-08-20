// ============================================================
// EXEVORI VOICE IA — TABLEAU DE BORD CLIENT
// Toutes les valeurs affichées proviennent de l'API dashboard.
// ============================================================

import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Bot,
  CalendarDays,
  Clock3,
  Gauge,
  Inbox,
  LifeBuoy,
  Phone,
  RefreshCw,
  ShieldCheck,
  Ticket,
  UserPlus,
  Users,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Card, CardContent } from "../components/ui/card.jsx";
import { cn } from "../lib/utils.js";

const API = import.meta.env.VITE_API_URL || "";

const ACTIVITY_META = {
  call_inbound: {
    icon: ArrowDownLeft,
    label: "Appel entrant",
    color: "bg-brand/15 text-brand",
    fallbackLink: "/calls",
  },
  call_outbound: {
    icon: ArrowUpRight,
    label: "Appel sortant",
    color: "bg-brand-purple/15 text-brand-purple",
    fallbackLink: "/calls",
  },
  appointment: {
    icon: CalendarDays,
    label: "Rendez-vous",
    color: "bg-brand-pink/15 text-brand-pink",
    fallbackLink: "/calendar",
  },
  contact: {
    icon: UserPlus,
    label: "Contact",
    color: "bg-brand-green/15 text-brand-green",
    fallbackLink: "/crm",
  },
  ticket: {
    icon: Ticket,
    label: "Ticket",
    color: "bg-brand-orange/15 text-brand-orange",
    fallbackLink: "/support",
  },
};

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number === null ? null : Math.max(0, number);
}

function formatCount(value) {
  const number = finiteNumber(value);
  return number === null ? "—" : new Intl.NumberFormat("fr-CA", { maximumFractionDigits: 0 }).format(number);
}

function formatCompactNumber(value) {
  const number = finiteNumber(value);
  return number === null
    ? "—"
    : new Intl.NumberFormat("fr-CA", { maximumFractionDigits: 1 }).format(number);
}

function formatMinutes(value) {
  const number = finiteNumber(value);
  return number === null ? "—" : `${formatCompactNumber(number)} min`;
}

function formatDuration(seconds) {
  const totalSeconds = nonNegativeNumber(seconds);
  if (totalSeconds === null) return "—";
  const rounded = Math.round(totalSeconds);
  if (rounded < 60) return `${rounded} s`;
  const minutes = Math.floor(rounded / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours} h` : `${hours} h ${remainingMinutes} min`;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = parseDate(value);
  return date
    ? date.toLocaleDateString("fr-CA", { day: "numeric", month: "short", year: "numeric" })
    : "—";
}

function formatTimestamp(value) {
  const date = parseDate(value);
  if (!date) return "date inconnue";
  return date.toLocaleString("fr-CA", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeStats(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const kpis = source.kpis && typeof source.kpis === "object" ? source.kpis : {};
  const calls = kpis.calls_7d && typeof kpis.calls_7d === "object" ? kpis.calls_7d : {};
  const roi = source.roi && typeof source.roi === "object" ? source.roi : {};
  const minutes = source.minutes && typeof source.minutes === "object" ? source.minutes : {};

  return {
    generatedAt: source.generated_at || null,
    windows: source.windows && typeof source.windows === "object" ? source.windows : {},
    calls: {
      total: nonNegativeNumber(calls.total),
      inbound: nonNegativeNumber(calls.inbound),
      outbound: nonNegativeNumber(calls.outbound),
    },
    appointmentsThisWeek: nonNegativeNumber(kpis.appointments_this_week),
    contactsCreated7d: nonNegativeNumber(kpis.contacts_created_7d),
    resolutionRate: nonNegativeNumber(kpis.ai_resolution_rate_pct),
    resolvedCalls: nonNegativeNumber(kpis.ai_resolved_calls_7d),
    eligibleCalls: nonNegativeNumber(kpis.ai_resolution_eligible_calls_7d),
    ticketsOpen: nonNegativeNumber(kpis.tickets_open),
    roi: {
      timeSavedSeconds: nonNegativeNumber(roi.time_saved_seconds),
      timeSavedHours: nonNegativeNumber(roi.time_saved_hours),
      calculation: typeof roi.calculation === "string" ? roi.calculation : null,
      transferTakeoverSeconds: nonNegativeNumber(roi.assumptions?.transfer_takeover_seconds),
    },
    minutes: {
      used: nonNegativeNumber(minutes.used),
      included: nonNegativeNumber(minutes.included),
      remaining: nonNegativeNumber(minutes.remaining),
      overage: nonNegativeNumber(minutes.overage),
      usagePct: nonNegativeNumber(minutes.usage_pct),
      periodStart: minutes.period_start || null,
      periodEnd: minutes.period_end || null,
    },
    hasActivity: typeof source.has_activity === "boolean" ? source.has_activity : null,
  };
}

function normalizeActivities(payload) {
  const activities = Array.isArray(payload?.activities) ? payload.activities : [];
  return activities.filter((activity) => activity && typeof activity === "object");
}

async function fetchJson(path, token, signal) {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok) {
    const error = new Error(`Requête dashboard refusée (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function PageMessage({ icon: Icon, title, description }) {
  return (
    <Card className="mx-auto max-w-2xl">
      <CardContent className="flex flex-col items-center px-6 py-12 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-orange/15 text-brand-orange">
          <Icon size={22} />
        </div>
        <h1 className="mt-4 text-lg font-semibold text-text-primary">{title}</h1>
        <p className="mt-2 max-w-lg text-sm text-text-secondary">{description}</p>
      </CardContent>
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────
//  ROOT
// ────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { t } = useTranslation();
  const { token, profile, effectiveCompanyId, impersonatedCompany } = useAuth();

  const [stats, setStats] = useState(null);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activityError, setActivityError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const isAdminConsole = profile?.role === "super_admin" && !impersonatedCompany;
  const companyName = impersonatedCompany?.name || profile?.company?.name || "";
  const companyCity = impersonatedCompany?.city || profile?.company?.city || "";
  const assistantName =
    impersonatedCompany?.assistant_name ||
    profile?.company?.assistant_name ||
    t("dashboard.assistant_fallback", "Votre assistante IA");

  const loadDashboard = useCallback(async (signal) => {
    if (!token || !effectiveCompanyId || isAdminConsole) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError("");
    setActivityError("");
    setStats(null);
    setActivity([]);

    const companyParam = encodeURIComponent(effectiveCompanyId);
    const [statsResult, activityResult] = await Promise.allSettled([
      fetchJson(`/api/v1/dashboard/stats?company_id=${companyParam}`, token, signal),
      fetchJson(`/api/v1/dashboard/activity?company_id=${companyParam}&limit=8`, token, signal),
    ]);

    if (signal.aborted) return;

    if (statsResult.status === "fulfilled") {
      setStats(normalizeStats(statsResult.value));
    } else {
      setStats(null);
      setError(
        statsResult.reason?.status === 401 || statsResult.reason?.status === 403
          ? "Vous n'avez pas accès aux données de cette entreprise."
          : "Le tableau de bord ne peut pas être chargé pour le moment."
      );
    }

    if (activityResult.status === "fulfilled") {
      setActivity(normalizeActivities(activityResult.value));
    } else {
      setActivity([]);
      setActivityError("Les dernières interactions sont temporairement indisponibles.");
    }

    setLoading(false);
  }, [effectiveCompanyId, isAdminConsole, token]);

  useEffect(() => {
    const controller = new AbortController();
    loadDashboard(controller.signal).catch((loadError) => {
      if (loadError?.name !== "AbortError") {
        setError("Le tableau de bord ne peut pas être chargé pour le moment.");
        setLoading(false);
      }
    });
    return () => controller.abort();
  }, [loadDashboard, refreshKey]);

  if (isAdminConsole) return <AdminConsole profile={profile} t={t} />;

  if (!effectiveCompanyId && !loading) {
    return (
      <PageMessage
        icon={AlertTriangle}
        title="Entreprise introuvable"
        description="Votre compte n'est associé à aucune entreprise. Contactez le support Exevori."
      />
    );
  }

  const isEmpty = !loading && !error && !activityError && stats?.hasActivity === false && activity.length === 0;

  return (
    <div className="space-y-6 animate-fade-in" data-testid="dashboard-pme">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          {(companyName || companyCity) && (
            <div className="mb-1.5 text-[11px] uppercase tracking-wider text-text-tertiary">
              {[companyName, companyCity].filter(Boolean).join(" — ")}
            </div>
          )}
          <h1 className="text-2xl font-bold tracking-tight text-text-primary" data-testid="dashboard-title">
            Tableau de bord de {assistantName}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            Activité réelle de votre assistante IA, sans données de démonstration.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {stats?.generatedAt && (
            <span className="hidden text-[11px] text-text-tertiary sm:inline">
              Mis à jour {formatTimestamp(stats.generatedAt)}
            </span>
          )}
          <button
            type="button"
            onClick={() => setRefreshKey((key) => key + 1)}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-bg-card px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="Actualiser le tableau de bord"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            Actualiser
          </button>
        </div>
      </div>

      {error && (
        <div className="flex flex-col gap-3 rounded-xl border border-brand-red/30 bg-brand-red/10 p-4 text-sm text-red-200 sm:flex-row sm:items-center sm:justify-between" role="alert">
          <span className="flex items-center gap-2">
            <AlertTriangle size={16} />
            {error}
          </span>
          <button
            type="button"
            onClick={() => setRefreshKey((key) => key + 1)}
            className="self-start text-xs font-semibold underline underline-offset-2 sm:self-auto"
          >
            Réessayer
          </button>
        </div>
      )}

      {isEmpty && (
        <Card className="border-dashed" data-testid="dashboard-empty">
          <CardContent className="flex flex-col items-center px-6 py-10 text-center">
            <Inbox size={28} className="text-text-tertiary" />
            <h2 className="mt-3 text-base font-semibold text-text-primary">Aucune activité</h2>
            <p className="mt-1 max-w-lg text-sm text-text-secondary">
              Les appels, rendez-vous, contacts et autres interactions apparaîtront ici dès qu'ils seront enregistrés.
            </p>
          </CardContent>
        </Card>
      )}

      <KpiGrid stats={stats} loading={loading} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <RoiCard roi={stats?.roi} loading={loading} />
        <MinutesUsageCard minutes={stats?.minutes} loading={loading} />
      </div>

      <RecentInteractions activities={activity} loading={loading} error={activityError} />
    </div>
  );
}

function KpiGrid({ stats, loading }) {
  const resolutionValue =
    stats?.eligibleCalls === 0 || stats?.eligibleCalls === null || stats?.eligibleCalls === undefined
      ? null
      : stats?.resolutionRate;

  const cards = [
    {
      testId: "kpi-calls-7d",
      icon: Phone,
      label: "Appels sur 7 jours",
      value: stats?.calls?.total,
      detail:
        stats?.calls?.inbound !== null && stats?.calls?.outbound !== null
          ? `${formatCount(stats.calls.inbound)} entrant(s) · ${formatCount(stats.calls.outbound)} sortant(s)`
          : "Entrants et sortants",
      color: "blue",
    },
    {
      testId: "kpi-appointments-week",
      icon: CalendarDays,
      label: "Rendez-vous cette semaine",
      value: stats?.appointmentsThisWeek,
      detail: "Planifiés pendant la semaine civile",
      color: "pink",
    },
    {
      testId: "kpi-contacts-created",
      icon: UserPlus,
      label: "Contacts créés",
      value: stats?.contactsCreated7d,
      detail: "Sur les 7 derniers jours",
      color: "purple",
    },
    {
      testId: "kpi-ai-resolution",
      icon: Bot,
      label: "Taux de résolution IA",
      value: resolutionValue,
      suffix: resolutionValue === null || resolutionValue === undefined ? "" : " %",
      detail:
        stats?.eligibleCalls === 0
          ? "Aucun appel admissible"
          : stats?.resolvedCalls !== null && stats?.eligibleCalls !== null
            ? `${formatCount(stats?.resolvedCalls)} résolu(s) sur ${formatCount(stats?.eligibleCalls)} admissible(s)`
            : "Appels résolus sans transfert",
      color: "cyan",
    },
    {
      testId: "kpi-tickets-open",
      icon: LifeBuoy,
      label: "Tickets ouverts",
      value: stats?.ticketsOpen,
      detail: "Ouverts, en cours ou en attente client",
      color: "orange",
      link: "/support",
    },
  ];

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5" data-testid="kpi-grid-loading">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="h-[148px] animate-pulse rounded-xl border border-border bg-bg-card" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5" data-testid="kpi-grid">
      {cards.map((card) => <MetricCard key={card.testId} {...card} />)}
    </div>
  );
}

function MetricCard({ testId, icon: Icon, label, value, suffix = "", detail, color, link }) {
  const colors = {
    blue: "bg-brand/15 text-brand",
    pink: "bg-brand-pink/15 text-brand-pink",
    purple: "bg-brand-purple/15 text-brand-purple",
    cyan: "bg-brand-cyan/15 text-brand-cyan",
    orange: "bg-brand-orange/15 text-brand-orange",
  };

  const content = (
    <Card className={cn("h-full", link && "transition-colors hover:border-border-strong")} data-testid={testId}>
      <CardContent className="p-5">
        <div className={cn("flex h-9 w-9 items-center justify-center rounded-lg", colors[color] || colors.blue)}>
          <Icon size={16} />
        </div>
        <div className="mt-3 text-3xl font-bold tracking-tight text-text-primary tabular-nums">
          {formatCount(value)}
          {value !== null && value !== undefined && suffix}
        </div>
        <div className="mt-0.5 text-xs font-medium text-text-secondary">{label}</div>
        <div className="mt-2 min-h-8 text-[11px] leading-4 text-text-tertiary">{detail}</div>
      </CardContent>
    </Card>
  );

  return link ? <Link to={link}>{content}</Link> : content;
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
//  ROI ET UTILISATION
// ────────────────────────────────────────────────────────────────

function RoiCard({ roi, loading }) {
  if (loading) {
    return <div className="h-[230px] animate-pulse rounded-xl border border-border bg-bg-card xl:col-span-3" />;
  }

  const savedSeconds = roi?.timeSavedSeconds;
  const calculation = roi?.calculation ||
    "Durée totale des appels sur 7 jours, moins 120 secondes de reprise humaine pour chaque appel transféré.";

  return (
    <DashCard
      title="ROI — temps économisé"
      icon={Clock3}
      accent="purple"
      testId="card-roi"
      className="xl:col-span-3"
      action={<Badge variant="outline">Estimation</Badge>}
    >
      <div className="flex h-full flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <div className="text-4xl font-bold tracking-tight text-text-primary tabular-nums" data-testid="roi-time-saved">
            {savedSeconds === null || savedSeconds === undefined ? "—" : formatDuration(savedSeconds)}
          </div>
          <div className="mt-1 text-sm text-text-secondary">économisé sur les 7 derniers jours</div>
        </div>
        <div className="max-w-xl rounded-lg border border-border bg-white/3 p-3 text-[11px] leading-5 text-text-tertiary">
          <span className="font-semibold text-text-secondary">Méthode de calcul : </span>
          {calculation}
          {roi?.transferTakeoverSeconds !== null && roi?.transferTakeoverSeconds !== undefined && (
            <span> Hypothèse de reprise : {formatDuration(roi.transferTakeoverSeconds)} par transfert.</span>
          )}
        </div>
      </div>
    </DashCard>
  );
}

function RecentInteractions({ activities, loading, error }) {
  return (
    <DashCard
      title="Dernières interactions"
      icon={Users}
      accent="blue"
      testId="card-recent-interactions"
      action={<span className="text-[11px] text-text-tertiary">8 plus récentes</span>}
    >
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="h-14 animate-pulse rounded-lg bg-white/5" />
          ))}
        </div>
      ) : error ? (
        <div className="flex min-h-24 items-center justify-center text-sm text-brand-orange" role="status">
          {error}
        </div>
      ) : activities.length === 0 ? (
        <EmptyState label="Aucune interaction récente" />
      ) : (
        <ul className="divide-y divide-border" data-testid="recent-interactions-list">
          {activities.map((activity, index) => (
            <RecentInteraction
              key={`${activity.type || "activity"}-${activity.id || activity.timestamp || index}`}
              activity={activity}
            />
          ))}
        </ul>
      )}
    </DashCard>
  );
}

function RecentInteraction({ activity }) {
  const meta = ACTIVITY_META[activity.type] || {
    icon: Inbox,
    label: "Interaction",
    color: "bg-white/5 text-text-secondary",
    fallbackLink: null,
  };
  const Icon = meta.icon;
  const link = typeof activity.link === "string" && activity.link.startsWith("/")
    ? activity.link
    : meta.fallbackLink;
  const content = (
    <div className="flex items-center gap-3 py-3">
      <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", meta.color)}>
        <Icon size={15} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
            {meta.label}
          </span>
          <span className="text-[10px] text-text-tertiary">{formatTimestamp(activity.timestamp)}</span>
        </div>
        <div className="truncate text-sm font-medium text-text-primary">{activity.title || meta.label}</div>
        {activity.description && (
          <div className="mt-0.5 truncate text-xs text-text-secondary">{activity.description}</div>
        )}
      </div>
      {activity.outcome && <OutcomeBadge outcome={activity.outcome} />}
      {link && <ArrowRight size={14} className="shrink-0 text-text-tertiary" />}
    </div>
  );

  return (
    <li>
      {link ? <Link to={link} className="block hover:bg-white/3">{content}</Link> : content}
    </li>
  );
}

function OutcomeBadge({ outcome }) {
  const outcomes = {
    resolved: { label: "Résolu", variant: "green" },
    appointment_booked: { label: "RDV pris", variant: "pink" },
    transferred: { label: "Transféré", variant: "orange" },
    completed: { label: "Terminé", variant: "outline" },
    open: { label: "Ouvert", variant: "orange" },
    in_progress: { label: "En cours", variant: "default" },
  };
  const meta = outcomes[outcome] || {
    label: String(outcome).replaceAll("_", " "),
    variant: "ghost",
  };
  return <Badge variant={meta.variant} className="hidden shrink-0 sm:inline-flex">{meta.label}</Badge>;
}

function MinutesUsageCard({ minutes, loading }) {
  if (loading) {
    return <div className="h-[230px] animate-pulse rounded-xl border border-border bg-bg-card xl:col-span-2" />;
  }

  const used = minutes?.used;
  const included = minutes?.included;
  const percentage =
    minutes?.usagePct !== null && minutes?.usagePct !== undefined
      ? minutes.usagePct
      : used !== null && used !== undefined && included > 0
        ? (used / included) * 100
        : null;
  const progressWidth = percentage === null ? 0 : Math.min(100, Math.max(0, percentage));
  const progressColor =
    percentage === null ? "bg-text-tertiary"
      : percentage >= 100 ? "bg-brand-red"
        : percentage >= 80 ? "bg-brand-orange"
          : "bg-brand";

  return (
    <DashCard
      title="Minutes et quota"
      icon={Gauge}
      accent="cyan"
      testId="card-minutes-usage"
      className="xl:col-span-2"
      action={<Link to="/billing" className="text-[11px] text-brand hover:underline">Facturation</Link>}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-bold tracking-tight text-text-primary tabular-nums">
          {formatMinutes(used)}
        </span>
        <span className="text-xs text-text-tertiary">
          / {included === null || included === undefined ? "—" : `${formatCompactNumber(included)} min`}
        </span>
      </div>

      <div
        className="mt-4 h-2 overflow-hidden rounded-full bg-white/5"
        role="progressbar"
        aria-label="Utilisation du quota de minutes"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentage === null ? undefined : Math.min(100, Math.round(percentage))}
      >
        <div
          className={cn("h-full rounded-full transition-[width]", progressColor)}
          style={{ width: `${progressWidth}%` }}
        />
      </div>

      <div className="mt-2 flex items-center justify-between text-[11px] text-text-tertiary">
        <span>{percentage === null ? "Quota indisponible" : `${Math.round(percentage)} % utilisé`}</span>
        <span>
          {minutes?.overage > 0
            ? `${formatCompactNumber(minutes.overage)} min en dépassement`
            : minutes?.remaining !== null && minutes?.remaining !== undefined
              ? `${formatCompactNumber(minutes.remaining)} min restantes`
              : ""}
        </span>
      </div>

      {(minutes?.periodStart || minutes?.periodEnd) && (
        <div className="mt-5 border-t border-border pt-3 text-[10px] text-text-tertiary">
          Période de facturation : {formatDate(minutes.periodStart)} — {formatDate(minutes.periodEnd)}
        </div>
      )}
    </DashCard>
  );
}

function AdminConsole({ profile, t }) {
  return (
    <div className="space-y-6 animate-fade-in" data-testid="dashboard-super-admin-entry">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-text-primary">
          {t("navigation.admin_dashboard", "Console Admin")}
        </h1>
        <p className="mt-1 text-sm text-text-secondary">
          {profile?.email}
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand-purple/15 text-brand-purple">
            <ShieldCheck size={22} />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold text-text-primary">Administration Exevori</h2>
            <p className="mt-1 text-sm text-text-secondary">
              Les indicateurs globaux et la gestion des entreprises sont disponibles dans la console dédiée.
            </p>
          </div>
          <Link
            to="/admin"
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            Ouvrir la console
            <ArrowRight size={14} />
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
