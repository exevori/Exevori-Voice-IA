// ============================================================
// EXEVORI VOICE IA — EMAIL ACCOUNTS TAB (Phase 6B)
//
// Onglet "Comptes courriel" sur /settings → liste + wizard 3 étapes
//   Étape 1: provider (Zoho / Gmail / Outlook / Custom)
//   Étape 2: credentials IMAP/SMTP + Test connexion AVANT save
//   Étape 3: persona (display_name, signature, tone, auto_reply, mode, KB filter, primary)
// ============================================================

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Mail, Plus, Trash2, CheckCircle2, AlertCircle, Loader2, ChevronRight,
  Shield, Send, ArrowLeft, X, ExternalLink, Star, Inbox,
} from "lucide-react";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { Badge } from "../ui/badge.jsx";
import { Button } from "../ui/button.jsx";
import { Input } from "../ui/input.jsx";
import { cn } from "../../lib/utils.js";

const API = import.meta.env.VITE_API_URL || "";

// Icônes pour chaque provider (texte simple — pas d'images externes)
const PROVIDER_ICONS = {
  zoho:    { label: "Zoho",     color: "from-orange-500/20 to-red-500/10  border-orange-500/30 text-orange-300" },
  gmail:   { label: "Gmail",    color: "from-red-500/20    to-rose-500/10 border-red-500/30    text-red-300" },
  outlook: { label: "Outlook",  color: "from-blue-500/20   to-cyan-500/10 border-blue-500/30   text-blue-300" },
  custom:  { label: "Personnalisé", color: "from-purple-500/20 to-pink-500/10 border-purple-500/30 text-purple-300" },
  imap:    { label: "IMAP",     color: "from-slate-500/20  to-slate-700/10 border-slate-500/30 text-slate-300" },
};

const TONES = [
  { value: "friendly", label: "Amical" },
  { value: "formal",   label: "Formel" },
  { value: "direct",   label: "Direct" },
];

const MODES = [
  { value: "draft_only",   label: "Brouillons seulement (recommandé)" },
  { value: "auto",         label: "Réponse automatique (sans validation)" },
  { value: "forward_only", label: "Transfert sans IA" },
  { value: "disabled",     label: "Désactivé" },
];

export default function EmailAccountsTab() {
  const { t } = useTranslation();
  const { token, effectiveCompanyId } = useAuth();
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showWizard, setShowWizard] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const fetchAccounts = () => {
    if (!token || !effectiveCompanyId) return;
    setLoading(true);
    fetch(`${API}/api/v1/email-accounts?company_id=${effectiveCompanyId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((d) => setAccounts(d.accounts || []))
      .finally(() => setLoading(false));
  };
  useEffect(fetchAccounts, [token, effectiveCompanyId]);

  const handleDelete = async (acc) => {
    if (!window.confirm(t("emails.confirmDelete", "Supprimer la connexion {{email}} ?", { email: acc.email }))) return;
    try {
      const r = await fetch(`${API}/api/v1/email-accounts/${acc.id}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setFeedback({ type: "success", msg: t("emails.deleted", "Compte supprimé") });
      fetchAccounts();
    } catch (e) {
      setFeedback({ type: "error", msg: e.message });
    }
    setTimeout(() => setFeedback(null), 3500);
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-bg-card/60 backdrop-blur-sm p-5" data-testid="email-accounts-loading">
        <div className="flex items-center gap-2 py-6 text-xs text-text-tertiary"><Loader2 size={14} className="animate-spin" /> Chargement…</div>
      </div>
    );
  }

  return (
    <div data-testid="email-accounts-tab">
      {/* Header + Add */}
      <div className="rounded-xl border border-border bg-bg-card/60 backdrop-blur-sm p-5 mb-3">
        <div className="flex items-start justify-between gap-3 mb-1">
          <div className="flex items-center gap-2">
            <Mail size={14} className="text-text-tertiary" />
            <h2 className="text-sm font-semibold text-text-primary">{t("emails.title", "Comptes courriel connectés")}</h2>
          </div>
          <Button onClick={() => setShowWizard(true)} data-testid="add-email-account-button" size="sm">
            <Plus size={14} /> {t("emails.addAccount", "Connecter un compte")}
          </Button>
        </div>
        <p className="text-[11px] text-text-tertiary">
          {t("emails.subtitle", "Connectez Zoho, Gmail, Outlook ou un courriel IMAP personnalisé. Chaque compte a sa propre personnalité Léa.")}
        </p>
      </div>

      {/* Liste */}
      {accounts.length === 0 ? (
        <div className="rounded-xl border border-border bg-white/3 p-8 text-center" data-testid="email-accounts-empty">
          <Inbox size={20} className="mx-auto text-text-tertiary mb-2" />
          <div className="text-sm font-medium text-text-primary">{t("emails.noAccount", "Aucun compte connecté")}</div>
          <div className="text-xs text-text-secondary mt-1">{t("emails.noAccountHint", "Connectez votre premier compte courriel pour activer Léa sur vos emails.")}</div>
        </div>
      ) : (
        <div className="space-y-2" data-testid="email-accounts-list">
          {accounts.map((acc) => <AccountRow key={acc.id} acc={acc} onDelete={handleDelete} />)}
        </div>
      )}

      {feedback && (
        <div className={cn("mt-3 rounded-md border px-3 py-2 text-xs flex items-center gap-2",
          feedback.type === "success" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                                     : "border-brand-red/30 bg-brand-red/10 text-red-200"
        )} data-testid="email-accounts-feedback">
          {feedback.type === "success" ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
          {feedback.msg}
        </div>
      )}

      {showWizard && (
        <EmailWizard
          token={token}
          companyId={effectiveCompanyId}
          onClose={() => setShowWizard(false)}
          onSuccess={() => { setShowWizard(false); fetchAccounts(); setFeedback({ type: "success", msg: t("emails.connected", "Compte connecté avec succès !") }); setTimeout(() => setFeedback(null), 4000); }}
        />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// Row pour un compte existant
// ════════════════════════════════════════════════════════════
function AccountRow({ acc, onDelete }) {
  const { t } = useTranslation();
  const provider = PROVIDER_ICONS[acc.provider] || PROVIDER_ICONS.imap;
  const imap = acc.imap_configs?.[0];

  const statusBadge = {
    active:       { variant: "green", label: t("emails.status.active",  "Actif") },
    error:        { variant: "red",   label: t("emails.status.error",   "Erreur") },
    disconnected: { variant: "default", label: t("emails.status.disconnected", "Déconnecté") },
    disabled:     { variant: "ghost", label: t("emails.status.disabled", "Désactivé") },
  }[acc.status] || { variant: "default", label: acc.status };

  return (
    <div
      className={cn("rounded-xl border border-border bg-bg-card/60 backdrop-blur-sm p-4 hover:border-brand-purple/30 transition-colors",
        acc.is_primary && "border-brand-purple/30 bg-brand-purple/5"
      )}
      data-testid={`email-account-${acc.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className={cn("flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br border text-xs font-bold shrink-0", provider.color)}>
            {provider.label.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="text-sm font-semibold text-text-primary truncate">{acc.email}</div>
              {acc.is_primary && (
                <Badge variant="purple" className="text-[9px] inline-flex items-center gap-1" data-testid={`primary-${acc.id}`}>
                  <Star size={9} /> Principal
                </Badge>
              )}
              <Badge variant={statusBadge.variant} className="text-[9px]">{statusBadge.label}</Badge>
            </div>
            <div className="text-[11px] text-text-secondary mt-0.5">
              {acc.display_name || provider.label} · {t(`emails.modeLabel.${acc.mode}`, MODES.find((m) => m.value === acc.mode)?.label || acc.mode)}
            </div>
            {imap && (
              <div className="text-[10px] text-text-tertiary mt-1 font-mono truncate">
                {imap.imap_host}:{imap.imap_port} · {imap.smtp_host}:{imap.smtp_port}
              </div>
            )}
          </div>
        </div>
        <button
          onClick={() => onDelete(acc)}
          data-testid={`delete-email-account-${acc.id}`}
          className="rounded-md p-1.5 text-text-tertiary hover:text-red-300 hover:bg-brand-red/10 transition-colors"
          title={t("emails.delete", "Supprimer la connexion")}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// WIZARD — 3 étapes (provider → credentials → persona)
// ════════════════════════════════════════════════════════════
function EmailWizard({ token, companyId, onClose, onSuccess }) {
  const { t } = useTranslation();
  const [step, setStep] = useState(1);
  const [providers, setProviders] = useState({});
  const [chosen, setChosen] = useState(null);     // "zoho" | "gmail" | "outlook" | "custom"
  const [creds, setCreds] = useState({});         // host/port/user/password
  const [persona, setPersona] = useState({
    display_name: "", signature: "", tone: "friendly",
    auto_reply_threshold: 0.85, mode: "draft_only", is_primary: false,
  });
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Fetch templates au mount
  useEffect(() => {
    fetch(`${API}/api/v1/email-accounts/providers`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((d) => setProviders(d.templates || {}));
  }, [token]);

  const pickProvider = (key) => {
    const tpl = providers[key];
    if (!tpl) return;
    setChosen(key);
    setCreds({
      imap_host: tpl.imap_host, imap_port: tpl.imap_port, imap_use_tls: tpl.imap_use_tls,
      smtp_host: tpl.smtp_host, smtp_port: tpl.smtp_port, smtp_use_tls: tpl.smtp_use_tls,
      email: "", username: "", password: "",
    });
    setStep(2);
  };

  const handleTest = async () => {
    setTesting(true); setTestResult(null); setError(null);
    try {
      const r = await fetch(`${API}/api/v1/email-accounts/test-connection`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...creds, username: creds.username || creds.email }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setTestResult(d);
    } catch (e) {
      setError(e.message);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true); setError(null);
    try {
      const r = await fetch(`${API}/api/v1/email-accounts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          company_id: companyId,
          provider: chosen,
          email: creds.email,
          display_name: persona.display_name || null,
          signature: persona.signature || null,
          tone: persona.tone,
          auto_reply_threshold: persona.auto_reply_threshold,
          mode: persona.mode,
          is_primary: persona.is_primary,
          imap: {
            imap_host: creds.imap_host, imap_port: creds.imap_port, imap_use_tls: creds.imap_use_tls,
            smtp_host: creds.smtp_host, smtp_port: creds.smtp_port, smtp_use_tls: creds.smtp_use_tls,
            username: creds.username || creds.email,
            password: creds.password,
          },
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      onSuccess();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const tpl = chosen ? providers[chosen] : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in"
      data-testid="email-wizard-modal"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-2xl rounded-xl border border-border bg-bg-card shadow-2xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-purple/15 text-brand-purple">
              <Mail size={14} />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-text-primary">{t("emails.wizard.title", "Connecter un compte courriel")}</h2>
              <div className="text-[11px] text-text-tertiary">{t("emails.wizard.step", "Étape {{n}}/3", { n: step })}</div>
            </div>
          </div>
          <button onClick={onClose} data-testid="wizard-close" className="rounded-md p-1.5 text-text-tertiary hover:text-text-primary"><X size={14} /></button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {/* STEP 1 — Provider */}
          {step === 1 && (
            <div data-testid="wizard-step-1" className="space-y-3">
              <p className="text-xs text-text-secondary">{t("emails.wizard.choose", "Choisissez votre fournisseur courriel :")}</p>
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(providers).map(([key, tpl]) => (
                  <button
                    key={key}
                    onClick={() => pickProvider(key)}
                    data-testid={`provider-${key}`}
                    className={cn("rounded-lg border bg-gradient-to-br p-4 text-left hover:scale-[1.02] transition-transform",
                      PROVIDER_ICONS[key]?.color || PROVIDER_ICONS.custom.color
                    )}
                  >
                    <div className="text-sm font-semibold text-text-primary">{tpl.label}</div>
                    {tpl.imap_host && <div className="text-[10px] font-mono mt-1 opacity-70">{tpl.imap_host}</div>}
                    {key === "custom" && <div className="text-[10px] mt-1 opacity-70">{t("emails.wizard.customHint", "Hostpapa, OVH, cPanel, etc.")}</div>}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* STEP 2 — Credentials */}
          {step === 2 && tpl && (
            <div data-testid="wizard-step-2" className="space-y-3">
              {tpl.help_text && (
                <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3 text-[11px] text-blue-200 flex items-start gap-2">
                  <Shield size={12} className="shrink-0 mt-0.5" />
                  <div>
                    <strong>{tpl.label}</strong> — {tpl.help_text}
                    {tpl.help_url && (
                      <a href={tpl.help_url} target="_blank" rel="noopener" className="ml-1 inline-flex items-center gap-0.5 underline hover:text-blue-100">
                        {t("emails.wizard.guide", "guide")} <ExternalLink size={9} />
                      </a>
                    )}
                  </div>
                </div>
              )}

              <Field label={t("emails.wizard.email", "Adresse courriel")}>
                <Input type="email" value={creds.email || ""} onChange={(e) => setCreds({ ...creds, email: e.target.value, username: e.target.value })}
                  placeholder="service@garage-tremblay.ca" data-testid="cred-email" />
              </Field>
              <Field label={t("emails.wizard.password", "Mot de passe d'application")} hint={t("emails.wizard.passwordHint", "Pas votre mot de passe principal — un mot de passe dédié généré dans votre fournisseur")}>
                <Input type="password" value={creds.password || ""} onChange={(e) => setCreds({ ...creds, password: e.target.value })} data-testid="cred-password" />
              </Field>

              {chosen === "custom" && (
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <Field label="IMAP host">
                    <Input value={creds.imap_host || ""} onChange={(e) => setCreds({ ...creds, imap_host: e.target.value })} data-testid="cred-imap-host" />
                  </Field>
                  <Field label="IMAP port">
                    <Input type="number" value={creds.imap_port || 993} onChange={(e) => setCreds({ ...creds, imap_port: Number(e.target.value) })} data-testid="cred-imap-port" />
                  </Field>
                  <Field label="SMTP host">
                    <Input value={creds.smtp_host || ""} onChange={(e) => setCreds({ ...creds, smtp_host: e.target.value })} data-testid="cred-smtp-host" />
                  </Field>
                  <Field label="SMTP port">
                    <Input type="number" value={creds.smtp_port || 465} onChange={(e) => setCreds({ ...creds, smtp_port: Number(e.target.value) })} data-testid="cred-smtp-port" />
                  </Field>
                </div>
              )}

              {/* Test result */}
              {testResult && (
                <div
                  className={cn("rounded-md border p-3 text-xs",
                    testResult.success ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                                       : "border-amber-500/30 bg-amber-500/10 text-amber-200"
                  )}
                  data-testid="test-result"
                >
                  <div className="flex items-center gap-1.5 font-medium">
                    {testResult.success ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                    {testResult.success ? t("emails.wizard.testOk", "Connexion réussie") : t("emails.wizard.testFail", "Connexion partielle")}
                  </div>
                  <div className="mt-1 text-[10px] space-y-0.5">
                    <div>IMAP : {testResult.imap_ok ? "✅" : "❌"} {testResult.imap_error}</div>
                    <div>SMTP : {testResult.smtp_ok ? "✅" : "❌"} {testResult.smtp_error}</div>
                  </div>
                </div>
              )}

              {error && <div className="text-xs text-red-300" data-testid="wizard-error"><AlertCircle size={11} className="inline mr-1" />{error}</div>}
            </div>
          )}

          {/* STEP 3 — Persona */}
          {step === 3 && (
            <div data-testid="wizard-step-3" className="space-y-3">
              <p className="text-xs text-text-secondary mb-2">{t("emails.wizard.personaIntro", "Personnalisez le comportement de Léa sur ce compte :")}</p>

              <Field label={t("emails.wizard.displayName", "Nom interne du compte")}>
                <Input value={persona.display_name} onChange={(e) => setPersona({ ...persona, display_name: e.target.value })}
                  placeholder="ex: Service mécanique" data-testid="persona-display-name" />
              </Field>

              <Field label={t("emails.wizard.signature", "Signature dans les réponses")}>
                <textarea
                  value={persona.signature} onChange={(e) => setPersona({ ...persona, signature: e.target.value })}
                  placeholder="— Sylvain Tremblay, Garage Tremblay"
                  rows={2}
                  data-testid="persona-signature"
                  className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-brand-purple/30 resize-y"
                />
              </Field>

              <div className="grid grid-cols-2 gap-2">
                <Field label={t("emails.wizard.tone", "Ton")}>
                  <select value={persona.tone} onChange={(e) => setPersona({ ...persona, tone: e.target.value })} data-testid="persona-tone"
                    className="w-full h-9 rounded-md border border-border bg-bg-card px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-brand-purple/30">
                    {TONES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Field>
                <Field label={t("emails.wizard.mode", "Comportement")}>
                  <select value={persona.mode} onChange={(e) => setPersona({ ...persona, mode: e.target.value })} data-testid="persona-mode"
                    className="w-full h-9 rounded-md border border-border bg-bg-card px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-brand-purple/30">
                    {MODES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Field>
              </div>

              {persona.mode === "auto" && (
                <Field label={t("emails.wizard.threshold", "Seuil de confiance auto-réponse : {{v}}", { v: persona.auto_reply_threshold.toFixed(2) })}
                       hint={t("emails.wizard.thresholdHint", "0.85 recommandé : Léa répond seul uniquement si elle est très sûre")}>
                  <input type="range" min="0.5" max="1" step="0.01" value={persona.auto_reply_threshold}
                    onChange={(e) => setPersona({ ...persona, auto_reply_threshold: Number(e.target.value) })}
                    data-testid="persona-threshold" className="w-full" />
                </Field>
              )}

              <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer mt-2" data-testid="persona-primary-label">
                <input type="checkbox" checked={persona.is_primary} onChange={(e) => setPersona({ ...persona, is_primary: e.target.checked })}
                  data-testid="persona-is-primary" className="rounded border-border bg-bg-card" />
                {t("emails.wizard.isPrimary", "Définir comme adresse principale (utilisée par défaut)")}
              </label>

              {error && <div className="text-xs text-red-300 mt-2" data-testid="wizard-error"><AlertCircle size={11} className="inline mr-1" />{error}</div>}
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border bg-white/3">
          <div>
            {step > 1 && (
              <button onClick={() => { setStep(step - 1); setError(null); }} data-testid="wizard-back"
                className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary">
                <ArrowLeft size={12} /> {t("common.back", "Retour")}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {step === 2 && (
              <Button variant="outline" onClick={handleTest} disabled={testing || !creds.email || !creds.password} data-testid="wizard-test">
                {testing ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                {t("emails.wizard.testConnection", "Tester la connexion")}
              </Button>
            )}
            {step === 2 && (
              <Button onClick={() => setStep(3)} disabled={!testResult?.success} data-testid="wizard-next-3">
                {t("emails.wizard.next", "Continuer")} <ChevronRight size={12} />
              </Button>
            )}
            {step === 3 && (
              <Button onClick={handleSave} disabled={saving} data-testid="wizard-save">
                {saving ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                {t("emails.wizard.finish", "Enregistrer le compte")}
              </Button>
            )}
          </div>
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
