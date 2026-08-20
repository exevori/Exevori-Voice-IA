// ============================================================
// EXEVORI VOICE IA — CONTACT FORM (Create + Edit)
// CRM V1 : E.164, pipeline, prochaine action et consentements
// ============================================================

import React, { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, CopyCheck, Loader2, Save, Tag, X } from "lucide-react";
import { Badge } from "../ui/badge.jsx";
import { Button } from "../ui/button.jsx";
import { Input } from "../ui/input.jsx";
import { Label } from "../ui/label.jsx";
import { Select } from "../ui/select.jsx";
import { Textarea } from "../ui/textarea.jsx";

const API = import.meta.env.VITE_API_URL || "";
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

const EMPTY_FORM = {
  full_name: "",
  first_name: "",
  last_name: "",
  email: "",
  phone: "",
  company: "",
  status: "new",
  source: "manual",
  urgency: "normal",
  main_need: "",
  budget: "",
  next_action_date: "",
  next_action_note: "",
  email_consent: null,
  sms_consent: null,
  call_consent: null,
  tags: [],
};

function compactPhone(value) {
  return String(value || "").trim().replace(/[\s().-]/g, "");
}

function toLocalDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function toIsoDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function consentValue(value) {
  if (value === true) return "granted";
  if (value === false) return "denied";
  return "unset";
}

function parseConsent(value) {
  if (value === "granted") return true;
  if (value === "denied") return false;
  return null;
}

function formatTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("fr-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function textOrNull(value, { lowerCase = false } = {}) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  return lowerCase ? normalized.toLowerCase() : normalized;
}

function contactPayloadBaseline(contact) {
  return {
    full_name: String(contact?.full_name || "").trim(),
    first_name: textOrNull(contact?.first_name),
    last_name: textOrNull(contact?.last_name),
    email: textOrNull(contact?.email, { lowerCase: true }),
    phone: compactPhone(contact?.phone),
    company: textOrNull(contact?.company),
    status: contact?.status || "new",
    source: contact?.source || "manual",
    urgency: contact?.urgency || "normal",
    main_need: textOrNull(contact?.main_need),
    budget: textOrNull(contact?.budget),
    // Compare against the minute precision actually rendered by datetime-local.
    next_action_date: toIsoDateTime(toLocalDateTime(contact?.next_action_date)),
    next_action_note: textOrNull(contact?.next_action_note),
    email_consent: contact?.email_consent ?? null,
    sms_consent: contact?.sms_consent ?? null,
    call_consent: contact?.call_consent ?? null,
    tags: Array.isArray(contact?.tags) ? contact.tags : [],
  };
}

function payloadValueEquals(key, nextValue, previousValue) {
  if (key === "tags") {
    return JSON.stringify(nextValue || []) === JSON.stringify(previousValue || []);
  }
  return nextValue === previousValue;
}

export default function ContactForm({ contact, companyId, token, onSaved, onCancel }) {
  const { t } = useTranslation();
  const isEdit = Boolean(contact?.id);
  const [form, setForm] = useState(EMPTY_FORM);
  const [tagInput, setTagInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [duplicates, setDuplicates] = useState([]);

  useEffect(() => {
    setForm(contact ? {
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
      next_action_date: toLocalDateTime(contact.next_action_date),
      next_action_note: contact.next_action_note || "",
      email_consent: contact.email_consent ?? null,
      sms_consent: contact.sms_consent ?? null,
      call_consent: contact.call_consent ?? null,
      tags: Array.isArray(contact.tags) ? contact.tags : [],
    } : EMPTY_FORM);
    setError(null);
    setDuplicates([]);
  }, [contact]);

  const upd = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }));
    if (duplicates.length) setDuplicates([]);
  };

  const addTag = () => {
    const value = tagInput.trim();
    if (value && !form.tags.includes(value)) {
      upd("tags", [...form.tags, value]);
    }
    setTagInput("");
  };

  const removeTag = (tag) => upd("tags", form.tags.filter((value) => value !== tag));

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError(null);
    setDuplicates([]);

    const fullName = form.full_name.trim();
    const phone = compactPhone(form.phone);
    if (!fullName) {
      setError(t("contacts.form.errorName", "Le nom est requis"));
      return;
    }
    if (!E164_PATTERN.test(phone)) {
      setError(t(
        "contacts.form.errorPhoneE164",
        "Le téléphone est requis au format E.164 compact, par exemple +14185551234.",
      ));
      return;
    }

    const nextActionDate = toIsoDateTime(form.next_action_date);
    if (form.next_action_date && !nextActionDate) {
      setError(t("contacts.form.errorNextActionDate", "La date de prochaine action est invalide."));
      return;
    }

    const completePayload = {
      full_name: fullName,
      first_name: textOrNull(form.first_name),
      last_name: textOrNull(form.last_name),
      email: textOrNull(form.email, { lowerCase: true }),
      phone,
      company: textOrNull(form.company),
      status: form.status,
      source: form.source,
      urgency: form.urgency,
      main_need: textOrNull(form.main_need),
      budget: textOrNull(form.budget),
      next_action_date: nextActionDate,
      next_action_note: textOrNull(form.next_action_note),
      email_consent: form.email_consent,
      sms_consent: form.sms_consent,
      call_consent: form.call_consent,
      tags: form.tags,
    };

    let payload = completePayload;
    if (isEdit) {
      const baseline = contactPayloadBaseline(contact);
      payload = Object.fromEntries(
        Object.entries(completePayload).filter(
          ([key, value]) => !payloadValueEquals(key, value, baseline[key])
        )
      );
      if (Object.keys(payload).length === 0) {
        onSaved?.(contact);
        return;
      }
    } else {
      payload = { ...completePayload, company_id: companyId };
    }

    setSaving(true);
    try {
      const url = isEdit
        ? `${API}/api/v1/contacts/${contact.id}`
        : `${API}/api/v1/contacts`;

      const response = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        if (response.status === 409 && body.error === "duplicate_contact") {
          setDuplicates(Array.isArray(body.duplicates) ? body.duplicates : []);
        }
        throw new Error(body.message || body.error || `HTTP ${response.status}`);
      }
      onSaved?.(body.contact || body);
    } catch (err) {
      setError(err.message || t("contacts.form.saveError", "Erreur lors de la sauvegarde"));
    } finally {
      setSaving(false);
    }
  };

  const statusOptions = [
    { value: "new", label: t("contacts.status.new", "Nouveau") },
    { value: "qualified", label: t("contacts.status.qualified", "Qualifié") },
    { value: "client", label: t("contacts.status.client", "Client") },
    { value: "lost", label: t("contacts.status.lost", "Perdu") },
  ];
  const urgencyOptions = [
    { value: "low", label: t("contacts.urgency.low", "Faible") },
    { value: "normal", label: t("contacts.urgency.normal", "Normal") },
    { value: "high", label: t("contacts.urgency.high", "Urgent") },
  ];
  const sourceOptions = [
    { value: "manual", label: t("contacts.source.manual", "Saisie manuelle") },
    { value: "call", label: t("contacts.source.call", "Appel") },
    { value: "email", label: t("contacts.source.email", "Courriel") },
    { value: "csv_import", label: t("contacts.source.csv", "Import CSV") },
    { value: "website", label: t("contacts.source.website", "Site web") },
    { value: "referral", label: t("contacts.source.referral", "Référence") },
  ];
  const consentOptions = [
    { value: "unset", label: t("contacts.consent.unset", "Non renseigné") },
    { value: "granted", label: t("contacts.consent.granted", "Accord") },
    { value: "denied", label: t("contacts.consent.denied", "Refus") },
  ];

  return (
    <form onSubmit={handleSubmit} className="space-y-3.5" data-testid="contact-form">
      <Field label={t("contacts.form.fullName", "Nom complet")} required>
        <Input
          value={form.full_name}
          onChange={(event) => upd("full_name", event.target.value)}
          placeholder="Jean Dupont"
          required
          autoFocus
          data-testid="form-full-name"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t("contacts.form.firstName", "Prénom")}>
          <Input value={form.first_name} onChange={(event) => upd("first_name", event.target.value)} data-testid="form-first-name" />
        </Field>
        <Field label={t("contacts.form.lastName", "Nom")}>
          <Input value={form.last_name} onChange={(event) => upd("last_name", event.target.value)} data-testid="form-last-name" />
        </Field>
      </div>

      <Field label={t("contacts.form.email", "Courriel")}>
        <Input type="email" value={form.email} onChange={(event) => upd("email", event.target.value)} placeholder="jean@exemple.com" data-testid="form-email" />
      </Field>

      <Field label={t("contacts.form.phone", "Téléphone E.164")} required>
        <Input
          type="tel"
          inputMode="tel"
          value={form.phone}
          onChange={(event) => upd("phone", event.target.value)}
          onBlur={() => upd("phone", compactPhone(form.phone))}
          placeholder="+14185551234"
          pattern="^\+[1-9]\d{7,14}$"
          required
          aria-describedby="form-phone-hint"
          data-testid="form-phone"
        />
        <p id="form-phone-hint" className="mt-1 text-[10px] text-text-tertiary">
          {t("contacts.form.phoneHint", "Indicatif pays obligatoire, sans espace ni ponctuation.")}
        </p>
      </Field>

      <Field label={t("contacts.form.company", "Entreprise")}>
        <Input value={form.company} onChange={(event) => upd("company", event.target.value)} data-testid="form-company" />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t("contacts.form.status", "Étape du pipeline")}>
          <Select value={form.status} onValueChange={(value) => upd("status", value)} options={statusOptions} testId="form-status" />
        </Field>
        <Field label={t("contacts.form.urgency", "Urgence")}>
          <Select value={form.urgency} onValueChange={(value) => upd("urgency", value)} options={urgencyOptions} testId="form-urgency" />
        </Field>
      </div>

      <Field label={t("contacts.form.source", "Source")}>
        <Select value={form.source} onValueChange={(value) => upd("source", value)} options={sourceOptions} testId="form-source" />
      </Field>

      <Field label={t("contacts.form.need", "Besoin principal")}>
        <Textarea value={form.main_need} onChange={(event) => upd("main_need", event.target.value)} placeholder="Décrivez le besoin..." rows={2} data-testid="form-need" />
      </Field>

      <Field label={t("contacts.form.budget", "Budget")}>
        <Input value={form.budget} onChange={(event) => upd("budget", event.target.value)} placeholder="—" data-testid="form-budget" />
      </Field>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t("contacts.form.nextActionDate", "Date de prochaine action")}>
          <Input
            type="datetime-local"
            value={form.next_action_date}
            onChange={(event) => upd("next_action_date", event.target.value)}
            data-testid="form-next-action-date"
          />
        </Field>
        <Field label={t("contacts.form.nextActionNote", "Prochaine action")}>
          <Input
            value={form.next_action_note}
            onChange={(event) => upd("next_action_note", event.target.value)}
            placeholder="Ex. rappeler après le devis"
            data-testid="form-next-action-note"
          />
        </Field>
      </div>

      <fieldset className="space-y-3 rounded-lg border border-border bg-white/3 p-3" data-testid="form-consents">
        <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
          {t("contacts.form.consents", "Consentements de communication")}
        </legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <ConsentField
            label={t("contacts.consent.email", "Courriel")}
            value={form.email_consent}
            onChange={(value) => upd("email_consent", value)}
            options={consentOptions}
            timestamp={contact?.email_consent_at}
            testId="form-email-consent"
          />
          <ConsentField
            label={t("contacts.consent.sms", "SMS")}
            value={form.sms_consent}
            onChange={(value) => upd("sms_consent", value)}
            options={consentOptions}
            timestamp={contact?.sms_consent_at}
            testId="form-sms-consent"
          />
          <ConsentField
            label={t("contacts.consent.call", "Appels")}
            value={form.call_consent}
            onChange={(value) => upd("call_consent", value)}
            options={consentOptions}
            timestamp={contact?.call_consent_at}
            testId="form-call-consent"
          />
        </div>
        <p className="text-[10px] text-text-tertiary">
          {t("contacts.consent.hint", "Non renseigné n’est pas un accord. Un refus d’appels synchronise automatiquement la liste DNC.")}
        </p>
      </fieldset>

      <Field label={t("contacts.form.tags", "Tags")} controlId="form-tags-input">
        <div className="flex min-h-[36px] flex-wrap items-center gap-1.5 rounded-lg border border-border bg-bg-primary/60 px-2 py-1.5">
          {form.tags.map((tag) => (
            <span key={tag} className="inline-flex items-center gap-1 rounded-md bg-brand-purple/15 px-2 py-0.5 text-xs text-brand-purple">
              <Tag size={9} />{tag}
              <button type="button" onClick={() => removeTag(tag)} className="ml-0.5 rounded p-0.5 hover:bg-white/10" aria-label={`Retirer ${tag}`}>
                <X size={10} />
              </button>
            </span>
          ))}
          <input
            id="form-tags-input"
            value={tagInput}
            onChange={(event) => setTagInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addTag();
              }
              if (event.key === "Backspace" && !tagInput && form.tags.length) {
                removeTag(form.tags[form.tags.length - 1]);
              }
            }}
            placeholder={form.tags.length ? "" : t("contacts.form.tagsPlaceholder", "Ajouter (Entrée)")}
            className="min-w-[100px] flex-1 bg-transparent py-1 text-xs text-text-primary outline-none placeholder:text-text-tertiary"
            data-testid="form-tags"
          />
        </div>
      </Field>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-brand-red/30 bg-brand-red/10 px-3 py-2 text-sm text-red-300" data-testid="form-error" role="alert">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /><span>{error}</span>
        </div>
      )}

      {duplicates.length > 0 && (
        <section className="space-y-2 rounded-lg border border-brand-orange/30 bg-brand-orange/10 p-3" data-testid="form-duplicates">
          <div className="flex items-center gap-2 text-xs font-semibold text-amber-100">
            <CopyCheck size={14} />
            {t("contacts.duplicates.blocked", "Enregistrement bloqué : doublon potentiel détecté")}
          </div>
          <ul className="space-y-2">
            {duplicates.map((duplicate) => (
              <li key={duplicate.id} className="rounded-md border border-brand-orange/20 bg-bg-card px-3 py-2 text-xs" data-testid={`form-duplicate-${duplicate.id}`}>
                <div className="font-medium text-text-primary">{duplicate.full_name || "Contact sans nom"}</div>
                <div className="mt-0.5 text-text-secondary">
                  {[duplicate.phone, duplicate.email, duplicate.company].filter(Boolean).join(" · ")}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {(duplicate.match_reasons || []).map((reason) => (
                    <Badge key={reason} variant="orange" className="text-[10px]">{duplicateReasonLabel(reason)}</Badge>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-amber-100/80">
            {t("contacts.duplicates.mergeHint", "Ouvrez la fiche existante pour examiner et fusionner manuellement les données.")}
          </p>
        </section>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel} disabled={saving} data-testid="form-cancel">
            {t("common.cancel", "Annuler")}
          </Button>
        )}
        <Button type="submit" disabled={saving} data-testid="form-save">
          {saving
            ? <><Loader2 size={14} className="animate-spin" /> {t("common.saving", "Sauvegarde...")}</>
            : <><Save size={14} /> {isEdit ? t("common.save", "Enregistrer") : t("contacts.form.create", "Créer le contact")}</>}
        </Button>
      </div>
    </form>
  );
}

function Field({ label, required, children, controlId }) {
  const generatedId = useId();
  const fieldId = controlId || generatedId;
  const childNodes = React.Children.toArray(children);
  const labelledChildren = controlId
    ? childNodes
    : childNodes.map((child, index) => (
        index === 0 && React.isValidElement(child)
          ? React.cloneElement(child, { id: child.props.id || fieldId })
          : child
      ));

  return (
    <div className="space-y-1.5">
      <Label htmlFor={fieldId} required={required}>{label}</Label>
      {labelledChildren}
    </div>
  );
}

function ConsentField({ label, value, onChange, options, timestamp, testId }) {
  const fieldId = useId();
  const formattedTimestamp = formatTimestamp(timestamp);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={fieldId}>{label}</Label>
      <Select
        id={fieldId}
        value={consentValue(value)}
        onValueChange={(nextValue) => onChange(parseConsent(nextValue))}
        options={options}
        placeholder={null}
        testId={testId}
        aria-label={`${label} — consentement`}
      />
      {formattedTimestamp && (
        <div className="text-[10px] text-text-tertiary" data-testid={`${testId}-timestamp`}>
          {formattedTimestamp}
        </div>
      )}
    </div>
  );
}

function duplicateReasonLabel(reason) {
  return {
    phone: "Même téléphone",
    email: "Même courriel",
    name_company: "Nom et entreprise proches",
    name_company_fuzzy: "Nom et entreprise proches",
  }[reason] || reason;
}
