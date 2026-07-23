// ============================================================
// EXEVORI VOICE IA — Page Signup public (auto-inscription)
// Fichier : frontend/src/components/auth/Signup.jsx
//
// Flux :
//   1. Client entre ses infos (nom, email, mdp, entreprise, ville)
//   2. POST /api/v1/auth/register → crée company + user Supabase + profile
//   3. Redirection vers /onboarding/billing (choix de plan + paiement)
// ============================================================

import React, { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Mail, Lock, User, Building2, MapPin, ArrowRight, AlertCircle, CheckCircle2, Eye, EyeOff } from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { Button } from "../components/ui/button.jsx";

const API = import.meta.env.VITE_API_URL || "";

const PLANS = [
  { key: "solo",          label: "Solo",          price: 79,  minutes: 150,  desc: "Idéal pour les travailleurs autonomes" },
  { key: "demarrage",     label: "Démarrage",     price: 159, minutes: 400,  desc: "PME de 1 à 5 employés", popular: true },
  { key: "essentiel",     label: "Essentiel",     price: 319, minutes: 1000, desc: "PME de 5 à 15 employés" },
  { key: "professionnel", label: "Professionnel", price: 529, minutes: 2500, desc: "PME de 15 employés et plus" },
];

export default function Signup() {
  const { user, signIn } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState(1); // 1=infos, 2=plan, 3=paiement
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showPassword, setShowPassword] = useState(false);
  const [companyId, setCompanyId] = useState(null);
  const [authToken, setAuthToken] = useState(null);

  // Étape 1 — infos
  const [form, setForm] = useState({
    company_name: "", contact_name: "", contact_email: "",
    password: "", city: "Lévis", phone: "",
  });

  // Étape 2 — plan
  const [selectedPlan, setSelectedPlan] = useState("demarrage");

  useEffect(() => {
    // Rediriger seulement si l'utilisateur arrive déjà connecté (étape 1).
    // Après register+signIn, on reste sur l'étape 2 pour le paiement.
    if (user && step === 1 && !companyId) navigate("/dashboard", { replace: true });
  }, [user, step, companyId, navigate]);

  const update = (field, val) => setForm(f => ({ ...f, [field]: val }));

  // ── Étape 1 : Créer le compte ─────────────────────────────
  const handleRegister = async (e) => {
    e.preventDefault();
    setError(null);

    if (form.password.length < 8) {
      setError("Le mot de passe doit contenir au moins 8 caractères.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API}/api/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_name:  form.company_name,
          contact_name:  form.contact_name,
          contact_email: form.contact_email,
          password:      form.password,
          phone:         form.phone,
          city:          form.city,
          plan:          "demarrage", // défaut, sera modifié à l'étape 2
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erreur lors de la création du compte");

      setCompanyId(data.company_id);

      // Connexion automatique — crée la session navigateur (persistée par Supabase)
      const authData = await signIn(form.contact_email, form.password);
      const sessionToken = authData?.session?.access_token;
      if (!sessionToken) throw new Error("Session non créée après l'inscription");
      setAuthToken(sessionToken);

      setStep(2);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Étape 2 : Lancer le checkout Stripe ──────────────────
  const handleCheckout = async () => {
    if (!companyId || !authToken) { setError("Session expirée — reconnectez-vous."); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/v1/billing/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          company_id:    companyId,
          plan_name:     selectedPlan,
          billing_cycle: "monthly",
          country:       "CA",
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erreur Stripe");

      // Redirection vers la page Stripe Checkout
      window.location.href = data.checkout_url;
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const passwordStrength = () => {
    const p = form.password;
    if (p.length === 0) return null;
    if (p.length < 6) return { label: "Trop court", color: "text-brand-red", width: "20%" };
    if (p.length < 8) return { label: "Faible", color: "text-brand-orange", width: "40%" };
    if (p.length < 12 && !/[!@#$%^&*]/.test(p)) return { label: "Moyen", color: "text-brand-orange", width: "60%" };
    if (p.length >= 12 || /[!@#$%^&*]/.test(p)) return { label: "Fort", color: "text-brand-green", width: "100%" };
    return { label: "Bon", color: "text-brand", width: "80%" };
  };

  const strength = passwordStrength();

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-bg-primary p-6 overflow-hidden">
      {/* Background glow */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-0 h-[60vh] w-[80vw] -translate-x-1/2 rounded-full bg-brand-purple/20 blur-[120px]" />
        <div className="absolute bottom-0 right-0 h-[40vh] w-[50vw] rounded-full bg-brand/10 blur-[120px]" />
      </div>

      <div className="relative z-10 w-full max-w-[480px]">
        {/* Stepper */}
        <div className="flex items-center justify-center gap-2 mb-6">
          {["Votre compte", "Votre forfait", "Paiement"].map((label, i) => (
            <React.Fragment key={label}>
              <div className="flex items-center gap-1.5">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold transition-colors ${
                  step > i + 1 ? "bg-brand-green text-white" :
                  step === i + 1 ? "bg-brand text-white" :
                  "bg-white/10 text-text-tertiary"
                }`}>
                  {step > i + 1 ? <CheckCircle2 size={12} /> : i + 1}
                </div>
                <span className={`text-xs ${step === i + 1 ? "text-text-primary font-medium" : "text-text-tertiary"}`}>
                  {label}
                </span>
              </div>
              {i < 2 && <div className={`h-px w-6 ${step > i + 1 ? "bg-brand-green" : "bg-border"}`} />}
            </React.Fragment>
          ))}
        </div>

        <div className="rounded-2xl border border-border bg-bg-card/60 backdrop-blur-2xl p-8 shadow-2xl">
          {/* Logo */}
          <div className="mb-6 flex items-center gap-3">
            <img src="/branding/exevori-logo.png" alt="Exevori" className="h-10 w-10 object-contain" />
            <div>
              <div className="text-base font-bold tracking-[0.08em] gradient-text leading-none">VOICEDESK AI</div>
              <div className="mt-0.5 text-[10px] tracking-[0.2em] text-text-tertiary">14 jours d'essai gratuit</div>
            </div>
          </div>

          {/* ── ÉTAPE 1 : Infos ── */}
          {step === 1 && (
            <>
              <div className="mb-5">
                <h1 className="text-xl font-bold text-text-primary">Créez votre compte</h1>
                <p className="text-sm text-text-secondary mt-1">Votre assistante IA sera prête en moins de 5 minutes.</p>
              </div>

              <form onSubmit={handleRegister} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary block mb-1">Votre nom</label>
                    <div className="relative">
                      <User size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
                      <input
                        type="text" required value={form.contact_name}
                        onChange={e => update("contact_name", e.target.value)}
                        placeholder="Marie Tremblay"
                        className="w-full rounded-lg border border-border bg-bg-primary/60 pl-9 pr-3 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-brand/60 focus:ring-2 focus:ring-brand/15"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary block mb-1">Entreprise</label>
                    <div className="relative">
                      <Building2 size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
                      <input
                        type="text" required value={form.company_name}
                        onChange={e => update("company_name", e.target.value)}
                        placeholder="Garage Tremblay"
                        className="w-full rounded-lg border border-border bg-bg-primary/60 pl-9 pr-3 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-brand/60 focus:ring-2 focus:ring-brand/15"
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary block mb-1">Ville</label>
                  <div className="relative">
                    <MapPin size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
                    <input
                      type="text" value={form.city}
                      onChange={e => update("city", e.target.value)}
                      placeholder="Lévis, Québec"
                      className="w-full rounded-lg border border-border bg-bg-primary/60 pl-9 pr-3 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-brand/60 focus:ring-2 focus:ring-brand/15"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary block mb-1">Courriel professionnel</label>
                  <div className="relative">
                    <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
                    <input
                      type="email" required value={form.contact_email}
                      onChange={e => update("contact_email", e.target.value)}
                      placeholder="marie@garagetremblay.ca"
                      className="w-full rounded-lg border border-border bg-bg-primary/60 pl-9 pr-3 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-brand/60 focus:ring-2 focus:ring-brand/15"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary block mb-1">Mot de passe</label>
                  <div className="relative">
                    <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
                    <input
                      type={showPassword ? "text" : "password"} required value={form.password}
                      onChange={e => update("password", e.target.value)}
                      placeholder="8 caractères minimum"
                      className="w-full rounded-lg border border-border bg-bg-primary/60 pl-9 pr-10 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-brand/60 focus:ring-2 focus:ring-brand/15"
                    />
                    <button type="button" onClick={() => setShowPassword(s => !s)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary">
                      {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  {strength && (
                    <div className="mt-1.5 space-y-1">
                      <div className="h-1 w-full rounded-full bg-white/10">
                        <div className={`h-1 rounded-full bg-current transition-all ${strength.color}`} style={{ width: strength.width }} />
                      </div>
                      <p className={`text-[10px] ${strength.color}`}>{strength.label}</p>
                    </div>
                  )}
                </div>

                {error && (
                  <div className="flex items-center gap-2 rounded-lg border border-brand-red/30 bg-brand-red/10 px-3 py-2.5 text-sm text-red-300">
                    <AlertCircle size={14} /> {error}
                  </div>
                )}

                <Button type="submit" disabled={loading} className="w-full gap-2" size="lg">
                  {loading ? "Création en cours..." : <><span>Continuer</span><ArrowRight size={15} /></>}
                </Button>

                <p className="text-center text-xs text-text-tertiary">
                  Déjà un compte ?{" "}
                  <Link to="/login" className="text-brand hover:underline">Se connecter</Link>
                </p>

                <p className="text-center text-[10px] text-text-tertiary leading-relaxed">
                  En créant un compte, vous acceptez nos{" "}
                  <a href="/terms" className="hover:underline">conditions d'utilisation</a>{" "}
                  et notre{" "}
                  <a href="/privacy" className="hover:underline">politique de confidentialité</a>.
                </p>
              </form>
            </>
          )}

          {/* ── ÉTAPE 2 : Choix du plan ── */}
          {step === 2 && (
            <>
              <div className="mb-5">
                <h1 className="text-xl font-bold text-text-primary">Choisissez votre forfait</h1>
                <p className="text-sm text-text-secondary mt-1">14 jours d'essai gratuit · Annulable en tout temps</p>
              </div>

              <div className="space-y-2 mb-5">
                {PLANS.map(plan => (
                  <button key={plan.key} onClick={() => setSelectedPlan(plan.key)}
                    className={`w-full text-left rounded-xl border px-4 py-3 transition-colors relative ${
                      selectedPlan === plan.key
                        ? "border-brand bg-brand/10"
                        : "border-border hover:border-brand/40"
                    }`}>
                    {plan.popular && (
                      <span className="absolute -top-2.5 right-3 bg-brand text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
                        POPULAIRE
                      </span>
                    )}
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-semibold text-text-primary">{plan.label}</p>
                        <p className="text-xs text-text-tertiary mt-0.5">{plan.desc}</p>
                        <p className="text-[11px] text-text-tertiary mt-0.5">{plan.minutes} min/mois incluses</p>
                      </div>
                      <div className="text-right shrink-0 ml-3">
                        <p className="text-lg font-bold text-text-primary">{plan.price}$</p>
                        <p className="text-[10px] text-text-tertiary">CAD/mois</p>
                      </div>
                    </div>
                    {selectedPlan === plan.key && (
                      <CheckCircle2 size={16} className="absolute right-3 bottom-3 text-brand" />
                    )}
                  </button>
                ))}
              </div>

              <div className="rounded-lg border border-brand-green/20 bg-brand-green/5 px-3 py-2.5 mb-4">
                <p className="text-xs text-brand-green">
                  ✓ 14 jours gratuits · ✓ Frais d'installation inclus · ✓ Annulable sans pénalité
                </p>
              </div>

              {error && (
                <div className="flex items-center gap-2 rounded-lg border border-brand-red/30 bg-brand-red/10 px-3 py-2.5 text-sm text-red-300 mb-3">
                  <AlertCircle size={14} /> {error}
                </div>
              )}

              <Button onClick={handleCheckout} disabled={loading} className="w-full gap-2" size="lg">
                {loading ? "Redirection vers le paiement..." : <><span>Payer et activer</span><ArrowRight size={15} /></>}
              </Button>

              <p className="text-center text-[10px] text-text-tertiary mt-3">
                Paiement sécurisé via Stripe · TPS/TVQ calculées automatiquement
              </p>
            </>
          )}
        </div>

        <p className="text-center text-[11px] text-text-tertiary mt-4">
          © {new Date().getFullYear()} Exevori — Lévis, Québec
        </p>
      </div>
    </div>
  );
}
