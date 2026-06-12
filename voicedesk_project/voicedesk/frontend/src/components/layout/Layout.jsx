// ============================================================
// EXEVORI VOICE IA — LAYOUT PRINCIPAL (Tailwind + shadcn)
// Sidebar (220px) + Header (lang switcher + notif + impersonation)
// ============================================================

import React from "react";
import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard, Phone, Mail, Calendar, Users, BookOpen,
  Settings, LifeBuoy, BarChart3, Brain, LogOut,
} from "lucide-react";
import LanguageSwitcher from "../common/LanguageSwitcher.jsx";
import NotificationBell from "../common/NotificationBell.jsx";
import ImpersonationSwitcher from "../common/ImpersonationSwitcher.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { cn } from "../../lib/utils";

const NAV_ITEMS = [
  { path: "/dashboard", icon: LayoutDashboard, key: "dashboard" },
  { path: "/calls",     icon: Phone,           key: "calls" },
  { path: "/outbound",  icon: Phone,           key: "outbound" },
  { path: "/emails",    icon: Mail,            key: "emails" },
  { path: "/crm",       icon: Users,           key: "crm" },
  { path: "/calendar",  icon: Calendar,        key: "calendar" },
  { path: "/knowledge", icon: BookOpen,        key: "knowledge" },
  { path: "/analytics", icon: BarChart3,       key: "analytics", role: "company_admin" },
  { path: "/config",    icon: Settings,        key: "config" },
  { path: "/support",   icon: LifeBuoy,        key: "support" },
];

const ADMIN_NAV_ITEMS = [
  { path: "/admin",         icon: Brain, key: "admin_dashboard" },
  { path: "/admin/clients", icon: Users, key: "admin_clients" },
];

export default function Layout() {
  const { t } = useTranslation();
  const { profile, impersonatedCompany, signOut } = useAuth();
  const navigate = useNavigate();

  const isSuperAdmin = profile?.role === "super_admin";
  const isImpersonating = isSuperAdmin && !!impersonatedCompany;
  // En impersonation : afficher la nav PME ; sinon, nav admin pour super_admin
  const navItems = isImpersonating ? NAV_ITEMS : (isSuperAdmin ? ADMIN_NAV_ITEMS : NAV_ITEMS);

  const handleSignOut = async () => {
    await signOut();
    navigate("/login");
  };

  return (
    <div className="flex min-h-screen bg-bg-primary">
      {/* ─── SIDEBAR ─── */}
      <aside
        className="fixed left-0 top-0 z-40 flex h-screen w-[224px] flex-col border-r border-border bg-bg-secondary/60 backdrop-blur-xl"
        data-testid="sidebar"
      >
        {/* Brand */}
        <div className="flex items-center gap-3 px-5 py-5">
          <img
            src="/branding/exevori-logo.png"
            alt="Exevori"
            className="h-9 w-9 object-contain drop-shadow-[0_0_8px_rgba(139,92,246,0.45)]"
            data-testid="sidebar-brand-logo"
          />
          <div>
            <div className="text-[15px] font-bold tracking-[0.08em] gradient-text leading-none">EXEVORI</div>
            <div className="mt-1 text-[10px] tracking-[0.22em] font-medium text-text-tertiary">VOICE IA</div>
          </div>
        </div>

        {/* Impersonation banner */}
        {isImpersonating && (
          <div className="mx-3 mb-2 rounded-md border border-brand-purple/30 bg-brand-purple/10 px-3 py-2 text-[11px] text-text-secondary">
            <div className="text-[10px] uppercase tracking-wider text-brand-purple font-semibold mb-0.5">Vue PME</div>
            <div className="truncate font-medium text-text-primary">{impersonatedCompany.name}</div>
          </div>
        )}

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5" data-testid="sidebar-nav">
          {navItems
            .filter((it) => !it.role || profile?.role === it.role || isSuperAdmin)
            .map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === "/dashboard" || item.path === "/admin"}
                data-testid={`nav-link-${item.key}`}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-[13px] font-medium transition-all",
                    isActive
                      ? "bg-white/8 text-text-primary border-l-2 border-brand-purple pl-[10px]"
                      : "text-text-secondary hover:text-text-primary hover:bg-white/5"
                  )
                }
              >
                <item.icon size={16} />
                <span>{t(`navigation.${item.key}`, item.key)}</span>
              </NavLink>
            ))}
        </nav>

        {/* Footer */}
        <div className="border-t border-border px-3 py-3" data-testid="sidebar-footer">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full gradient-brand text-white text-xs font-bold">
              {(profile?.full_name || profile?.email || "?")[0].toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="truncate text-xs font-medium text-text-primary">
                {profile?.full_name || profile?.email}
              </div>
              <div className="truncate text-[10px] text-text-tertiary">{profile?.role}</div>
            </div>
            <button
              onClick={handleSignOut}
              data-testid="sign-out-btn"
              className="rounded-md p-1.5 text-text-tertiary hover:text-text-primary hover:bg-white/5 transition-colors"
              title={t("common.logout", "Logout")}
            >
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </aside>

      {/* ─── MAIN ─── */}
      <main className="ml-[224px] flex-1 flex flex-col min-h-screen" data-testid="main-content">
        <header
          className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-bg-primary/80 backdrop-blur-xl px-6"
          data-testid="main-header"
        >
          <div className="flex items-center gap-3">
            {isSuperAdmin && <ImpersonationSwitcher />}
          </div>
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
            <NotificationBell />
          </div>
        </header>

        <div className="flex-1 p-6 lg:p-8" data-testid="page-container">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
