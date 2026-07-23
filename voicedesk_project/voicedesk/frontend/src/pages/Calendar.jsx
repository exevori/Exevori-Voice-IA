// ============================================================
// EXEVORI VOICE IA — PAGE CALENDRIER (Tâche 11 — version corrigée)
// Affiche les rendez-vous créés par Léa pendant les appels
// Fichier : frontend/src/pages/Calendar.jsx
// APIs alignées sur les composants réels du repo :
//   - DataTable : col.render(row) — un seul paramètre
//   - DataTable : emptyState={{ icon, title, description }}
//   - FilterBar : searchValue / onSearchChange
//   - RowActionButton : children (icônes), pas de label/variant
//   - Badge : variants valides (default purple green orange red cyan pink outline ghost)
//   - Button : variants valides (default secondary ghost outline destructive link)
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import {
  Calendar as CalendarIcon, CheckCircle2, Clock, XCircle,
  User, Phone, Mail, Building2, RefreshCcw, Eye,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import DataTable, { RowActionButton } from "../components/common/DataTable.jsx";
import FilterBar from "../components/common/FilterBar.jsx";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "../components/ui/sheet.jsx";

const API = import.meta.env.VITE_API_URL || "";

// ─── Status meta (variants Badge réels uniquement) ───────────
const STATUS_META = {
  pending:   { label: "En attente", variant: "orange" },
  confirmed: { label: "Confirmé",   variant: "green"  },
  cancelled: { label: "Annulé",     variant: "red"    },
  completed: { label: "Complété",   variant: "default" },
};

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || STATUS_META.pending;
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

function KpiCard({ label, value, icon: Icon, color }) {
  return (
    <div className="rounded-xl border border-border bg-bg-card p-4 flex items-center gap-3">
      <div className={`rounded-lg p-2 ${color}`}>
        <Icon size={20} className="text-white" />
      </div>
      <div>
        <p className="text-2xl font-bold text-text-primary">{value}</p>
        <p className="text-xs text-text-tertiary">{label}</p>
      </div>
    </div>
  );
}

export default function CalendarPage() {
  const { token, effectiveCompanyId } = useAuth();

  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  // ─── Fetch appointments ───────────────────────────────────
  const fetchAppointments = async () => {
    if (!token || !effectiveCompanyId) { setLoading(false); return; }
    setLoading(true);
    try {
      const res = await fetch(
        `${API}/api/v1/calendar/appointments?company_id=${effectiveCompanyId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.ok) {
        const data = await res.json();
        setAppointments(data.appointments || []);
      }
    } catch (e) {
      console.error("[Calendar] fetch error:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAppointments(); }, [token, effectiveCompanyId]);

  // ─── Patch status ─────────────────────────────────────────
  const patchStatus = async (id, newStatus) => {
    if (!token) return;
    try {
      await fetch(`${API}/api/v1/calendar/appointments/${id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      setAppointments(prev => prev.map(a => a.id === id ? { ...a, status: newStatus } : a));
    } catch (e) {
      console.error("[Calendar] patch error:", e);
    }
  };

  // ─── KPIs ─────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay() + 1);
    startOfWeek.setHours(0, 0, 0, 0);
    return {
      total:     appointments.filter(a => a.date && new Date(a.date) >= startOfWeek).length,
      confirmed: appointments.filter(a => a.status === "confirmed").length,
      pending:   appointments.filter(a => a.status === "pending").length,
      thisMonth: appointments.filter(a => {
        if (!a.date) return false;
        const d = new Date(a.date);
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      }).length,
    };
  }, [appointments]);

  // ─── Filter ───────────────────────────────────────────────
  const filtered = useMemo(() => {
    let list = [...appointments];
    if (statusFilter) list = list.filter(a => a.status === statusFilter);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(a =>
        [a.contacts?.full_name, a.type, a.channel, a.notes]
          .filter(Boolean)
          .some(v => String(v).toLowerCase().includes(q))
      );
    }
    return list;
  }, [appointments, statusFilter, search]);

  // ─── Columns — render(row) un seul paramètre ──────────────
  const columns = useMemo(() => [
    {
      key: "date",
      header: "Date & heure",
      render: (row) => (
        <div>
          <p className="font-medium text-text-primary text-sm">
            {row.date ? new Date(row.date).toLocaleDateString("fr-CA", { weekday: "short", day: "numeric", month: "short" }) : "—"}
          </p>
          <p className="text-xs text-text-tertiary">{row.time || "—"}</p>
        </div>
      ),
    },
    {
      key: "contact",
      header: "Client",
      sortable: false,
      render: (row) => (
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-brand/10 flex items-center justify-center text-brand text-xs font-bold">
            {(row.contacts?.full_name || "?")[0].toUpperCase()}
          </div>
          <div>
            <p className="text-sm font-medium text-text-primary">{row.contacts?.full_name || "—"}</p>
            <p className="text-xs text-text-tertiary">{row.contacts?.company || ""}</p>
          </div>
        </div>
      ),
    },
    {
      key: "type",
      header: "Type",
      render: (row) => <span className="text-sm text-text-secondary">{row.type || "—"}</span>,
    },
    {
      key: "channel",
      header: "Canal",
      render: (row) => <span className="text-xs text-text-tertiary">{row.channel || "—"}</span>,
    },
    {
      key: "status",
      header: "Statut",
      render: (row) => <StatusBadge status={row.status} />,
    },
  ], []);

  // ─── rowActions — RowActionButton children only ───────────
  const rowActions = (row) => (
    <div className="flex gap-0.5">
      {row.status === "pending" && (
        <RowActionButton
          title="Confirmer"
          onClick={() => patchStatus(row.id, "confirmed")}
        >
          <CheckCircle2 size={14} className="text-brand-green" />
        </RowActionButton>
      )}
      {row.status !== "cancelled" && row.status !== "completed" && (
        <RowActionButton
          title="Annuler"
          onClick={() => patchStatus(row.id, "cancelled")}
        >
          <XCircle size={14} className="text-brand-red" />
        </RowActionButton>
      )}
      <RowActionButton
        title="Détails"
        onClick={() => setSelectedId(row.id)}
      >
        <Eye size={14} />
      </RowActionButton>
    </div>
  );

  const statusOptions = [
    { value: "pending",   label: "En attente" },
    { value: "confirmed", label: "Confirmé" },
    { value: "cancelled", label: "Annulé" },
    { value: "completed", label: "Complété" },
  ];

  const selected = useMemo(() => appointments.find(a => a.id === selectedId), [appointments, selectedId]);

  return (
    <div className="space-y-5">
      {/* ── KPIs ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Cette semaine" value={kpis.total}     icon={CalendarIcon} color="bg-brand" />
        <KpiCard label="Confirmés"     value={kpis.confirmed} icon={CheckCircle2} color="bg-brand-green" />
        <KpiCard label="En attente"    value={kpis.pending}   icon={Clock}        color="bg-brand-orange" />
        <KpiCard label="Ce mois"       value={kpis.thisMonth} icon={CalendarIcon} color="bg-brand-purple" />
      </div>

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Rendez-vous</h2>
          <p className="text-xs text-text-tertiary">Planifiés par votre assistante pendant les appels</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchAppointments} className="gap-2">
          <RefreshCcw size={14} /> Actualiser
        </Button>
      </div>

      {/* ── Filters — searchValue (API réelle) ── */}
      <FilterBar
        testId="calendar-filterbar"
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Chercher un client, un type de RDV…"
        filters={[
          { key: "status", label: "Statut", options: statusOptions, current: statusFilter },
        ]}
        onFilterChange={(_k, v) => setStatusFilter(v)}
      />

      {/* ── Table — emptyState objet (API réelle) ── */}
      <DataTable
        testId="calendar-table"
        columns={columns}
        data={filtered}
        loading={loading}
        rowActions={rowActions}
        emptyState={{
          icon: CalendarIcon,
          title: "Aucun rendez-vous",
          description: search || statusFilter
            ? "Aucun rendez-vous ne correspond à vos critères"
            : "Votre assistante ajoutera automatiquement les RDV détectés pendant les appels",
        }}
      />

      {/* ── Detail Sheet ── */}
      <Sheet open={!!selectedId} onOpenChange={(o) => !o && setSelectedId(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Détails du rendez-vous</SheetTitle>
            <SheetDescription>Informations complètes</SheetDescription>
          </SheetHeader>
          {selected && (
            <div className="mt-4 space-y-4">
              <div className="rounded-lg border border-border p-4 space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <CalendarIcon size={15} className="text-text-tertiary" />
                  <span className="font-medium">
                    {selected.date
                      ? new Date(selected.date).toLocaleDateString("fr-CA", { weekday: "long", day: "numeric", month: "long" })
                      : "—"
                    }
                    {selected.time ? ` à ${selected.time}` : ""}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <User size={15} className="text-text-tertiary" />
                  <span>{selected.contacts?.full_name || "—"}</span>
                </div>
                {selected.contacts?.email && (
                  <div className="flex items-center gap-2 text-sm text-text-secondary">
                    <Mail size={15} className="text-text-tertiary" />
                    <span>{selected.contacts.email}</span>
                  </div>
                )}
                {selected.contacts?.phone && (
                  <div className="flex items-center gap-2 text-sm text-text-secondary">
                    <Phone size={15} className="text-text-tertiary" />
                    <span>{selected.contacts.phone}</span>
                  </div>
                )}
                {selected.contacts?.company && (
                  <div className="flex items-center gap-2 text-sm text-text-secondary">
                    <Building2 size={15} className="text-text-tertiary" />
                    <span>{selected.contacts.company}</span>
                  </div>
                )}
              </div>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary uppercase tracking-wide">Type</p>
                <p className="text-sm text-text-primary">{selected.type || "—"}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary uppercase tracking-wide">Canal</p>
                <p className="text-sm text-text-primary">{selected.channel || "—"}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary uppercase tracking-wide">Statut</p>
                <StatusBadge status={selected.status} />
              </div>
              {selected.notes && (
                <div className="space-y-1">
                  <p className="text-xs text-text-tertiary uppercase tracking-wide">Notes de l'assistante</p>
                  <p className="text-sm text-text-secondary leading-relaxed">{selected.notes}</p>
                </div>
              )}
              <div className="pt-2 flex gap-2">
                {selected.status === "pending" && (
                  <Button size="sm"
                    onClick={() => { patchStatus(selected.id, "confirmed"); setSelectedId(null); }}>
                    <CheckCircle2 size={14} /> Confirmer
                  </Button>
                )}
                {selected.status !== "cancelled" && selected.status !== "completed" && (
                  <Button size="sm" variant="destructive"
                    onClick={() => { patchStatus(selected.id, "cancelled"); setSelectedId(null); }}>
                    <XCircle size={14} /> Annuler
                  </Button>
                )}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
