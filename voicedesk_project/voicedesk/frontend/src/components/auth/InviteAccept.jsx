// ============================================================
// VOICEDESK IA — PAGE INVITE ACCEPT
// ============================================================

import React, { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

const API = import.meta.env.VITE_API_URL || "http://localhost:3000";

export default function InviteAccept() {
  const { t } = useTranslation();
  const { token } = useParams();
  const navigate = useNavigate();

  const [invitation, setInvitation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Vérifier le token au chargement
  useEffect(() => {
    fetch(`${API}/api/v1/auth/invite/verify/${token}`)
      .then(r => r.json())
      .then(data => {
        if (data.valid) {
          setInvitation(data.invitation);
        } else {
          setError(data.error || t("auth.invite.invalid"));
        }
      })
      .catch(() => setError(t("auth.invite.invalid")))
      .finally(() => setLoading(false));
  }, [token, t]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError(t("auth.invite.passwordMismatch"));
      return;
    }
    if (password.length < 8) {
      setError(t("auth.invite.minChars"));
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`${API}/api/v1/auth/invite/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();

      if (data.success) {
        // Redirection vers login
        navigate("/login?invitation=accepted");
      } else {
        setError(data.error || "Erreur");
      }
    } catch (err) {
      setError("Erreur de connexion");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="auth-page"><div className="auth-card"><p>{t("common.loading")}</p></div></div>;
  }

  if (error && !invitation) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h2>{t("auth.invite.invalid")}</h2>
          <p className="form-error">{error}</p>
          <button onClick={() => navigate("/login")} className="btn-primary">
            {t("common.back")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-header">
          <div className="brand-logo">V</div>
          <h1>{t("auth.invite.title")}</h1>
          <p>{t("auth.invite.subtitle")}</p>
        </div>

        <div className="invite-info">
          <strong>{invitation.contact_name}</strong>
          <br />
          <span>{invitation.email}</span>
          <br />
          <em>{invitation.company_name}</em>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="form-group">
            <label>{t("auth.invite.createPassword")}</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              minLength={8}
              autoFocus
            />
            <small>{t("auth.invite.minChars")}</small>
          </div>

          <div className="form-group">
            <label>{t("auth.invite.confirmPassword")}</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              required
            />
          </div>

          {error && <div className="form-error">{error}</div>}

          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? t("common.loading") : t("common.create")}
          </button>
        </form>
      </div>
    </div>
  );
}
