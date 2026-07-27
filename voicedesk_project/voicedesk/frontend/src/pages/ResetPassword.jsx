// ============================================================
// EXEVORI VOICE IA — Choix du nouveau mot de passe
// ============================================================

import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  KeyRound,
  Lock,
} from "lucide-react";
import { supabase, useAuth } from "../contexts/AuthContext.jsx";
import { Button } from "../components/ui/button.jsx";

const MIN_PASSWORD_LENGTH = 8;

export default function ResetPassword() {
  const {
    user,
    loading: authLoading,
    isPasswordRecovery,
    signOut,
    clearPasswordRecovery,
  } = useAuth();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [linkError, setLinkError] = useState(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const queryParams = new URLSearchParams(window.location.search);
    const authError = hashParams.get("error_description")
      || queryParams.get("error_description");

    if (authError) {
      setLinkError(authError.replace(/\+/g, " "));
    }
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(
        `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`
      );
      return;
    }
    if (password !== confirmation) {
      setError("Les deux mots de passe ne correspondent pas.");
      return;
    }

    setLoading(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({
        password,
      });
      if (updateError) throw updateError;

      setSuccess(true);
      clearPasswordRecovery();
      window.history.replaceState({}, document.title, "/reset-password");
    } catch (updateError) {
      setError(
        updateError?.message
        || "Impossible de modifier le mot de passe. Demandez un nouveau lien."
      );
      setLoading(false);
      return;
    }

    try {
      await signOut();
    } catch (signOutError) {
      console.error(
        "Mot de passe modifié, mais la déconnexion automatique a échoué:",
        signOutError
      );
    } finally {
      setLoading(false);
    }
  };

  const invalidLink = (
    !authLoading
    && (!user || !isPasswordRecovery)
    && !success
  );

  return (
    <div
      className="relative min-h-screen flex items-center justify-center bg-bg-primary p-6 overflow-hidden"
      data-testid="reset-password-page"
    >
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-0 h-[60vh] w-[80vw] -translate-x-1/2 rounded-full bg-brand-purple/20 blur-[120px]" />
        <div className="absolute bottom-0 left-1/2 h-[40vh] w-[60vw] -translate-x-1/2 rounded-full bg-brand/10 blur-[120px]" />
      </div>

      <main className="relative z-10 w-full max-w-[440px] rounded-2xl border border-border bg-bg-card/60 p-8 shadow-2xl backdrop-blur-2xl">
        <div className="mb-7 flex items-center gap-3.5">
          <img
            src="/branding/exevori-logo.png"
            alt="Exevori"
            className="h-12 w-12 object-contain drop-shadow-[0_0_10px_rgba(139,92,246,0.45)]"
          />
          <div>
            <div className="gradient-text text-lg font-bold leading-none tracking-[0.08em]">
              EXEVORI
            </div>
            <div className="mt-1 text-[11px] font-medium tracking-[0.22em] text-text-tertiary">
              VOICE IA
            </div>
          </div>
        </div>

        {success ? (
          <section data-testid="reset-password-success">
            <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-brand-green/15 text-brand-green">
              <CheckCircle2 size={24} />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">
              Mot de passe modifié
            </h1>
            <p className="mt-2 text-sm leading-6 text-text-secondary">
              Votre nouveau mot de passe est actif. Reconnectez-vous pour
              accéder à votre tableau de bord.
            </p>
            <Button asChild size="lg" className="mt-6 w-full">
              <Link to="/login">Se connecter</Link>
            </Button>
          </section>
        ) : authLoading ? (
          <div
            className="py-10 text-center text-sm text-text-secondary"
            data-testid="reset-password-loading"
          >
            Validation du lien sécurisé...
          </div>
        ) : invalidLink || linkError ? (
          <section data-testid="reset-password-invalid">
            <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-brand-red/15 text-brand-red">
              <AlertCircle size={24} />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">
              Lien invalide ou expiré
            </h1>
            <p className="mt-2 text-sm leading-6 text-text-secondary">
              {linkError
                || "Ce lien ne contient plus de session de récupération valide."}
            </p>
            <Button asChild size="lg" className="mt-6 w-full">
              <Link to="/forgot-password">Demander un nouveau lien</Link>
            </Button>
            <Link
              to="/login"
              className="mt-4 flex items-center justify-center gap-1.5 text-xs text-text-secondary transition-colors hover:text-brand"
            >
              <ArrowLeft size={14} />
              Retour à la connexion
            </Link>
          </section>
        ) : (
          <>
            <div className="mb-6">
              <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-brand-purple/15 text-brand-purple">
                <KeyRound size={22} />
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-text-primary">
                Nouveau mot de passe
              </h1>
              <p className="mt-1.5 text-sm leading-6 text-text-secondary">
                Choisissez un mot de passe unique d&apos;au moins huit
                caractères.
              </p>
            </div>

            <form
              onSubmit={handleSubmit}
              className="space-y-4"
              data-testid="reset-password-form"
            >
              <PasswordField
                id="new-password"
                label="Nouveau mot de passe"
                value={password}
                onChange={setPassword}
                autoFocus
              />
              <PasswordField
                id="confirm-password"
                label="Confirmer le mot de passe"
                value={confirmation}
                onChange={setConfirmation}
              />

              {error && (
                <div
                  role="alert"
                  className="flex items-center gap-2 rounded-lg border border-brand-red/30 bg-brand-red/10 px-3 py-2.5 text-sm text-red-300"
                  data-testid="reset-password-error"
                >
                  <AlertCircle size={16} />
                  <span>{error}</span>
                </div>
              )}

              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={loading}
                data-testid="reset-password-submit"
              >
                {loading ? "Mise à jour..." : "Enregistrer le mot de passe"}
              </Button>
            </form>
          </>
        )}
      </main>
    </div>
  );
}

function PasswordField({ id, label, value, onChange, autoFocus = false }) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={id}
        className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary"
      >
        {label}
      </label>
      <div className="relative">
        <Lock
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
        />
        <input
          id={id}
          type="password"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          autoFocus={autoFocus}
          placeholder="••••••••"
          className="w-full rounded-lg border border-border bg-bg-primary/60 px-10 py-3 text-sm text-text-primary outline-none transition-all placeholder:text-text-tertiary focus:border-brand-purple/60 focus:bg-bg-primary focus:ring-2 focus:ring-brand-purple/15"
          data-testid={id}
        />
      </div>
    </div>
  );
}
