// ============================================================
// EXEVORI VOICE IA — PAGE CALLS (Phase 4A)
// Liste + filtres + détail (Sheet) + TranscriptView
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  Phone, PhoneIncoming, PhoneOff, PhoneForwarded, CheckCircle2,
  Clock, AlertCircle, Sparkles, User, ChevronRight, ExternalLink,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "../components/ui/sheet.jsx";
import DataTable, { RowActionButton } from "../components/common/DataTable.jsx";
import FilterBar from "../components/common/FilterBar.jsx";
import TranscriptView from "../components/calls/TranscriptView.jsx";
import { cn } from "../lib/utils.js";

const API = import.meta.env.VITE_API_URL || "";

// ─── Status meta ────────────────────────────────────────────────
const STATUS_META = {
  completed:   { label: "Complété",  icon: CheckCircle2,   dot: "bg-brand-green",  variant: "green" },
  in_progress: { label: "En cours",  icon: Clock,          dot: "bg-brand",        variant: "default" },
  transferred: { label: "Transféré", icon: PhoneForwarded, dot: "bg-brand-orange", variant: "orange" },
  abandoned:   { label: "Abandonné", icon: PhoneOff,       dot: "bg-brand-red",    variant: "red" },
};

export default function Calls() {
  const { t, i18n } = useTranslation();
  const { token, effectiveCompanyId, profile, impersonatedCompany } = useAuth();
  const navigate = useNavigate();

  const [calls, setCalls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  // Assistant name (depuis impersonation > profile)
  const assistantName = useMemo(
    () => impersonatedCompany?.assistant_name || profile?.company?.assistant_name || "Assistante",
    [impersonatedCompany, profile]
  );

  useEffect(() => {
    if (!token || !effectiveCompanyId) { setLoading(false); return; }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, effectiveCompanyId]);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(
        `${API}/api/v1/calls?company_id=${effectiveCompanyId}&limit=200`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const d = await res.json();
      setCalls(d.calls || []);
    } catch (e) {
      console.error("[Calls] load error:", e);
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => {
    let list = calls;
    if (statusFilter) list = list.filter((c) => c.status === statusFilter);
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      list = list.filter((c) =>
        [c.caller_name, c.caller_phone, c.ai_summary, c.intent, c.contact?.full_name]
          .filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
      );
    }
    return list;
  }, [calls, search, statusFilter]);

  const statusCounts = useMemo(() => {
    const c = { completed: 0, in_progress: 0, transferred: 0, abandoned: 0 };
    calls.forEach((ct) => { if (c[ct.status] != null) c[ct.status]++; });
    return c;
  }, [calls]);

  const statusOptions = [
    { value: "completed",   label: STATUS_META.completed.label,   color: STATUS_META.completed.dot,   count: statusCounts.completed },
    { value: "in_progress", label: STATUS_META.in_progress.label, color: STATUS_META.in_progress.dot, count: statusCounts.in_progress },
    { value: "transferred", label: STATUS_META.transferred.label, color: STATUS_META.transferred.dot, count: statusCounts.transferred },
    { value: "abandoned",   label: STATUS_META.abandoned.label,   color: STATUS_META.abandoned.dot,   count: statusCounts.abandoned },
  ];

  const columns = useMemo(() => [
    {
      key: "created_at",
      header: t("calls.col.time", "Heure"),
      width: "150px",
      render: (r) => (
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-text-primary tabular-nums">{formatTime(r.created_at, i18n.language)}</span>
          <span className="text-[10px] text-text-tertiary">{formatRelative(r.created_at, i18n.language)}</span>
        </div>
      ),
    },
    {
      key: "caller",
      header: t("calls.col.caller", "Contact"),
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-text-primary">
            {r.caller_name || <span className="text-text-tertiary italic">Inconnu</span>}
          </div>
          {r.contact?.full_name && r.contact.full_name !== r.caller_name && (
            <div className="truncate text-[10px] text-text-tertiary">CRM: {r.contact.full_name}</div>
          )}
        </div>
      ),
    },
    {
      key: "caller_phone",
      header: t("calls.col.phone", "Téléphone"),
      width: "150px",
      render: (r) => (
        <span className="font-mono text-xs text-text-secondary">{r.caller_phone || "—"}</span>
      ),
    },
    {
      key: "duration_seconds",
      header: t("calls.col.duration", "Durée"),
      width: "90px",
      render: (r) => (
        <span className="font-mono text-xs text-text-secondary tabular-nums">{formatDuration(r.duration_seconds)}</span>
      ),
    },
    {
      key: "intent",
      header: t("calls.col.intent", "Intent IA"),
      width: "180px",
      render: (r) => r.intent
        ? <Badge variant="purple" className="text-[10px]" data-testid={`intent-${r.intent}`}><Sparkles size={9} />{r.intent}</Badge>
        : <span className="text-text-tertiary">—</span>,
    },
    {
      key: "status",
      header: t("calls.col.status", "Statut"),
      width: "130px",
      render: (r) => <StatusBadge status={r.status} />,
    },
    {
      key: "confidence_score",
      header: t("calls.col.confidence", "Conf."),
      width: "80px",
      render: (r) => <ConfidencePill value={r.confidence_score} />,
    },
  ], [t, i18n.language]);

  return (
    <div className="space-y-5 animate-fade-in" data-testid="calls-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-tertiary mb-1">
            <PhoneIncoming size={11} /> {t("calls.kicker", "Appels entrants")}
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary" data-testid="calls-title">
            {t("calls.title", "Appels")}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            {t("calls.subtitle", "Historique complet — transcripts, intents et résumés générés par votre assistante.")}
          </p>
        </div>
      </div>

      <FilterBar
        testId="calls-filterbar"
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder={t("calls.searchPlaceholder", "Nom, téléphone, intent…")}
        filters={[
          { key: "status", label: t("calls.filter.status", "Statut"), options: statusOptions, current: statusFilter },
        ]}
        onFilterChange={(_k, v) => setStatusFilter(v)}
      />

      <DataTable
        testId="calls-table"
        columns={columns}
        data={filtered}
        rowKey="id"
        loading={loading}
        onRowClick={(row) => setSelectedId(row.id)}
        rowActions={(row) => (
          <RowActionButton onClick={() => setSelectedId(row.id)} data-testid={`view-call-${row.id}`}>
            <ChevronRight size={14} />
          </RowActionButton>
        )}
        emptyState={{
          icon: Phone,
          title: t("calls.empty.title", "Aucun appel"),
          description: search || statusFilter
            ? t("calls.empty.filtered", "Aucun appel ne correspond à vos critères")
            : t("calls.empty.default", "Les appels apparaîtront ici dès que votre assistante répondra."),
        }}
      />

      <CallDetailSheet
        callId={selectedId}
        open={!!selectedId}
        onClose={() => setSelectedId(null)}
        token={token}
        t={t}
        lang={i18n.language}
        assistantName={assistantName}
        onOpenContact={(contactId) => {
          setSelectedId(null);
          navigate(`/contacts?focus=${contactId}`);
        }}
      />
    </div>
  );
}

// ─── Detail Sheet ───────────────────────────────────────────────
function CallDetailSheet({ callId, open, onClose, token, t, lang, assistantName, onOpenContact }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!callId || !token) return;
    setLoading(true);
    fetch(`${API}/api/v1/calls/${callId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((d) => setDetail(d))
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [callId, token]);

  const c = detail?.call;
  const transcript = detail?.transcript || [];

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent data-testid="call-detail-sheet" className="overflow-y-auto sm:max-w-2xl">
        {loading || !c ? (
          <>
            <SheetHeader>
              <SheetTitle className="sr-only">{t("calls.detail.loading", "Chargement de l'appel")}</SheetTitle>
            </SheetHeader>
            <div className="p-6 space-y-3">
              <div className="h-8 w-2/3 rounded bg-white/5 animate-pulse" />
              <div className="h-4 w-1/3 rounded bg-white/5 animate-pulse" />
              <div className="h-32 rounded bg-white/5 animate-pulse" />
            </div>
          </>
        ) : (
          <>
            <SheetHeader>
              <div className="flex items-start gap-3 pr-10">
                <div className="flex h-11 w-11 items-center justify-center rounded-full gradient-brand text-white shrink-0">
                  <Phone size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <SheetTitle data-testid="call-detail-name">
                    {c.caller_name || c.caller_phone || "Appel"}
                  </SheetTitle>
                  <div className="flex flex-wrap items-center gap-2 mt-1.5 text-xs text-text-secondary">
                    <StatusBadge status={c.status} />
                    {c.intent && (
                      <Badge variant="purple" className="text-[10px]">
                        <Sparkles size={9} />{c.intent}
                      </Badge>
                    )}
                    <span className="font-mono text-text-tertiary">{formatDuration(c.duration_seconds)}</span>
                    <span className="text-text-tertiary">·</span>
                    <span className="text-text-tertiary">{formatTime(c.created_at, lang)}</span>
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border">
                {c.caller_phone && (
                  <Button size="sm" variant="secondary" asChild data-testid="call-action-callback">
                    <a href={`tel:${c.caller_phone}`}><Phone size={12} /> {c.caller_phone}</a>
                  </Button>
                )}
                {c.contact?.id && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onOpenContact(c.contact.id)}
                    data-testid="call-action-open-contact"
                  >
                    <User size={12} /> {t("calls.viewContact", "Voir fiche contact")}
                    <ExternalLink size={11} />
                  </Button>
                )}
              </div>
            </SheetHeader>

            <div className="px-6 py-4 space-y-5">
              {/* Résumé IA */}
              <section data-testid="call-section-summary">
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary mb-2 flex items-center gap-1.5">
                  <Sparkles size={11} className="text-brand-purple" />
                  {t("calls.detail.summary", "Résumé généré par l'IA")}
                </h4>
                {c.ai_summary ? (
                  <div className="rounded-lg border border-brand-purple/20 bg-brand-purple/5 p-3.5 text-sm leading-relaxed text-text-primary">
                    {c.ai_summary}
                  </div>
                ) : (
                  <div className="rounded-lg border border-border bg-white/3 p-3.5 text-xs text-text-tertiary">
                    {t("calls.detail.noSummary", "Aucun résumé disponible.")}
                  </div>
                )}
                {c.confidence_score != null && (
                  <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-text-tertiary">
                    <AlertCircle size={9} />
                    {t("calls.detail.confidence", "Confiance modèle :")} <ConfidencePill value={c.confidence_score} />
                  </div>
                )}
              </section>

              {/* Transcript */}
              <section data-testid="call-section-transcript">
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary mb-2">
                  {t("calls.detail.transcript", "Transcript")}
                </h4>
                <TranscriptView
                  transcript={transcript}
                  assistantName={assistantName}
                  callerName={c.caller_name || c.contact?.full_name || "Appelant"}
                />
              </section>

              {/* Métadonnées */}
              <section className="rounded-lg border border-border bg-white/3 p-3 text-[11px] text-text-tertiary grid grid-cols-2 gap-2">
                <div><span className="uppercase tracking-wider text-text-tertiary">Outcome :</span> <span className="text-text-secondary">{c.outcome || "—"}</span></div>
                <div><span className="uppercase tracking-wider text-text-tertiary">Langue :</span> <span className="text-text-secondary">{c.language_used || "—"}</span></div>
                <div><span className="uppercase tracking-wider text-text-tertiary">Twilio SID :</span> <span className="font-mono text-text-secondary">{c.twilio_call_sid || "—"}</span></div>
                <div><span className="uppercase tracking-wider text-text-tertiary">Coût :</span> <span className="text-text-secondary">{c.cost_usd != null ? `${c.cost_usd} USD` : "—"}</span></div>
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ─── Helpers ───────────────────────────────────────────────────
function StatusBadge({ status }) {
  const meta = STATUS_META[status] || STATUS_META.completed;
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} data-testid={`call-status-${status}`}>
      <Icon size={10} />
      <span>{meta.label}</span>
    </Badge>
  );
}

function ConfidencePill({ value }) {
  if (value == null) return <span className="text-text-tertiary text-xs">—</span>;
  const n = Math.round(Number(value));
  const tone =
    n >= 85 ? "bg-brand-green/10 text-brand-green border-brand-green/20" :
    n >= 60 ? "bg-brand-orange/10 text-amber-200 border-brand-orange/20" :
              "bg-brand-red/10 text-brand-red border-brand-red/20";
  return (
    <span
      className={cn("inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium tabular-nums", tone)}
      data-testid="confidence-pill"
    >
      {n}%
    </span>
  );
}

function formatDuration(seconds) {
  if (seconds == null) return "—";
  const s = Math.max(0, Math.floor(Number(seconds)));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
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
