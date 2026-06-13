// ============================================================
// EXEVORI VOICE IA — PAGE EMAILS (Phase 4B)
// Tabs : Inbox + Drafts pending validation
// ============================================================

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Mail, Inbox, Sparkles, AlertTriangle, FileEdit, Send, Reply,
  CheckCircle2, Tag, ChevronRight,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs.jsx";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "../components/ui/sheet.jsx";
import DataTable, { RowActionButton } from "../components/common/DataTable.jsx";
import FilterBar from "../components/common/FilterBar.jsx";
import DraftCard from "../components/emails/DraftCard.jsx";
import { cn } from "../lib/utils.js";

const API = import.meta.env.VITE_API_URL || "";

const CLASSIF_META = {
  quote_request:          { label: "Devis",         variant: "purple" },
  appointment_confirmation:{ label: "Confirmation RDV", variant: "green" },
  service_request:        { label: "Service",       variant: "default" },
  support_request:        { label: "Support",       variant: "orange" },
  newsletter:             { label: "Infolettre",    variant: "ghost" },
  spam:                   { label: "Spam",          variant: "red" },
};

export default function Emails() {
  const { t, i18n } = useTranslation();
  const { token, effectiveCompanyId } = useAuth();

  const [emails, setEmails] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState(null);
  const [selectedEmailId, setSelectedEmailId] = useState(null);
  const [tab, setTab] = useState("inbox");
  const [toast, setToast] = useState(null);

  const loadAll = useCallback(async () => {
    if (!token || !effectiveCompanyId) { setLoading(false); return; }
    setLoading(true);
    try {
      const [r1, r2] = await Promise.all([
        fetch(`${API}/api/v1/emails?company_id=${effectiveCompanyId}&limit=200`, {
          headers: { Authorization: `Bearer ${token}` },
        }).then((r) => r.json()),
        fetch(`${API}/api/v1/emails/drafts?company_id=${effectiveCompanyId}`, {
          headers: { Authorization: `Bearer ${token}` },
        }).then((r) => r.json()),
      ]);
      setEmails(r1.emails || []);
      setDrafts(r2.drafts || []);
    } catch (e) {
      console.error("[Emails] load error:", e);
    } finally {
      setLoading(false);
    }
  }, [token, effectiveCompanyId]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // ─── Inbox filtering ─────────────────────────────────────────
  const filteredEmails = useMemo(() => {
    let list = emails;
    if (classFilter) list = list.filter((e) => e.classification === classFilter);
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      list = list.filter((e) =>
        [e.from_name, e.from_email, e.subject, e.ai_summary]
          .filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
      );
    }
    return list;
  }, [emails, search, classFilter]);

  const classCounts = useMemo(() => {
    const c = {};
    emails.forEach((e) => { if (e.classification) c[e.classification] = (c[e.classification] || 0) + 1; });
    return c;
  }, [emails]);

  const classOptions = Object.keys(CLASSIF_META).map((k) => ({
    value: k,
    label: CLASSIF_META[k].label,
    color: variantToColor(CLASSIF_META[k].variant),
    count: classCounts[k] || 0,
  }));

  // ─── Columns inbox ───────────────────────────────────────────
  const columns = useMemo(() => [
    {
      key: "received_at",
      header: t("emails.col.time", "Reçu"),
      width: "140px",
      render: (r) => (
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-text-primary tabular-nums">{formatTime(r.received_at, i18n.language)}</span>
          <span className="text-[10px] text-text-tertiary">{formatRelative(r.received_at, i18n.language)}</span>
        </div>
      ),
    },
    {
      key: "from",
      header: t("emails.col.from", "Expéditeur"),
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-text-primary">{r.from_name || r.from_email}</div>
          {r.from_name && r.from_email && (
            <div className="truncate text-[10px] text-text-tertiary">{r.from_email}</div>
          )}
        </div>
      ),
    },
    {
      key: "subject",
      header: t("emails.col.subject", "Objet"),
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-text-primary">{r.subject || "—"}</div>
          {r.ai_summary && (
            <div className="truncate text-[10px] text-text-tertiary italic">« {r.ai_summary} »</div>
          )}
        </div>
      ),
    },
    {
      key: "classification",
      header: t("emails.col.classif", "Classification"),
      width: "150px",
      render: (r) => <ClassifBadge value={r.classification} />,
    },
    {
      key: "level",
      header: t("emails.col.level", "Niveau"),
      width: "120px",
      render: (r) => r.level === 2
        ? <Badge variant="orange" className="text-[10px]"><AlertTriangle size={9} /> À valider</Badge>
        : <Badge variant="ghost"  className="text-[10px]"><CheckCircle2 size={9} /> Auto</Badge>,
    },
    {
      key: "status",
      header: t("emails.col.status", "Statut"),
      width: "100px",
      render: (r) => <StatusBadge value={r.status} />,
    },
  ], [t, i18n.language]);

  // ─── Draft actions ───────────────────────────────────────────
  const handleApprove = useCallback(async (id, { body, subject }) => {
    const res = await fetch(`${API}/api/v1/emails/drafts/${id}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ edited_body: body, edited_subject: subject }),
    });
    const d = await res.json();
    if (!d.success) throw new Error(d.error || "Approbation échouée");
    setDrafts((arr) => arr.filter((x) => x.id !== id));
    setToast({
      type: d.sent_via_resend ? "success" : "warn",
      msg: d.sent_via_resend
        ? t("emails.toast.sent", "Courriel envoyé")
        : t("emails.toast.approvedNoSend", "Brouillon approuvé — l'envoi automatique via Resend n'est pas configuré."),
    });
  }, [token, t]);

  const handleReject = useCallback(async (id, reason) => {
    await fetch(`${API}/api/v1/emails/drafts/${id}/reject`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    setDrafts((arr) => arr.filter((x) => x.id !== id));
    setToast({ type: "success", msg: t("emails.toast.rejected", "Brouillon refusé") });
  }, [token, t]);

  const handleRegenerate = useCallback(async (id, instruction) => {
    const res = await fetch(`${API}/api/v1/emails/drafts/${id}/regenerate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ instruction }),
    });
    const d = await res.json();
    if (d?.draft) {
      setDrafts((arr) => arr.map((x) => (x.id === id ? { ...x, ...d.draft } : x)));
    }
    setToast({ type: "success", msg: t("emails.toast.regenerated", "Brouillon régénéré") });
  }, [token, t]);

  const handleSaveEdit = useCallback(async (id, { body, subject }) => {
    const res = await fetch(`${API}/api/v1/emails/drafts/${id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body, subject }),
    });
    const d = await res.json();
    if (d?.draft) {
      setDrafts((arr) => arr.map((x) => (x.id === id ? { ...x, ...d.draft } : x)));
    }
    setToast({ type: "success", msg: t("emails.toast.saved", "Modifications enregistrées") });
  }, [token, t]);

  const pendingCount = drafts.length;

  return (
    <div className="space-y-5 animate-fade-in" data-testid="emails-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-tertiary mb-1">
            <Mail size={11} /> {t("emails.kicker", "Boîte courriels")}
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary" data-testid="emails-title">
            {t("emails.title", "Courriels")}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            {t("emails.subtitle", "Boîte de réception et validation des brouillons générés par votre assistante.")}
          </p>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab} data-testid="emails-tabs">
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="inbox" data-testid="tab-inbox">
            <Inbox size={12} />
            {t("emails.tabs.inbox", "Boîte de réception")}
            <span className="ml-1.5 rounded-full bg-white/8 px-1.5 py-0.5 text-[10px] tabular-nums">
              {emails.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="drafts" data-testid="tab-drafts">
            <FileEdit size={12} />
            {t("emails.tabs.drafts", "À valider")}
            {pendingCount > 0 && (
              <span
                className="ml-1.5 rounded-full bg-brand-orange/20 text-amber-200 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums"
                data-testid="drafts-badge"
              >
                {pendingCount}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ─── TAB : INBOX ─────────────────────────────────────── */}
        <TabsContent value="inbox" className="mt-5 space-y-4">
          <FilterBar
            testId="emails-filterbar"
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder={t("emails.searchPlaceholder", "Expéditeur, sujet, résumé…")}
            filters={[
              { key: "classification", label: t("emails.filter.classif", "Classification"), options: classOptions, current: classFilter },
            ]}
            onFilterChange={(_k, v) => setClassFilter(v)}
          />

          <DataTable
            testId="emails-table"
            columns={columns}
            data={filteredEmails}
            rowKey="id"
            loading={loading}
            onRowClick={(row) => setSelectedEmailId(row.id)}
            rowActions={(row) => (
              <RowActionButton onClick={() => setSelectedEmailId(row.id)} data-testid={`view-email-${row.id}`}>
                <ChevronRight size={14} />
              </RowActionButton>
            )}
            emptyState={{
              icon: Inbox,
              title: t("emails.empty.title", "Aucun courriel"),
              description: t("emails.empty.default", "Les courriels reçus par votre assistante apparaîtront ici."),
            }}
          />
        </TabsContent>

        {/* ─── TAB : DRAFTS ────────────────────────────────────── */}
        <TabsContent value="drafts" className="mt-5">
          {loading ? (
            <div className="rounded-lg border border-border bg-white/3 p-8 text-center text-sm text-text-tertiary">
              {t("common.loading", "Chargement...")}
            </div>
          ) : drafts.length === 0 ? (
            <div className="rounded-lg border border-border bg-white/3 p-10 text-center" data-testid="drafts-empty">
              <CheckCircle2 size={36} className="mx-auto text-brand-green mb-2" />
              <h3 className="text-base font-semibold text-text-primary">{t("emails.drafts.emptyTitle", "Aucun brouillon en attente")}</h3>
              <p className="mt-1 text-sm text-text-secondary">
                {t("emails.drafts.emptySubtitle", "Tout est validé. Vous êtes à jour !")}
              </p>
            </div>
          ) : (
            <ul className="space-y-3" data-testid="drafts-list">
              {drafts.map((d) => (
                <li key={d.id}>
                  <DraftCard
                    draft={d}
                    sourceLabel={d.email?.subject}
                    sourceMeta={d.email ? {
                      name:    d.email.from_name,
                      email:   d.email.from_email,
                      summary: d.email.ai_summary,
                    } : null}
                    onApprove={handleApprove}
                    onReject={handleReject}
                    onRegenerate={handleRegenerate}
                    onSaveEdit={handleSaveEdit}
                  />
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>

      {/* Email detail sheet */}
      <EmailDetailSheet
        emailId={selectedEmailId}
        open={!!selectedEmailId}
        onClose={() => setSelectedEmailId(null)}
        token={token}
        t={t}
        lang={i18n.language}
        onJumpToDraft={() => { setSelectedEmailId(null); setTab("drafts"); }}
      />

      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}
    </div>
  );
}

// ─── Email detail sheet ────────────────────────────────────────
function EmailDetailSheet({ emailId, open, onClose, token, t, lang, onJumpToDraft }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!emailId || !token) return;
    setLoading(true);
    fetch(`${API}/api/v1/emails/${emailId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [emailId, token]);

  const e = data?.email;
  const draft = data?.draft;

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent data-testid="email-detail-sheet" className="overflow-y-auto sm:max-w-xl">
        {loading || !e ? (
          <>
            <SheetHeader>
              <SheetTitle className="sr-only">{t("emails.detail.loading", "Chargement du courriel")}</SheetTitle>
            </SheetHeader>
            <div className="p-6 space-y-3">
              <div className="h-6 w-2/3 rounded bg-white/5 animate-pulse" />
              <div className="h-4 w-1/3 rounded bg-white/5 animate-pulse" />
              <div className="h-32 rounded bg-white/5 animate-pulse" />
            </div>
          </>
        ) : (
          <>
            <SheetHeader>
              <div className="flex items-start gap-3 pr-10">
                <div className="flex h-10 w-10 items-center justify-center rounded-full gradient-brand text-white shrink-0">
                  <Mail size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <SheetTitle data-testid="email-detail-subject">{e.subject || "(Sans objet)"}</SheetTitle>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                    <span className="font-medium text-text-primary">{e.from_name || e.from_email}</span>
                    {e.from_name && <span className="text-text-tertiary">&lt;{e.from_email}&gt;</span>}
                    <span className="text-text-tertiary">·</span>
                    <span className="text-text-tertiary">{formatDate(e.received_at, lang)}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <ClassifBadge value={e.classification} />
                    {e.level === 2 && <Badge variant="orange" className="text-[10px]"><AlertTriangle size={9} /> À valider</Badge>}
                    <StatusBadge value={e.status} />
                  </div>
                </div>
              </div>
              {draft && (
                <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border">
                  <Button size="sm" variant="secondary" onClick={onJumpToDraft} data-testid="email-jump-to-draft">
                    <FileEdit size={12} /> {t("emails.detail.jumpDraft", "Voir le brouillon de réponse")}
                  </Button>
                </div>
              )}
            </SheetHeader>

            <div className="px-6 py-4 space-y-4">
              {e.ai_summary && (
                <section className="rounded-lg border border-brand-purple/20 bg-brand-purple/5 p-3 text-sm text-text-primary" data-testid="email-summary">
                  <div className="text-[10px] uppercase tracking-wider text-brand-purple mb-1 flex items-center gap-1.5">
                    <Sparkles size={10} /> {t("emails.detail.summary", "Résumé IA")}
                  </div>
                  {e.ai_summary}
                </section>
              )}
              <section data-testid="email-body">
                <h4 className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary mb-2">
                  {t("emails.detail.body", "Message original")}
                </h4>
                <pre className="rounded-lg border border-border bg-white/3 p-3 text-sm leading-relaxed text-text-primary whitespace-pre-wrap break-words font-sans">
                  {e.body}
                </pre>
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ─── Helpers ───────────────────────────────────────────────────
function ClassifBadge({ value }) {
  const meta = CLASSIF_META[value] || { label: value || "—", variant: "ghost" };
  return (
    <Badge variant={meta.variant} className="text-[10px]" data-testid={`classif-${value || "none"}`}>
      <Tag size={9} /> {meta.label}
    </Badge>
  );
}
function StatusBadge({ value }) {
  const map = {
    received:  { v: "default", label: "Reçu", Icon: Inbox },
    processed: { v: "purple",  label: "Traité", Icon: Sparkles },
    replied:   { v: "green",   label: "Répondu", Icon: Reply },
  };
  const m = map[value] || { v: "ghost", label: value || "—", Icon: Inbox };
  return <Badge variant={m.v} className="text-[10px]"><m.Icon size={9} /> {m.label}</Badge>;
}

function variantToColor(variant) {
  const map = {
    purple: "bg-brand-purple",
    green:  "bg-brand-green",
    orange: "bg-brand-orange",
    red:    "bg-brand-red",
    default:"bg-brand",
    ghost:  "bg-white/30",
  };
  return map[variant] || "bg-white/30";
}

function formatDate(iso, lang) {
  if (!iso) return "—";
  const locale = lang?.startsWith("fr") ? "fr-CA" : "en-CA";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}
function formatTime(iso, lang) {
  if (!iso) return "—";
  const locale = lang?.startsWith("fr") ? "fr-CA" : "en-CA";
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
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

// ─── Toast ──────────────────────────────────────────────────────
function Toast({ toast, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [toast, onClose]);
  return (
    <div
      role="status"
      data-testid="toast"
      className={cn(
        "fixed bottom-6 right-6 z-50 max-w-sm rounded-lg border px-4 py-3 text-sm shadow-xl animate-fade-in",
        toast.type === "success" && "border-brand-green/30 bg-brand-green/10 text-emerald-100",
        toast.type === "warn"    && "border-brand-orange/30 bg-brand-orange/10 text-amber-100",
        toast.type === "error"   && "border-brand-red/30 bg-brand-red/10 text-red-200"
      )}
    >
      {toast.msg}
    </div>
  );
}
