// ============================================================
// EXEVORI VOICE IA — PAGE CONTACTS (Phase 3A)
// Liste + Filtres + Search + Sort + Pagination
// Détail contact via Sheet slide-in (3 tabs)
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  Users, Snowflake, UserPlus, ShoppingBag,
  Phone, Mail, MessageSquare, Calendar as CalendarIcon, Tag, Activity,
  Plus, Upload, Eye, Sparkles, Pencil, Archive, GitMerge, PhoneCall,
  CalendarPlus, ShieldCheck, AlertTriangle, Loader2,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "../components/ui/sheet.jsx";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs.jsx";
import DataTable, { RowActionButton } from "../components/common/DataTable.jsx";
import FilterBar from "../components/common/FilterBar.jsx";
import ContactForm from "../components/contacts/ContactForm.jsx";
import ImportWizard from "../components/contacts/ImportWizard.jsx";
import { cn } from "../lib/utils.js";
import { hasPermission } from "../utils/auth-helpers.js";

const API = import.meta.env.VITE_API_URL || "";

// ─── Status meta ────────────────────────────────────────────────
const STATUS_META = {
  new:       { label: "Nouveau",  icon: UserPlus,    dot: "bg-brand",        variant: "default" },
  qualified: { label: "Qualifié", icon: Sparkles,    dot: "bg-brand-purple", variant: "purple" },
  client:    { label: "Client",   icon: ShoppingBag, dot: "bg-brand-green",  variant: "green" },
  lost:      { label: "Perdu",    icon: Snowflake,   dot: "bg-brand-red",    variant: "red" },
  archived:  { label: "Archivé",  icon: Archive,     dot: "bg-white/30",     variant: "ghost" },
};

// ────────────────────────────────────────────────────────────────
//  ROOT
// ────────────────────────────────────────────────────────────────
export default function Contacts() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { token, effectiveCompanyId, profile } = useAuth();

  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState(null);
  const [selected, setSelected] = useState(null); // contact id pour Sheet
  const [formContact, setFormContact] = useState(null); // null = create, obj = edit
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [toast, setToast] = useState(null);
  const [mergeSelection, setMergeSelection] = useState(null);
  const loadSequenceRef = useRef(0);
  const loadControllerRef = useRef(null);
  const canMerge = ["company_admin", "super_admin"].includes(profile?.role);
  const canTriggerCalls = hasPermission(profile?.role, "TRIGGER_CALLS");

  useEffect(() => {
    loadControllerRef.current?.abort();
    loadSequenceRef.current += 1;
    setContacts([]);
    setSelected(null);
    setFormContact(null);
    setShowForm(false);
    setShowImport(false);
    setMergeSelection(null);
    setToast(null);

    if (!token || !effectiveCompanyId) {
      setLoading(false);
      return undefined;
    }
    load();
    return () => {
      loadControllerRef.current?.abort();
      loadSequenceRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, effectiveCompanyId]);

  async function load() {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    const sequence = ++loadSequenceRef.current;
    loadControllerRef.current = controller;
    setLoading(true);
    try {
      const pageSize = 200;
      const fetchPage = async (offset) => {
        const params = new URLSearchParams({
          company_id: effectiveCompanyId,
          limit: String(pageSize),
          offset: String(offset),
          include_archived: "true",
        });
        const response = await fetch(`${API}/api/v1/contacts?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!response.ok) {
          const errorBody = await response.json().catch(() => ({}));
          throw new Error(errorBody.error || `HTTP ${response.status}`);
        }
        return response.json();
      };

      const firstPage = await fetchPage(0);
      const total = Number(firstPage.total) || 0;
      const offsets = [];
      for (let offset = pageSize; offset < total; offset += pageSize) {
        offsets.push(offset);
      }

      const remainingPages = [];
      for (let index = 0; index < offsets.length; index += 5) {
        const batch = await Promise.all(
          offsets.slice(index, index + 5).map(fetchPage)
        );
        remainingPages.push(...batch);
      }

      const uniqueContacts = new Map();
      for (const contact of [
        ...(firstPage.contacts || []),
        ...remainingPages.flatMap(page => page.contacts || []),
      ]) {
        if (contact?.id && contact.status !== "anonymized") {
          uniqueContacts.set(contact.id, contact);
        }
      }
      if (sequence !== loadSequenceRef.current) return;
      setContacts([...uniqueContacts.values()]);
    } catch (e) {
      if (e.name === "AbortError" || sequence !== loadSequenceRef.current) return;
      console.error("[Contacts] load error:", e);
      setToast({ type: "error", msg: e.message || "Impossible de charger les contacts" });
    } finally {
      if (sequence === loadSequenceRef.current) setLoading(false);
      if (loadControllerRef.current === controller) loadControllerRef.current = null;
    }
  }

  const filtered = useMemo(() => {
    let list = contacts.filter((contact) => contact.status !== "anonymized");
    if (statusFilter) list = list.filter((c) => c.status === statusFilter);
    else list = list.filter((contact) => contact.status !== "archived");
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      list = list.filter((c) =>
        [c.full_name, c.email, c.phone, c.company, c.main_need]
          .filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
      );
    }
    return list;
  }, [contacts, search, statusFilter]);

  // Counts par status pour FilterBar
  const statusCounts = useMemo(() => {
    const c = { new: 0, qualified: 0, client: 0, lost: 0, archived: 0 };
    contacts.forEach((ct) => { if (c[ct.status] != null) c[ct.status]++; });
    return c;
  }, [contacts]);

  const statusOptions = [
    { value: "new",       label: STATUS_META.new.label,       color: STATUS_META.new.dot,       count: statusCounts.new },
    { value: "qualified", label: STATUS_META.qualified.label, color: STATUS_META.qualified.dot, count: statusCounts.qualified },
    { value: "client",    label: STATUS_META.client.label,    color: STATUS_META.client.dot,    count: statusCounts.client },
    { value: "lost",      label: STATUS_META.lost.label,      color: STATUS_META.lost.dot,      count: statusCounts.lost },
    { value: "archived",  label: STATUS_META.archived.label,  color: STATUS_META.archived.dot,  count: statusCounts.archived },
  ];

  // ─── Columns ─────────────────────────────────────────────────
  const columns = useMemo(() => [
    {
      key: "full_name",
      header: t("contacts.col.name", "Contact"),
      render: (r) => (
        <div className="flex items-center gap-3">
          <Avatar name={r.full_name} status={r.status} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-text-primary">{r.full_name}</div>
            {r.company && <div className="truncate text-[11px] text-text-tertiary">{r.company}</div>}
          </div>
        </div>
      ),
    },
    {
      key: "status",
      header: t("contacts.col.status", "Statut"),
      width: "120px",
      render: (r) => <StatusBadge status={r.status} />,
    },
    {
      key: "phone",
      header: t("contacts.col.phone", "Téléphone"),
      width: "160px",
      render: (r) => r.phone
        ? <span className="font-mono text-xs text-text-secondary">{r.phone}</span>
        : <span className="text-text-tertiary">—</span>,
    },
    {
      key: "email",
      header: t("contacts.col.email", "Courriel"),
      render: (r) => r.email
        ? <span className="truncate text-xs text-text-secondary">{r.email}</span>
        : <span className="text-text-tertiary">—</span>,
    },
    {
      key: "main_need",
      header: t("contacts.col.need", "Besoin"),
      render: (r) => r.main_need
        ? <span className="truncate text-xs text-text-secondary" title={r.main_need}>{r.main_need}</span>
        : <span className="text-text-tertiary">—</span>,
    },
    {
      key: "next_action_date",
      header: t("contacts.col.nextAction", "Prochaine action"),
      width: "150px",
      render: (r) => (
        <div className="max-w-[170px]">
          <div className="text-xs text-text-secondary">{formatDateTime(r.next_action_date, i18n.language)}</div>
          {r.next_action_note && <div className="truncate text-[10px] text-text-tertiary" title={r.next_action_note}>{r.next_action_note}</div>}
        </div>
      ),
    },
    {
      key: "last_interaction_at",
      header: t("contacts.col.last", "Dernier contact"),
      width: "140px",
      render: (r) => <span className="text-xs text-text-tertiary">{formatRelative(r.last_interaction_at, i18n.language)}</span>,
    },
    {
      key: "actions",
      header: <span className="sr-only">{t("common.actions", "Actions")}</span>,
      width: "52px",
      sortable: false,
      render: (r) => (
        <RowActionButton
          type="button"
          onClick={() => setSelected(r.id)}
          data-testid={`view-${r.id}`}
          aria-label={t("contacts.openContact", "Ouvrir la fiche de {{name}}", { name: r.full_name })}
          className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple"
        >
          <Eye size={14} />
        </RowActionButton>
      ),
    },
  ], [t, i18n.language]);

  return (
    <div className="space-y-5 animate-fade-in" data-testid="contacts-page">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-tertiary mb-1">
            <Users size={11} /> CRM
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary" data-testid="contacts-title">
            {t("contacts.title", "Contacts")}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            {t("contacts.subtitle", "Suivez chaque relation, du premier échange jusqu'au client — sans perdre la prochaine action.")}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowImport(true)}
            data-testid="btn-import"
          >
            <Upload size={14} /> {t("contacts.import", "Importer CSV")}
          </Button>
          <Button
            size="sm"
            onClick={() => { setFormContact(null); setShowForm(true); }}
            data-testid="btn-new-contact"
          >
            <Plus size={14} /> {t("contacts.new", "Nouveau contact")}
          </Button>
        </div>
      </div>

      {/* FilterBar */}
      <FilterBar
        testId="contacts-filterbar"
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder={t("contacts.searchPlaceholder", "Nom, courriel, téléphone…")}
        filters={[
          { key: "status", label: t("contacts.filter.status", "Statut"), options: statusOptions, current: statusFilter },
        ]}
        onFilterChange={(_k, v) => setStatusFilter(v)}
      />

      {/* DataTable */}
      <DataTable
        testId="contacts-table"
        columns={columns}
        data={filtered}
        rowKey="id"
        loading={loading}
        onRowClick={(row) => setSelected(row.id)}
        emptyState={{
          icon: Users,
          title: t("contacts.empty.title", "Aucun contact"),
          description: search || statusFilter
            ? t("contacts.empty.filtered", "Aucun contact ne correspond à vos critères")
            : t("contacts.empty.default", "Les contacts apparaîtront ici dès qu'ils interagissent avec votre assistante"),
        }}
      />

      {/* Detail Sheet */}
      <ContactDetailSheet
        contactId={selected}
        open={!!selected}
        onClose={() => setSelected(null)}
        token={token}
        companyId={effectiveCompanyId}
        t={t}
        lang={i18n.language}
        canMerge={canMerge}
        canTriggerCalls={canTriggerCalls}
        onVoiceCall={(contact) => navigate(`/outbound?contact_id=${encodeURIComponent(contact.id)}`)}
        onBookAppointment={(contact) => navigate(`/calendar?contact_id=${encodeURIComponent(contact.id)}`)}
        onMerge={(primary, duplicate) => {
          setSelected(null);
          setMergeSelection({ primary, duplicate });
        }}
        onEdit={(c) => { setSelected(null); setFormContact(c); setShowForm(true); }}
        onArchive={async (c) => {
          if (!window.confirm(t("contacts.confirmArchive", "Archiver {{name}} ? Son historique sera conservé.", { name: c.full_name }))) return;
          try {
            const res = await fetch(`${API}/api/v1/contacts/${c.id}`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${token}` },
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
            setSelected(null);
            setContacts((arr) => arr.map((item) => (
              item.id === c.id
                ? {
                    ...item,
                    ...(body.contact || {}),
                    status: "archived",
                    next_action: null,
                    next_action_date: null,
                    next_action_note: null,
                  }
                : item
            )));
            setToast({ type: "success", msg: t("contacts.archived", "Contact archivé") });
          } catch (e) {
            setToast({ type: "error", msg: e.message });
          }
        }}
      />

      <MergeContactsSheet
        selection={mergeSelection}
        open={Boolean(mergeSelection)}
        token={token}
        onClose={() => setMergeSelection(null)}
        onMerged={(result) => {
          const primary = result.contact || mergeSelection?.primary;
          const mergedId = result.merged_contact_id || mergeSelection?.duplicate?.id;
          setContacts((items) => items.map((item) => {
            if (item.id === primary?.id) return { ...item, ...primary };
            if (item.id === mergedId) {
              return {
                ...item,
                status: "archived",
                merged_into_contact_id: primary?.id || null,
                next_action: null,
                next_action_date: null,
                next_action_note: null,
              };
            }
            return item;
          }));
          setMergeSelection(null);
          setToast({ type: "success", msg: t("contacts.duplicates.merged", "Contacts fusionnés avec succès") });
        }}
      />

      {/* Contact Form Sheet (create + edit) */}
      <Sheet open={showForm} onOpenChange={(o) => !o && setShowForm(false)}>
        <SheetContent data-testid="contact-form-sheet" className="overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>
              {formContact?.id
                ? t("contacts.form.editTitle", "Modifier le contact")
                : t("contacts.form.newTitle", "Nouveau contact")}
            </SheetTitle>
            <SheetDescription>
              {formContact?.id
                ? t("contacts.form.editSubtitle", "Mettez à jour les informations.")
                : t("contacts.form.newSubtitle", "Ajoutez manuellement une fiche contact.")}
            </SheetDescription>
          </SheetHeader>
          <div className="px-6 py-4">
            <ContactForm
              key={formContact?.id || "new"}
              contact={formContact}
              companyId={effectiveCompanyId}
              token={token}
              onCancel={() => setShowForm(false)}
              onSaved={(saved) => {
                setShowForm(false);
                setToast({
                  type: "success",
                  msg: formContact?.id
                    ? t("contacts.updated", "Contact mis à jour")
                    : t("contacts.created", "Contact créé"),
                });
                if (formContact?.id) {
                  setContacts((arr) => arr.map((c) => (c.id === saved.id ? { ...c, ...saved } : c)));
                } else {
                  setContacts((arr) => [saved, ...arr]);
                }
              }}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* Import CSV Wizard */}
      <ImportWizard
        key={effectiveCompanyId || "no-company"}
        open={showImport}
        onClose={() => setShowImport(false)}
        companyId={effectiveCompanyId}
        token={token}
        onImported={(res) => {
          setToast({
            type: "success",
            msg: t("contacts.importDone", "{{imported}} importés, {{updated}} mis à jour, {{skipped}} ignorés", {
              imported: res?.imported || 0,
              updated:  res?.updated  || 0,
              skipped:  res?.skipped  || 0,
            }),
          });
          load();
        }}
      />

      {/* Toast */}
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
//  DÉTAIL CONTACT — SHEET avec 3 tabs
// ────────────────────────────────────────────────────────────────
function ContactDetailSheet({
  contactId,
  open,
  onClose,
  token,
  companyId,
  t,
  lang,
  canMerge,
  canTriggerCalls,
  onEdit,
  onArchive,
  onMerge,
  onVoiceCall,
  onBookAppointment,
}) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [duplicates, setDuplicates] = useState([]);
  const [duplicatesLoading, setDuplicatesLoading] = useState(false);
  const [duplicatesError, setDuplicatesError] = useState(null);

  useEffect(() => {
    if (!contactId || !token) return;
    const controller = new AbortController();
    setDetail(null);
    setDuplicates([]);
    setLoadError(null);
    setDuplicatesError(null);
    setLoading(true);
    setDuplicatesLoading(true);

    const headers = { Authorization: `Bearer ${token}` };
    const loadDetail = async () => {
      const response = await fetch(`${API}/api/v1/contacts/${contactId}?company_id=${encodeURIComponent(companyId)}`, {
        headers,
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setDetail(body);
    };
    const loadDuplicates = async () => {
      try {
        const response = await fetch(`${API}/api/v1/contacts/${contactId}/duplicates?company_id=${encodeURIComponent(companyId)}`, {
          headers,
          signal: controller.signal,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        setDuplicates(Array.isArray(body.duplicates) ? body.duplicates : []);
      } catch (error) {
        if (error.name !== "AbortError") setDuplicatesError(error.message);
      } finally {
        if (!controller.signal.aborted) setDuplicatesLoading(false);
      }
    };

    loadDetail()
      .catch((error) => {
        if (error.name !== "AbortError") setLoadError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    loadDuplicates();

    return () => controller.abort();
  }, [companyId, contactId, token]);

  const c = detail?.contact;
  const archived = c?.status === "archived";
  const voiceCallDisabled = !canTriggerCalls || !c?.phone || c?.call_consent !== true || archived;
  const voiceCallTitle = !canTriggerCalls
    ? t("contacts.quick.voiceForbidden", "Seul un responsable peut lancer un appel Voice IA.")
    : archived
    ? t("contacts.quick.voiceArchived", "Un contact archivé ne peut pas être appelé.")
    : !c?.phone
      ? t("contacts.quick.voiceNoPhone", "Ajoutez un téléphone E.164 pour appeler.")
      : c?.call_consent !== true
        ? t("contacts.quick.voiceNoConsent", "Un accord explicite aux appels est requis.")
        : t("contacts.quick.voice", "Préparer un appel sortant avec Voice IA");
  const emailActionDisabled = archived || c?.email_consent !== true;
  const emailActionTitle = archived
    ? t("contacts.quick.emailArchived", "Un contact archivé ne peut pas être contacté par courriel.")
    : c?.email_consent === false
      ? t("contacts.quick.emailDenied", "Ce contact a refusé les communications par courriel.")
      : t("contacts.quick.emailUnknown", "Un accord explicite aux courriels est requis.");

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent data-testid="contact-detail-sheet" className="overflow-y-auto">
        {loading ? (
          <>
            <SheetHeader>
              <SheetTitle className="sr-only">{t("contacts.detail.loading", "Chargement du contact")}</SheetTitle>
            </SheetHeader>
            <div className="p-6 space-y-3">
              <div className="h-16 w-16 rounded-full bg-white/5 animate-pulse" />
              <div className="h-4 w-2/3 rounded bg-white/5 animate-pulse" />
              <div className="h-3 w-1/2 rounded bg-white/5 animate-pulse" />
            </div>
          </>
        ) : loadError || !c ? (
          <>
            <SheetHeader>
              <SheetTitle>{t("contacts.detail.errorTitle", "Contact indisponible")}</SheetTitle>
              <SheetDescription>{loadError || t("contacts.detail.error", "Impossible de charger cette fiche.")}</SheetDescription>
            </SheetHeader>
            <div className="flex items-start gap-2 p-6 text-sm text-red-300" role="alert" data-testid="contact-detail-error">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              {loadError || t("contacts.detail.error", "Impossible de charger cette fiche.")}
            </div>
          </>
        ) : (
          <>
            <SheetHeader>
              <div className="flex items-start gap-4 pr-10">
                <Avatar name={c.full_name} status={c.status} size="lg" />
                <div className="flex-1 min-w-0">
                  <SheetTitle data-testid="detail-name">{c.full_name}</SheetTitle>
                  <div className="flex flex-wrap items-center gap-2 mt-1.5 text-sm text-text-secondary">
                    <StatusBadge status={c.status} />
                    <UrgencyPill urgency={c.urgency} />
                    {c.tags?.length > 0 && c.tags.slice(0, 3).map((tg) => (
                      <Badge key={tg} variant="ghost"><Tag size={9} />{tg}</Badge>
                    ))}
                  </div>
                </div>
              </div>

              {/* Quick contact actions */}
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={voiceCallDisabled}
                  onClick={() => onVoiceCall?.(c)}
                  title={voiceCallTitle}
                  data-testid="quick-voice-call"
                >
                  <PhoneCall size={12} /> {t("contacts.quick.voice", "Appeler avec Voice IA")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={c.status === "archived"}
                  onClick={() => onBookAppointment?.(c)}
                  title={c.status === "archived" ? t("contacts.quick.appointmentArchived", "Un contact archivé ne peut pas prendre de rendez-vous.") : undefined}
                  data-testid="quick-book-appointment"
                >
                  <CalendarPlus size={12} /> {t("contacts.quick.appointment", "Prendre un RDV")}
                </Button>
                {c.email && !emailActionDisabled && (
                  <Button size="sm" variant="secondary" asChild data-testid="detail-email">
                    <a href={`mailto:${c.email}`}><Mail size={12} /> Courriel</a>
                  </Button>
                )}
                {c.email && emailActionDisabled && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled
                    title={emailActionTitle}
                    data-testid="detail-email"
                  >
                    <Mail size={12} /> Courriel
                  </Button>
                )}
                <div className="ml-auto flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onEdit?.(c)}
                    disabled={c.status === "archived"}
                    data-testid="detail-edit"
                  >
                    <Pencil size={12} /> {t("common.edit", "Modifier")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onArchive?.(c)}
                    disabled={c.status === "archived"}
                    title={t("contacts.archive", "Archiver")}
                    aria-label={t("contacts.archive", "Archiver")}
                    data-testid="detail-archive"
                  >
                    <Archive size={12} />
                  </Button>
                </div>
              </div>
              {voiceCallDisabled && (
                <p className="mt-2 text-[10px] text-text-tertiary" data-testid="quick-voice-disabled-reason">
                  {voiceCallTitle}
                </p>
              )}
            </SheetHeader>

            <div className="px-6 py-4">
              <DuplicateCandidates
                contact={c}
                duplicates={duplicates}
                loading={duplicatesLoading}
                error={duplicatesError}
                canMerge={canMerge}
                onMerge={(duplicate) => onMerge?.(c, duplicate)}
                t={t}
              />
              <Tabs defaultValue="ai" data-testid="detail-tabs">
                <TabsList className="w-full grid grid-cols-4">
                  <TabsTrigger value="ai" data-testid="tab-ai">
                    {t("contacts.tabs.ai", "IA")}
                    {(detail.history?.calls?.length > 0 || detail.history?.learning_suggestions?.length > 0) && (
                      <span className="ml-1.5 rounded-full bg-brand-purple/20 text-brand-purple px-1.5 py-0.5 text-[10px] tabular-nums">
                        {(detail.history?.calls?.length || 0) + (detail.history?.learning_suggestions?.length || 0)}
                      </span>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="infos" data-testid="tab-infos">{t("contacts.tabs.info", "Infos")}</TabsTrigger>
                  <TabsTrigger value="history" data-testid="tab-history">
                    {t("contacts.tabs.history", "Historique")}
                    {detail.stats?.total_interactions > 0 && (
                      <span className="ml-1.5 rounded-full bg-white/8 px-1.5 py-0.5 text-[10px] tabular-nums">
                        {detail.stats.total_interactions}
                      </span>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="notes" data-testid="tab-notes">
                    {t("contacts.tabs.notes", "Notes")}
                    {detail.history?.notes?.length > 0 && (
                      <span className="ml-1.5 rounded-full bg-white/8 px-1.5 py-0.5 text-[10px] tabular-nums">
                        {detail.history.notes.length}
                      </span>
                    )}
                  </TabsTrigger>
                </TabsList>

                {/* ── TAB IA — 3 zones (Léa / Humain / Hésitations) ── */}
                <TabsContent value="ai">
                  <AiTab
                    contact={c}
                    calls={detail.history?.calls || []}
                    suggestions={detail.history?.learning_suggestions || []}
                    token={token}
                    onContactUpdate={(updated) => setDetail((d) => ({ ...d, contact: { ...d.contact, ...updated } }))}
                    onSuggestionResolved={(sid) => setDetail((d) => ({
                      ...d,
                      history: { ...d.history, learning_suggestions: d.history.learning_suggestions.filter(s => s.id !== sid) },
                    }))}
                    t={t}
                    lang={lang}
                  />
                </TabsContent>

                {/* ── TAB INFOS ── */}
                <TabsContent value="infos">
                  <InfoTab contact={c} t={t} lang={lang} />
                </TabsContent>

                {/* ── TAB HISTORIQUE ── */}
                <TabsContent value="history">
                  <HistoryTab history={detail.history} t={t} lang={lang} />
                </TabsContent>

                {/* ── TAB NOTES ── */}
                <TabsContent value="notes">
                  <NotesTab notes={detail.history?.notes || []} t={t} lang={lang} />
                </TabsContent>
              </Tabs>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function DuplicateCandidates({ duplicates, loading, error, canMerge, onMerge, t }) {
  if (loading) {
    return (
      <section className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-white/3 px-3 py-2 text-xs text-text-secondary" data-testid="contact-duplicates">
        <Loader2 size={13} className="animate-spin" />
        {t("contacts.duplicates.loading", "Recherche de doublons potentiels…")}
      </section>
    );
  }

  if (error) {
    return (
      <section className="mb-4 flex items-start gap-2 rounded-lg border border-brand-orange/30 bg-brand-orange/10 px-3 py-2 text-xs text-amber-100" data-testid="contact-duplicates" role="status">
        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
        {t("contacts.duplicates.unavailable", "La recherche de doublons est temporairement indisponible.")}
      </section>
    );
  }

  if (!duplicates.length) return null;

  return (
    <section className="mb-4 space-y-2 rounded-xl border border-brand-orange/30 bg-brand-orange/8 p-3" data-testid="contact-duplicates">
      <div className="flex items-center gap-2">
        <GitMerge size={14} className="text-brand-orange" />
        <h3 className="text-xs font-semibold text-text-primary">
          {t("contacts.duplicates.title", "Doublons potentiels")}
        </h3>
        <Badge variant="orange" className="ml-auto text-[10px]">{duplicates.length}</Badge>
      </div>
      <p className="text-[10px] text-text-tertiary">
        {canMerge
          ? t("contacts.duplicates.review", "Vérifiez les deux fiches avant de choisir celle à conserver.")
          : t("contacts.duplicates.adminOnly", "Seul un administrateur de l’entreprise peut fusionner des fiches.")}
      </p>
      <ul className="space-y-2">
        {duplicates.map((duplicate) => (
          <li key={duplicate.id} className="rounded-lg border border-border bg-bg-card p-3" data-testid={`contact-duplicate-${duplicate.id}`}>
            <div className="flex items-start gap-3">
              <Avatar name={duplicate.full_name} status={duplicate.status} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-text-primary">{duplicate.full_name || "Contact sans nom"}</div>
                <div className="mt-0.5 truncate text-[10px] text-text-secondary">
                  {[duplicate.company, duplicate.phone, duplicate.email].filter(Boolean).join(" · ") || "—"}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {(duplicate.match_reasons || []).map((reason) => (
                    <Badge key={reason} variant="orange" className="text-[10px]">{duplicateReasonLabel(reason)}</Badge>
                  ))}
                  {duplicate.similarity_score != null && (
                    <Badge variant="ghost" className="text-[10px]">{formatSimilarity(duplicate.similarity_score)}</Badge>
                  )}
                </div>
              </div>
              {canMerge && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onMerge(duplicate)}
                  data-testid={`merge-contact-${duplicate.id}`}
                >
                  <GitMerge size={12} /> {t("contacts.duplicates.merge", "Fusionner")}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MergeContactsSheet({ selection, open, token, onClose, onMerged }) {
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState(null);
  const primary = selection?.primary;
  const duplicate = selection?.duplicate;

  useEffect(() => {
    setMerging(false);
    setError(null);
  }, [primary?.id, duplicate?.id]);

  const merge = async () => {
    if (!primary?.id || !duplicate?.id || merging) return;
    setMerging(true);
    setError(null);
    try {
      const response = await fetch(`${API}/api/v1/contacts/${primary.id}/merge`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ duplicate_contact_id: duplicate.id }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      onMerged?.(body);
    } catch (mergeError) {
      setError(mergeError.message || "La fusion a échoué.");
    } finally {
      setMerging(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(nextOpen) => !nextOpen && !merging && onClose()}>
      <SheetContent data-testid="merge-contacts-sheet" className="overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Confirmer la fusion</SheetTitle>
          <SheetDescription>
            Les interactions seront rattachées à la fiche conservée. La fiche doublon sera archivée, jamais supprimée.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-6 py-5">
          <MergeContactCard label="Fiche conservée" contact={primary} tone="keep" testId="merge-primary" />
          <div className="flex justify-center text-text-tertiary"><GitMerge size={18} /></div>
          <MergeContactCard label="Fiche archivée après fusion" contact={duplicate} tone="archive" testId="merge-duplicate" />

          <div className="flex items-start gap-2 rounded-lg border border-brand-orange/30 bg-brand-orange/10 px-3 py-2.5 text-xs text-amber-100">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            Vérifiez le sens de la fusion : cette opération regroupe l’historique et ne peut pas être annulée depuis l’interface.
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-brand-red/30 bg-brand-red/10 px-3 py-2 text-sm text-red-300" role="alert" data-testid="merge-error">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button variant="secondary" onClick={onClose} disabled={merging} data-testid="cancel-merge">
              Annuler
            </Button>
            <Button onClick={merge} disabled={!primary || !duplicate || merging} data-testid="confirm-merge">
              {merging ? <><Loader2 size={14} className="animate-spin" /> Fusion…</> : <><GitMerge size={14} /> Confirmer la fusion</>}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function MergeContactCard({ label, contact, tone, testId }) {
  return (
    <section className={cn(
      "rounded-xl border p-4",
      tone === "keep"
        ? "border-brand-green/30 bg-brand-green/8"
        : "border-border bg-white/3",
    )} data-testid={testId}>
      <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
        {tone === "keep" ? <ShieldCheck size={12} className="text-brand-green" /> : <Archive size={12} />}
        {label}
      </div>
      <div className="text-sm font-semibold text-text-primary">{contact?.full_name || "—"}</div>
      <dl className="mt-2 space-y-1 text-xs text-text-secondary">
        <div><dt className="inline text-text-tertiary">Téléphone : </dt><dd className="inline font-mono">{contact?.phone || "—"}</dd></div>
        <div><dt className="inline text-text-tertiary">Courriel : </dt><dd className="inline">{contact?.email || "—"}</dd></div>
        <div><dt className="inline text-text-tertiary">Entreprise : </dt><dd className="inline">{contact?.company || "—"}</dd></div>
      </dl>
    </section>
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

function formatSimilarity(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "";
  const percent = numeric <= 1 ? numeric * 100 : numeric;
  return `${Math.round(percent)} % similaire`;
}

// ────────────────────────────────────────────────────────────────
//  AI TAB — 3 zones (Léa / Humain / Hésitations)
// ────────────────────────────────────────────────────────────────
function formatTranscript(raw) {
  if (!raw) return "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((t) => {
        const role = t.role === "agent" || t.role === "assistant" ? "Léa" : (t.role || "?");
        const msg = t.message || t.text || t.content || "";
        return `${role}: ${msg}`;
      })
      .join("\n");
  }
  try { return JSON.stringify(raw, null, 2); } catch { return String(raw); }
}

function AiTab({ contact: c, calls, suggestions, token, onContactUpdate, onSuggestionResolved, t, lang }) {
  // Plus récent appel (avec ai_summary / intent / etc.)
  const lastCall = (calls || []).find((cc) => cc.ai_summary || cc.ai_transcript) || calls?.[0] || null;
  const pendingSuggestions = (suggestions || []).filter((s) => s.status === "pending");

  return (
    <div className="space-y-4" data-testid="ai-tab">
      {/* ZONE BLEUE — Léa (in-band, IA) */}
      <LeaZone call={lastCall} t={t} lang={lang} />

      {/* ZONE VERTE — Humain (out-of-band) */}
      <HumanNotesZone contact={c} token={token} onUpdate={onContactUpdate} t={t} />

      {/* ZONE VIOLETTE — Hésitations IA */}
      <HesitationsZone
        suggestions={pendingSuggestions}
        token={token}
        onResolved={onSuggestionResolved}
        t={t}
        lang={lang}
      />
    </div>
  );
}

function LeaZone({ call, t, lang }) {
  return (
    <section
      data-testid="ai-zone-lea"
      className="rounded-xl border border-brand/30 bg-brand/8 p-4"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-brand/20 text-brand">
            <Sparkles size={14} />
          </div>
          <h4 className="text-sm font-semibold text-text-primary">
            {t("contacts.ai.lea_title", "Notes Léa (IA)")}
          </h4>
        </div>
        {call?.confidence_score != null && (
          <Badge variant="ghost" className="text-[10px]" data-testid="lea-confidence">
            {t("contacts.ai.confidence", "Confiance")} {call.confidence_score}%
          </Badge>
        )}
      </div>

      {!call ? (
        <p className="text-xs text-text-tertiary">
          {t("contacts.ai.lea_empty", "Aucun appel analysé pour ce contact.")}
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {call.intent && (
              <Badge variant="ghost" className="text-[10px]" data-testid="lea-intent">
                <Tag size={9} /> {call.intent}
              </Badge>
            )}
            {call.outcome && (
              <Badge variant="ghost" className="text-[10px]" data-testid="lea-outcome">
                <Activity size={9} /> {call.outcome}
              </Badge>
            )}
            {call.duration_seconds != null && (
              <Badge variant="ghost" className="text-[10px]">
                <Phone size={9} /> {Math.round(call.duration_seconds)}s
              </Badge>
            )}
            <Badge variant="ghost" className="text-[10px]">
              {formatRelative(call.created_at, lang)}
            </Badge>
          </div>

          {call.ai_summary && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1">
                {t("contacts.ai.summary", "Résumé")}
              </div>
              <p className="text-sm text-text-primary whitespace-pre-wrap" data-testid="lea-summary">
                {call.ai_summary}
              </p>
            </div>
          )}

          {call.ai_transcript && (
            <details>
              <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-text-tertiary hover:text-text-secondary">
                {t("contacts.ai.transcript", "Transcript complet")}
              </summary>
              <pre
                data-testid="lea-transcript"
                className="mt-2 max-h-72 overflow-y-auto rounded-md border border-border bg-bg-elev px-3 py-2 text-xs text-text-secondary whitespace-pre-wrap font-mono"
              >
                {formatTranscript(call.ai_transcript)}
              </pre>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function HumanNotesZone({ contact: c, token, onUpdate, t }) {
  const [value, setValue] = useState(c?.notes || "");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const readOnly = c?.status === "archived";

  useEffect(() => {
    setValue(c?.notes || "");
    setSaveError(null);
  }, [c?.id, c?.notes]);

  const save = async () => {
    if (saving || readOnly) return;
    setSaving(true);
    setSaveError(null);
    try {
      const r = await fetch(`${API}/api/v1/contacts/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ notes: value }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      onUpdate?.(d.contact || { notes: value });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (error) {
      setSaveError(error.message || t("contacts.ai.saveError", "Impossible d’enregistrer la note."));
    } finally {
      setSaving(false);
    }
  };

  const dirty = (c?.notes || "") !== value;

  return (
    <section
      data-testid="ai-zone-human"
      className="rounded-xl border border-brand-green/30 bg-brand-green/8 p-4"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-green/20 text-brand-green">
            <Pencil size={14} />
          </div>
          <h4 className="text-sm font-semibold text-text-primary">
            {t("contacts.ai.human_title", "Notes humaines")}
          </h4>
        </div>
        {savedFlash && (
          <span className="text-[10px] text-brand-green animate-fade-in">
            {t("contacts.ai.saved", "Enregistré ✓")}
          </span>
        )}
      </div>

      <textarea
        data-testid="ai-human-notes"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t("contacts.ai.human_placeholder", "Notes éditables sur ce contact (rappels, contexte, préférences)…")}
        rows={5}
        disabled={readOnly}
        aria-label={t("contacts.ai.human_title", "Notes humaines")}
        aria-describedby={readOnly ? "archived-contact-notes-hint" : undefined}
        className="w-full rounded-md border border-border bg-bg-elev px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-brand-green focus:outline-none resize-y disabled:cursor-not-allowed disabled:opacity-60"
      />

      {readOnly && (
        <p id="archived-contact-notes-hint" className="mt-2 text-xs text-text-tertiary">
          {t("contacts.ai.archivedReadOnly", "Ce contact est archivé : ses notes sont conservées en lecture seule.")}
        </p>
      )}

      {saveError && <p className="mt-2 text-xs text-red-300" role="alert" data-testid="ai-human-error">{saveError}</p>}

      <div className="mt-2 flex items-center justify-end">
        <Button
          size="sm"
          variant="secondary"
          onClick={save}
          disabled={readOnly || !dirty || saving}
          title={readOnly ? t("contacts.ai.archivedReadOnly", "Ce contact est archivé : ses notes sont conservées en lecture seule.") : undefined}
          data-testid="ai-human-save"
        >
          {saving ? t("common.saving", "Enregistrement…") : t("common.save", "Enregistrer")}
        </Button>
      </div>
    </section>
  );
}

function HesitationsZone({ suggestions, token, onResolved, t, lang }) {
  const [handlingId, setHandlingId] = useState(null);
  const [handleError, setHandleError] = useState(null);
  const handle = async (id, action) => {
    setHandlingId(id);
    setHandleError(null);
    const path = action === "approve" ? "approve" : "reject";
    try {
      const r = await fetch(`${API}/api/v1/learning/suggestions/${id}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      onResolved?.(id);
    } catch (error) {
      setHandleError(error.message || t("contacts.ai.actionError", "Impossible de traiter cette suggestion."));
    } finally {
      setHandlingId(null);
    }
  };

  return (
    <section
      data-testid="ai-zone-hesitations"
      className="rounded-xl border border-brand-purple/30 bg-brand-purple/8 p-4"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-purple/20 text-brand-purple">
            <MessageSquare size={14} />
          </div>
          <h4 className="text-sm font-semibold text-text-primary">
            {t("contacts.ai.hesitations_title", "Hésitations IA")}
          </h4>
        </div>
        {suggestions.length > 0 && (
          <Badge variant="ghost" className="text-[10px]">
            {suggestions.length} {t("contacts.ai.pending", "en attente")}
          </Badge>
        )}
      </div>

      {suggestions.length === 0 ? (
        <p className="text-xs text-text-tertiary">
          {t("contacts.ai.hesitations_empty", "Aucune hésitation détectée — Léa a su répondre.")}
        </p>
      ) : (
        <ul className="space-y-3" data-testid="hesitations-list">
          {suggestions.map((s) => (
            <li
              key={s.id}
              className="rounded-lg border border-brand-purple/20 bg-brand-purple/4 p-3"
              data-testid={`hesitation-${s.id}`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] uppercase tracking-wider text-text-tertiary">
                  {formatRelative(s.detected_at, lang)}
                </span>
                {s.confidence != null && (
                  <span className="text-[10px] text-text-tertiary tabular-nums">
                    {s.confidence}%
                  </span>
                )}
              </div>
              <div className="space-y-2 text-sm">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-text-tertiary">
                    {t("contacts.ai.question", "Question")}
                  </div>
                  <p className="text-text-primary">{s.question}</p>
                </div>
                {s.proposed_answer && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-text-tertiary">
                      {t("contacts.ai.suggested_kb", "À ajouter à la KB")}
                    </div>
                    <p className="text-text-secondary italic">{s.proposed_answer}</p>
                  </div>
                )}
              </div>
              <div className="mt-3 flex items-center gap-2 justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-red-300 hover:text-red-200 hover:bg-brand-red/10"
                  onClick={() => handle(s.id, "reject")}
                  disabled={handlingId === s.id}
                  data-testid={`hesitation-reject-${s.id}`}
                >
                  {t("contacts.ai.reject", "Refuser")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => handle(s.id, "approve")}
                  disabled={handlingId === s.id}
                  data-testid={`hesitation-approve-${s.id}`}
                >
                  {t("contacts.ai.approve", "Approuver")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {handleError && <p className="mt-2 text-xs text-red-300" role="alert" data-testid="hesitations-error">{handleError}</p>}
    </section>
  );
}

// ────────────────────────────────────────────────────────────────
//  TABS CONTENT
// ────────────────────────────────────────────────────────────────
function InfoTab({ contact: c, t, lang }) {
  const rows = [
    { label: t("contacts.field.email", "Courriel"),     value: c.email,         icon: Mail },
    { label: t("contacts.field.phone", "Téléphone"),    value: c.phone,         icon: Phone, mono: true },
    { label: t("contacts.field.company", "Entreprise"), value: c.company,       icon: Users },
    { label: t("contacts.field.source", "Source"),      value: c.source,        icon: Sparkles },
    { label: t("contacts.field.need", "Besoin"),        value: c.main_need,     icon: MessageSquare },
    { label: t("contacts.field.budget", "Budget"),      value: c.budget,        icon: Tag },
    { label: t("contacts.field.nextDate", "Date de prochaine action"), value: formatDateTime(c.next_action_date, lang), icon: CalendarIcon },
    { label: t("contacts.field.nextNote", "Prochaine action"), value: c.next_action_note, icon: Activity },
    { label: t("contacts.field.created", "Créé le"),    value: formatDate(c.created_at, lang) },
    { label: t("contacts.field.last", "Dernier contact"), value: formatRelative(c.last_interaction_at, lang) },
  ];
  return (
    <div className="space-y-4">
      <dl className="space-y-2.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-3 rounded-lg border border-border bg-white/3 px-3 py-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-white/5 text-text-tertiary shrink-0">
              {r.icon ? <r.icon size={13} /> : <span className="text-[10px]">·</span>}
            </div>
            <div className="flex-1 min-w-0">
              <dt className="text-[10px] uppercase tracking-wider text-text-tertiary">{r.label}</dt>
              <dd className={cn("mt-0.5 text-sm text-text-primary truncate", r.mono && "font-mono")}>
                {r.value || <span className="text-text-tertiary">—</span>}
              </dd>
            </div>
          </div>
        ))}
        {c.tags?.length > 0 && (
          <div className="rounded-lg border border-border bg-white/3 px-3 py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-2">
              {t("contacts.field.tags", "Tags")}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {c.tags.map((tg) => <Badge key={tg} variant="purple"><Tag size={9} />{tg}</Badge>)}
            </div>
          </div>
        )}
      </dl>
      <ConsentSummary contact={c} t={t} lang={lang} />
    </div>
  );
}

function ConsentSummary({ contact, t, lang }) {
  const consents = [
    { key: "email", label: t("contacts.consent.email", "Courriel"), value: contact.email_consent, at: contact.email_consent_at },
    { key: "sms", label: t("contacts.consent.sms", "SMS"), value: contact.sms_consent, at: contact.sms_consent_at },
    { key: "call", label: t("contacts.consent.call", "Appels"), value: contact.call_consent, at: contact.call_consent_at },
  ];
  return (
    <section className="rounded-xl border border-border bg-white/3 p-3" data-testid="contact-consents">
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck size={14} className="text-brand-purple" />
        <h4 className="text-xs font-semibold text-text-primary">{t("contacts.consent.title", "Consentements de communication")}</h4>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {consents.map((consent) => {
          const state = consent.value === true
            ? { label: t("contacts.consent.granted", "Accord"), variant: "green" }
            : consent.value === false
              ? { label: t("contacts.consent.denied", "Refus"), variant: "red" }
              : { label: t("contacts.consent.unset", "Non renseigné"), variant: "ghost" };
          return (
            <div key={consent.key} className="rounded-lg border border-border bg-bg-card p-2.5" data-testid={`consent-${consent.key}`}>
              <div className="text-[10px] uppercase tracking-wider text-text-tertiary">{consent.label}</div>
              <Badge variant={state.variant} className="mt-1.5">{state.label}</Badge>
              <div className="mt-1 text-[10px] text-text-tertiary">
                {consent.at ? formatDateTime(consent.at, lang) : t("contacts.consent.noTimestamp", "Aucune décision enregistrée")}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function HistoryTab({ history, t, lang }) {
  const events = useMemo(() => {
    const all = [
      ...(history.calls || []).map((c) => ({ ...c, _type: "call", _at: c.created_at })),
      ...(history.outbound_calls || []).map((c) => ({ ...c, _type: "outbound", _at: c.created_at })),
      ...(history.emails || []).map((e) => ({ ...e, _type: "email", _at: e.received_at })),
      ...(history.appointments || []).map((a) => ({ ...a, _type: "appointment", _at: a.date })),
    ];
    return all.sort((a, b) => new Date(b._at) - new Date(a._at));
  }, [history]);

  if (events.length === 0) {
    return <div className="py-8 text-center text-xs text-text-tertiary">{t("contacts.history.empty", "Aucun historique")}</div>;
  }

  return (
    <ul className="space-y-2" data-testid="history-list">
      {events.map((e, i) => <HistoryItem key={i} event={e} t={t} lang={lang} />)}
    </ul>
  );
}

function HistoryItem({ event: e, t, lang }) {
  const map = {
    call:        { Icon: Phone,         color: "blue",   label: "Appel entrant" },
    outbound:    { Icon: Phone,         color: "purple", label: "Appel sortant" },
    email:       { Icon: Mail,          color: "purple", label: "Courriel" },
    appointment: { Icon: CalendarIcon,  color: "pink",   label: "Rendez-vous" },
  };
  const m = map[e._type];
  const colorBg = { blue: "bg-brand/10 text-brand", purple: "bg-brand-purple/10 text-brand-purple", pink: "bg-brand-pink/10 text-brand-pink" }[m.color];

  return (
    <li className="flex items-start gap-3 rounded-lg border border-border bg-white/3 px-3 py-2.5">
      <div className={cn("flex h-7 w-7 items-center justify-center rounded-md shrink-0", colorBg)}>
        <m.Icon size={13} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-text-primary">{m.label}</span>
          <span className="text-[10px] text-text-tertiary shrink-0">{formatRelative(e._at, lang)}</span>
        </div>
        <div className="mt-1 text-xs text-text-secondary line-clamp-2">
          {e._type === "email"
            ? (e.subject || e.body?.slice(0, 100))
            : (e.ai_summary || e.transcript_summary || e.notes || e.type || "—")}
        </div>
        {(e.outcome || e.status) && (
          <div className="mt-1.5">
            <Badge variant="ghost" className="text-[10px]">{e.outcome || e.status}</Badge>
          </div>
        )}
      </div>
    </li>
  );
}

function NotesTab({ notes, t, lang }) {
  if (notes.length === 0) {
    return <div className="py-8 text-center text-xs text-text-tertiary">{t("contacts.notes.empty", "Aucune note ajoutée pour ce contact")}</div>;
  }
  return (
    <ul className="space-y-2" data-testid="notes-list">
      {notes.map((n) => (
        <li key={n.id} className="rounded-lg border border-border bg-white/3 p-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] uppercase tracking-wider text-text-tertiary">{n.author || "—"}</span>
            <span className="text-[10px] text-text-tertiary">{formatRelative(n.created_at, lang)}</span>
          </div>
          <p className="text-sm text-text-primary whitespace-pre-wrap">{n.content || n.note}</p>
        </li>
      ))}
    </ul>
  );
}

// ────────────────────────────────────────────────────────────────
//  HELPERS UI
// ────────────────────────────────────────────────────────────────
function Avatar({ name, status, size = "md" }) {
  const initials = (name || "?")
    .split(" ")
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const meta = STATUS_META[status];
  const sizeCls = size === "lg" ? "h-14 w-14 text-base" : "h-9 w-9 text-xs";
  return (
    <div className="relative shrink-0">
      <div className={cn("flex items-center justify-center rounded-full gradient-brand text-white font-semibold", sizeCls)}>
        {initials}
      </div>
      {meta && (
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 inline-block h-3 w-3 rounded-full border-2 border-bg-card",
            meta.dot
          )}
          title={meta.label}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || STATUS_META.new;
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} data-testid={`status-badge-${status}`}>
      <Icon size={10} />
      <span>{meta.label}</span>
    </Badge>
  );
}

function UrgencyPill({ urgency }) {
  if (!urgency || urgency === "normal") {
    return <span className="text-[11px] text-text-tertiary">Normal</span>;
  }
  const map = {
    high: { v: "red",    label: "Urgent" },
    low:  { v: "ghost",  label: "Faible" },
  };
  const m = map[urgency] || { v: "ghost", label: urgency };
  return <Badge variant={m.v} className="text-[10px]">{m.label}</Badge>;
}

function formatRelative(iso, lang) {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const diff = Math.floor((now - d) / 1000);
  const locale = lang?.startsWith("fr") ? "fr-CA" : "en-CA";
  if (Math.abs(diff) < 60) return locale === "fr-CA" ? "À l'instant" : "Just now";
  const min = Math.floor(diff / 60);
  if (Math.abs(min) < 60) return locale === "fr-CA" ? `Il y a ${min} min` : `${min} min ago`;
  const h = Math.floor(min / 60);
  if (Math.abs(h) < 24) return locale === "fr-CA" ? `Il y a ${h} h` : `${h} h ago`;
  const days = Math.floor(h / 24);
  if (Math.abs(days) < 7) return locale === "fr-CA" ? `Il y a ${days} j` : `${days} d ago`;
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(d);
}

function formatDate(iso, lang) {
  if (!iso) return "—";
  const locale = lang?.startsWith("fr") ? "fr-CA" : "en-CA";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(date);
}

function formatDateTime(iso, lang) {
  if (!iso) return "—";
  const locale = lang?.startsWith("fr") ? "fr-CA" : "en-CA";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}


// ────────────────────────────────────────────────────────────────
//  TOAST (lightweight, auto-dismiss)
// ────────────────────────────────────────────────────────────────
function Toast({ toast, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [toast, onClose]);
  return (
    <div
      role={toast.type === "error" ? "alert" : "status"}
      data-testid="toast"
      className={cn(
        "fixed bottom-6 right-6 z-50 max-w-sm rounded-lg border px-4 py-3 text-sm shadow-xl animate-fade-in",
        toast.type === "success"
          ? "border-brand-green/30 bg-brand-green/10 text-emerald-100"
          : "border-brand-red/30 bg-brand-red/10 text-red-200"
      )}
    >
      {toast.msg}
    </div>
  );
}
