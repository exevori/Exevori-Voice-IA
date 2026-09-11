// ============================================================
// EXEVORI VOICE IA — SETTINGS PAGE (Phase 6A)
//
// Layout: sidebar verticale gauche (tabs) + zone contenu droite.
// Onglets:
//   1. Assistant Léa   (READY — Phase 6A)
//   2. Entreprise      (READY — Phase 6A)
//   3. Équipe          (READY — Phase 6A)
//   4. Comptes courriel  (COMING SOON — Phase 6B)
//   5. Calendrier       (COMING SOON — Phase 6C)
//   6. Téléphonie       (COMING SOON — Phase 6D)
//   7. Notifications    (COMING SOON — Phase 6E)
// ============================================================

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import {
  Settings as SettingsIcon, Bot, Building2, Users, Mail, Calendar, Phone, Bell,
  Save, Loader2, AlertCircle, CheckCircle2, Send, X, ShieldCheck,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import {ProfileSettings,SecuritySettings,CompanyPreferences,TeamSettings} from "../components/settings/AccountSettings.jsx";
import {settingsTab,assistantPatch} from "../utils/account-settings.js";
import TelephonyTab from "../components/settings/TelephonyTab.jsx";
import NotificationsTab from "../components/settings/NotificationsTab.jsx";
import { cn } from "../lib/utils.js";

const API = import.meta.env.VITE_API_URL || "";

const TABS = [
  {key:"profile",icon:Users,labelKey:"settings.tabs.profile",fallback:"Mon profil"},
  {key:"security",icon:ShieldCheck,labelKey:"settings.tabs.security",fallback:"Sécurité"},
  {key:"assistant",icon:Bot,labelKey:"settings.tabs.assistant",fallback:"Assistante"},
  {key:"company",icon:Building2,labelKey:"settings.tabs.company",fallback:"Entreprise"},
  {key:"team",icon:Users,labelKey:"settings.tabs.team",fallback:"Équipe"},
  {key:"integrations",icon:Calendar,labelKey:"settings.tabs.integrations",fallback:"Intégrations"},
  {key:"privacy",icon:ShieldCheck,labelKey:"settings.tabs.privacy",fallback:"Confidentialité"},
  {key:"telephony",icon:Phone,labelKey:"settings.tabs.telephony",fallback:"Téléphonie"},
  {key:"notifications",icon:Bell,labelKey:"settings.tabs.notifications",fallback:"Notifications"},
];

export default function Settings() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const {token,effectiveCompanyId,profile}=useAuth();
  const active=settingsTab(searchParams.get("tab"));
  const canManage=["company_admin","super_admin"].includes(profile?.role);
  const requestedCompany=searchParams.get("company_id");
  const teamCompanyId=profile?.role === "super_admin" && /^[0-9a-f-]{36}$/i.test(requestedCompany || "") ? requestedCompany : effectiveCompanyId;

  const goTab = (k) => {
    setSearchParams({ tab: k }, { replace: true });
  };

  return (
    <div className="space-y-5 animate-fade-in" data-testid="settings-page">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-tertiary mb-1">
          <SettingsIcon size={11} /> {t("settings.kicker", "Configuration")}
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-text-primary" data-testid="settings-title">
          {t("settings.title", "Paramètres")}
        </h1>
        <p className="mt-1 text-sm text-text-secondary">
          {t("settings.subtitle", "Personnalisez votre assistante et votre environnement Exevori.")}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[220px_1fr]">
        {/* Sidebar tabs */}
        <nav
          className="rounded-xl border border-border bg-bg-card/60 backdrop-blur-sm p-1.5 self-start"
          data-testid="settings-tabs"
        >
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = tab.key === active;
            const isComingSoon = !!tab.phase;
            return (
              <button
                key={tab.key}
                onClick={() => goTab(tab.key)}
                data-testid={`tab-${tab.key}`}
                className={cn(
                  "w-full flex items-center gap-2.5 rounded-md px-3 py-2 text-xs font-medium transition-colors mb-0.5 last:mb-0",
                  isActive
                    ? "bg-white/8 text-text-primary"
                    : "text-text-secondary hover:text-text-primary hover:bg-white/3"
                )}
              >
                <Icon size={13} className={isActive ? "text-brand-purple" : ""} />
                <span className="flex-1 text-left truncate">{t(tab.labelKey, tab.fallback)}</span>
                {isComingSoon && (
                  <Badge variant="default" className="text-[9px] px-1 py-0">{tab.phase}</Badge>
                )}
              </button>
            );
          })}
        </nav>

        {/* Tab content */}
        <div className="space-y-4" key={active+":"+effectiveCompanyId+":"+token}>
          {active === "profile" && <ProfileSettings/>}
          {active === "security" && <SecuritySettings/>}
          {active === "privacy" && <CompanyPreferences/>}
          {active === "integrations" && <CompanyPreferences integration/>}
          {active === "assistant"        && <fieldset disabled={!canManage}><AssistantTab /></fieldset>}
          {active === "company"          && <fieldset disabled={!canManage}><CompanyTab /></fieldset>}
          {active === "team"             && <TeamSettings companyId={teamCompanyId} />}
          {active === "telephony"        && <TelephonyTab />}
          {active === "notifications"    && <NotificationsTab />}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
//  TAB 1 — ASSISTANT LÉA
// ════════════════════════════════════════════════════════════
function AssistantTab() {
  const { t } = useTranslation();
  const { token, effectiveCompanyId } = useAuth();
  const [data, setData] = useState({ config: null, available_voices: [], available_tones: {} });
  const [form, setForm] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  useEffect(() => {
    if (!token || !effectiveCompanyId) return;
    setLoading(true);
    fetch(`${API}/api/v1/config?company_id=${effectiveCompanyId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async(r) => {const d=await r.json();if(!r.ok)throw new Error("Configuration indisponible.");return d;})
      .then((d) => { setData(d); setForm(d.config || {}); })
      .catch(e => setFeedback({type:"error",msg:e.message}))
      .finally(() => setLoading(false));
  }, [token, effectiveCompanyId]);

  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true); setFeedback(null);
    try {
      const r = await fetch(`${API}/api/v1/config`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: effectiveCompanyId, ...assistantPatch(form) }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error === "settings_busy_or_missing"
        ? "Configuration en cours de synchronisation ou absente. Réessayez après deux minutes."
        : "Configuration non enregistrée. Vérifiez les champs et réessayez.");
      setData((prev) => ({ ...prev, config: d.config }));
      setForm(d.config);
      setFeedback(d.sync_status === "failed"
        ? {type:"error",msg:"Configuration enregistrée, mais synchronisation ElevenLabs non confirmée. Réenregistrez pour réessayer."}
        : {type:"success",msg:d.sync_status === "not_provisioned" ? "Configuration enregistrée. Elle sera appliquée lors de l’activation de votre assistante." : "Configuration enregistrée et agent synchronisé."});
    } catch (e) {
      setFeedback({ type: "error", msg: e.message });
    } finally {
      setSaving(false);
      setTimeout(() => setFeedback(null), 4000);
    }
  };

  if (loading) return <LoadingCard testId="assistant-loading" />;
  if (!data.config) {
    return (
      <Card>
        {feedback && <Feedback feedback={feedback}/>}
        <EmptyState
          icon={Bot}
          title={t("settings.assistant.noConfig", "Configuration Léa non initialisée")}
          desc={t("settings.assistant.noConfigDesc", "Complétez l'onboarding initial pour créer votre assistante.")}
        />
      </Card>
    );
  }

  return (
    <>
      <Card testId="assistant-tab">
        {["failed","in_progress"].includes(data.config.settings_sync_status) && <p role="alert" className="text-sm text-amber-300">Synchronisation de la voix : {data.config.settings_sync_status === "in_progress" ? "en cours ; réessayez après deux minutes si elle reste bloquée." : "à relancer en enregistrant à nouveau."}</p>}
        <SectionTitle icon={Bot} title={t("settings.assistant.identity", "Identité")} />
        <Grid cols={2}>
          <Field label={t("settings.assistant.name", "Nom de l'assistante")}>
            <Input value={form.assistant_name || ""} onChange={(e) => update("assistant_name", e.target.value)} data-testid="assistant-name-input" />
          </Field>
          <Field label={t("settings.assistant.gender", "Genre")}>
            <Select value={form.assistant_gender || "feminine"} onChange={(v) => update("assistant_gender", v)} testId="assistant-gender-select"
              options={[
                { value: "feminine",  label: t("settings.assistant.feminine",  "Féminin") },
                { value: "masculine", label: t("settings.assistant.masculine", "Masculin") },
                { value: "neutral",   label: t("settings.assistant.neutral",   "Neutre") },
              ]}
            />
          </Field>
          <Field label={t("settings.assistant.tone", "Ton de voix")}>
            <Select value={form.tone || "professional"} onChange={(v) => update("tone", v)} testId="assistant-tone-select"
              options={Object.entries(data.available_tones || {}).map(([k, v]) => ({ value: k, label: v.label_fr || k }))}
            />
          </Field>
          <Field label={t("settings.assistant.voice", "Voix ElevenLabs")}>
            <Select value={form.voice_id || ""} onChange={(v) => update("voice_id", v)} testId="assistant-voice-select"
              options={(data.available_voices || []).map((v) => ({
                value: v.id,
                label: `${v.name} · ${v.language}${v.accent && v.accent !== "neutral" ? ` (${v.accent})` : ""}`,
              }))}
            />
          </Field>
        </Grid>
      </Card>

      <Card>
        <SectionTitle icon={Send} title={t("settings.assistant.greetings", "Salutations & messages")} />
        <Field label={t("settings.assistant.greetingFR", "Salutation appel entrant (FR)")}>
          <TextArea value={form.greeting_inbound_fr || ""} onChange={(e) => update("greeting_inbound_fr", e.target.value)} rows={2} testId="assistant-greeting-fr" />
        </Field>
        <Field label={t("settings.assistant.voicemail", "Message de boîte vocale (FR)")}>
          <TextArea value={form.voicemail_message_fr || ""} onChange={(e) => update("voicemail_message_fr", e.target.value)} rows={2} testId="assistant-voicemail-fr" />
        </Field>
        <Field label={t("settings.assistant.signature", "Signature courriel")}>
          <TextArea value={form.signature_email_fr || ""} onChange={(e) => update("signature_email_fr", e.target.value)} rows={2} testId="assistant-signature" />
        </Field>
      </Card>

      <Card>
        <SectionTitle icon={ShieldCheck} title={t("settings.assistant.systemPrompt", "Instructions système")} />
        <Field
          label={t("settings.assistant.voicePrompt", "Prompt vocal (utilisé pendant les appels)")}
          hint={t("settings.assistant.voicePromptHint", "Décrivez le rôle, le ton et les limites de votre assistante. Ce texte est envoyé tel quel au LLM pendant chaque appel téléphonique.")}
        >
          <TextArea value={form.system_prompt_voice_fr || ""} onChange={(e) => update("system_prompt_voice_fr", e.target.value)} rows={6} testId="assistant-system-prompt-voice-fr" />
        </Field>
      </Card>

      <Card>
        <Field label="Seuil de pertinence des connaissances (0 à 1)" hint="Ce seuil filtre les passages du RAG. Ce n’est pas une probabilité de vérité : une valeur élevée réduit les réponses disponibles.">
          <Input type="number" min={0} max={1} step={0.05} value={form.rag_min_similarity ?? 0.25} onChange={e=>update("rag_min_similarity",Number(e.target.value))}/>
        </Field>
      </Card>
      <SaveBar feedback={feedback} saving={saving} onSave={save} testId="assistant-save" />
    </>
  );
}

// ════════════════════════════════════════════════════════════
//  TAB 2 — ENTREPRISE
// ════════════════════════════════════════════════════════════
function CompanyTab() {
  const { t } = useTranslation();
  const { token, effectiveCompanyId } = useAuth();
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  useEffect(() => {
    if (!token || !effectiveCompanyId) return;
    setLoading(true);
    fetch(`${API}/api/v1/company?company_id=${effectiveCompanyId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async(r) => {const d=await r.json();if(!r.ok)throw new Error("Entreprise indisponible.");return d;})
      .then((d) => setForm(d.company || {}))
      .catch(e=>setFeedback({type:"error",msg:e.message}))
      .finally(() => setLoading(false));
  }, [token, effectiveCompanyId]);

  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true); setFeedback(null);
    try {
      const r = await fetch(`${API}/api/v1/company`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: effectiveCompanyId, ...form }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setForm(d.company);
      setFeedback({ type: "success", msg: t("settings.company.saved", "Entreprise mise à jour") });
    } catch (e) {
      setFeedback({ type: "error", msg: e.message });
    } finally {
      setSaving(false);
      setTimeout(() => setFeedback(null), 4000);
    }
  };

  if (loading) return <LoadingCard testId="company-loading" />;
  if (!form) return <Card>{feedback && <Feedback feedback={feedback}/>}</Card>;

  return (
    <>
      <Card testId="company-tab">
        <SectionTitle icon={Building2} title={t("settings.company.basics", "Informations de base")} />
        <Grid cols={2}>
          <Field label={t("settings.company.name", "Nom commercial")}>
            <Input value={form.name || ""} onChange={(e) => update("name", e.target.value)} data-testid="company-name-input" />
          </Field>
          <Field label={t("settings.company.sector", "Secteur")}>
            <Input value={form.sector || ""} onChange={(e) => update("sector", e.target.value)} data-testid="company-sector-input" placeholder="ex: garage, immobilier, comptabilité" />
          </Field>
          <Field label={t("settings.company.contactName", "Contact principal")}>
            <Input value={form.contact_name || ""} onChange={(e) => update("contact_name", e.target.value)} data-testid="company-contact-name-input" />
          </Field>
          <Field label={t("settings.company.contactEmail", "Courriel principal")}>
            <Input type="email" value={form.contact_email || ""} onChange={(e) => update("contact_email", e.target.value)} data-testid="company-contact-email-input" />
          </Field>
          <Field label={t("settings.company.phone", "Téléphone")}>
            <Input value={form.phone || ""} onChange={(e) => update("phone", e.target.value)} data-testid="company-phone-input" />
          </Field>
          <Field label={t("settings.company.website", "Site web")}>
            <Input value={form.website || ""} onChange={(e) => update("website", e.target.value)} data-testid="company-website-input" placeholder="https://" />
          </Field>
        </Grid>
      </Card>

      <Card>
        <SectionTitle icon={Building2} title={t("settings.company.location", "Localisation")} />
        <Grid cols={3}>
          <Field label={t("settings.company.city", "Ville")}>
            <Input value={form.city || ""} onChange={(e) => update("city", e.target.value)} data-testid="company-city-input" />
          </Field>
          <Field label={t("settings.company.province", "Province / État")}>
            <Input value={form.province || ""} onChange={(e) => update("province", e.target.value)} data-testid="company-province-input" placeholder="QC" />
          </Field>
          <Field label={t("settings.company.country", "Pays")}>
            <Input value={form.country || ""} onChange={(e) => update("country", e.target.value)} data-testid="company-country-input" placeholder="CA" />
          </Field>
        </Grid>
      </Card>

      <SaveBar feedback={feedback} saving={saving} onSave={save} testId="company-save" />
    </>
  );
}

// ════════════════════════════════════════════════════════════
//  TAB 3 — ÉQUIPE
// ════════════════════════════════════════════════════════════
function Card({ children, testId }) {
  return <div className="rounded-xl border border-border bg-bg-card/60 backdrop-blur-sm p-5" data-testid={testId}>{children}</div>;
}

function SectionTitle({ icon: Icon, title }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon size={14} className="text-text-tertiary" />
      <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-wider text-text-tertiary mb-1">{label}</div>
      {children}
      {hint && <div className="text-[11px] text-text-tertiary mt-1">{hint}</div>}
    </label>
  );
}

function Grid({ cols = 2, children }) {
  return <div className={cn("grid gap-3", cols === 3 ? "md:grid-cols-3" : "md:grid-cols-2")}>{children}</div>;
}

function TextArea({ testId, ...props }) {
  return (
    <textarea
      {...props}
      data-testid={testId}
      className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-brand-purple/30 focus:border-brand-purple/50 resize-y"
    />
  );
}

function Select({ value, onChange, options, testId }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      data-testid={testId}
      className="w-full h-9 rounded-md border border-border bg-bg-card px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-brand-purple/30 focus:border-brand-purple/50"
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function SaveBar({ feedback, saving, onSave, testId }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-card/60 backdrop-blur-sm px-4 py-3 sticky bottom-3" data-testid={`${testId}-bar`}>
      <div className="flex-1 min-w-0">
        {feedback && <Feedback feedback={feedback} compact />}
      </div>
      <Button onClick={onSave} disabled={saving} data-testid={testId}>
        {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
        {saving ? "Enregistrement…" : "Enregistrer les modifications"}
      </Button>
    </div>
  );
}

function Feedback({ feedback, compact }) {
  const Icon = feedback.type === "error" ? AlertCircle : CheckCircle2;
  const color = feedback.type === "error" ? "text-red-300" : "text-emerald-300";
  return (
    <div className={cn("flex items-center gap-1.5 text-xs", color, compact && "truncate")} data-testid="settings-feedback">
      <Icon size={12} /> <span className="truncate">{feedback.msg}</span>
    </div>
  );
}

function LoadingCard({ testId }) {
  return <Card testId={testId}><div className="flex items-center gap-2 py-6 text-xs text-text-tertiary"><Loader2 size={14} className="animate-spin" /> Chargement…</div></Card>;
}

function EmptyState({ icon: Icon, title, desc }) {
  return (
    <div className="rounded-md border border-border bg-white/3 p-5 text-center">
      <Icon size={18} className="text-text-tertiary mx-auto mb-2" />
      <div className="text-sm font-medium text-text-primary mb-1">{title}</div>
      <div className="text-xs text-text-secondary">{desc}</div>
    </div>
  );
}

function Avatar({ name }) {
  const initials = (name || "?").split(/\s+/).slice(0, 2).map((s) => s[0]?.toUpperCase() || "").join("");
  return (
    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-brand-purple/30 to-brand-pink/30 text-xs font-bold text-text-primary shrink-0">
      {initials || "?"}
    </div>
  );
}
