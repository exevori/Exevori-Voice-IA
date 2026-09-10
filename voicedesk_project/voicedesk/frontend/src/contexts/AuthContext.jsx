import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import { createClient } from "@supabase/supabase-js";
import { initLanguageFromProfile } from "../i18n";
import { requestAdminJson } from "../utils/admin-company.js";
import { createImpersonationFetch, restoreCandidate, clientViewProfile, assertVerifiedSession, IMPERSONATION_KEY } from "../utils/impersonation.js";

const API = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
let requestContext = null;
const originalFetchKey = Symbol.for("voicedesk.originalFetch");
const directFetch = window[originalFetchKey] || window.fetch.bind(window);
window[originalFetchKey] = directFetch;
window.fetch = createImpersonationFetch({fetchImpl:directFetch,apiBase:API,origin:window.location.origin,getContext:()=>requestContext});
export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL,import.meta.env.VITE_SUPABASE_ANON_KEY);
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user,setUser] = useState(null);
  const [profile,setProfile] = useState(null);
  const [token,setToken] = useState(null);
  const [loading,setLoading] = useState(true);
  const [authError,setAuthError] = useState("");
  const [isPasswordRecovery,setIsPasswordRecovery] = useState(false);
  const [impersonatedCompany,setImpersonatedCompany] = useState(null);
  const [impersonationSession,setImpersonationSession] = useState(null);
  const [impersonationError,setImpersonationError] = useState("");
  const authVersion = useRef(0);
  const authSnapshot = useRef(null);

  function clearImpersonation() {
    requestContext = null;
    setImpersonatedCompany(null);
    setImpersonationSession(null);
    try { sessionStorage.removeItem(IMPERSONATION_KEY); localStorage.removeItem("voicedesk_impersonate_company"); } catch {}
  }
  function acceptImpersonation(company,session,actorId,accessToken) {
    assertVerifiedSession(company,session,actorId);
    requestContext = {session,token:accessToken};
    setImpersonatedCompany(company);
    setImpersonationSession(session);
    try { sessionStorage.setItem(IMPERSONATION_KEY,JSON.stringify({actor_id:actorId,company,session})); } catch {}
    setImpersonationError("");
  }
  async function loadProfile(accessToken,actorId) {
    const version = ++authVersion.current;
    setLoading(true);
    setAuthError("");
    try {
      const res = await directFetch(API+"/api/v1/auth/me",{headers:{Authorization:"Bearer "+accessToken}});
      if (!res.ok) throw new Error("profile_unavailable");
      const data = await res.json();
      if (version !== authVersion.current) return;
      let stored = null;
      try { stored = restoreCandidate(sessionStorage.getItem(IMPERSONATION_KEY),actorId); } catch {}
      if (data.role === "super_admin" && stored) {
        try {
          const verified = await requestAdminJson(API+"/api/v1/admin/impersonations/"+stored.session.id,{token:accessToken,fetchImpl:directFetch});
          if (version !== authVersion.current) return;
          if (verified.session.company_id !== stored.company.id) throw new Error("session_mismatch");
          acceptImpersonation(stored.company,verified.session,actorId,accessToken);
        } catch {
          if (version !== authVersion.current) return;
          clearImpersonation();
          window.location.replace("/admin");
          return;
        }
      } else clearImpersonation();
      setProfile(data);
      initLanguageFromProfile(data);
    } catch {
      if (version !== authVersion.current) return;
      setProfile(null);
      setAuthError("Impossible de vérifier votre profil. Actualisez ou reconnectez-vous.");
    } finally {
      if (version === authVersion.current) setLoading(false);
    }
  }
  useEffect(() => {
    let mounted = true;
    function acceptAuth(session,event) {
      if (!mounted) return;
      if (event === "PASSWORD_RECOVERY") setIsPasswordRecovery(true);
      if (session) {
        if (authSnapshot.current?.token === session.access_token && authSnapshot.current?.actor === session.user.id) return;
        authSnapshot.current = {token:session.access_token,actor:session.user.id};
        setUser(session.user);
        setToken(session.access_token);
        void loadProfile(session.access_token,session.user.id);
      } else {
        authSnapshot.current = null;
        authVersion.current += 1;
        setUser(null); setProfile(null); setToken(null); setIsPasswordRecovery(false);
        clearImpersonation(); setAuthError(""); setLoading(false);
      }
    }
    const initialVersion = authVersion.current;
    supabase.auth.getSession().then(({data:{session}}) => {
      if (authVersion.current === initialVersion) acceptAuth(session);
    }).catch(() => { if (mounted) { setAuthError("Impossible de charger la session."); setLoading(false); } });
    const {data:{subscription}} = supabase.auth.onAuthStateChange((event,session) => acceptAuth(session,event));
    return () => { mounted=false; authVersion.current += 1; subscription.unsubscribe(); };
  },[]);
  async function signIn(email,password) {
    const {data,error} = await supabase.auth.signInWithPassword({email,password});
    if (error) throw error;
    return data;
  }
  async function signOut() {
    if (impersonationSession) {
      try { await requestAdminJson(API+"/api/v1/admin/impersonations/"+impersonationSession.id+"/end",{
        token,fetchImpl:directFetch,method:"POST",body:JSON.stringify({reason:"sign_out"}),
      }); } catch { setImpersonationError("Fin de vue non confirmée ; expiration automatique sous 30 minutes."); }
    }
    const {error} = await supabase.auth.signOut();
    if (error) throw error;
    authVersion.current += 1;
    setUser(null); setProfile(null); setToken(null); setIsPasswordRecovery(false);
    clearImpersonation();
  }
  const clearPasswordRecovery = useCallback(() => setIsPasswordRecovery(false),[]);
  async function impersonateCompany(company,reason,requestId=crypto.randomUUID()) {
    if (profile?.role !== "super_admin") throw new Error("Accès administrateur requis.");
    const version = authVersion.current;
    if (!company) {
      if (impersonationSession) await requestAdminJson(API+"/api/v1/admin/impersonations/"+impersonationSession.id+"/end",{
        token,fetchImpl:directFetch,method:"POST",body:JSON.stringify({reason:"user_exit"}),
      });
      clearImpersonation();
    } else {
      const result = await requestAdminJson(API+"/api/v1/admin/companies/"+company.id+"/impersonate",{
        token,fetchImpl:directFetch,method:"POST",headers:{"X-Request-Id":requestId},
        body:JSON.stringify({confirm_company_id:company.id,reason}),
      });
      if (version !== authVersion.current) throw new Error("Session modifiée. Réessayez.");
      acceptImpersonation(result.company,result.session,user.id,token);
    }
  }
  useEffect(() => {
    if (!impersonationSession) return;
    const timer = setTimeout(() => window.location.replace("/admin"),Math.max(0,Date.parse(impersonationSession.expires_at)-Date.now()));
    return () => clearTimeout(timer);
  },[impersonationSession]);
  const effectiveCompanyId = (profile?.role === "super_admin" ? impersonatedCompany?.id : null) || profile?.company_id || null;
  return <AuthContext.Provider value={{user,profile:clientViewProfile(profile,impersonationSession,impersonatedCompany),adminProfile:profile,token,loading,isPasswordRecovery,signIn,signOut,clearPasswordRecovery,
    impersonatedCompany,impersonateCompany,impersonationSession,impersonationError,effectiveCompanyId}}>
    {authError && user && !isPasswordRecovery ? <div role="alert" className="p-8 text-text-primary">{authError}
      <button className="ml-4 underline" onClick={()=>window.location.reload()}>Réessayer</button>
      <button className="ml-4 underline" onClick={()=>{void signOut();}}>Se déconnecter</button>
    </div> : children}
  </AuthContext.Provider>;
}
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
