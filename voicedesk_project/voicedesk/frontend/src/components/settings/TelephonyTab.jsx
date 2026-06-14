// ============================================================
// EXEVORI VOICE IA — TELEPHONY TAB (Phase 6D)
// /settings?tab=telephony — config Twilio par PME (1 max)
// ============================================================

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Phone, Save, Loader2, AlertCircle, CheckCircle2, Trash2, Shield, ExternalLink, Send,
} from "lucide-react";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { Badge } from "../ui/badge.jsx";
import { Button } from "../ui/button.jsx";
import { Input } from "../ui/input.jsx";
import { cn } from "../../lib/utils.js";

const API = import.meta.env.VITE_API_URL || "";

export default function TelephonyTab() {
  const { t } = useTranslation();
  const { token, effectiveCompanyId } = useAuth();
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState({
    account_sid: "", auth_token: "",
    phone_number: "", forwarding_number: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [feedback, setFeedback] = useState(null);

  const fetchConfig = () => {
    if (!token || !effectiveCompanyId) return;
    setLoading(true);
    fetch(`${API}/api/v1/twilio-config?company_id=${effectiveCompanyId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((d) => {
        setConfig(d.config);
        if (d.config) {
          setForm({
            account_sid: d.config.account_sid || "",
            auth_token: "", // jamais re-rempli — la PME doit retaper si elle veut update
            phone_number: d.config.phone_number || "",
            forwarding_number: d.config.forwarding_number || "",
          });
        }
      })
      .finally(() => setLoading(false));
  };
  useEffect(fetchConfig, [token, effectiveCompanyId]);

  const handleTest = async () => {
    if (!form.account_sid || !form.auth_token) {
      setTestResult({ ok: false, error: t("twilio.errors.requiredTest", "account_sid et auth_token requis pour tester") });
      return;
    }
    setTesting(true); setTestResult(null);
    try {
      const r = await fetch(`${API}/api/v1/twilio-config/test`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ account_sid: form.account_sid, auth_token: form.auth_token }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setTestResult(d);
    } catch (e) {
      setTestResult({ ok: false, error: e.message });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true); setFeedback(null);
    try {
      const r = await fetch(`${API}/api/v1/twilio-config`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          company_id: effectiveCompanyId,
          account_sid: form.account_sid.trim(),
          auth_token: form.auth_token,
          phone_number: form.phone_number.trim(),
          forwarding_number: form.forwarding_number.trim() || null,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setFeedback({
        type: d.verified ? "success" : "warn",
        msg: d.verified
          ? t("twilio.saved", "Configuration Twilio enregistrée et validée — {{name}}", { name: d.config.twilio_account_name || "" })
          : t("twilio.savedUnverified", "Enregistré, mais Twilio refuse les credentials : {{err}}", { err: d.verify_error || "" }),
      });
      fetchConfig();
    } catch (e) {
      setFeedback({ type: "error", msg: e.message });
    } finally {
      setSaving(false);
      setTimeout(() => setFeedback(null), 6000);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(t("twilio.confirmDelete", "Supprimer la configuration Twilio ? Léa ne pourra plus recevoir d'appels."))) return;
    try {
      const r = await fetch(`${API}/api/v1/twilio-config?company_id=${effectiveCompanyId}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setConfig(null);
      setForm({ account_sid: "", auth_token: "", phone_number: "", forwarding_number: "" });
      setTestResult(null);
      setFeedback({ type: "success", msg: t("twilio.deleted", "Configuration supprimée") });
    } catch (e) {
      setFeedback({ type: "error", msg: e.message });
    }
    setTimeout(() => setFeedback(null), 4000);
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-bg-card/60 backdrop-blur-sm p-5" data-testid="telephony-loading">
        <div className="flex items-center gap-2 py-6 text-xs text-text-tertiary"><Loader2 size={14} className="animate-spin" /> Chargement…</div>
      </div>
    );
  }

  const statusBadge = config?.status === "active"   ? { variant: "green",  label: t("twilio.status.active", "Actif") }
                    : config?.status === "error"    ? { variant: "red",    label: t("twilio.status.error",  "Erreur") }
                    : config?.status === "disabled" ? { variant: "ghost",  label: t("twilio.status.disabled", "Désactivé") }
                    : null;

  return (
    <div className="space-y-3" data-testid="telephony-tab">
      {/* Status banner si config présente */}
      {config && (
        <div className="rounded-xl border border-border bg-bg-card/60 backdrop-blur-sm p-4 flex items-center justify-between gap-3" data-testid="twilio-status-banner">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-300 shrink-0">
              <Phone size={16} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-text-primary truncate font-mono">{config.phone_number}</span>
                {statusBadge && <Badge variant={statusBadge.variant} className="text-[9px]">{statusBadge.label}</Badge>}
              </div>
              <div className="text-[11px] text-text-secondary truncate">
                {config.twilio_account_name || config.account_sid}
                {config.last_test_at && ` · ${t("twilio.lastTest", "testé")} ${new Date(config.last_test_at).toLocaleString("fr-CA")}`}
              </div>
            </div>
          </div>
          <button
            onClick={handleDelete}
            data-testid="twilio-delete"
            className="rounded-md p-1.5 text-text-tertiary hover:text-red-300 hover:bg-brand-red/10 transition-colors"
            title={t("twilio.delete", "Supprimer")}
          >
            <Trash2 size={13} />
          </button>
        </div>
      )}

      {/* Form */}
      <div className="rounded-xl border border-border bg-bg-card/60 backdrop-blur-sm p-5">
        <div className="flex items-center gap-2 mb-3">
          <Phone size={14} className="text-text-tertiary" />
          <h2 className="text-sm font-semibold text-text-primary">
            {config ? t("twilio.titleEdit", "Modifier votre configuration Twilio") : t("twilio.titleNew", "Configurer Twilio")}
          </h2>
        </div>

        <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3 text-[11px] text-blue-200 flex items-start gap-2 mb-3">
          <Shield size={12} className="shrink-0 mt-0.5" />
          <div>
            {t("twilio.help", "Récupérez votre Account SID et Auth Token depuis le tableau de bord Twilio. Le Phone Number est celui que vous avez acheté chez Twilio (format E.164).")}
            <a href="https://console.twilio.com/" target="_blank" rel="noopener" className="ml-1 inline-flex items-center gap-0.5 underline hover:text-blue-100">
              Console Twilio <ExternalLink size={9} />
            </a>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label={t("twilio.accountSid", "Account SID")} hint={t("twilio.accountSidHint", "Format AC + 32 caractères hexadécimaux")}>
            <Input
              value={form.account_sid}
              onChange={(e) => setForm({ ...form, account_sid: e.target.value })}
              placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              data-testid="twilio-account-sid"
            />
          </Field>
          <Field label={t("twilio.authToken", "Auth Token")} hint={config ? t("twilio.authTokenHintExisting", "Laissez vide pour conserver l'actuel — sinon retapez pour mettre à jour") : t("twilio.authTokenHintNew", "Affiché une seule fois dans Twilio. Stocké chiffré.")}>
            <Input
              type="password"
              value={form.auth_token}
              onChange={(e) => setForm({ ...form, auth_token: e.target.value })}
              placeholder={config ? "•••••••• (déjà enregistré)" : ""}
              data-testid="twilio-auth-token"
              autoComplete="new-password"
            />
          </Field>
          <Field label={t("twilio.phoneNumber", "Numéro Twilio attribué")} hint={t("twilio.phoneHint", "Format E.164 : +1 puis indicatif régional")}>
            <Input
              value={form.phone_number}
              onChange={(e) => setForm({ ...form, phone_number: e.target.value })}
              placeholder="+14186891234"
              data-testid="twilio-phone-number"
            />
          </Field>
          <Field label={t("twilio.forwardingNumber", "Numéro de transfert (optionnel)")} hint={t("twilio.forwardingHint", "Où Léa transfère un appel si elle ne peut pas répondre")}>
            <Input
              value={form.forwarding_number}
              onChange={(e) => setForm({ ...form, forwarding_number: e.target.value })}
              placeholder="+14185551234"
              data-testid="twilio-forwarding-number"
            />
          </Field>
        </div>

        {/* Test result */}
        {testResult && (
          <div
            className={cn("mt-3 rounded-md border p-3 text-xs flex items-start gap-2",
              testResult.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                            : "border-brand-red/30 bg-brand-red/10 text-red-200"
            )}
            data-testid="twilio-test-result"
          >
            {testResult.ok ? <CheckCircle2 size={13} className="shrink-0 mt-0.5" /> : <AlertCircle size={13} className="shrink-0 mt-0.5" />}
            <div>
              {testResult.ok
                ? <>{t("twilio.testOk", "Credentials Twilio valides")} — <strong>{testResult.friendly_name}</strong> ({testResult.status})</>
                : <>{t("twilio.testFail", "Échec")} : {testResult.error}</>
              }
            </div>
          </div>
        )}

        {feedback && (
          <div
            className={cn("mt-3 rounded-md border p-3 text-xs flex items-center gap-2",
              feedback.type === "success" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              : feedback.type === "warn"  ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                                          : "border-brand-red/30 bg-brand-red/10 text-red-200"
            )}
            data-testid="twilio-feedback"
          >
            {feedback.type === "success" ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
            {feedback.msg}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 mt-4">
          <Button
            variant="outline"
            onClick={handleTest}
            disabled={testing || !form.account_sid || !form.auth_token}
            data-testid="twilio-test-button"
          >
            {testing ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
            {t("twilio.testConnection", "Tester la connexion")}
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || !form.account_sid || !form.auth_token || !form.phone_number}
            data-testid="twilio-save-button"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            {config ? t("twilio.update", "Mettre à jour") : t("twilio.save", "Enregistrer")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-wider text-text-tertiary mb-1">{label}</div>
      {children}
      {hint && <div className="text-[10px] text-text-tertiary mt-1">{hint}</div>}
    </label>
  );
}
