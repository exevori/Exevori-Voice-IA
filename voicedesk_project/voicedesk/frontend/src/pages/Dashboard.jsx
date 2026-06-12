// ============================================================
// EXEVORI VOICE IA — PAGE DASHBOARD
// Phase 1 : version safe (super_admin welcome + PME stats si applicable)
// Phase 2 : design complet avec KPI cards + Assistant Profile + ...
// ============================================================

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Phone, Mail, Calendar, Users, AlertTriangle, BookOpen,
  Sparkles, ShieldCheck, ArrowRight, Clock,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";

const API = import.meta.env.VITE_API_URL || "";

export default function Dashboard() {
  const { t } = useTranslation();
  const { token, profile } = useAuth();
  const [stats, setStats] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState("today");
  const [statsError, setStatsError] = useState(null);

  const isSuperAdmin = profile?.role === "super_admin";

  useEffect(() => {
    if (!token) return;
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, period]);

  const loadData = async () => {
    setLoading(true);
    setStatsError(null);
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [sRes, aRes, actRes] = await Promise.all([
        fetch(`${API}/api/v1/dashboard/stats?period=${period}`, { headers }),
        fetch(`${API}/api/v1/dashboard/alerts`, { headers }),
        fetch(`${API}/api/v1/dashboard/activity?limit=10`, { headers }),
      ]);

      if (sRes.ok) {
        const s = await sRes.json();
        setStats(s.kpis || null);
      } else {
        setStatsError((await sRes.json().catch(() => ({}))).error || "stats_unavailable");
      }
      if (aRes.ok) setAlerts((await aRes.json()).alerts || []);
      if (actRes.ok) setActivity((await actRes.json()).activities || []);
    } catch (err) {
      console.error("[Dashboard] load error:", err);
      setStatsError("network_error");
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="page-loading" data-testid="dashboard-loading">
        {t("common.loading")}
      </div>
    );
  }

  // ── SUPER ADMIN — placeholder Phase 1 (Phase 7 = vrai admin dashboard) ──
  if (isSuperAdmin) {
    return (
      <div className="dashboard super-admin" data-testid="dashboard-super-admin">
        <div className="page-header">
          <div>
            <h1 data-testid="dashboard-title">{t("navigation.admin_dashboard", "Console Admin")}</h1>
            <p className="subtitle">
              {t("dashboard.subtitle", "Vue d'ensemble Exevori")} — {profile?.email}
            </p>
          </div>
        </div>

        <div className="admin-welcome-card" data-testid="admin-welcome-card">
          <div className="admin-welcome-icon">
            <ShieldCheck size={28} />
          </div>
          <div className="admin-welcome-body">
            <h2>Bienvenue, {profile?.full_name || "Super Admin"}</h2>
            <p>
              Vous êtes connecté en tant que <strong>super_admin</strong>. La console
              d'administration complète (gestion PMEs, facturation globale, configuration
              voix) sera disponible en <strong>Phase 7</strong>.
            </p>
            <div className="admin-welcome-meta">
              <div className="meta-pill">
                <Sparkles size={14} />
                <span>Phase 1 — Auth opérationnelle</span>
              </div>
              <div className="meta-pill">
                <Clock size={14} />
                <span>Prochaine étape : Dashboard PME (Phase 2)</span>
              </div>
            </div>
          </div>
        </div>

        <div className="admin-quick-stats" data-testid="admin-quick-stats">
          <div className="quick-stat" data-testid="quick-stat-companies">
            <div className="quick-stat-icon" style={{ background: "rgba(59,130,246,0.12)", color: "var(--primary)" }}>
              <Users size={18} />
            </div>
            <div>
              <div className="quick-stat-value">—</div>
              <div className="quick-stat-label">PMEs actives</div>
            </div>
          </div>
          <div className="quick-stat" data-testid="quick-stat-revenue">
            <div className="quick-stat-icon" style={{ background: "rgba(16,185,129,0.12)", color: "var(--green)" }}>
              <BookOpen size={18} />
            </div>
            <div>
              <div className="quick-stat-value">—</div>
              <div className="quick-stat-label">MRR (CAD)</div>
            </div>
          </div>
          <div className="quick-stat" data-testid="quick-stat-calls">
            <div className="quick-stat-icon" style={{ background: "rgba(139,92,246,0.12)", color: "var(--purple)" }}>
              <Phone size={18} />
            </div>
            <div>
              <div className="quick-stat-value">—</div>
              <div className="quick-stat-label">Appels traités (7j)</div>
            </div>
          </div>
        </div>

        <div className="admin-roadmap" data-testid="admin-roadmap">
          <h3>Feuille de route — prochaines phases</h3>
          <ul>
            <li><span className="phase-tag done">✓ Phase 0</span> Setup Supabase + migrations + seed</li>
            <li><span className="phase-tag active">→ Phase 1</span> Auth opérationnelle (en cours)</li>
            <li><span className="phase-tag">Phase 2</span> Dashboard PME complet (KPI + sparklines + Assistant Profile)</li>
            <li><span className="phase-tag">Phase 3</span> CRM + Import CSV</li>
            <li><span className="phase-tag">Phase 4</span> Calls + Emails (validation brouillons IA)</li>
          </ul>
        </div>
      </div>
    );
  }

  // ── COMPANY USER / ADMIN — Phase 2 stub (sera étoffé en Phase 2) ──
  const kpiCards = stats ? [
    { key: "inboundCalls", icon: Phone, value: stats.inbound_calls, color: "blue" },
    { key: "totalMinutes", icon: Phone, value: stats.total_minutes, color: "cyan" },
    { key: "emailsReceived", icon: Mail, value: stats.emails_received, color: "purple" },
    { key: "draftsPending", icon: Mail, value: stats.drafts_pending, color: "orange" },
    { key: "appointmentsUpcoming", icon: Calendar, value: stats.appointments_upcoming, color: "pink" },
    { key: "hotLeads", icon: Users, value: stats.hot_leads, color: "red" },
    { key: "knowledgeBaseSize", icon: BookOpen, value: stats.knowledge_base_size, color: "green" },
  ] : [];

  return (
    <div className="dashboard" data-testid="dashboard-pme">
      <div className="page-header">
        <div>
          <h1>{t("dashboard.title", "Tableau de bord")}</h1>
          <p className="subtitle">
            {t("dashboard.subtitle", "Vue d'ensemble")} — {profile?.company?.name || profile?.companies?.name}
          </p>
        </div>

        <div className="period-selector">
          {["today", "week", "month"].map(p => (
            <button
              key={p}
              className={"period-btn" + (period === p ? " active" : "")}
              onClick={() => setPeriod(p)}
              data-testid={`period-btn-${p}`}
            >
              {t("common." + (p === "today" ? "today" : p === "week" ? "thisWeek" : "thisMonth"))}
            </button>
          ))}
        </div>
      </div>

      {statsError && (
        <div className="alert-card severity-low" data-testid="dashboard-warning">
          <AlertTriangle size={18} />
          <div className="alert-content">
            <div className="alert-title">
              Les statistiques détaillées arriveront en Phase 2.
            </div>
          </div>
        </div>
      )}

      {alerts.length > 0 && (
        <div className="alerts-section">
          {alerts.map((alert, i) => (
            <div key={i} className={"alert-card severity-" + alert.severity}>
              <AlertTriangle size={18} />
              <div className="alert-content">
                <div className="alert-title">{alert.title}</div>
              </div>
              {alert.link && (
                <a href={alert.link} className="alert-action">
                  {alert.action} <ArrowRight size={12} />
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      {kpiCards.length > 0 && (
        <div className="kpi-grid">
          {kpiCards.map(card => (
            <div key={card.key} className={"kpi-card color-" + card.color}>
              <card.icon size={20} />
              <div className="kpi-value">{card.value ?? 0}</div>
              <div className="kpi-label">{t("dashboard.kpis." + card.key, card.key)}</div>
            </div>
          ))}
        </div>
      )}

      <div className="dashboard-section">
        <h2>{t("dashboard.todayActivity", "Activité récente")}</h2>
        <div className="activity-list">
          {activity.length === 0 ? (
            <p className="empty-state">{t("common.none", "Aucune activité pour le moment")}</p>
          ) : (
            activity.map((item, i) => (
              <div key={i} className="activity-item">
                <span className="activity-icon">{item.icon}</span>
                <div className="activity-content">
                  <div className="activity-title">{item.title}</div>
                  {item.description && <div className="activity-desc">{item.description}</div>}
                </div>
                <div className="activity-time">
                  {new Date(item.timestamp).toLocaleString()}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
