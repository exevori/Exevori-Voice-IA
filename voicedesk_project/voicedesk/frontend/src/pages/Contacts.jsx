// ============================================================
// EXEVORI VOICE IA — PAGE CONTACTS (Phase 3A)
// Liste + Filtres + Search + Sort + Pagination
// Détail contact via Sheet slide-in (3 tabs)
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Users, Search, FlameKindling, Snowflake, UserPlus, ShoppingBag, Sun,
  Phone, Mail, MessageSquare, Calendar as CalendarIcon, Tag, Activity,
  ChevronDown, Plus, Upload, Eye, MoreHorizontal, Sparkles,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "../components/ui/sheet.jsx";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs.jsx";
import DataTable, { RowActionButton } from "../components/common/DataTable.jsx";
import FilterBar from "../components/common/FilterBar.jsx";
import { cn } from "../lib/utils.js";

const API = import.meta.env.VITE_API_URL || "";

// ─── Status meta ────────────────────────────────────────────────
const STATUS_META = {
  hot:      { label: "Chaud",   icon: FlameKindling, dot: "bg-brand-red",    variant: "red" },
  warm:     { label: "Tiède",   icon: Sun,           dot: "bg-brand-orange", variant: "orange" },
  customer: { label: "Client",  icon: ShoppingBag,   dot: "bg-brand-green",  variant: "green" },
  new:      { label: "Nouveau", icon: UserPlus,      dot: "bg-brand",        variant: "default" },
  cold:     { label: "Froid",   icon: Snowflake,     dot: "bg-white/30",     variant: "ghost" },
};

// ────────────────────────────────────────────────────────────────
//  ROOT
// ────────────────────────────────────────────────────────────────
export default function Contacts() {
  const { t, i18n } = useTranslation();
  const { token, effectiveCompanyId } = useAuth();

  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState(null);
  const [selected, setSelected] = useState(null); // contact id pour Sheet

  useEffect(() => {
    if (!token || !effectiveCompanyId) { setLoading(false); return; }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, effectiveCompanyId]);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/v1/contacts?company_id=${effectiveCompanyId}&limit=200`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await res.json();
      setContacts(d.contacts || []);
    } catch (e) {
      console.error("[Contacts] load error:", e);
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => {
    let list = contacts;
    if (statusFilter) list = list.filter((c) => c.status === statusFilter);
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
    const c = { hot: 0, warm: 0, customer: 0, new: 0, cold: 0 };
    contacts.forEach((ct) => { if (c[ct.status] != null) c[ct.status]++; });
    return c;
  }, [contacts]);

  const statusOptions = [
    { value: "hot",      label: STATUS_META.hot.label,      color: STATUS_META.hot.dot,      count: statusCounts.hot },
    { value: "warm",     label: STATUS_META.warm.label,     color: STATUS_META.warm.dot,     count: statusCounts.warm },
    { value: "customer", label: STATUS_META.customer.label, color: STATUS_META.customer.dot, count: statusCounts.customer },
    { value: "new",      label: STATUS_META.new.label,      color: STATUS_META.new.dot,      count: statusCounts.new },
    { value: "cold",     label: STATUS_META.cold.label,     color: STATUS_META.cold.dot,     count: statusCounts.cold },
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
      key: "urgency",
      header: t("contacts.col.urgency", "Urgence"),
      width: "100px",
      render: (r) => <UrgencyPill urgency={r.urgency} />,
    },
    {
      key: "last_interaction_at",
      header: t("contacts.col.last", "Dernier contact"),
      width: "140px",
      render: (r) => <span className="text-xs text-text-tertiary">{formatRelative(r.last_interaction_at, i18n.language)}</span>,
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
            {t("contacts.subtitle", "Tous vos contacts en un coup d'œil — chauds, tièdes, clients et nouveaux")}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" disabled data-testid="btn-import" title="Disponible en Phase 3B">
            <Upload size={14} /> {t("contacts.import", "Importer CSV")}
          </Button>
          <Button size="sm" disabled data-testid="btn-new-contact" title="Disponible en Phase 3B">
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
        rowActions={(row) => (
          <RowActionButton onClick={() => setSelected(row.id)} data-testid={`view-${row.id}`}>
            <Eye size={14} />
          </RowActionButton>
        )}
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
        t={t}
        lang={i18n.language}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
//  DÉTAIL CONTACT — SHEET avec 3 tabs
// ────────────────────────────────────────────────────────────────
function ContactDetailSheet({ contactId, open, onClose, token, t, lang }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!contactId || !token) return;
    setLoading(true);
    fetch(`${API}/api/v1/contacts/${contactId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((d) => setDetail(d))
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [contactId, token]);

  const c = detail?.contact;
  const meta = c && STATUS_META[c.status];

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent data-testid="contact-detail-sheet" className="overflow-y-auto">
        {loading || !c ? (
          <div className="p-6 space-y-3">
            <div className="h-16 w-16 rounded-full bg-white/5 animate-pulse" />
            <div className="h-4 w-2/3 rounded bg-white/5 animate-pulse" />
            <div className="h-3 w-1/2 rounded bg-white/5 animate-pulse" />
          </div>
        ) : (
          <>
            <SheetHeader>
              <div className="flex items-start gap-4 pr-10">
                <Avatar name={c.full_name} status={c.status} size="lg" />
                <div className="flex-1 min-w-0">
                  <SheetTitle data-testid="detail-name">{c.full_name}</SheetTitle>
                  <SheetDescription className="flex flex-wrap items-center gap-2 mt-1.5">
                    <StatusBadge status={c.status} />
                    <UrgencyPill urgency={c.urgency} />
                    {c.tags?.length > 0 && c.tags.slice(0, 3).map((tg) => (
                      <Badge key={tg} variant="ghost"><Tag size={9} />{tg}</Badge>
                    ))}
                  </SheetDescription>
                </div>
              </div>

              {/* Quick contact actions */}
              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border">
                {c.phone && (
                  <Button size="sm" variant="secondary" asChild data-testid="detail-call">
                    <a href={`tel:${c.phone}`}><Phone size={12} /> {c.phone}</a>
                  </Button>
                )}
                {c.email && (
                  <Button size="sm" variant="secondary" asChild data-testid="detail-email">
                    <a href={`mailto:${c.email}`}><Mail size={12} /> Courriel</a>
                  </Button>
                )}
              </div>
            </SheetHeader>

            <div className="px-6 py-4">
              <Tabs defaultValue="infos" data-testid="detail-tabs">
                <TabsList className="w-full grid grid-cols-3">
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
    { label: t("contacts.field.next", "Prochaine action"), value: c.next_action, icon: Activity },
    { label: t("contacts.field.created", "Créé le"),    value: formatDate(c.created_at, lang) },
    { label: t("contacts.field.last", "Dernier contact"), value: formatRelative(c.last_interaction_at, lang) },
  ];
  return (
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
  return new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(new Date(iso));
}
