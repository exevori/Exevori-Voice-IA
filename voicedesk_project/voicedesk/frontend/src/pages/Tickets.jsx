import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  LifeBuoy,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCcw,
  Send,
  Shield,
  User,
  UserRoundCheck,
  X,
} from "lucide-react";

import { useAuth } from "../contexts/AuthContext.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";

const API = import.meta.env.VITE_API_URL || "";

const PRIORITY_META = {
  urgent: { label: "Urgente", variant: "red" },
  high: { label: "Haute", variant: "orange" },
  normal: { label: "Moyenne", variant: "default" },
  low: { label: "Basse", variant: "green" },
};

const STATUS_META = {
  open: { label: "Ouvert", variant: "cyan" },
  in_progress: { label: "En cours", variant: "orange" },
  waiting_client: { label: "En attente client", variant: "purple" },
  resolved: { label: "Résolu", variant: "green" },
  closed: { label: "Fermé", variant: "ghost" },
};

const STATUS_ACTIONS = ["open", "in_progress", "resolved", "closed"];

const CATEGORIES = [
  { key: "general", label: "Question générale" },
  { key: "technical", label: "Problème technique" },
  { key: "billing", label: "Facturation" },
  { key: "feature_request", label: "Demande de fonctionnalité" },
  { key: "bug", label: "Anomalie" },
  { key: "onboarding", label: "Démarrage" },
];

const SLA_META = {
  on_track: { label: "Dans les délais", className: "text-brand-green" },
  at_risk: { label: "À risque", className: "text-brand-orange" },
  breached: { label: "SLA dépassé", className: "text-brand-red" },
  completed: { label: "SLA terminé", className: "text-text-tertiary" },
};

async function requestJson(path, { token, ...options } = {}) {
  const headers = new Headers(options.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${API}${path}`, { ...options, headers });
  const raw = await response.text();
  let payload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { message: raw.slice(0, 300) };
    }
  }
  if (!response.ok) {
    throw new Error(payload.message || payload.error || `Erreur HTTP ${response.status}`);
  }
  return payload;
}

function timeAgo(dateValue, nowMs = Date.now()) {
  const timestamp = new Date(dateValue).getTime();
  if (!Number.isFinite(timestamp)) return "—";
  const minutes = Math.max(0, Math.floor((nowMs - timestamp) / 60_000));
  if (minutes < 1) return "à l’instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return `il y a ${Math.floor(hours / 24)} j`;
}

function durationLabel(milliseconds) {
  const absolute = Math.abs(milliseconds);
  const minutes = Math.max(1, Math.ceil(absolute / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.ceil(hours / 24)} j`;
}

function slaPresentation(ticket, nowMs) {
  let currentStatus = ticket?.sla_status || "on_track";
  if (!ticket?.sla_deadline || ticket.sla_status === "completed") {
    const meta = SLA_META[currentStatus] || SLA_META.on_track;
    return { ...meta, timer: null, milestone: null, status: currentStatus };
  }
  const remaining = new Date(ticket.sla_deadline).getTime() - nowMs;
  if (!Number.isFinite(remaining)) {
    const meta = SLA_META[currentStatus] || SLA_META.on_track;
    return { ...meta, timer: null, milestone: null, status: currentStatus };
  }
  const riskWindow = ticket.sla_milestone === "first_response" ? 3_600_000 : 4 * 3_600_000;
  if (remaining <= 0) currentStatus = "breached";
  else if (remaining <= riskWindow) currentStatus = "at_risk";
  const meta = SLA_META[currentStatus] || SLA_META.on_track;
  return {
    ...meta,
    status: currentStatus,
    timer: remaining <= 0
      ? `dépassé de ${durationLabel(remaining)}`
      : `dans ${durationLabel(remaining)}`,
    milestone: ticket.sla_milestone === "first_response"
      ? "1re réponse"
      : "résolution",
  };
}

function useClock(intervalMs = 1_000) {
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return nowMs;
}

function ErrorBanner({ message, onClose }) {
  if (!message) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-xl border border-brand-red/30 bg-brand-red/10 px-3 py-2.5 text-sm text-brand-red">
      <AlertCircle size={16} className="mt-0.5 shrink-0" />
      <span className="flex-1">{message}</span>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Fermer l’erreur">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

function NewTicketModal({ onClose, onCreated, token, companyId }) {
  const [form, setForm] = useState({
    subject: "",
    description: "",
    category: "general",
    priority: "normal",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const submit = async event => {
    event.preventDefault();
    const subject = form.subject.trim();
    const description = form.description.trim();
    if (!subject || !description) {
      setError("Le sujet et la description sont obligatoires.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await requestJson("/api/v1/tickets", {
        token,
        method: "POST",
        body: JSON.stringify({ ...form, subject, description, company_id: companyId }),
      });
      onCreated(result.ticket);
      onClose();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-ticket-title"
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-bg-card shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-border p-5">
          <h2 id="new-ticket-title" className="flex items-center gap-2 font-semibold text-text-primary">
            <LifeBuoy size={18} /> Nouvelle demande de support
          </h2>
          <button type="button" onClick={onClose} className="text-text-tertiary hover:text-text-primary" aria-label="Fermer">
            <X size={18} />
          </button>
        </header>
        <form onSubmit={submit} className="space-y-4 p-5">
          <div>
            <label htmlFor="ticket-subject" className="mb-1.5 block text-xs text-text-tertiary">Sujet</label>
            <input
              id="ticket-subject"
              required
              maxLength={200}
              value={form.subject}
              onChange={event => setForm(current => ({ ...current, subject: event.target.value }))}
              placeholder="Ex. Mon numéro ne répond plus aux appels"
              className="w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-sm text-text-primary outline-none focus:border-brand"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="ticket-category" className="mb-1.5 block text-xs text-text-tertiary">Catégorie</label>
              <select
                id="ticket-category"
                value={form.category}
                onChange={event => setForm(current => ({ ...current, category: event.target.value }))}
                className="w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-sm text-text-primary outline-none focus:border-brand"
              >
                {CATEGORIES.map(category => (
                  <option key={category.key} value={category.key}>{category.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="ticket-priority" className="mb-1.5 block text-xs text-text-tertiary">Priorité</label>
              <select
                id="ticket-priority"
                value={form.priority}
                onChange={event => setForm(current => ({ ...current, priority: event.target.value }))}
                className="w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-sm text-text-primary outline-none focus:border-brand"
              >
                {Object.entries(PRIORITY_META).map(([value, meta]) => (
                  <option key={value} value={value}>{meta.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="ticket-description" className="mb-1.5 block text-xs text-text-tertiary">Description</label>
            <textarea
              id="ticket-description"
              required
              maxLength={10000}
              rows={6}
              value={form.description}
              onChange={event => setForm(current => ({ ...current, description: event.target.value }))}
              placeholder="Expliquez ce qui se passe, le résultat attendu et depuis quand le problème existe."
              className="w-full resize-none rounded-lg border border-border bg-bg-input px-3 py-2 text-sm text-text-primary outline-none focus:border-brand"
            />
            <p className="mt-1 text-right text-[10px] text-text-tertiary">{form.description.length}/10 000</p>
          </div>
          <ErrorBanner message={error} />
          <footer className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Annuler</Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Envoyer
            </Button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function AdminControls({ ticket, token, agents, onUpdated }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const mutate = async (kind, body) => {
    setBusy(kind);
    setError(null);
    try {
      const result = await requestJson(`/api/v1/tickets/${ticket.id}/${kind}`, {
        token,
        method: "PATCH",
        body: JSON.stringify(body),
      });
      onUpdated(result.ticket);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="space-y-1 text-[10px] uppercase tracking-wide text-text-tertiary">
          <span>Responsable</span>
          <select
            aria-label="Responsable du ticket"
            disabled={Boolean(busy)}
            value={ticket.assigned_to_user_id || ""}
            onChange={event => mutate("assign", { assigned_to_user_id: event.target.value || null })}
            className="w-full rounded-lg border border-border bg-bg-input px-2 py-1.5 text-xs normal-case tracking-normal text-text-primary"
          >
            <option value="">Non assigné</option>
            {agents.map(agent => (
              <option key={agent.user_id} value={agent.user_id}>{agent.full_name}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-[10px] uppercase tracking-wide text-text-tertiary">
          <span>Priorité</span>
          <select
            aria-label="Priorité du ticket"
            disabled={Boolean(busy)}
            value={ticket.priority}
            onChange={event => mutate("priority", { priority: event.target.value })}
            className="w-full rounded-lg border border-border bg-bg-input px-2 py-1.5 text-xs normal-case tracking-normal text-text-primary"
          >
            {Object.entries(PRIORITY_META).map(([value, meta]) => (
              <option key={value} value={value}>{meta.label}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-[10px] uppercase tracking-wide text-text-tertiary">
          <span>Statut</span>
          <select
            aria-label="Statut du ticket"
            disabled={Boolean(busy)}
            value={ticket.status}
            onChange={event => mutate("status", { status: event.target.value })}
            className="w-full rounded-lg border border-border bg-bg-input px-2 py-1.5 text-xs normal-case tracking-normal text-text-primary"
          >
            {ticket.status === "waiting_client" && (
              <option value="waiting_client" disabled>En attente client (historique)</option>
            )}
            {STATUS_ACTIONS.map(value => (
              <option key={value} value={value}>{STATUS_META[value].label}</option>
            ))}
          </select>
        </label>
      </div>
      {busy && <p className="flex items-center gap-1 text-[10px] text-text-tertiary"><Loader2 size={10} className="animate-spin" /> Mise à jour…</p>}
      <ErrorBanner message={error} onClose={() => setError(null)} />
    </div>
  );
}

function TicketThread({ ticket: initialTicket, token, isAdmin, agents, onUpdated }) {
  const [ticket, setTicket] = useState(initialTicket);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reply, setReply] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const bottomRef = useRef(null);
  const nowMs = useClock();

  const updateTicket = useCallback(updated => {
    setTicket(current => ({ ...current, ...updated }));
    onUpdated(updated);
  }, [onUpdated]);

  useEffect(() => {
    setTicket(initialTicket);
    setMessages([]);
    setError(null);
    setLoading(true);
    const controller = new AbortController();
    requestJson(`/api/v1/tickets/${initialTicket.id}`, {
      token,
      signal: controller.signal,
    }).then(result => {
      setTicket(result.ticket);
      setMessages(result.messages || []);
      onUpdated(result.ticket);
    }).catch(requestError => {
      if (requestError.name !== "AbortError") setError(requestError.message);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [initialTicket.id, token, onUpdated]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (isAdmin && ticket?.status === "closed") setIsInternal(true);
  }, [isAdmin, ticket?.status]);

  const submitReply = async () => {
    const body = reply.trim();
    if (!body) return;
    setSending(true);
    setError(null);
    try {
      const result = await requestJson(`/api/v1/tickets/${ticket.id}/messages`, {
        token,
        method: "POST",
        body: JSON.stringify({ body, is_internal: isAdmin && isInternal }),
      });
      setMessages(current => [...current, result.message]);
      updateTicket(result.ticket);
      setReply("");
      if (ticket.status !== "closed") setIsInternal(false);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSending(false);
    }
  };

  const sla = slaPresentation(ticket, nowMs);
  const canReply = ticket?.status !== "closed" || (isAdmin && isInternal);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 space-y-3 border-b border-border p-4">
        <div className="flex items-start justify-between gap-3 pr-8">
          <div className="min-w-0">
            <p className="font-mono text-[10px] text-text-tertiary">{ticket?.ticket_number || "Chargement…"}</p>
            <h2 className="mt-0.5 text-base font-semibold leading-tight text-text-primary">{ticket?.subject}</h2>
            {isAdmin && ticket?.companies?.name && (
              <p className="mt-1 text-xs text-text-tertiary">{ticket.companies.name} · {ticket.created_by_name}</p>
            )}
          </div>
          <Badge variant={STATUS_META[ticket?.status]?.variant || "ghost"}>
            {STATUS_META[ticket?.status]?.label || ticket?.status}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <Badge variant={PRIORITY_META[ticket?.priority]?.variant || "default"}>
            {PRIORITY_META[ticket?.priority]?.label || ticket?.priority}
          </Badge>
          <span className="text-text-tertiary">
            {CATEGORIES.find(category => category.key === ticket?.category)?.label || ticket?.category}
          </span>
          <span className={`flex items-center gap-1 font-medium ${sla.className}`}>
            <Clock3 size={11} /> {sla.label}
            {sla.timer && ` · ${sla.milestone} ${sla.timer}`}
          </span>
          {ticket?.assigned_to_name && (
            <span className="ml-auto flex items-center gap-1 text-text-tertiary">
              <UserRoundCheck size={11} /> {ticket.assigned_to_name}
            </span>
          )}
        </div>
        {isAdmin && ticket && (
          <AdminControls ticket={ticket} token={token} agents={agents} onUpdated={updateTicket} />
        )}
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-text-tertiary">
            <Loader2 size={16} className="animate-spin" /> Chargement du fil…
          </div>
        ) : messages.length ? messages.map(message => {
          const clientMessage = message.author_role === "client";
          return (
            <article key={message.id} className={`flex flex-col ${clientMessage ? "items-end" : "items-start"}`}>
              {message.is_internal && (
                <span className="mb-1 flex items-center gap-1 text-[10px] font-medium text-brand-orange">
                  <Shield size={10} /> Note interne — invisible au client
                </span>
              )}
              <div className={`max-w-[88%] rounded-xl border px-3.5 py-2.5 ${
                message.is_internal
                  ? "border-brand-orange/25 bg-brand-orange/10"
                  : clientMessage
                    ? "border-brand/25 bg-brand/10"
                    : "border-border bg-bg-secondary"
              }`}>
                <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-text-secondary">
                  {clientMessage ? <User size={11} /> : <Shield size={11} />}
                  {message.author_name || (clientMessage ? "Client" : "Équipe Exevori")}
                </p>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-text-primary">{message.body}</p>
              </div>
              <time className="mt-1 text-[10px] text-text-tertiary">{timeAgo(message.created_at, nowMs)}</time>
            </article>
          );
        }) : (
          <p className="py-12 text-center text-sm text-text-tertiary">Aucun message dans ce fil.</p>
        )}
        <div ref={bottomRef} />
      </div>

      <footer className="shrink-0 space-y-2 border-t border-border p-3">
        <ErrorBanner message={error} onClose={() => setError(null)} />
        {isAdmin && (
          <label className="flex cursor-pointer items-center gap-2 text-xs text-text-tertiary">
            <input
              type="checkbox"
              checked={isInternal}
              disabled={ticket?.status === "closed"}
              onChange={event => setIsInternal(event.target.checked)}
              className="rounded"
            />
            Note interne (jamais visible ni envoyée par courriel au client)
          </label>
        )}
        {canReply ? (
          <div className="flex gap-2">
            <textarea
              value={reply}
              maxLength={10000}
              onChange={event => setReply(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submitReply();
                }
              }}
              placeholder={isAdmin && isInternal ? "Ajouter une note interne…" : "Écrire une réponse…"}
              rows={2}
              className="flex-1 resize-none rounded-lg border border-border bg-bg-input px-3 py-2 text-sm text-text-primary outline-none focus:border-brand"
            />
            <Button size="sm" onClick={submitReply} disabled={sending || !reply.trim()} className="self-end" aria-label="Envoyer la réponse">
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            </Button>
          </div>
        ) : (
          <p className="rounded-lg bg-white/5 px-3 py-2 text-xs text-text-tertiary">Ce ticket est fermé. Contactez le support avec un nouveau ticket si nécessaire.</p>
        )}
        {canReply && <p className="text-[10px] text-text-tertiary">Entrée pour envoyer · Maj + Entrée pour une nouvelle ligne</p>}
      </footer>
    </div>
  );
}

function TicketCard({ ticket, selected, onClick, nowMs, isAdmin }) {
  const status = STATUS_META[ticket.status] || STATUS_META.open;
  const priority = PRIORITY_META[ticket.priority] || PRIORITY_META.normal;
  const sla = slaPresentation(ticket, nowMs);
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full space-y-2 border-b border-border p-4 text-left transition-colors last:border-b-0 ${
        selected ? "bg-brand/10" : "hover:bg-white/[0.03]"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[10px] text-text-tertiary">{ticket.ticket_number}</p>
          <p className="truncate text-sm font-medium text-text-primary">{ticket.subject}</p>
        </div>
        <Badge variant={status.variant}>{status.label}</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[10px] text-text-tertiary">
        <Badge variant={priority.variant}>{priority.label}</Badge>
        {isAdmin && ticket.companies?.name && <span className="truncate">{ticket.companies.name}</span>}
        <span className={`flex items-center gap-1 ${sla.className}`}>
          <Clock3 size={10} /> {sla.timer || sla.label}
        </span>
        <span className="ml-auto">{timeAgo(ticket.updated_at || ticket.created_at, nowMs)}</span>
      </div>
    </button>
  );
}

export default function Tickets() {
  const { token, effectiveCompanyId, profile } = useAuth();
  const isAdmin = profile?.role === "super_admin";
  const [searchParams, setSearchParams] = useSearchParams();
  const [tickets, setTickets] = useState([]);
  const [agents, setAgents] = useState([]);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const nowMs = useClock(10_000);

  const fetchTickets = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (!isAdmin && effectiveCompanyId) params.set("company_id", effectiveCompanyId);
      if (statusFilter) params.set("status", statusFilter);
      const result = await requestJson(`/api/v1/tickets?${params}`, { token });
      setTickets(result.tickets || []);
      const requestedTicketId = searchParams.get("ticket");
      if (requestedTicketId) {
        const match = result.tickets?.find(ticket => ticket.id === requestedTicketId);
        setSelectedTicket(current => match || current || { id: requestedTicketId });
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, [token, isAdmin, effectiveCompanyId, statusFilter, searchParams]);

  useEffect(() => {
    void fetchTickets();
  }, [fetchTickets]);

  useEffect(() => {
    if (!isAdmin || !token) {
      setAgents([]);
      return;
    }
    requestJson("/api/v1/tickets/agents", { token })
      .then(result => setAgents(result.agents || []))
      .catch(requestError => setError(requestError.message));
  }, [isAdmin, token]);

  const selectTicket = ticket => {
    setSelectedTicket(ticket);
    const next = new URLSearchParams(searchParams);
    next.set("ticket", ticket.id);
    setSearchParams(next, { replace: true });
  };

  const closeTicket = () => {
    setSelectedTicket(null);
    const next = new URLSearchParams(searchParams);
    next.delete("ticket");
    setSearchParams(next, { replace: true });
  };

  const updateTicket = useCallback(updated => {
    if (!updated?.id) return;
    setTickets(current => current.map(ticket => ticket.id === updated.id ? { ...ticket, ...updated } : ticket));
    setSelectedTicket(current => current?.id === updated.id ? { ...current, ...updated } : current);
  }, []);

  const onCreated = ticket => {
    setTickets(current => [ticket, ...current]);
    selectTicket(ticket);
  };

  const filteredTickets = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return tickets;
    return tickets.filter(ticket => [
      ticket.subject,
      ticket.ticket_number,
      ticket.companies?.name,
      ticket.created_by_name,
    ].some(value => String(value || "").toLowerCase().includes(needle)));
  }, [tickets, search]);

  const kpis = useMemo(() => ({
    open: tickets.filter(ticket => ticket.status === "open").length,
    progress: tickets.filter(ticket => ["in_progress", "waiting_client"].includes(ticket.status)).length,
    sla: tickets.filter(ticket => slaPresentation(ticket, nowMs).status === "breached").length,
    resolved: tickets.filter(ticket => ["resolved", "closed"].includes(ticket.status)).length,
  }), [tickets, nowMs]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-text-primary">
            <LifeBuoy size={21} className="text-brand" /> Support
          </h1>
          <p className="mt-1 text-sm text-text-tertiary">
            {isAdmin ? "Suivi de toutes les demandes clients" : "Une demande, un responsable et un délai clair"}
          </p>
        </div>
        {!isAdmin && (
          <Button size="sm" onClick={() => setShowNew(true)}>
            <Plus size={14} /> Nouveau ticket
          </Button>
        )}
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Ouverts", value: kpis.open, icon: MessageSquare, color: "text-brand", bg: "bg-brand/10" },
          { label: "En cours", value: kpis.progress, icon: Clock3, color: "text-brand-orange", bg: "bg-brand-orange/10" },
          { label: "SLA dépassés", value: kpis.sla, icon: AlertTriangle, color: "text-brand-red", bg: "bg-brand-red/10" },
          { label: "Résolus", value: kpis.resolved, icon: CheckCircle2, color: "text-brand-green", bg: "bg-brand-green/10" },
        ].map(item => (
          <div key={item.label} className={`rounded-xl border border-border p-3 ${item.bg}`}>
            <div className={`flex items-center gap-2 ${item.color}`}>
              <item.icon size={15} />
              <strong className="text-xl">{item.value}</strong>
            </div>
            <p className="mt-0.5 text-xs text-text-tertiary">{item.label}</p>
          </div>
        ))}
      </div>

      <ErrorBanner message={error} onClose={() => setError(null)} />

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder="Rechercher un ticket…"
          className="min-w-52 flex-1 rounded-lg border border-border bg-bg-input px-3 py-1.5 text-sm text-text-primary outline-none focus:border-brand sm:max-w-xs"
        />
        <div className="flex flex-wrap gap-1">
          {["", "open", "in_progress", "resolved", "closed"].map(status => (
            <button
              type="button"
              key={status || "all"}
              onClick={() => setStatusFilter(status)}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                statusFilter === status
                  ? "bg-brand text-white"
                  : "border border-border text-text-secondary hover:border-brand/50"
              }`}
            >
              {status ? STATUS_META[status].label : "Tous"}
            </button>
          ))}
        </div>
        <Button variant="outline" size="icon" onClick={fetchTickets} aria-label="Actualiser les tickets">
          <RefreshCcw size={14} className={loading ? "animate-spin" : ""} />
        </Button>
      </div>

      <div className="grid min-h-[520px] flex-1 overflow-hidden rounded-xl border border-border bg-bg-card lg:grid-cols-[minmax(300px,0.85fr)_minmax(420px,1.35fr)]">
        <section aria-label="Liste des tickets" className={`${selectedTicket ? "hidden lg:block" : "block"} min-h-0 overflow-y-auto border-r border-border`}>
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-text-tertiary">
              <Loader2 size={16} className="animate-spin" /> Chargement…
            </div>
          ) : filteredTickets.length ? filteredTickets.map(ticket => (
            <TicketCard
              key={ticket.id}
              ticket={ticket}
              selected={ticket.id === selectedTicket?.id}
              onClick={() => selectTicket(ticket)}
              nowMs={nowMs}
              isAdmin={isAdmin}
            />
          )) : (
            <div className="px-6 py-16 text-center">
              <MessageSquare size={28} className="mx-auto mb-3 text-text-tertiary" />
              <p className="text-sm font-medium text-text-secondary">Aucun ticket trouvé</p>
              <p className="mt-1 text-xs text-text-tertiary">Modifiez le filtre ou créez une nouvelle demande.</p>
            </div>
          )}
        </section>
        <section aria-label="Détail du ticket" className={`${selectedTicket ? "block" : "hidden lg:block"} min-h-0`}>
          {selectedTicket ? (
            <div className="relative h-full">
              <button type="button" onClick={closeTicket} className="absolute right-3 top-3 z-10 rounded-md p-1.5 text-text-tertiary hover:bg-white/5 hover:text-text-primary" aria-label="Fermer le détail">
                <X size={16} />
              </button>
              <TicketThread
                key={selectedTicket.id}
                ticket={selectedTicket}
                token={token}
                isAdmin={isAdmin}
                agents={agents}
                onUpdated={updateTicket}
              />
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center text-text-tertiary">
              <LifeBuoy size={34} className="mb-3 opacity-60" />
              <p className="text-sm font-medium text-text-secondary">Sélectionnez un ticket</p>
              <p className="mt-1 max-w-sm text-xs">Le fil complet, le responsable et le compteur SLA apparaîtront ici.</p>
            </div>
          )}
        </section>
      </div>

      {showNew && (
        <NewTicketModal
          token={token}
          companyId={effectiveCompanyId}
          onClose={() => setShowNew(false)}
          onCreated={onCreated}
        />
      )}
    </div>
  );
}
