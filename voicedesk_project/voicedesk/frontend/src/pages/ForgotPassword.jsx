// ============================================================
// EXEVORI VOICE IA — Demande de réinitialisation du mot de passe
// ============================================================

import React, { useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Mail,
  Send,
} from "lucide-react";
import { supabase } from "../contexts/AuthContext.jsx";
import { Button } from "../components/ui/button.jsx";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const redirectTo = `${window.location.origin}/reset-password`;
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(
        email.trim(),
        { redirectTo }
      );
      if (resetError) throw resetError;
      setSent(true);
    } catch (resetError) {
      setError(
        resetError?.message
        || "Impossible d'envoyer le courriel pour le moment. Réessayez."
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="relative min-h-screen flex items-center justify-center bg-bg-primary p-6 overflow-hidden"
      data-testid="forgot-password-page"
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

        {sent ? (
          <section data-testid="forgot-password-success">
            <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-brand-green/15 text-brand-green">
              <CheckCircle2 size={24} />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">
              Consultez votre courriel
            </h1>
            <p className="mt-2 text-sm leading-6 text-text-secondary">
              Si un compte correspond à <strong>{email}</strong>, un lien de
              réinitialisation vient d&apos;être envoyé. Vérifiez aussi vos
              courriels indésirables.
            </p>
            <Link
              to="/login"
              className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-brand transition-colors hover:text-brand-purple"
            >
              <ArrowLeft size={16} />
              Retour à la connexion
            </Link>
          </section>
        ) : (
          <>
            <div className="mb-6">
              <h1 className="text-2xl font-bold tracking-tight text-text-primary">
                Mot de passe oublié
              </h1>
              <p className="mt-1.5 text-sm leading-6 text-text-secondary">
                Saisissez le courriel associé à votre compte. Nous vous
                enverrons un lien sécurisé pour choisir un nouveau mot de passe.
              </p>
            </div>

            <form
              onSubmit={handleSubmit}
              className="space-y-4"
              data-testid="forgot-password-form"
            >
              <div className="space-y-1.5">
                <label
                  htmlFor="forgot-email"
                  className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary"
                >
                  Courriel
                </label>
                <div className="relative">
                  <Mail
                    size={16}
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
                  />
                  <input
                    id="forgot-email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                    autoComplete="email"
                    autoFocus
                    placeholder="contact@entreprise.ca"
                    className="w-full rounded-lg border border-border bg-bg-primary/60 px-10 py-3 text-sm text-text-primary outline-none transition-all placeholder:text-text-tertiary focus:border-brand-purple/60 focus:bg-bg-primary focus:ring-2 focus:ring-brand-purple/15"
                    data-testid="forgot-password-email"
                  />
                </div>
              </div>

              {error && (
                <div
                  role="alert"
                  className="flex items-center gap-2 rounded-lg border border-brand-red/30 bg-brand-red/10 px-3 py-2.5 text-sm text-red-300"
                  data-testid="forgot-password-error"
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
                data-testid="forgot-password-submit"
              >
                <span>{loading ? "Envoi en cours..." : "Envoyer le lien"}</span>
                {!loading && <Send size={16} />}
              </Button>

              <div className="text-center">
                <Link
                  to="/login"
                  className="inline-flex items-center gap-1.5 text-xs text-text-secondary transition-colors hover:text-brand"
                >
                  <ArrowLeft size={14} />
                  Retour à la connexion
                </Link>
              </div>
            </form>
          </>
        )}
      </main>
    </div>
  );
}
