// ============================================================
// VOICEDESK IA — LAYOUT PRINCIPAL
// Sidebar + Header avec switcher langue + notifications
// ============================================================

import React from "react";
import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard, Phone, Mail, Calendar, Users, BookOpen,
  Settings, LifeBuoy, BarChart3, Brain, LogOut, Bell,
} from "lucide-react";
import LanguageSwitcher from "../common/LanguageSwitcher.jsx";
import NotificationBell from "../common/NotificationBell.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";

const NAV_ITEMS = [
  { path: "/dashboard",   icon: LayoutDashboard, key: "dashboard" },
  { path: "/calls",       icon: Phone,           key: "calls" },
  { path: "/outbound",    icon: Phone,           key: "outbound" },
  { path: "/emails",      icon: Mail,            key: "emails" },
  { path: "/crm",         icon: Users,           key: "crm" },
  { path: "/calendar",    icon: Calendar,        key: "calendar" },
  { path: "/knowledge",   icon: BookOpen,        key: "knowledge" },
  { path: "/analytics",   icon: BarChart3,       key: "analytics", role: "company_admin" },
  { path: "/config",      icon: Settings,        key: "config" },
  { path: "/support",     icon: LifeBuoy,        key: "support" },
];

const ADMIN_NAV_ITEMS = [
  { path: "/admin",          icon: Brain, key: "admin_dashboard" },
  { path: "/admin/clients",  icon: Users, key: "admin_clients" },
];

export default function Layout() {
  const { t } = useTranslation();
  const { user, profile, signOut } = useAuth();
  const navigate = useNavigate();

  const isAdmin = profile?.role === "super_admin";
  const navItems = isAdmin ? ADMIN_NAV_ITEMS : NAV_ITEMS;

  const handleSignOut = async () => {
    await signOut();
    navigate("/login");
  };

  return (
    <div className="layout">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <img
            src="/branding/exevori-logo.png"
            alt="Exevori"
            className="brand-logo-img"
          />
          <div>
            <div className="brand-title">EXEVORI</div>
            <div className="brand-subtitle">VOICE IA</div>
          </div>
        </div>

        <nav className="sidebar-nav">
          {navItems
            .filter(item => !item.role || profile?.role === item.role || isAdmin)
            .map(item => (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) => "nav-link" + (isActive ? " active" : "")}
              >
                <item.icon size={18} />
                <span>{t(`navigation.${item.key}`)}</span>
              </NavLink>
            ))}
        </nav>

        <div className="sidebar-footer">
          <div className="user-info">
            <div className="user-avatar">{(profile?.full_name || "?")[0]}</div>
            <div>
              <div className="user-name">{profile?.full_name}</div>
              <div className="user-role">{profile?.role}</div>
            </div>
          </div>
          <button onClick={handleSignOut} className="sign-out-btn" title={t("common.logout")}>
            <LogOut size={16} />
          </button>
        </div>
      </aside>

      {/* Main content area */}
      <main className="main-content">
        <header className="main-header">
          <div className="header-left">{/* Breadcrumb à venir */}</div>
          <div className="header-right">
            <LanguageSwitcher />
            <NotificationBell />
          </div>
        </header>

        <div className="page-container">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
