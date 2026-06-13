// ============================================================
// EXEVORI VOICE IA — TimeSavedCard (Phase Reports+A)
//
// Carte "Avant/Après Léa" affichée sur le Dashboard principal.
// Réutilise GET /api/v1/reports/summary.
//
// Démo immobilier: argument WOW vente — "Sans Léa: 5h48 →
// Avec Léa: 14min → Vous économisez 5h34 et 195$ cette semaine"
// ============================================================

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Clock, TrendingUp, ArrowRight, Sparkles, Loader2 } from "lucide-react";

const API = import.meta.env.VITE_API_URL || "";

export default function TimeSavedCard({ token, companyId, period = "week" }) {
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token || !companyId) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    fetch(`${API}/api/v1/reports/summary?company_id=${companyId}&period=${period}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((d) => { if (alive) setData(d); })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [token, companyId, period]);

  const ts = data?.time_saved;
  const periodLabel = data?.period?.label || t("reports.period.week", "7 derniers jours");

  return (
    <div
      className="relative overflow-hidden rounded-xl border border-brand-green/30 bg-gradient-to-br from-brand-green/10 via-bg-card/60 to-bg-card/40 backdrop-blur-sm p-5"
      data-testid="time-saved-card"
    >
      {/* Decorative glow */}
      <div className="pointer-events-none absolute -right-20 -top-20 h-44 w-44 rounded-full bg-emerald-500/20 blur-3xl" />

      <div className="relative flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-300">
            <Sparkles size={14} />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary">
              {t("reports.timeSaved.kicker", "Votre ROI")}
            </div>
            <h3 className="text-sm font-semibold text-text-primary">
              {t("reports.timeSaved.title", "Temps économisé grâce à votre IA")}
            </h3>
          </div>
        </div>
        <span className="text-[10px] text-text-tertiary uppercase tracking-wider" data-testid="time-saved-period">
          {periodLabel}
        </span>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-xs text-text-tertiary">
          <Loader2 size={14} className="animate-spin" /> {t("common.loading", "Chargement…")}
        </div>
      ) : !ts || ts.saved_seconds === 0 ? (
        <div className="rounded-md border border-border bg-white/3 p-3 text-xs text-text-secondary" data-testid="time-saved-empty">
          {t("reports.timeSaved.empty", "Aucune activité sur cette période. Léa vous attend !")}
        </div>
      ) : (
        <>
          {/* Avant / Après */}
          <div className="grid grid-cols-2 gap-2 mb-3">
            <div className="rounded-md border border-border bg-white/3 p-2.5" data-testid="time-saved-sans">
              <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1">
                {t("reports.timeSaved.sansLea", "Sans Léa")}
              </div>
              <div className="font-mono text-lg font-bold text-text-secondary line-through decoration-red-400/50 decoration-2 tabular-nums">
                {formatDuration(ts.sans_lea_seconds)}
              </div>
            </div>
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2.5" data-testid="time-saved-avec">
              <div className="text-[10px] uppercase tracking-wider text-emerald-300/80 mb-1">
                {t("reports.timeSaved.avecLea", "Avec Léa")}
              </div>
              <div className="font-mono text-lg font-bold text-emerald-200 tabular-nums">
                {formatDuration(ts.avec_lea_seconds)}
              </div>
            </div>
          </div>

          {/* Saved big number */}
          <div className="rounded-md bg-gradient-to-r from-emerald-500/15 to-emerald-500/5 border border-emerald-500/30 p-3 mb-2">
            <div className="flex items-end justify-between gap-2">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-emerald-300/80 mb-0.5">
                  {t("reports.timeSaved.youSave", "Vous économisez")}
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-3xl font-bold text-emerald-200 tabular-nums" data-testid="time-saved-amount">
                    {formatDuration(ts.saved_seconds)}
                  </span>
                  {ts.saved_cad > 0 && (
                    <span className="text-sm text-emerald-300/80 tabular-nums" data-testid="time-saved-cad">
                      ≈ {ts.saved_cad.toFixed(0)} $ CAD
                    </span>
                  )}
                </div>
              </div>
              <TrendingUp size={28} className="text-emerald-300/60" />
            </div>
            <div className="mt-1.5 text-[10px] text-text-tertiary">
              {t("reports.timeSaved.hourlyRate", "Calculé à {{rate}} $/h", { rate: ts.hourly_rate_cad })}
            </div>
          </div>

          <Link
            to="/analytics"
            className="inline-flex items-center gap-1 text-[11px] text-text-secondary hover:text-emerald-300 transition-colors"
            data-testid="time-saved-link-details"
          >
            {t("reports.timeSaved.seeMore", "Voir le rapport détaillé")}
            <ArrowRight size={11} />
          </Link>
        </>
      )}
    </div>
  );
}

// Formatte X seconds → "5 h 48" ou "14 min" ou "47 s"
function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem === 0 ? `${h} h` : `${h} h ${String(rem).padStart(2, "0")}`;
}
