// ============================================================
// VOICEDESK IA — NOTIFICATION BELL
// Cloche avec badge de notifications non lues + dropdown
// ============================================================

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bell, X, Check } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext.jsx";

const API = import.meta.env.VITE_API_URL || "http://localhost:3000";

export default function NotificationBell() {
  const { t, i18n } = useTranslation();
  const { token } = useAuth();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const fetchUnreadCount = async () => {
    if (!token) return;
    try {
      const res = await fetch(`${API}/api/v1/notifications/unread-count`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setUnreadCount(data.unread_count || 0);
    } catch (e) { /* silencieux */ }
  };

  const fetchNotifications = async () => {
    if (!token) return;
    try {
      const res = await fetch(`${API}/api/v1/notifications?limit=10`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setNotifications(data.notifications || []);
    } catch (e) { /* silencieux */ }
  };

  const markAsRead = async (id) => {
    await fetch(`${API}/api/v1/notifications/${id}/read`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
    setUnreadCount(c => Math.max(0, c - 1));
  };

  const markAllAsRead = async () => {
    await fetch(`${API}/api/v1/notifications/mark-all-read`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    setUnreadCount(0);
  };

  // Polling toutes les 30 secondes
  useEffect(() => {
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 30000);
    return () => clearInterval(interval);
  }, [token]);

  useEffect(() => {
    if (open) fetchNotifications();
  }, [open]);

  const formatTime = (ts) => {
    const d = new Date(ts);
    return d.toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" });
  };

  return (
    <div className="notification-bell">
      <button className="bell-button" onClick={() => setOpen(!open)}>
        <Bell size={18} />
        {unreadCount > 0 && (
          <span className="bell-badge">{unreadCount > 99 ? "99+" : unreadCount}</span>
        )}
      </button>

      {open && (
        <>
          <div className="bell-backdrop" onClick={() => setOpen(false)} />
          <div className="bell-dropdown">
            <div className="bell-header">
              <h3>{t("notifications.title", "Notifications")}</h3>
              {unreadCount > 0 && (
                <button className="mark-all-btn" onClick={markAllAsRead}>
                  {t("notifications.markAllRead", "Tout marquer lu")}
                </button>
              )}
            </div>

            <div className="bell-list">
              {notifications.length === 0 ? (
                <div className="bell-empty">
                  {t("notifications.empty", "Aucune notification")}
                </div>
              ) : (
                notifications.map(n => (
                  <div
                    key={n.id}
                    className={"bell-item type-" + n.type + (n.read ? "" : " unread")}
                    onClick={() => {
                      if (!n.read) markAsRead(n.id);
                      if (n.link) window.location.href = n.link;
                    }}
                  >
                    <div className="bell-item-title">{n.title}</div>
                    {n.body && <div className="bell-item-body">{n.body}</div>}
                    <div className="bell-item-time">{formatTime(n.created_at)}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
