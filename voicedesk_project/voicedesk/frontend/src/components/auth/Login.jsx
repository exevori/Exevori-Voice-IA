// ============================================================
// VOICEDESK IA — PAGE LOGIN
// ============================================================

import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
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
      setError(t("auth.login.loginError"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-header">
          <div className="brand-logo">V</div>
          <h1>{t("auth.login.title")}</h1>
          <p>{t("auth.login.subtitle")}</p>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="form-group">
            <label>{t("auth.login.email")}</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoComplete="email"
              autoFocus
            />
          </div>

          <div className="form-group">
            <label>{t("auth.login.password")}</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>

          {error && <div className="form-error">{error}</div>}

          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? t("common.loading") : t("auth.login.signIn")}
          </button>

          <div className="auth-footer">
            <a href="/reset-password">{t("auth.login.forgotPassword")}</a>
          </div>
        </form>

        <div className="auth-bottom">
          <LanguageSwitcher />
        </div>
      </div>
    </div>
  );
}
