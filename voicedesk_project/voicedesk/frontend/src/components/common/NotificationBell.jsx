// ============================================================
// EXEVORI VOICE IA — NOTIFICATION BELL (Tailwind)
// ============================================================

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bell, CheckCheck } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext.jsx";

const API = import.meta.env.VITE_API_URL || "";

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
      if (res.ok) {
        const data = await res.json();
        setUnreadCount(data.unread_count || 0);
      }
    } catch {}
  };

  const fetchNotifications = async () => {
    if (!token) return;
    try {
      const res = await fetch(`${API}/api/v1/notifications?limit=10`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.notifications || []);
      }
    } catch {}
  };

  const markAllAsRead = async () => {
    await fetch(`${API}/api/v1/notifications/mark-all-read`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnreadCount(0);
  };

  useEffect(() => {
    fetchUnreadCount();
    const id = setInterval(fetchUnreadCount, 30000);
    return () => clearInterval(id);
  }, [token]);

  useEffect(() => { if (open) fetchNotifications(); }, [open]);

  return (
    <div className="relative">
      <button
        data-testid="notification-bell"
        onClick={() => setOpen(!open)}
        className="relative rounded-lg p-2 text-text-secondary hover:text-text-primary hover:bg-white/5 transition-colors"
        aria-label="Notifications"
      >
        <Bell size={16} />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-brand-red px-1 text-[9px] font-semibold text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            data-testid="notification-dropdown"
            className="absolute right-0 top-full z-40 mt-2 w-80 origin-top-right rounded-xl border border-border bg-bg-elevated/95 backdrop-blur-xl shadow-2xl animate-fade-in"
          >
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <h3 className="text-xs font-semibold text-text-primary">
                {t("notifications.title", "Notifications")}
              </h3>
              {unreadCount > 0 && (
                <button
                  onClick={markAllAsRead}
                  className="flex items-center gap-1 text-[11px] text-brand hover:underline"
                >
                  <CheckCheck size={12} />
                  {t("notifications.markAllRead", "Tout marquer lu")}
                </button>
              )}
            </div>
            <div className="max-h-80 overflow-y-auto py-1">
              {notifications.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-text-tertiary">
                  {t("notifications.empty", "Aucune notification")}
                </div>
              ) : (
                notifications.map((n) => (
                  <div
                    key={n.id}
                    className={`mx-1 my-0.5 cursor-pointer rounded-md px-3 py-2 transition-colors hover:bg-white/5 ${
                      !n.read ? "border-l-2 border-brand-purple bg-white/3" : ""
                    }`}
                    onClick={() => n.link && (window.location.href = n.link)}
                  >
                    <div className="text-xs font-medium text-text-primary">{n.title}</div>
                    {n.body && <div className="mt-0.5 text-[11px] text-text-secondary">{n.body}</div>}
                    <div className="mt-1 text-[10px] text-text-tertiary">
                      {new Date(n.created_at).toLocaleString(i18n.language === "fr" ? "fr-CA" : "en-CA", { dateStyle: "short", timeStyle: "short" })}
                    </div>
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
