import React, { createContext, useContext, useState } from "react";
import { createDemoApi } from "./api.js";
import { DEMO_EMAIL, DEMO_PASSWORD, COMPANY_ID, USER_ID, TOKEN, SESSION_KEY } from "./data.js";
import "./demo.css";

if (!["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname)) throw new Error("La démo est disponible uniquement sur ce PC.");
const api = createDemoApi({ storage: window.localStorage, isSignedIn: () => sessionStorage.getItem(SESSION_KEY) === "yes", origin: window.location.origin });
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, options) => {
  const url = new URL(typeof input === "string" ? input : input.url, location.origin);
  if (url.pathname.startsWith("/api/") || url.origin !== location.origin) return api.fetch(input, options);
  return nativeFetch(input, options);
};
document.addEventListener("click", (event) => {
  const anchor = event.target.closest?.("a[href]");
  if (anchor && (new URL(anchor.href, location.origin).origin !== location.origin || /^(tel|mailto):/i.test(anchor.href))) {
    event.preventDefault(); event.stopPropagation();
    window.alert("Démonstration locale : les appels, courriels et liens externes sont désactivés.");
  }
}, true);
const unavailable = async () => ({ data: null, error: new Error("Opération réelle désactivée en démo locale.") });
export const supabase = { auth: { updateUser: unavailable, resetPasswordForEmail: unavailable, exchangeCodeForSession: unavailable, getUser: unavailable, getSession: async () => ({ data: { session: null }, error: null }) } };
const Context = createContext(null);
export function AuthProvider({ children }) {
  const [signedIn, setSignedIn] = useState(sessionStorage.getItem(SESSION_KEY) === "yes");
  const [profile, setProfile] = useState(api.getProfile());
  const signIn = async (email, password) => {
    if (email.trim().toLowerCase() !== DEMO_EMAIL || password !== DEMO_PASSWORD) throw new Error("Utilisez l'identifiant et le mot de passe de démonstration affichés en haut.");
    sessionStorage.setItem(SESSION_KEY, "yes"); setSignedIn(true);
    return { session: { access_token: TOKEN }, user: { id: USER_ID, email: DEMO_EMAIL } };
  };
  const signOut = async () => { sessionStorage.removeItem(SESSION_KEY); setSignedIn(false); };
  const value = { user: signedIn ? { id: USER_ID, email: DEMO_EMAIL } : null, profile: signedIn ? profile : null, adminProfile: signedIn ? profile : null, token: signedIn ? TOKEN : null, loading: false, effectiveCompanyId: signedIn ? COMPANY_ID : null, signIn, signOut, refreshProfile: async () => setProfile(api.getProfile()), isPasswordRecovery: false, clearPasswordRecovery() {}, impersonatedCompany: null, impersonationSession: null, impersonationError: "", impersonateCompany: unavailable };
  return <Context.Provider value={value}>
    <aside className="local-demo-banner" aria-label="Démonstration locale" data-testid="local-demo-banner">
      <div><strong>DÉMO LOCALE</strong> · Données fictives · Aucun appel, paiement ou envoi réel
        {!signedIn && <div>Connexion : <b>{DEMO_EMAIL}</b> · Mot de passe : <b>{DEMO_PASSWORD}</b></div>}
      </div>
      <div className="local-demo-actions">
        {signedIn && <><a href="/dashboard">Tableau de bord</a><a href="/outbound">Appels sortants</a></>}
        <button onClick={() => { if (window.confirm("Réinitialiser uniquement les données fictives de cette démo ?")) { api.reset(); location.reload(); } }}>Réinitialiser la démo</button>
      </div>
    </aside>
    {children}
  </Context.Provider>;
}
export function useAuth() { const ctx = useContext(Context); if (!ctx) throw new Error("Demo AuthProvider missing"); return ctx; }
