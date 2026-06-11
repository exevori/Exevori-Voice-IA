// ============================================================
// VOICEDESK IA — PAGE DASHBOARD
// ============================================================

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Phone, Mail, Calendar, Users, Bell, AlertTriangle, BookOpen } from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";

const API = import.meta.env.VITE_API_URL || "http://localhost:3000";

export default function Dashboard() {
  const { t } = useTranslation();
  const { token, profile } = useAuth();
  const [stats, setStats] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState("today");

  useEffect(() => {
    if (!token) return;
    loadData();
  }, [token, period]);

  const loadData = async () => {
    setLoading(true);
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [s, a, act] = await Promise.all([
        fetch(`${API}/api/v1/dashboard/stats?period=${period}`, { headers }).then(r => r.json()),
        fetch(`${API}/api/v1/dashboard/alerts`, { headers }).then(r => r.json()),
        fetch(`${API}/api/v1/dashboard/activity?limit=10`, { headers }).then(r => r.json()),
      ]);
      setStats(s.kpis);
      setAlerts(a.alerts || []);
      setActivity(act.activities || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="page-loading">{t("common.loading")}</div>;

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
    <div className="dashboard">
      <div className="page-header">
        <div>
          <h1>{t("dashboard.title")}</h1>
          <p className="subtitle">{t("dashboard.subtitle")} — {profile?.companies?.name}</p>
        </div>

        <div className="period-selector">
          {["today", "week", "month"].map(p => (
            <button
              key={p}
              className={"period-btn" + (period === p ? " active" : "")}
              onClick={() => setPeriod(p)}
            >
              {t("common." + (p === "today" ? "today" : p === "week" ? "thisWeek" : "thisMonth"))}
            </button>
          ))}
        </div>
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="alerts-section">
          {alerts.map((alert, i) => (
            <div key={i} className={"alert-card severity-" + alert.severity}>
              <AlertTriangle size={18} />
              <div className="alert-content">
                <div className="alert-title">{alert.title}</div>
              </div>
              {alert.link && (
                <a href={alert.link} className="alert-action">{alert.action} →</a>
              )}
            </div>
          ))}
        </div>
      )}

      {/* KPIs */}
      <div className="kpi-grid">
        {kpiCards.map(card => (
          <div key={card.key} className={"kpi-card color-" + card.color}>
            <card.icon size={20} />
            <div className="kpi-value">{card.value || 0}</div>
            <div className="kpi-label">{t("dashboard.kpis." + card.key)}</div>
          </div>
        ))}
      </div>

      {/* Activité récente */}
      <div className="dashboard-section">
        <h2>{t("dashboard.todayActivity")}</h2>
        <div className="activity-list">
          {activity.length === 0 ? (
            <p className="empty-state">{t("common.none")}</p>
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
