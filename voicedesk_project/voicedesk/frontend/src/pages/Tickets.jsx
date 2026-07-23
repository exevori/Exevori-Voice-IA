// ============================================================
// EXEVORI VOICE IA — Page Tickets / Support client
// Fichier : frontend/src/pages/Tickets.jsx
//
// Vue client PME : créer, voir, répondre à ses propres tickets
// Vue admin : voir tous les tickets de tous les clients
// ============================================================

import React, { useEffect, useState, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  LifeBuoy, Plus, MessageSquare, Clock, CheckCircle2,
  AlertCircle, ChevronRight, Send, X, AlertTriangle,
  User, Shield, Loader2, RefreshCcw, Filter
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "../components/ui/sheet.jsx";

const API = import.meta.env.VITE_API_URL || "";

// ── Meta configs ──────────────────────────────────────────────
const PRIORITY_META = {
  urgent: { label: "Urgent",  variant: "red",    icon: AlertTriangle },
  high:   { label: "Élevée",  variant: "orange", icon: AlertCircle  },
  normal: { label: "Normale", variant: "default", icon: Clock       },
  low:    { label: "Basse",   variant: "green",  icon: CheckCircle2 },
};

const STATUS_META = {
  open:        { label: "Ouvert",      variant: "cyan"    },
  in_progress: { label: "En cours",   variant: "orange"  },
  waiting:     { label: "En attente", variant: "default" },
  resolved:    { label: "Résolu",     variant: "green"   },
  closed:      { label: "Fermé",      variant: "default" },
};

const CATEGORIES = [
  { key: "general",   label: "Question générale" },
  { key: "technical", label: "Problème technique" },
  { key: "billing",   label: "Facturation" },
  { key: "voice",     label: "Assistante vocale" },
  { key: "account",   label: "Compte" },
];

const SLA_STATUS_META = {
  ok:       { label: "Dans les délais", color: "text-brand-green" },
  warning:  { label: "Délai approche",  color: "text-brand-orange" },
  breached: { label: "SLA dépassé",     color: "text-brand-red" },
};

// ── Helper ────────────────────────────────────────────────────
function timeAgo(dateStr) {
  if (!dateStr) return "—";
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return "À l'instant";
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h}h`;
  const d = Math.floor(h / 24);
  return `il y a ${d}j`;
}

// ── Nouveau ticket modal ───────────────────────────────────────
function NewTicketModal({ onClose, onCreated, token, companyId, profile }) {
  const [form, setForm] = useState({ subject: "", description: "", category: "general", priority: "normal" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.subject.trim() || !form.description.trim()) {
      setError("Sujet et description sont obligatoires.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/v1/tickets`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          company_id:        companyId,
          subject:           form.subject,
          description:       form.description,
          category:          form.category,
          priority:          form.priority,
          created_by_name:   profile?.full_name || "Utilisateur",
          created_by_email:  profile?.email || "",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erreur création ticket");
      onCreated(data.ticket);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-border bg-bg-card shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
            <Plus size={16} /> Nouveau ticket
          </h2>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="text-xs text-text-tertiary block mb-1.5">Sujet</label>
            <input
              type="text" required value={form.subject}
              onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
              placeholder="Ex: Mon numéro ne répond plus aux appels"
              className="w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-sm text-text-primary outline-none focus:border-brand"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-text-tertiary block mb-1.5">Catégorie</label>
              <select
                value={form.category}
                onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                className="w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-sm text-text-primary outline-none focus:border-brand"
              >
                {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-text-tertiary block mb-1.5">Priorité</label>
              <select
                value={form.priority}
                onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
                className="w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-sm text-text-primary outline-none focus:border-brand"
              >
                {Object.entries(PRIORITY_META).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-text-tertiary block mb-1.5">Description</label>
            <textarea
              required value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Décrivez votre problème en détail..."
              rows={5}
              className="w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-sm text-text-primary outline-none focus:border-brand resize-none"
            />
          </div>
          {error && (
            <p className="text-sm text-brand-red flex items-center gap-1.5"><AlertCircle size={13}/>{error}</p>
          )}
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="ghost" onClick={onClose}>Annuler</Button>
            <Button type="submit" disabled={loading} className="gap-2">
              {loading ? <Loader2 size={13} className="animate-spin"/> : <Send size={13}/>}
              Envoyer le ticket
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Thread de messages ─────────────────────────────────────────
function TicketThread({ ticket, token, profile, isAdmin, onStatusChange }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reply, setReply] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const [sending, setSending] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    if (!ticket) return;
    setLoading(true);
    fetch(`${API}/api/v1/tickets/${ticket.id}?is_admin=${isAdmin}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(d => { setMessages(d.messages || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [ticket?.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendReply = async () => {
    if (!reply.trim()) return;
    setSending(true);
    try {
      const res = await fetch(`${API}/api/v1/tickets/${ticket.id}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          author_name:   profile?.full_name || "Utilisateur",
          author_role:   isAdmin ? "admin" : "client",
          body:          reply.trim(),
          is_internal:   isAdmin && isInternal,
        }),
      });
      const data = await res.json();
      if (res.ok && data.message) {
        setMessages(m => [...m, data.message]);
        setReply("");
      }
    } catch {}
    setSending(false);
  };

  const sla = SLA_STATUS_META[ticket?.sla_status] || SLA_STATUS_META.ok;

  return (
    <div className="flex flex-col h-full">
      {/* Header du ticket */}
      <div className="p-4 border-b border-border space-y-2 shrink-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-mono text-text-tertiary">{ticket?.ticket_number}</p>
            <h3 className="text-sm font-semibold text-text-primary leading-tight mt-0.5">{ticket?.subject}</h3>
          </div>
          <Badge variant={STATUS_META[ticket?.status]?.variant || "default"}>
            {STATUS_META[ticket?.status]?.label || ticket?.status}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <Badge variant={PRIORITY_META[ticket?.priority]?.variant || "default"} className="text-[10px]">
            {PRIORITY_META[ticket?.priority]?.label || ticket?.priority}
          </Badge>
          <span className="text-[10px] text-text-tertiary">
            {CATEGORIES.find(c => c.key === ticket?.category)?.label || ticket?.category}
          </span>
          <span className={`text-[10px] font-medium ${sla.color}`}>{sla.label}</span>
          <span className="text-[10px] text-text-tertiary ml-auto">{timeAgo(ticket?.created_at)}</span>
        </div>
        {/* Actions admin */}
        {isAdmin && (
          <div className="flex gap-2 pt-1">
            {["in_progress", "resolved", "closed"].map(s => (
              <button key={s}
                onClick={() => onStatusChange(ticket.id, s)}
                className="text-[10px] px-2 py-1 rounded border border-border text-text-secondary hover:border-brand hover:text-brand transition-colors">
                → {STATUS_META[s]?.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-text-tertiary text-sm py-8 justify-center">
            <Loader2 size={15} className="animate-spin"/> Chargement...
          </div>
        ) : (
          messages.map(msg => {
            const isClientMsg = msg.author_role === "client";
            return (
              <div key={msg.id} className={`flex flex-col ${isClientMsg ? "items-end" : "items-start"}`}>
                {msg.is_internal && (
                  <span className="text-[10px] text-brand-orange mb-1 flex items-center gap-1">
                    <Shield size={9}/> Note interne
                  </span>
                )}
                <div className={`max-w-[85%] rounded-xl px-3.5 py-2.5 ${
                  isClientMsg
                    ? "bg-brand/15 border border-brand/20"
                    : msg.is_internal
                      ? "bg-brand-orange/10 border border-brand-orange/20"
                      : "bg-bg-secondary border border-border"
                }`}>
                  <p className="text-xs font-medium text-text-secondary mb-1 flex items-center gap-1.5">
                    {isClientMsg ? <User size={10}/> : <Shield size={10}/>}
                    {msg.author_name}
                  </p>
                  <p className="text-sm text-text-primary leading-relaxed whitespace-pre-wrap">{msg.body}</p>
                </div>
                <span className="text-[10px] text-text-tertiary mt-1">{timeAgo(msg.created_at)}</span>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Zone de réponse */}
      {ticket?.status !== "closed" && (
        <div className="p-3 border-t border-border shrink-0 space-y-2">
          {isAdmin && (
            <label className="flex items-center gap-2 text-xs text-text-tertiary cursor-pointer">
              <input
                type="checkbox" checked={isInternal}
                onChange={e => setIsInternal(e.target.checked)}
                className="rounded"
              />
              Note interne (invisible pour le client)
            </label>
          )}
          <div className="flex gap-2">
            <textarea
              value={reply}
              onChange={e => setReply(e.target.value)}
              onKeyDown={e => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), sendReply())}
              placeholder={isAdmin && isInternal ? "Note interne..." : "Votre réponse..."}
              rows={2}
              className="flex-1 rounded-lg border border-border bg-bg-input px-3 py-2 text-sm text-text-primary outline-none focus:border-brand resize-none"
            />
            <Button size="sm" onClick={sendReply} disabled={sending || !reply.trim()} className="self-end gap-1.5">
              {sending ? <Loader2 size={13} className="animate-spin"/> : <Send size={13}/>}
            </Button>
          </div>
          <p className="text-[10px] text-text-tertiary">Entrée pour envoyer · Maj+Entrée pour saut de ligne</p>
        </div>
      )}
    </div>
  );
}

// ── PAGE PRINCIPALE ────────────────────────────────────────────
export default function Tickets() {
  const { token, effectiveCompanyId, profile } = useAuth();
  const isAdmin = profile?.role === "super_admin";

  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [statusFilter, setStatusFilter] = useState(null);
  const [search, setSearch] = useState("");

  const fetchTickets = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (!isAdmin && effectiveCompanyId) params.set("company_id", effectiveCompanyId);
      if (statusFilter) params.set("status", statusFilter);

      const res = await fetch(`${API}/api/v1/tickets?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setTickets(data.tickets || []);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { fetchTickets(); }, [token, effectiveCompanyId, statusFilter]);

  const handleStatusChange = async (ticketId, newStatus) => {
    await fetch(`${API}/api/v1/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });
    setTickets(t => t.map(x => x.id === ticketId ? { ...x, status: newStatus } : x));
    if (selectedTicket?.id === ticketId) setSelectedTicket(t => ({ ...t, status: newStatus }));
  };

  const filtered = useMemo(() => {
    if (!search) return tickets;
    const q = search.toLowerCase();
    return tickets.filter(t =>
      (t.subject || "").toLowerCase().includes(q) ||
      (t.ticket_number || "").toLowerCase().includes(q) ||
      (t.companies?.name || "").toLowerCase().includes(q)
    );
  }, [tickets, search]);

  // KPIs
  const kpis = useMemo(() => ({
    open:     tickets.filter(t => t.status === "open").length,
    progress: tickets.filter(t => t.status === "in_progress").length,
    sla:      tickets.filter(t => t.sla_status === "breached").length,
    resolved: tickets.filter(t => ["resolved", "closed"].includes(t.status)).length,
  }), [tickets]);

  return (
    <div className="space-y-4 h-full">
      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Ouverts",       value: kpis.open,     color: "text-brand",        bg: "bg-brand/10" },
          { label: "En cours",      value: kpis.progress, color: "text-brand-orange", bg: "bg-brand-orange/10" },
          { label: "SLA dépassé",   value: kpis.sla,      color: "text-brand-red",    bg: "bg-brand-red/10" },
          { label: "Résolus",       value: kpis.resolved, color: "text-brand-green",  bg: "bg-brand-green/10" },
        ].map(k => (
          <div key={k.label} className={`rounded-xl border border-border ${k.bg} p-4`}>
            <p className={`text-2xl font-bold ${k.color}`}>{k.value}</p>
            <p className="text-xs text-text-tertiary mt-0.5">{k.label}</p>
          </div>
        ))}
      </div>

      {/* Header + actions */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Chercher un ticket..."
            className="rounded-lg border border-border bg-bg-input px-3 py-1.5 text-sm text-text-primary outline-none focus:border-brand w-52"
          />
          <div className="flex gap-1">
            {[null, "open", "in_progress", "resolved"].map(s => (
              <button key={s ?? "all"}
                onClick={() => setStatusFilter(s)}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  statusFilter === s
                    ? "bg-brand text-white"
                    : "border border-border text-text-secondary hover:border-brand/50"
                }`}>
                {s ? STATUS_META[s]?.label : "Tous"}
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchTickets}>
            <RefreshCcw size={13}/>
          </Button>
          {!isAdmin && (
            <Button size="sm" onClick={() => setShowNewModal(true)} className="gap-1.5">
              <Plus size={13}/> Nouveau ticket
            </Button>
          )}
        </div>
      </div>

      {/* Liste + détail côte à côte */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" style={{ height: "calc(100vh - 280px)" }}>
        {/* Liste */}
        <div className="rounded-xl border border-border bg-bg-card overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-text-tertiary">
              <Loader2 size={16} className="animate-spin"/> Chargement...
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-center px-6">
              <LifeBuoy size={28} className="text-text-tertiary" />
              <p className="text-sm font-medium text-text-primary">
                {search ? "Aucun ticket correspondant" : "Aucun ticket"}
              </p>
              {!isAdmin && !search && (
                <Button size="sm" onClick={() => setShowNewModal(true)} className="gap-1.5 mt-1">
                  <Plus size={12}/> Créer un ticket
                </Button>
              )}
            </div>
          ) : (
            filtered.map(ticket => {
              const pMeta = PRIORITY_META[ticket.priority] || PRIORITY_META.normal;
              const sMeta = STATUS_META[ticket.status] || STATUS_META.open;
              const sla = SLA_STATUS_META[ticket.sla_status] || SLA_STATUS_META.ok;
              const isSelected = selectedTicket?.id === ticket.id;

              return (
                <button key={ticket.id}
                  onClick={() => setSelectedTicket(ticket)}
                  className={`w-full text-left px-4 py-3.5 border-b border-border hover:bg-bg-hover transition-colors ${isSelected ? "bg-brand/5 border-l-2 border-l-brand" : ""}`}>
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <div className="min-w-0">
                      <p className="text-[10px] font-mono text-text-tertiary">{ticket.ticket_number}</p>
                      <p className="text-sm font-medium text-text-primary truncate">{ticket.subject}</p>
                      {isAdmin && ticket.companies?.name && (
                        <p className="text-xs text-text-tertiary mt-0.5">{ticket.companies.name}</p>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <Badge variant={sMeta.variant} className="text-[10px]">{sMeta.label}</Badge>
                      <span className={`text-[10px] ${sla.color}`}>{sla.label}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={pMeta.variant} className="text-[10px]">{pMeta.label}</Badge>
                    <span className="text-[10px] text-text-tertiary">
                      {CATEGORIES.find(c => c.key === ticket.category)?.label}
                    </span>
                    <span className="text-[10px] text-text-tertiary ml-auto">{timeAgo(ticket.created_at)}</span>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Détail / Thread */}
        <div className="rounded-xl border border-border bg-bg-card overflow-hidden flex flex-col">
          {selectedTicket ? (
            <TicketThread
              ticket={selectedTicket}
              token={token}
              profile={profile}
              isAdmin={isAdmin}
              onStatusChange={handleStatusChange}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-8 text-text-tertiary">
              <MessageSquare size={28} />
              <p className="text-sm">Sélectionnez un ticket pour voir la conversation</p>
            </div>
          )}
        </div>
      </div>

      {/* Modal nouveau ticket */}
      {showNewModal && (
        <NewTicketModal
          onClose={() => setShowNewModal(false)}
          onCreated={(t) => { setTickets(prev => [t, ...prev]); setSelectedTicket(t); }}
          token={token}
          companyId={effectiveCompanyId}
          profile={profile}
        />
      )}
    </div>
  );
}
