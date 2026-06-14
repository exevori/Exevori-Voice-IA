// ============================================================
// EXEVORI VOICE IA — NOTIFICATIONS TAB (Phase 6E)
// /settings?tab=notifications
//
// 5 catégories x 1 canal email (in-app toujours actif).
// Bouton "Envoyer un email test" pour valider la config Resend.
// ============================================================

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Bell, Save, Loader2, AlertCircle, CheckCircle2, Send,
  Ticket, CreditCard, FileEdit, Sparkles, ShieldAlert, Mail,
} from "lucide-react";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { Button } from "../ui/button.jsx";
import { cn } from "../../lib/utils.js";

const API = import.meta.env.VITE_API_URL || "";

const CATEGORIES = [
  {
    key: "ticket",   icon: Ticket,      defaultOn: true,
    titleKey: "notifs.ticket.title",   titleFallback: "Tickets de support",
    descKey:  "notifs.ticket.desc",    descFallback: "Nouveau ticket reçu, escalade, résolution.",
  },
  {
    key: "billing",  icon: CreditCard,  defaultOn: true,
    titleKey: "notifs.billing.title",  titleFallback: "Facturation",
    descKey:  "notifs.billing.desc",   descFallback: "Paiement réussi, échec de carte, renouvellement.",
  },
  {
    key: "draft",    icon: FileEdit,    defaultOn: false,
    titleKey: "notifs.draft.title",    titleFallback: "Brouillons à valider",
    descKey:  "notifs.draft.desc",     descFallback: "Léa a préparé un brouillon de réponse — l'in-app suffit en général.",
  },
  {
    key: "learning", icon: Sparkles,    defaultOn: false,
    titleKey: "notifs.learning.title", titleFallback: "Suggestions IA",
    descKey:  "notifs.learning.desc",  descFallback: "Léa a appris quelque chose de nouveau ou suggère un ajustement.",
  },
  {
    key: "system",   icon: ShieldAlert, defaultOn: true,
    titleKey: "notifs.system.title",   titleFallback: "Alertes système",
    descKey:  "notifs.system.desc",    descFallback: "Twilio offline, IMAP erreur, quota dépassé, sécurité.",
  },
];

export default function NotificationsTab() {
  const { t } = useTranslation();
  const { token, profile } = useAuth();
  const [prefs, setPrefs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    fetch(`${API}/api/v1/notifications/preferences`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((d) => setPrefs(d.preferences || {}))
      .finally(() => setLoading(false));
  }, [token]);

  const toggle = (cat) => setPrefs((p) => ({ ...p, [`${cat}_email`]: !p[`${cat}_email`] }));

  const handleSave = async () => {
    setSaving(true); setFeedback(null);
    try {
      const r = await fetch(`${API}/api/v1/notifications/preferences`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(prefs),
      });
      if (!r.ok) {
        const d = await r.json();
        throw new Error(d.error || `HTTP ${r.status}`);
      }
      setFeedback({ type: "success", msg: t("notifs.saved", "Préférences enregistrées") });
    } catch (e) {
      setFeedback({ type: "error", msg: e.message });
    } finally {
      setSaving(false);
      setTimeout(() => setFeedback(null), 5000);
    }
  };

  const handleSendTest = async () => {
    setTesting(true); setFeedback(null);
    try {
      const r = await fetch(`${API}/api/v1/notifications/send-test`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setFeedback({
        type: "success",
        msg: t("notifs.testSent", "Email test envoyé à {{email}} (vérifiez votre boîte, y compris spam)", { email: d.to }),
      });
    } catch (e) {
      setFeedback({ type: "error", msg: e.message });
    } finally {
      setTesting(false);
      setTimeout(() => setFeedback(null), 8000);
    }
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-bg-card/60 backdrop-blur-sm p-5" data-testid="notifications-loading">
        <div className="flex items-center gap-2 py-6 text-xs text-text-tertiary"><Loader2 size={14} className="animate-spin" /> Chargement…</div>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="notifications-tab">
      {/* Header card */}
      <div className="rounded-xl border border-border bg-bg-card/60 backdrop-blur-sm p-5">
        <div className="flex items-center gap-2 mb-3">
          <Bell size={14} className="text-text-tertiary" />
          <h2 className="text-sm font-semibold text-text-primary">
            {t("notifs.title", "Canaux de notifications")}
          </h2>
        </div>
        <p className="text-xs text-text-secondary mb-4 leading-relaxed">
          {t("notifs.subtitle", "Les notifications in-app (cloche en haut à droite) sont toujours actives. Choisissez quelles catégories doivent aussi vous envoyer un courriel.")}
        </p>

        <div className="divide-y divide-border">
          {CATEGORIES.map((cat) => {
            const Icon = cat.icon;
            const isOn = !!prefs[`${cat.key}_email`];
            return (
              <div key={cat.key} className="flex items-start justify-between gap-3 py-3" data-testid={`notif-row-${cat.key}`}>
                <div className="flex items-start gap-2.5 min-w-0">
                  <div className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-purple/10 text-brand-purple shrink-0">
                    <Icon size={13} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-text-primary">{t(cat.titleKey, cat.titleFallback)}</div>
                    <div className="text-[11px] text-text-secondary mt-0.5">{t(cat.descKey, cat.descFallback)}</div>
                  </div>
                </div>
                <Toggle on={isOn} onChange={() => toggle(cat.key)} testId={`notif-toggle-${cat.key}`} />
              </div>
            );
          })}
        </div>
      </div>

      {/* Test email card */}
      <div className="rounded-xl border border-border bg-bg-card/60 backdrop-blur-sm p-5">
        <div className="flex items-center gap-2 mb-2">
          <Mail size={14} className="text-text-tertiary" />
          <h2 className="text-sm font-semibold text-text-primary">{t("notifs.testCard.title", "Vérifier l'envoi de courriels")}</h2>
        </div>
        <p className="text-xs text-text-secondary mb-3 leading-relaxed">
          {t("notifs.testCard.desc", "Envoie un courriel de test à votre adresse ({{email}}) pour vérifier que Resend est bien configuré.", { email: profile?.email || "—" })}
        </p>
        <Button
          variant="outline"
          onClick={handleSendTest}
          disabled={testing}
          data-testid="notif-send-test-button"
        >
          {testing ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
          {t("notifs.sendTest", "Envoyer un courriel test")}
        </Button>
      </div>

      {/* Feedback */}
      {feedback && (
        <div
          className={cn("rounded-md border p-3 text-xs flex items-center gap-2",
            feedback.type === "success" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                                        : "border-brand-red/30 bg-brand-red/10 text-red-200"
          )}
          data-testid="notif-feedback"
        >
          {feedback.type === "success" ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
          {feedback.msg}
        </div>
      )}

      {/* Save bar */}
      <div className="flex items-center justify-end gap-2 rounded-xl border border-border bg-bg-card/60 backdrop-blur-sm px-4 py-3 sticky bottom-3">
        <Button onClick={handleSave} disabled={saving} data-testid="notif-save-button">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {t("notifs.save", "Enregistrer les préférences")}
        </Button>
      </div>
    </div>
  );
}

function Toggle({ on, onChange, testId }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onChange}
      data-testid={testId}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-brand-purple/30",
        on ? "bg-brand-purple" : "bg-white/10"
      )}
    >
      <span
        className={cn(
          "inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform",
          on ? "translate-x-5" : "translate-x-1"
        )}
      />
    </button>
  );
}
