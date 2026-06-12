// ============================================================
// EXEVORI VOICE IA — CONTACT FORM (Create + Edit)
// Réutilisable dans Sheet
// ============================================================

import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Save, Loader2, AlertCircle, Tag, X } from "lucide-react";
import { Button } from "../ui/button.jsx";
import { Input } from "../ui/input.jsx";
import { Label } from "../ui/label.jsx";
import { Textarea } from "../ui/textarea.jsx";
import { Select } from "../ui/select.jsx";
import { cn } from "../../lib/utils.js";

const API = import.meta.env.VITE_API_URL || "";

export default function ContactForm({ contact, companyId, token, onSaved, onCancel }) {
  const { t } = useTranslation();
  const isEdit = !!contact?.id;

  const [form, setForm] = useState({
    full_name: "", first_name: "", last_name: "",
    email: "", phone: "", company: "",
    status: "new", source: "manual",
    urgency: "normal", main_need: "", budget: "",
    next_action: "", tags: [],
  });
  const [tagInput, setTagInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (contact) {
      setForm({
        full_name: contact.full_name || "",
        first_name: contact.first_name || "",
        last_name: contact.last_name || "",
        email: contact.email || "",
        phone: contact.phone || "",
        company: contact.company || "",
        status: contact.status || "new",
        source: contact.source || "manual",
        urgency: contact.urgency || "normal",
        main_need: contact.main_need || "",
        budget: contact.budget || "",
        next_action: contact.next_action || "",
        tags: contact.tags || [],
      });
    }
  }, [contact]);

  const upd = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const addTag = () => {
    const v = tagInput.trim();
    if (v && !form.tags.includes(v)) {
      upd("tags", [...form.tags, v]);
    }
    setTagInput("");
  };
  const removeTag = (tg) => upd("tags", form.tags.filter((x) => x !== tg));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!form.full_name?.trim()) {
      setError(t("contacts.form.errorName", "Le nom est requis"));
      return;
    }
    setSaving(true);
    try {
      const url = isEdit
        ? `${API}/api/v1/contacts/${contact.id}`
        : `${API}/api/v1/contacts`;
      const method = isEdit ? "PATCH" : "POST";
      const body = isEdit
        ? form
        : { ...form, company_id: companyId };

      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }
      const saved = await res.json();
      onSaved && onSaved(saved.contact || saved);
    } catch (err) {
      setError(err.message || "Erreur lors de la sauvegarde");
    } finally {
      setSaving(false);
    }
  };

  const statusOptions = [
    { value: "new",      label: t("contacts.status.new", "Nouveau") },
    { value: "hot",      label: t("contacts.status.hot", "Chaud") },
    { value: "warm",     label: t("contacts.status.warm", "Tiède") },
    { value: "customer", label: t("contacts.status.customer", "Client") },
    { value: "cold",     label: t("contacts.status.cold", "Froid") },
  ];
  const urgencyOptions = [
    { value: "low",    label: t("contacts.urgency.low", "Faible") },
    { value: "normal", label: t("contacts.urgency.normal", "Normal") },
    { value: "high",   label: t("contacts.urgency.high", "Urgent") },
  ];
  const sourceOptions = [
    { value: "manual",     label: t("contacts.source.manual", "Saisie manuelle") },
    { value: "call",       label: t("contacts.source.call", "Appel") },
    { value: "email",      label: t("contacts.source.email", "Courriel") },
    { value: "csv_import", label: t("contacts.source.csv", "Import CSV") },
    { value: "website",    label: t("contacts.source.website", "Site web") },
    { value: "referral",   label: t("contacts.source.referral", "Référence") },
  ];

  return (
    <form onSubmit={handleSubmit} className="space-y-3.5" data-testid="contact-form">
      {/* Full name */}
      <Field label={t("contacts.form.fullName", "Nom complet")} required>
        <Input value={form.full_name} onChange={(e) => upd("full_name", e.target.value)} placeholder="Jean Dupont" required autoFocus data-testid="form-full-name" />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t("contacts.form.firstName", "Prénom")}>
          <Input value={form.first_name} onChange={(e) => upd("first_name", e.target.value)} data-testid="form-first-name" />
        </Field>
        <Field label={t("contacts.form.lastName", "Nom")}>
          <Input value={form.last_name} onChange={(e) => upd("last_name", e.target.value)} data-testid="form-last-name" />
        </Field>
      </div>

      <Field label={t("contacts.form.email", "Courriel")}>
        <Input type="email" value={form.email} onChange={(e) => upd("email", e.target.value)} placeholder="jean@exemple.com" data-testid="form-email" />
      </Field>

      <Field label={t("contacts.form.phone", "Téléphone")}>
        <Input type="tel" value={form.phone} onChange={(e) => upd("phone", e.target.value)} placeholder="+1 418 555 1234" data-testid="form-phone" />
      </Field>

      <Field label={t("contacts.form.company", "Entreprise")}>
        <Input value={form.company} onChange={(e) => upd("company", e.target.value)} data-testid="form-company" />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t("contacts.form.status", "Statut")}>
          <Select value={form.status} onValueChange={(v) => upd("status", v)} options={statusOptions} testId="form-status" />
        </Field>
        <Field label={t("contacts.form.urgency", "Urgence")}>
          <Select value={form.urgency} onValueChange={(v) => upd("urgency", v)} options={urgencyOptions} testId="form-urgency" />
        </Field>
      </div>

      <Field label={t("contacts.form.source", "Source")}>
        <Select value={form.source} onValueChange={(v) => upd("source", v)} options={sourceOptions} testId="form-source" />
      </Field>

      <Field label={t("contacts.form.need", "Besoin principal")}>
        <Textarea value={form.main_need} onChange={(e) => upd("main_need", e.target.value)} placeholder="Décrivez le besoin..." rows={2} data-testid="form-need" />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t("contacts.form.budget", "Budget")}>
          <Input value={form.budget} onChange={(e) => upd("budget", e.target.value)} placeholder="—" data-testid="form-budget" />
        </Field>
        <Field label={t("contacts.form.nextAction", "Prochaine action")}>
          <Input value={form.next_action} onChange={(e) => upd("next_action", e.target.value)} placeholder="—" data-testid="form-next" />
        </Field>
      </div>

      {/* Tags */}
      <Field label={t("contacts.form.tags", "Tags")}>
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-bg-primary/60 px-2 py-1.5 min-h-[36px]">
          {form.tags.map((tg) => (
            <span key={tg} className="inline-flex items-center gap-1 rounded-md bg-brand-purple/15 px-2 py-0.5 text-xs text-brand-purple">
              <Tag size={9} />{tg}
              <button type="button" onClick={() => removeTag(tg)} className="ml-0.5 rounded p-0.5 hover:bg-white/10">
                <X size={10} />
              </button>
            </span>
          ))}
          <input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } if (e.key === "Backspace" && !tagInput && form.tags.length) removeTag(form.tags[form.tags.length - 1]); }}
            placeholder={form.tags.length ? "" : t("contacts.form.tagsPlaceholder", "Ajouter (Entrée)")}
            className="flex-1 min-w-[100px] bg-transparent text-xs text-text-primary placeholder:text-text-tertiary outline-none py-1"
            data-testid="form-tags"
          />
        </div>
      </Field>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-brand-red/30 bg-brand-red/10 px-3 py-2 text-sm text-red-300" data-testid="form-error">
          <AlertCircle size={14} /><span>{error}</span>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-3 border-t border-border">
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel} disabled={saving} data-testid="form-cancel">
            {t("common.cancel", "Annuler")}
          </Button>
        )}
        <Button type="submit" disabled={saving} data-testid="form-save">
          {saving ? <><Loader2 size={14} className="animate-spin" /> {t("common.saving", "Sauvegarde...")}</> : <><Save size={14} /> {isEdit ? t("common.save", "Enregistrer") : t("contacts.form.create", "Créer le contact")}</>}
        </Button>
      </div>
    </form>
  );
}

function Field({ label, required, children }) {
  return (
    <div className="space-y-1.5">
      <Label required={required}>{label}</Label>
      {children}
    </div>
  );
}
