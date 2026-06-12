// ============================================================
// EXEVORI VOICE IA — PAGE LOGIN (Tailwind + shadcn)
// ============================================================

import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Mail, Lock, ArrowRight, AlertCircle } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { Button } from "../ui/button.jsx";
import LanguageSwitcher from "../common/LanguageSwitcher.jsx";

export default function Login() {
  const { t } = useTranslation();
  const { signIn } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await signIn(email, password);
      navigate("/dashboard");
    } catch (err) {
      setError(err?.message || t("auth.login.loginError"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-bg-primary p-6 overflow-hidden" data-testid="login-page">
      {/* Background glow */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-0 h-[60vh] w-[80vw] -translate-x-1/2 rounded-full bg-brand-purple/20 blur-[120px]" />
        <div className="absolute bottom-0 left-1/2 h-[40vh] w-[60vw] -translate-x-1/2 rounded-full bg-brand/10 blur-[120px]" />
      </div>

      <div className="absolute right-6 top-6 z-10">
        <LanguageSwitcher />
      </div>

      {/* Card */}
      <div
        className="relative z-10 w-full max-w-[420px] rounded-2xl border border-border bg-bg-card/60 backdrop-blur-2xl p-8 shadow-2xl animate-fade-in"
        data-testid="login-card"
      >
        {/* Brand */}
        <div className="mb-7 flex items-center gap-3.5">
          <img
            src="/branding/exevori-logo.png"
            alt="Exevori"
            className="h-12 w-12 object-contain drop-shadow-[0_0_10px_rgba(139,92,246,0.45)]"
            data-testid="login-brand-logo"
          />
          <div>
            <div className="text-lg font-bold tracking-[0.08em] gradient-text leading-none">EXEVORI</div>
            <div className="mt-1 text-[11px] tracking-[0.22em] font-medium text-text-tertiary">VOICE IA</div>
          </div>
        </div>

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight text-text-primary" data-testid="login-title">
            {t("auth.login.title")}
          </h1>
          <p className="mt-1.5 text-sm text-text-secondary" data-testid="login-subtitle">
            {t("auth.login.subtitle")}
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4" data-testid="login-form">
          <div className="space-y-1.5">
            <label htmlFor="login-email" className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
              {t("auth.login.email")}
            </label>
            <div className="relative">
              <Mail size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
              <input
                id="login-email"
                data-testid="login-email-input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                autoFocus
                placeholder="contact@exevori.com"
                className="w-full rounded-lg border border-border bg-bg-primary/60 px-10 py-3 text-sm text-text-primary placeholder:text-text-tertiary outline-none transition-all focus:border-brand-purple/60 focus:bg-bg-primary focus:ring-2 focus:ring-brand-purple/15"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="login-password" className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
              {t("auth.login.password")}
            </label>
            <div className="relative">
              <Lock size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
              <input
                id="login-password"
                data-testid="login-password-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                placeholder="••••••••"
                className="w-full rounded-lg border border-border bg-bg-primary/60 px-10 py-3 text-sm text-text-primary placeholder:text-text-tertiary outline-none transition-all focus:border-brand-purple/60 focus:bg-bg-primary focus:ring-2 focus:ring-brand-purple/15"
              />
            </div>
          </div>

          {error && (
            <div
              role="alert"
              data-testid="login-error"
              className="flex items-center gap-2 rounded-lg border border-brand-red/30 bg-brand-red/10 px-3 py-2.5 text-sm text-red-300"
            >
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}

          <Button
            type="submit"
            disabled={loading}
            data-testid="login-submit-button"
            className="w-full"
            size="lg"
          >
            <span>{loading ? t("auth.login.signingIn") : t("auth.login.signIn")}</span>
            {!loading && <ArrowRight size={16} />}
          </Button>

          <div className="text-center">
            <a
              href="/reset-password"
              data-testid="login-forgot-link"
              className="text-xs text-text-secondary transition-colors hover:text-brand"
            >
              {t("auth.login.forgotPassword")}
            </a>
          </div>
        </form>
      </div>

      {/* Footer meta */}
      <div className="absolute bottom-5 left-0 right-0 text-center text-[11px] tracking-wider text-text-tertiary z-10" data-testid="login-meta">
        © {new Date().getFullYear()} Exevori — Lévis, Québec
      </div>
    </div>
  );
}
