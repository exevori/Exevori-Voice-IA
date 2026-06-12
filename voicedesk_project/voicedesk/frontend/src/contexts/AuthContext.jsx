// ============================================================
// EXEVORI VOICE IA — AUTH CONTEXT
// État global auth + profile + impersonation super_admin
// ============================================================

import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";
import { initLanguageFromProfile } from "../i18n";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

const AuthContext = createContext(null);
const IMPERSONATE_KEY = "voicedesk_impersonate_company";

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [impersonatedCompany, setImpersonatedCompany] = useState(() => {
    try {
      const raw = localStorage.getItem(IMPERSONATE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  });

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        setUser(session.user);
        setToken(session.access_token);
        loadProfile(session.access_token);
      } else {
        setLoading(false);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        setUser(session.user);
        setToken(session.access_token);
        loadProfile(session.access_token);
      } else {
        setUser(null);
        setProfile(null);
        setToken(null);
        setImpersonatedCompany(null);
        try { localStorage.removeItem(IMPERSONATE_KEY); } catch {}
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const loadProfile = async (accessToken) => {
    try {
      const API = import.meta.env.VITE_API_URL || "";
      const res = await fetch(`${API}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setProfile(data);
        initLanguageFromProfile(data);
      }
    } catch (err) {
      console.error("Failed to load profile:", err);
    } finally {
      setLoading(false);
    }
  };

  const signIn = async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
    setToken(null);
    setImpersonatedCompany(null);
    try { localStorage.removeItem(IMPERSONATE_KEY); } catch {}
  };

  // === IMPERSONATION (super_admin only) ===
  const impersonateCompany = useCallback((company) => {
    if (profile?.role !== "super_admin") return;
    if (!company) {
      setImpersonatedCompany(null);
      try { localStorage.removeItem(IMPERSONATE_KEY); } catch {}
    } else {
      const minimal = { id: company.id, name: company.name, city: company.city, assistant_name: company.assistant_name };
      setImpersonatedCompany(minimal);
      try { localStorage.setItem(IMPERSONATE_KEY, JSON.stringify(minimal)); } catch {}
    }
  }, [profile]);

  // company_id effectif (impersonation override pour super_admin)
  const effectiveCompanyId = impersonatedCompany?.id || profile?.company_id || null;

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        token,
        loading,
        signIn,
        signOut,
        impersonatedCompany,
        impersonateCompany,
        effectiveCompanyId,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
