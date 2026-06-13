// ============================================================
// EXEVORI VOICE IA — REPORTS PAGE (Phase Reports+A)
// /analytics — Dashboard ROI détaillé pour la PME
//
// Layout:
//   - Period selector (today/week/month/year)
//   - 4 KPI cards (Total handled / Appointments / Time saved / Recovery rate)
//   - TimeSavedCard (Avant/Après détaillé)
//   - Sparkline série temporelle (Tremor LineChart)
//   - Breakdown détaillé du calcul time_saved
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BarChart3, Phone, Calendar, Clock, Target, Loader2, Sparkles, ArrowRight, Mail, RefreshCcw,
  FileText, FileSpreadsheet,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { LineChart } from "@tremor/react";
import { cn } from "../lib/utils.js";
import TimeSavedCard from "../components/dashboard/TimeSavedCard.jsx";

const API = import.meta.env.VITE_API_URL || "";

const PERIODS = [
  { key: "today", labelKey: "reports.period.today", fallback: "Aujourd'hui" },
  { key: "week",  labelKey: "reports.period.week",  fallback: "7 jours" },
  { key: "month", labelKey: "reports.period.month", fallback: "Ce mois-ci" },
  { key: "year",  labelKey: "reports.period.year",  fallback: "Cette année" },
];

export default function Reports() {
  const { t, i18n } = useTranslation();
  const { token, effectiveCompanyId, profile, impersonatedCompany } = useAuth();
  const [period, setPeriod] = useState("week");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const companyName = impersonatedCompany?.name || profile?.company?.name;

  const fetchSummary = () => {
    if (!token || !effectiveCompanyId) { setLoading(false); return; }
    setLoading(true);
    fetch(`${API}/api/v1/reports/summary?company_id=${effectiveCompanyId}&period=${period}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then(setData)
      .catch((e) => console.error("[Reports] summary:", e))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchSummary(); /* eslint-disable-next-line */ }, [token, effectiveCompanyId, period]);

  const kpis = data?.kpis;
  const ts   = data?.time_saved;
  const series = data?.series || [];
  const counts = data?.counts || {};

  // Format série pour Tremor
  const chartData = useMemo(() => series.map((s) => ({
    t: shortLabel(s.t, i18n.language),
    [t("reports.chart.calls", "Appels")]:   s.calls,
    [t("reports.chart.emails", "Courriels")]: s.emails,
  })), [series, t, i18n.language]);

  return (
    <div className="space-y-5 animate-fade-in" data-testid="reports-page">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-tertiary mb-1">
            <BarChart3 size={11} /> {t("reports.kicker", "Statistiques & ROI")}
            {companyName && <span className="ml-1 text-text-tertiary/70">· {companyName}</span>}
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary" data-testid="reports-title">
            {t("reports.title", "Votre rapport d'impact")}
          </h1>
          <p className="mt-1 text-sm text-text-secondary" data-testid="reports-subtitle">
            {t("reports.subtitle", "Mesurez l'impact réel de votre assistante sur votre quotidien.")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PeriodSelector value={period} onChange={setPeriod} t={t} />
          <ExportButtons token={token} companyId={effectiveCompanyId} period={period} t={t} />
          <button
            onClick={fetchSummary}
            data-testid="reports-refresh"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-bg-card text-text-secondary hover:text-text-primary transition-colors"
            title={t("common.refresh", "Actualiser")}
          >
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCcw size={13} />}
          </button>
        </div>
      </div>

      {/* 4 KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="reports-kpi-grid">
        <KpiCard
          icon={Sparkles} label={t("reports.kpi.handled", "Interactions gérées")}
          value={kpis?.total_handled ?? 0} suffix=""
          hint={t("reports.kpi.handledHint", "{{c}} appels · {{e}} courriels", { c: counts.calls ?? 0, e: counts.emails ?? 0 })}
          loading={loading} testId="kpi-handled" color="purple"
        />
        <KpiCard
          icon={Calendar} label={t("reports.kpi.appointments", "Rendez-vous pris")}
          value={kpis?.appointments_booked ?? 0}
          hint={t("reports.kpi.appointmentsHint", "via appels + courriels")}
          loading={loading} testId="kpi-appointments" color="blue"
        />
        <KpiCard
          icon={Clock} label={t("reports.kpi.timeSaved", "Temps économisé")}
          value={formatDuration(kpis?.time_saved_seconds ?? 0)} isText
          hint={ts?.saved_cad ? `≈ ${ts.saved_cad.toFixed(0)} $ CAD` : ""}
          loading={loading} testId="kpi-time-saved" color="green"
        />
        <KpiCard
          icon={Target} label={t("reports.kpi.recovery", "Taux de récupération")}
          value={`${kpis?.recovery_rate_pct ?? 0}%`} isText
          hint={t("reports.kpi.recoveryHint", "Demandes traitées avec succès")}
          loading={loading} testId="kpi-recovery" color="pink"
        />
      </div>

      {/* TimeSavedCard détaillée */}
      <TimeSavedCard token={token} companyId={effectiveCompanyId} period={period} />

      {/* Chart série temporelle */}
      <div className="rounded-xl border border-border bg-bg-card/60 backdrop-blur-sm p-5" data-testid="reports-chart-card">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">{t("reports.chart.title", "Volume d'activité")}</h3>
            <p className="text-[11px] text-text-tertiary">{t("reports.chart.subtitle", "Appels et courriels gérés par Léa")}</p>
          </div>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 py-12 justify-center text-xs text-text-tertiary">
            <Loader2 size={14} className="animate-spin" /> {t("common.loading", "Chargement…")}
          </div>
        ) : chartData.length === 0 ? (
          <div className="rounded-md border border-border bg-white/3 p-4 text-center text-xs text-text-secondary" data-testid="reports-chart-empty">
            {t("reports.chart.empty", "Aucune donnée pour cette période.")}
          </div>
        ) : (
          <LineChart
            data={chartData}
            index="t"
            categories={[t("reports.chart.calls", "Appels"), t("reports.chart.emails", "Courriels")]}
            colors={["purple", "cyan"]}
            yAxisWidth={28}
            showLegend={true}
            className="h-56"
          />
        )}
      </div>

      {/* Breakdown du calcul */}
      {ts && ts.saved_seconds > 0 && (
        <div className="rounded-xl border border-border bg-bg-card/60 backdrop-blur-sm p-5" data-testid="reports-breakdown-card">
          <h3 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
            <BarChart3 size={14} className="text-text-tertiary" />
            {t("reports.breakdown.title", "Détail du calcul")}
          </h3>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <BreakdownRow
              icon={Phone} label={t("reports.breakdown.calls", "Durée des appels")}
              value={formatDuration(ts.breakdown.calls_seconds)} testId="bk-calls"
            />
            <BreakdownRow
              icon={Mail} label={t("reports.breakdown.emails", "Équivalent emails (3 min/email)")}
              value={formatDuration(ts.breakdown.emails_seconds_equivalent)} testId="bk-emails"
            />
            <BreakdownRow
              icon={Calendar} label={t("reports.breakdown.appointments", "Prise de RDV (5 min/RDV)")}
              value={formatDuration(ts.breakdown.appointments_seconds_equiv)} testId="bk-appts"
            />
            <BreakdownRow
              icon={Clock} label={t("reports.breakdown.draftsAndTransfers", "Validations + transferts (à votre charge)")}
              value={`− ${formatDuration(ts.breakdown.drafts_validated_seconds + ts.breakdown.transfers_seconds)}`}
              testId="bk-overhead" negative
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Subcomponents ─────────────────────────────────────────────
// ─── Subcomponents ─────────────────────────────────────────────
function ExportButtons({ token, companyId, period, t }) {
  const [busy, setBusy] = useState(null); // "csv" | "pdf" | null

  const doDownload = async (format) => {
    if (!token || !companyId) return;
    setBusy(format);
    try {
      const url = `${API}/api/v1/reports/export/${format}?company_id=${companyId}&period=${period}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      const blobUrl = URL.createObjectURL(blob);
      // Récupère le nom de fichier du header Content-Disposition
      const cd = r.headers.get("content-disposition") || "";
      const m = /filename="?([^";]+)"?/.exec(cd);
      const fname = m ? m[1] : `exevori-rapport-${period}.${format}`;
      const a = document.createElement("a");
      a.href = blobUrl; a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(blobUrl);
    } catch (e) {
      alert(t("reports.export.error", "Échec export") + " : " + e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="inline-flex rounded-lg border border-border bg-bg-card p-0.5" data-testid="reports-export-buttons">
      <button
        onClick={() => doDownload("csv")}
        disabled={!!busy}
        data-testid="export-csv-button"
        className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
        title={t("reports.export.csvTooltip", "Télécharger CSV (Excel)")}
      >
        {busy === "csv" ? <Loader2 size={12} className="animate-spin" /> : <FileSpreadsheet size={12} />}
        CSV
      </button>
      <button
        onClick={() => doDownload("pdf")}
        disabled={!!busy}
        data-testid="export-pdf-button"
        className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
        title={t("reports.export.pdfTooltip", "Télécharger PDF")}
      >
        {busy === "pdf" ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />}
        PDF
      </button>
    </div>
  );
}

function PeriodSelector({ value, onChange, t }) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-bg-card p-0.5" data-testid="reports-period-selector">
      {PERIODS.map((p) => (
        <button
          key={p.key}
          onClick={() => onChange(p.key)}
          data-testid={`reports-period-${p.key}`}
          className={cn(
            "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
            value === p.key
              ? "bg-white/8 text-text-primary shadow-sm"
              : "text-text-secondary hover:text-text-primary"
          )}
        >
          {t(p.labelKey, p.fallback)}
        </button>
      ))}
    </div>
  );
}

function KpiCard({ icon: Icon, label, value, suffix, hint, isText, loading, testId, color }) {
  const colorMap = {
    purple: "from-brand-purple/15 to-brand-purple/5 border-brand-purple/30 text-brand-purple",
    blue:   "from-cyan-500/15 to-cyan-500/5 border-cyan-500/30 text-cyan-300",
    green:  "from-emerald-500/15 to-emerald-500/5 border-emerald-500/30 text-emerald-300",
    pink:   "from-pink-500/15 to-pink-500/5 border-pink-500/30 text-pink-300",
  };
  return (
    <div
      className={cn(
        "rounded-xl border bg-gradient-to-br backdrop-blur-sm p-4",
        colorMap[color] || colorMap.purple
      )}
      data-testid={testId}
    >
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider mb-1.5 opacity-80">
        <Icon size={11} /> {label}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-2xl font-bold text-text-primary tabular-nums">
          {loading ? <Loader2 size={18} className="animate-spin" /> : (isText ? value : value)}
        </span>
        {suffix && <span className="text-xs text-text-tertiary">{suffix}</span>}
      </div>
      {hint && <div className="mt-1 text-[10px] text-text-tertiary truncate">{hint}</div>}
    </div>
  );
}

function BreakdownRow({ icon: Icon, label, value, testId, negative }) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-md border border-border bg-white/3 px-3 py-2",
        negative && "border-amber-500/30 bg-amber-500/5"
      )}
      data-testid={testId}
    >
      <div className="flex items-center gap-2 text-xs text-text-secondary min-w-0">
        <Icon size={12} className={negative ? "text-amber-300" : "text-text-tertiary"} />
        <span className="truncate">{label}</span>
      </div>
      <span className={cn(
        "font-mono text-xs tabular-nums",
        negative ? "text-amber-300" : "text-text-primary"
      )}>
        {value}
      </span>
    </div>
  );
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem === 0 ? `${h} h` : `${h} h ${String(rem).padStart(2, "0")}`;
}

function shortLabel(t, lang) {
  // t is like "2026-06-13" or "2026-06-13T14:00" or "2026-06"
  if (!t) return "—";
  if (/^\d{4}-\d{2}$/.test(t)) {
    const [y, m] = t.split("-");
    return `${m}/${y.slice(2)}`;
  }
  if (/T\d{2}:\d{2}$/.test(t)) {
    return t.split("T")[1];
  }
  const [y, m, d] = t.split("-");
  return `${d}/${m}`;
}
