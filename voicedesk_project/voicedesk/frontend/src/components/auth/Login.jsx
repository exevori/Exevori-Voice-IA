// ============================================================
// EXEVORI VOICE IA — PAGE LOGIN
// Design : dark premium, palette Linear/Cursor
// ============================================================

import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Mail, Lock, ArrowRight, AlertCircle } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext.jsx";
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
    <div className="login-page" data-testid="login-page">
      <div className="login-bg-glow" />

      <div className="login-lang-switcher">
        <LanguageSwitcher />
      </div>

      <div className="login-card" data-testid="login-card">
        <div className="login-brand">
          <img
            src="/branding/exevori-logo.png"
            alt="Exevori"
            className="login-brand-logo"
            data-testid="login-brand-logo"
          />
          <div className="login-brand-text">
            <div className="login-brand-title">EXEVORI</div>
            <div className="login-brand-subtitle">VOICE IA</div>
          </div>
        </div>

        <div className="login-header">
          <h1 data-testid="login-title">{t("auth.login.title")}</h1>
          <p data-testid="login-subtitle">{t("auth.login.subtitle")}</p>
        </div>

        <form onSubmit={handleSubmit} className="login-form" data-testid="login-form">
          <div className="login-field">
            <label htmlFor="login-email">{t("auth.login.email")}</label>
            <div className="login-input-wrap">
              <Mail size={16} className="login-input-icon" />
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
              />
            </div>
          </div>

          <div className="login-field">
            <label htmlFor="login-password">{t("auth.login.password")}</label>
            <div className="login-input-wrap">
              <Lock size={16} className="login-input-icon" />
              <input
                id="login-password"
                data-testid="login-password-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                placeholder="••••••••"
              />
            </div>
          </div>

          {error && (
            <div className="login-error" data-testid="login-error" role="alert">
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            className="login-submit"
            disabled={loading}
            data-testid="login-submit-button"
          >
            <span>{loading ? t("auth.login.signingIn") : t("auth.login.signIn")}</span>
            {!loading && <ArrowRight size={16} />}
          </button>

          <div className="login-footer">
            <a href="/reset-password" data-testid="login-forgot-link">
              {t("auth.login.forgotPassword")}
            </a>
          </div>
        </form>
      </div>

      <div className="login-footer-meta" data-testid="login-meta">
        <span>© {new Date().getFullYear()} Exevori — Lévis, Québec</span>
      </div>
    </div>
  );
}
