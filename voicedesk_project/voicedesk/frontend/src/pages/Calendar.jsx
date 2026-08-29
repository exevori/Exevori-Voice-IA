// ============================================================
// EXEVORI VOICE IA — CALENDRIER / CALENDLY
// OAuth par entreprise, disponibilités réelles et réservation directe.
// ============================================================

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
  Building2,
  Calendar as CalendarIcon,
  CalendarPlus,
  CheckCircle2,
  Clock,
  ExternalLink,
  Link2,
  Link2Off,
  Loader2,
  Mail,
  Phone,
  RefreshCcw,
  Save,
  User,
  XCircle,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import DataTable from "../components/common/DataTable.jsx";
import FilterBar from "../components/common/FilterBar.jsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet.jsx";

const API = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
const COMPANY_MANAGER_ROLES = new Set(["company_admin", "super_admin"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SELECT_CLASS = "h-10 w-full rounded-lg border border-border bg-bg-card px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-brand-purple/30 focus:border-brand-purple/50 disabled:cursor-not-allowed disabled:opacity-50";

const STATUS_META = {
  pending: { label: "En attente", variant: "orange" },
  confirmed: { label: "Confirmé", variant: "green" },
  cancelled: { label: "Annulé", variant: "red" },
  completed: { label: "Complété", variant: "default" },
};

const CONNECTION_META = {
  connected: { label: "Connecté", variant: "green" },
  connecting: { label: "Connexion en cours", variant: "orange" },
  reconnect_required: { label: "Reconnexion requise", variant: "orange" },
  error: { label: "Erreur", variant: "red" },
  disconnected: { label: "Non connecté", variant: "ghost" },
};

class ApiError extends Error {
  constructor(message, status, payload = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

function newIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `booking-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
}

function queryString(values) {
  const params = new URLSearchParams();
  Object.entries(values || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  });
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

async function apiRequest(resourcePath, { token, method = "GET", body, signal, idempotencyKey } = {}) {
  const response = await fetch(`${API}${resourcePath}`, {
    method,
    signal,
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text.slice(0, 500) };
    }
  }

  if (!response.ok) {
    throw new ApiError(
      payload.message || payload.error || `La requête a échoué (HTTP ${response.status}).`,
      response.status,
      payload
    );
  }
  return payload;
}

function calendarRequest(path, options) {
  return apiRequest(`/api/v1/calendar${path}`, options);
}

function normalizeConnection(payload) {
  const raw = payload?.connection || payload || {};
  const status = raw.status || (payload?.connected ? "connected" : "disconnected");
  return {
    ...raw,
    status,
    connected: payload?.connected === true || status === "connected",
  };
}

function eventTypeUri(eventType) {
  return eventType?.uri || eventType?.event_type_uri || "";
}

function eventTypeName(eventType) {
  return eventType?.name || eventType?.label || "Type de rendez-vous";
}

function eventTypeDuration(eventType) {
  const duration = eventType?.duration_minutes ?? eventType?.duration;
  return Number.isFinite(Number(duration)) ? Number(duration) : null;
}

function slotStart(slot) {
  return slot?.start_time || slot?.start || "";
}

function appointmentStart(appointment) {
  if (appointment?.start_at) return new Date(appointment.start_at);
  if (!appointment?.date) return null;
  const rawTime = String(appointment.time || "00:00:00").slice(0, 8);
  const normalizedTime = rawTime.length === 5 ? `${rawTime}:00` : rawTime;
  const date = new Date(`${appointment.date}T${normalizedTime}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateTime(value, options = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fr-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    ...options,
  }).format(date);
}

function safeCalendlyUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:") return null;
    if (host !== "calendly.com" && !host.endsWith(".calendly.com")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function defaultBooking() {
  let timezone = "America/Toronto";
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || timezone;
  } catch {
    // Le fuseau de repli demeure America/Toronto.
  }
  return {
    contact_id: "",
    name: "",
    email: "",
    phone: "",
    timezone,
    event_type_uri: "",
    start_time: "",
    confirmed: false,
  };
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status || "Inconnu", variant: "ghost" };
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

function Notice({ type = "info", children, action }) {
  const isError = type === "error";
  const Icon = isError ? AlertCircle : CheckCircle2;
  return (
    <div
      className={`flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${
        isError
          ? "border-brand-red/30 bg-brand-red/10 text-red-200"
          : "border-brand-green/30 bg-brand-green/10 text-emerald-200"
      }`}
      role={isError ? "alert" : "status"}
      aria-live="polite"
    >
      <div className="flex min-w-0 items-start gap-2">
        <Icon size={16} className="mt-0.5 shrink-0" />
        <span>{children}</span>
      </div>
      {action}
    </div>
  );
}

function KpiCard({ label, value, icon: Icon, color }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-bg-card p-4">
      <div className={`rounded-lg p-2 ${color}`} aria-hidden="true">
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
  const { token, effectiveCompanyId, profile } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const canManageConnection = COMPANY_MANAGER_ROLES.has(profile?.role);

  const [connection, setConnection] = useState(null);
  const [eventTypes, setEventTypes] = useState([]);
  const [defaultEventType, setDefaultEventType] = useState("");
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState("");
  const [appointmentsError, setAppointmentsError] = useState("");
  const [feedback, setFeedback] = useState(null);
  const [busyAction, setBusyAction] = useState("");
  const [disconnectConfirm, setDisconnectConfirm] = useState(false);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [externalUrl, setExternalUrl] = useState("");

  const [bookingOpen, setBookingOpen] = useState(false);
  const [booking, setBooking] = useState(defaultBooking);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [availability, setAvailability] = useState([]);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [availabilityError, setAvailabilityError] = useState("");

  const pageRequestRef = useRef({ generation: 0, controller: null });
  const availabilityRequestRef = useRef({ generation: 0, controller: null });
  const contactRequestRef = useRef({ generation: 0, controller: null });

  const resetBookingKey = useCallback(() => {
    setIdempotencyKey(newIdempotencyKey());
  }, []);

  const updateBooking = useCallback((patch) => {
    setBooking((current) => ({ ...current, ...patch }));
    setIdempotencyKey(newIdempotencyKey());
  }, []);

  const loadCalendar = useCallback(async () => {
    pageRequestRef.current.controller?.abort();
    const controller = new AbortController();
    const generation = pageRequestRef.current.generation + 1;
    pageRequestRef.current = { generation, controller };

    if (!token || !effectiveCompanyId) {
      setConnection(null);
      setEventTypes([]);
      setAppointments([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setConnectionError("");
    setAppointmentsError("");

    const companyQuery = queryString({ company_id: effectiveCompanyId });
    const [connectionResult, appointmentsResult] = await Promise.allSettled([
      calendarRequest(`/connection${companyQuery}`, { token, signal: controller.signal }),
      calendarRequest(`/appointments${companyQuery}`, { token, signal: controller.signal }),
    ]);

    if (controller.signal.aborted || pageRequestRef.current.generation !== generation) return;

    let nextConnection = null;
    if (connectionResult.status === "fulfilled") {
      nextConnection = normalizeConnection(connectionResult.value);
      setConnection(nextConnection);
      setDefaultEventType(nextConnection.default_event_type_uri || "");
    } else if (connectionResult.reason?.name !== "AbortError") {
      setConnection(null);
      setConnectionError(connectionResult.reason?.message || "Impossible de vérifier Calendly.");
    }

    if (appointmentsResult.status === "fulfilled") {
      setAppointments(appointmentsResult.value.appointments || []);
    } else if (appointmentsResult.reason?.name !== "AbortError") {
      setAppointmentsError(appointmentsResult.reason?.message || "Impossible de charger les rendez-vous.");
    }

    if (nextConnection?.connected) {
      try {
        const data = await calendarRequest(`/event-types${companyQuery}`, {
          token,
          signal: controller.signal,
        });
        if (!controller.signal.aborted && pageRequestRef.current.generation === generation) {
          const types = Array.isArray(data.event_types)
            ? data.event_types.filter((eventType) => eventTypeUri(eventType))
            : [];
          setEventTypes(types);
          const configured = nextConnection.default_event_type_uri || "";
          const fallback = eventTypeUri(types[0]);
          setDefaultEventType(configured || fallback);
          setBooking((current) => ({
            ...current,
            event_type_uri: current.event_type_uri || configured || fallback,
          }));
        }
      } catch (error) {
        if (error?.name !== "AbortError" && pageRequestRef.current.generation === generation) {
          setEventTypes([]);
          setConnectionError(error.message || "Impossible de charger les types de rendez-vous.");
        }
      }
    } else {
      setEventTypes([]);
    }

    if (!controller.signal.aborted && pageRequestRef.current.generation === generation) {
      setLoading(false);
    }
  }, [effectiveCompanyId, token]);

  useEffect(() => {
    setBooking(defaultBooking());
    setIdempotencyKey(newIdempotencyKey());
    setBookingOpen(false);
    setAvailability([]);
    setSelectedId(null);
    setDisconnectConfirm(false);
    setCancelConfirm(false);
    setExternalUrl("");
  }, [effectiveCompanyId]);

  useEffect(() => {
    loadCalendar();
    return () => pageRequestRef.current.controller?.abort();
  }, [loadCalendar]);

  useEffect(() => {
    const oauthState = searchParams.get("calendar") || searchParams.get("calendly") || searchParams.get("oauth");
    const oauthError = searchParams.get("calendar_error") || searchParams.get("error_description");
    if (oauthError) {
      setFeedback({ type: "error", message: oauthError });
    } else if (["connected", "success"].includes(oauthState)) {
      setFeedback({ type: "success", message: "Le compte Calendly est maintenant connecté." });
    }
  }, [searchParams]);

  useEffect(() => {
    const contactId = searchParams.get("contact_id");
    contactRequestRef.current.controller?.abort();
    if (!contactId || !token || !effectiveCompanyId) return undefined;
    if (!UUID_RE.test(contactId)) {
      setFeedback({ type: "error", message: "Le contact demandé est invalide." });
      return undefined;
    }

    const controller = new AbortController();
    const generation = contactRequestRef.current.generation + 1;
    contactRequestRef.current = { generation, controller };
    setBookingOpen(true);

    apiRequest(`/api/v1/contacts/${encodeURIComponent(contactId)}${queryString({ company_id: effectiveCompanyId })}`, {
      token,
      signal: controller.signal,
    })
      .then((data) => {
        if (controller.signal.aborted || contactRequestRef.current.generation !== generation) return;
        const contact = data.contact || {};
        setBooking((current) => ({
          ...current,
          contact_id: contact.id || contactId,
          name: contact.full_name || "",
          email: contact.email || "",
          phone: contact.phone || "",
        }));
        resetBookingKey();
      })
      .catch((error) => {
        if (error?.name !== "AbortError" && contactRequestRef.current.generation === generation) {
          setFeedback({ type: "error", message: error.message || "Impossible de charger ce contact." });
        }
      });

    return () => controller.abort();
  }, [effectiveCompanyId, resetBookingKey, searchParams, token]);

  useEffect(() => {
    availabilityRequestRef.current.controller?.abort();
    const eventType = booking.event_type_uri || defaultEventType;
    if (!bookingOpen || !connection?.connected || !eventType || !token || !effectiveCompanyId) {
      setAvailability([]);
      setAvailabilityLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    const generation = availabilityRequestRef.current.generation + 1;
    availabilityRequestRef.current = { generation, controller };
    const start = new Date();
    const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);

    setAvailabilityLoading(true);
    setAvailabilityError("");
    calendarRequest(`/availability${queryString({
      company_id: effectiveCompanyId,
      event_type_uri: eventType,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
    })}`, { token, signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted || availabilityRequestRef.current.generation !== generation) return;
        const slots = Array.isArray(data.availability)
          ? data.availability.filter((slot) => slotStart(slot) && (!slot.status || slot.status === "available"))
          : [];
        setAvailability(slots);
      })
      .catch((error) => {
        if (error?.name !== "AbortError" && availabilityRequestRef.current.generation === generation) {
          setAvailability([]);
          setAvailabilityError(error.message || "Impossible de charger les disponibilités.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && availabilityRequestRef.current.generation === generation) {
          setAvailabilityLoading(false);
        }
      });

    return () => controller.abort();
  }, [booking.event_type_uri, bookingOpen, connection?.connected, defaultEventType, effectiveCompanyId, token]);

  const handleConnect = async () => {
    if (!canManageConnection || !effectiveCompanyId || !token) return;
    setBusyAction("connect");
    setFeedback(null);
    try {
      const data = await calendarRequest("/oauth/start", {
        token,
        method: "POST",
        body: { company_id: effectiveCompanyId, return_path: "/calendar" },
      });
      const authorizationUrl = safeCalendlyUrl(data.authorization_url);
      if (!authorizationUrl) throw new Error("Calendly a retourné une URL d’autorisation invalide.");
      window.location.assign(authorizationUrl);
    } catch (error) {
      setFeedback({ type: "error", message: error.message || "Connexion Calendly impossible." });
      setBusyAction("");
    }
  };

  const handleDisconnect = async () => {
    if (!canManageConnection || !effectiveCompanyId || !token) return;
    setBusyAction("disconnect");
    setFeedback(null);
    try {
      await calendarRequest("/connection", {
        token,
        method: "DELETE",
        body: { company_id: effectiveCompanyId },
      });
      setDisconnectConfirm(false);
      setFeedback({ type: "success", message: "Le compte Calendly a été déconnecté." });
      await loadCalendar();
    } catch (error) {
      setFeedback({ type: "error", message: error.message || "Déconnexion Calendly impossible." });
    } finally {
      setBusyAction("");
    }
  };

  const handleSaveDefaultEvent = async () => {
    if (!canManageConnection || !effectiveCompanyId || !defaultEventType || !token) return;
    setBusyAction("event-type");
    setFeedback(null);
    try {
      const data = await calendarRequest("/settings", {
        token,
        method: "PATCH",
        body: {
          company_id: effectiveCompanyId,
          default_event_type_uri: defaultEventType,
        },
      });
      setConnection((current) => ({
        ...current,
        ...(data.connection || {}),
        default_event_type_uri: defaultEventType,
      }));
      setBooking((current) => ({ ...current, event_type_uri: defaultEventType, start_time: "" }));
      resetBookingKey();
      setFeedback({ type: "success", message: "Le type de rendez-vous par défaut a été enregistré." });
    } catch (error) {
      setFeedback({ type: "error", message: error.message || "Enregistrement impossible." });
    } finally {
      setBusyAction("");
    }
  };

  const handleBook = async (event) => {
    event.preventDefault();
    if (!connection?.connected || !effectiveCompanyId || !token) return;
    if (!booking.name.trim() || !booking.email.trim() || !booking.event_type_uri || !booking.start_time) {
      setFeedback({ type: "error", message: "Complétez l’identité, le type et l’heure du rendez-vous." });
      return;
    }
    if (!booking.confirmed) {
      setFeedback({ type: "error", message: "Confirmez explicitement le rendez-vous avant de le réserver." });
      return;
    }

    setBusyAction("book");
    setFeedback(null);
    try {
      const data = await calendarRequest("/book", {
        token,
        method: "POST",
        idempotencyKey,
        body: {
          company_id: effectiveCompanyId,
          idempotency_key: idempotencyKey,
          confirmed: true,
          ...(booking.contact_id ? { contact_id: booking.contact_id } : {}),
          name: booking.name.trim(),
          email: booking.email.trim(),
          ...(booking.phone.trim() ? { phone: booking.phone.trim() } : {}),
          timezone: booking.timezone,
          event_type_uri: booking.event_type_uri,
          start_time: booking.start_time,
        },
      });
      const appointment = data.appointment || data.booking || null;
      const confirmation = data.confirmation_queued === false
        ? "Rendez-vous créé; la confirmation courriel doit être vérifiée."
        : "Rendez-vous confirmé. Un courriel de confirmation a été programmé.";
      setFeedback({
        type: "success",
        message: data.idempotent_replay ? "Cette réservation avait déjà été confirmée." : confirmation,
      });
      if (appointment?.id) setSelectedId(appointment.id);
      setBookingOpen(false);
      setAvailability([]);
      setBooking((current) => ({
        ...defaultBooking(),
        event_type_uri: connection.default_event_type_uri || current.event_type_uri || defaultEventType,
      }));
      resetBookingKey();
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete("contact_id");
      setSearchParams(nextParams, { replace: true });
      await loadCalendar();
    } catch (error) {
      setFeedback({
        type: "error",
        message: error.message || "La réservation n’a pas pu être confirmée. Vous pouvez réessayer sans risque de doublon.",
      });
    } finally {
      setBusyAction("");
    }
  };

  const mutateAppointment = async (appointment, action, extra = {}) => {
    if (!appointment?.id || !effectiveCompanyId || !token) return null;
    setBusyAction(`${action}:${appointment.id}`);
    setExternalUrl("");
    try {
      const data = await calendarRequest(`/appointments/${encodeURIComponent(appointment.id)}`, {
        token,
        method: "PATCH",
        body: { company_id: effectiveCompanyId, action, ...extra },
      });
      return data;
    } catch (error) {
      if (action === "reschedule" && error.status === 409 && error.payload?.reschedule_url) {
        return error.payload;
      }
      throw error;
    } finally {
      setBusyAction("");
    }
  };

  const handleCancelAppointment = async () => {
    const appointment = appointments.find((item) => item.id === selectedId);
    if (!appointment) return;
    setFeedback(null);
    try {
      await mutateAppointment(appointment, "cancel", {
        reason: cancelReason.trim() || "Annulé depuis VoiceDesk",
      });
      setCancelConfirm(false);
      setCancelReason("");
      setFeedback({ type: "success", message: "Le rendez-vous a été annulé dans Calendly." });
      await loadCalendar();
    } catch (error) {
      setFeedback({ type: "error", message: error.message || "Annulation impossible." });
    }
  };

  const handleRescheduleAppointment = async () => {
    const appointment = appointments.find((item) => item.id === selectedId);
    if (!appointment) return;
    setFeedback(null);
    try {
      const data = await mutateAppointment(appointment, "reschedule");
      const url = safeCalendlyUrl(data?.reschedule_url || appointment.calendly_reschedule_url);
      if (!url) throw new Error("Aucun lien de replanification Calendly n’est disponible.");
      setExternalUrl(url);
      const popup = window.open(url, "_blank", "noopener,noreferrer");
      if (!popup) {
        setFeedback({
          type: "success",
          message: "Le lien est prêt. Utilisez « Ouvrir Calendly » si votre navigateur a bloqué le nouvel onglet.",
        });
      }
    } catch (error) {
      setFeedback({ type: "error", message: error.message || "Replanification impossible." });
    }
  };

  const selected = useMemo(
    () => appointments.find((appointment) => appointment.id === selectedId) || null,
    [appointments, selectedId]
  );

  const kpis = useMemo(() => {
    const now = new Date();
    const weekEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    return {
      upcoming: appointments.filter((appointment) => {
        const start = appointmentStart(appointment);
        return start && start >= now && start <= weekEnd && appointment.status !== "cancelled";
      }).length,
      confirmed: appointments.filter((appointment) => appointment.status === "confirmed").length,
      pending: appointments.filter((appointment) => appointment.status === "pending").length,
      thisMonth: appointments.filter((appointment) => {
        const start = appointmentStart(appointment);
        return start && start.getMonth() === now.getMonth() && start.getFullYear() === now.getFullYear();
      }).length,
    };
  }, [appointments]);

  const filteredAppointments = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("fr-CA");
    return appointments.filter((appointment) => {
      if (statusFilter && appointment.status !== statusFilter) return false;
      if (!needle) return true;
      return [
        appointment.contacts?.full_name,
        appointment.invitee_name,
        appointment.invitee_email,
        appointment.type,
        appointment.channel,
        appointment.notes,
      ].filter(Boolean).some((value) => String(value).toLocaleLowerCase("fr-CA").includes(needle));
    });
  }, [appointments, search, statusFilter]);

  const columns = useMemo(() => [
    {
      key: "start_at",
      header: "Date et heure",
      render: (row) => {
        const start = appointmentStart(row);
        return (
          <div>
            <p className="text-sm font-medium text-text-primary">{start ? formatDateTime(start) : "—"}</p>
            {row.timezone && <p className="text-xs text-text-tertiary">{row.timezone}</p>}
          </div>
        );
      },
    },
    {
      key: "contact",
      header: "Client",
      sortable: false,
      render: (row) => {
        const name = row.contacts?.full_name || row.invitee_name || "—";
        const email = row.contacts?.email || row.invitee_email || "";
        return (
          <div>
            <p className="text-sm font-medium text-text-primary">{name}</p>
            {email && <p className="text-xs text-text-tertiary">{email}</p>}
          </div>
        );
      },
    },
    {
      key: "type",
      header: "Type",
      render: (row) => <span className="text-sm text-text-secondary">{row.type || "—"}</span>,
    },
    {
      key: "status",
      header: "Statut",
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: "actions",
      header: "",
      sortable: false,
      render: (row) => (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setSelectedId(row.id);
            setCancelConfirm(false);
            setCancelReason("");
            setExternalUrl("");
          }}
          aria-label={`Voir le rendez-vous de ${row.contacts?.full_name || row.invitee_name || "ce client"}`}
        >
          Détails
        </Button>
      ),
    },
  ], []);

  const connectionStatus = connection?.status || "disconnected";
  const connectionMeta = CONNECTION_META[connectionStatus] || CONNECTION_META.error;
  const accountName = connection?.user_name;
  const accountEmail = connection?.user_email;
  const configuredDefault = connection?.default_event_type_uri || "";
  const canSaveDefault = Boolean(
    canManageConnection
    && defaultEventType
    && defaultEventType !== configuredDefault
    && !busyAction
  );

  if (!effectiveCompanyId) {
    return (
      <div className="rounded-xl border border-border bg-bg-card p-8 text-center" role="status">
        <Building2 size={28} className="mx-auto mb-3 text-text-tertiary" />
        <h1 className="text-lg font-semibold text-text-primary">Sélectionnez une entreprise</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Choisissez une entreprise dans le sélecteur d’impersonation pour consulter son calendrier.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="calendar-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-tertiary">
            <CalendarIcon size={12} /> Calendrier
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Rendez-vous Calendly</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Disponibilités réelles, réservations de Léa et suivi CRM au même endroit.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={loadCalendar} disabled={loading || Boolean(busyAction)}>
            <RefreshCcw size={14} className={loading ? "animate-spin" : ""} /> Actualiser
          </Button>
          <Button
            type="button"
            onClick={() => {
              setBooking((current) => ({
                ...current,
                event_type_uri: current.event_type_uri || configuredDefault || defaultEventType,
              }));
              setBookingOpen(true);
            }}
            disabled={!connection?.connected || loading}
          >
            <CalendarPlus size={15} /> Nouveau rendez-vous
          </Button>
        </div>
      </div>

      {feedback && (
        <Notice
          type={feedback.type}
          action={externalUrl ? (
            <a
              href={externalUrl}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 font-medium underline underline-offset-2"
            >
              Ouvrir Calendly
            </a>
          ) : null}
        >
          {feedback.message}
        </Notice>
      )}

      <section className="rounded-xl border border-border bg-bg-card p-5" aria-labelledby="calendly-connection-title">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="calendly-connection-title" className="text-base font-semibold text-text-primary">
                Connexion Calendly
              </h2>
              <Badge variant={connectionMeta.variant}>{connectionMeta.label}</Badge>
              {connection?.webhook_status === "active" && <Badge variant="cyan">Synchronisation active</Badge>}
            </div>
            {loading ? (
              <p className="mt-2 flex items-center gap-2 text-sm text-text-secondary" role="status">
                <Loader2 size={14} className="animate-spin" /> Vérification de la connexion…
              </p>
            ) : connection?.connected ? (
              <div className="mt-2 text-sm text-text-secondary">
                <p>{accountName || "Compte Calendly"}</p>
                {accountEmail && <p className="text-xs text-text-tertiary">{accountEmail}</p>}
              </div>
            ) : (
              <p className="mt-2 max-w-2xl text-sm text-text-secondary">
                Connectez le compte Calendly de cette entreprise pour que Léa puisse consulter les créneaux et réserver directement.
              </p>
            )}
            {connectionError && <p className="mt-2 text-sm text-red-300" role="alert">{connectionError}</p>}
            {connection?.last_error && <p className="mt-2 text-xs text-red-300">{connection.last_error}</p>}
          </div>

          {canManageConnection ? (
            <div className="flex shrink-0 flex-wrap gap-2">
              {connection?.connected ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDisconnectConfirm(true)}
                  disabled={Boolean(busyAction)}
                >
                  <Link2Off size={14} /> Déconnecter
                </Button>
              ) : (
                <Button type="button" onClick={handleConnect} disabled={Boolean(busyAction) || loading}>
                  {busyAction === "connect" ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
                  {connectionStatus === "reconnect_required" ? "Reconnecter Calendly" : "Connecter Calendly"}
                </Button>
              )}
            </div>
          ) : (
            <p className="text-xs text-text-tertiary">Seul un administrateur de l’entreprise peut modifier cette connexion.</p>
          )}
        </div>

        {disconnectConfirm && (
          <div className="mt-4 rounded-lg border border-brand-red/30 bg-brand-red/10 p-4" role="alertdialog" aria-labelledby="disconnect-title">
            <p id="disconnect-title" className="text-sm font-medium text-text-primary">Déconnecter ce compte Calendly?</p>
            <p className="mt-1 text-xs text-text-secondary">
              Les rendez-vous déjà synchronisés restent visibles, mais Léa ne pourra plus réserver ni recevoir les mises à jour Calendly.
            </p>
            <div className="mt-3 flex gap-2">
              <Button type="button" variant="destructive" size="sm" onClick={handleDisconnect} disabled={Boolean(busyAction)}>
                {busyAction === "disconnect" && <Loader2 size={14} className="animate-spin" />}
                Confirmer la déconnexion
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setDisconnectConfirm(false)} disabled={Boolean(busyAction)}>
                Conserver la connexion
              </Button>
            </div>
          </div>
        )}

        {connection?.connected && (
          <div className="mt-5 border-t border-border pt-4">
            <label htmlFor="default-event-type" className="mb-1.5 block text-xs font-medium text-text-secondary">
              Type de rendez-vous par défaut
            </label>
            <div className="flex max-w-2xl flex-col gap-2 sm:flex-row">
              <select
                id="default-event-type"
                value={defaultEventType}
                onChange={(event) => setDefaultEventType(event.target.value)}
                className={SELECT_CLASS}
                disabled={!canManageConnection || !eventTypes.length || Boolean(busyAction)}
              >
                {!eventTypes.length && <option value="">Aucun type actif disponible</option>}
                {eventTypes.map((eventType) => {
                  const uri = eventTypeUri(eventType);
                  const duration = eventTypeDuration(eventType);
                  return <option key={uri} value={uri}>{eventTypeName(eventType)}{duration ? ` · ${duration} min` : ""}</option>;
                })}
              </select>
              {canManageConnection && (
                <Button type="button" variant="secondary" onClick={handleSaveDefaultEvent} disabled={!canSaveDefault}>
                  {busyAction === "event-type" ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  Enregistrer
                </Button>
              )}
            </div>
          </div>
        )}
      </section>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="7 prochains jours" value={kpis.upcoming} icon={CalendarIcon} color="bg-brand" />
        <KpiCard label="Confirmés" value={kpis.confirmed} icon={CheckCircle2} color="bg-brand-green" />
        <KpiCard label="En attente" value={kpis.pending} icon={Clock} color="bg-brand-orange" />
        <KpiCard label="Ce mois" value={kpis.thisMonth} icon={CalendarIcon} color="bg-brand-purple" />
      </div>

      <section className="space-y-3" aria-labelledby="appointments-title">
        <div>
          <h2 id="appointments-title" className="text-lg font-semibold text-text-primary">Rendez-vous de l’entreprise</h2>
          <p className="text-xs text-text-tertiary">Liste synchronisée avec le compte Calendly connecté.</p>
        </div>
        <FilterBar
          testId="calendar-filterbar"
          searchValue={search}
          onSearchChange={setSearch}
          searchPlaceholder="Chercher un client, un courriel ou un type…"
          filters={[{
            key: "status",
            label: "Statut",
            current: statusFilter,
            options: [
              { value: "pending", label: "En attente" },
              { value: "confirmed", label: "Confirmé" },
              { value: "cancelled", label: "Annulé" },
              { value: "completed", label: "Complété" },
            ],
          }]}
          onFilterChange={(_key, value) => setStatusFilter(value)}
        />
        {appointmentsError && <Notice type="error">{appointmentsError}</Notice>}
        <DataTable
          testId="calendar-table"
          columns={columns}
          data={filteredAppointments}
          loading={loading}
          emptyState={{
            icon: CalendarIcon,
            title: "Aucun rendez-vous",
            description: search || statusFilter
              ? "Aucun rendez-vous ne correspond à ces critères."
              : connection?.connected
                ? "Les réservations Calendly apparaîtront ici automatiquement."
                : "Connectez Calendly pour synchroniser et créer des rendez-vous.",
          }}
        />
      </section>

      <Sheet open={Boolean(selectedId)} onOpenChange={(open) => {
        if (!open) {
          setSelectedId(null);
          setCancelConfirm(false);
          setCancelReason("");
          setExternalUrl("");
        }
      }}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Détails du rendez-vous</SheetTitle>
            <SheetDescription>Informations Calendly et association CRM.</SheetDescription>
          </SheetHeader>
          {selected && (
            <div className="space-y-5 p-6">
              <div className="rounded-lg border border-border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-text-primary">{selected.type || "Rendez-vous"}</p>
                    <p className="mt-1 text-sm text-text-secondary">
                      {appointmentStart(selected) ? formatDateTime(appointmentStart(selected)) : "Date non disponible"}
                    </p>
                    {selected.timezone && <p className="text-xs text-text-tertiary">{selected.timezone}</p>}
                  </div>
                  <StatusBadge status={selected.status} />
                </div>
              </div>

              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2 text-text-secondary">
                  <User size={15} className="text-text-tertiary" />
                  <span>{selected.contacts?.full_name || selected.invitee_name || "—"}</span>
                </div>
                {(selected.contacts?.email || selected.invitee_email) && (
                  <div className="flex items-center gap-2 text-text-secondary">
                    <Mail size={15} className="text-text-tertiary" />
                    <span>{selected.contacts?.email || selected.invitee_email}</span>
                  </div>
                )}
                {(selected.contacts?.phone || selected.invitee_phone) && (
                  <div className="flex items-center gap-2 text-text-secondary">
                    <Phone size={15} className="text-text-tertiary" />
                    <span>{selected.contacts?.phone || selected.invitee_phone}</span>
                  </div>
                )}
                {selected.contacts?.company && (
                  <div className="flex items-center gap-2 text-text-secondary">
                    <Building2 size={15} className="text-text-tertiary" />
                    <span>{selected.contacts.company}</span>
                  </div>
                )}
              </div>

              {safeHttpsUrl(selected.meet_link) && (
                <a
                  href={safeHttpsUrl(selected.meet_link)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 text-sm font-medium text-brand hover:underline"
                >
                  <ExternalLink size={14} /> Ouvrir le lien de rencontre
                </a>
              )}

              {selected.notes && (
                <div>
                  <p className="mb-1 text-xs uppercase tracking-wide text-text-tertiary">Notes</p>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">{selected.notes}</p>
                </div>
              )}

              {selected.status !== "cancelled" && selected.status !== "completed" && (
                <div className="space-y-3 border-t border-border pt-4">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleRescheduleAppointment}
                      disabled={Boolean(busyAction)}
                    >
                      {busyAction === `reschedule:${selected.id}` ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}
                      Replanifier dans Calendly
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => setCancelConfirm(true)}
                      disabled={Boolean(busyAction)}
                    >
                      <XCircle size={14} /> Annuler le rendez-vous
                    </Button>
                  </div>

                  {externalUrl && (
                    <a
                      href={externalUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 text-sm font-medium text-brand hover:underline"
                    >
                      <ExternalLink size={14} /> Ouvrir le lien de replanification
                    </a>
                  )}

                  {cancelConfirm && (
                    <div className="rounded-lg border border-brand-red/30 bg-brand-red/10 p-4" role="alertdialog" aria-labelledby="cancel-appointment-title">
                      <p id="cancel-appointment-title" className="text-sm font-medium text-text-primary">
                        Confirmer l’annulation dans Calendly
                      </p>
                      <label htmlFor="cancellation-reason" className="mt-3 block text-xs text-text-secondary">
                        Motif (facultatif)
                      </label>
                      <Input
                        id="cancellation-reason"
                        value={cancelReason}
                        onChange={(event) => setCancelReason(event.target.value)}
                        maxLength={250}
                        placeholder="Ex. Demande du client"
                        className="mt-1"
                      />
                      <div className="mt-3 flex gap-2">
                        <Button type="button" size="sm" variant="destructive" onClick={handleCancelAppointment} disabled={Boolean(busyAction)}>
                          {busyAction === `cancel:${selected.id}` && <Loader2 size={14} className="animate-spin" />}
                          Confirmer
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setCancelConfirm(false)} disabled={Boolean(busyAction)}>
                          Retour
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>

      <Sheet open={bookingOpen} onOpenChange={(open) => {
        if (!open && busyAction !== "book") {
          setBookingOpen(false);
          setAvailabilityError("");
        }
      }}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Réserver un rendez-vous</SheetTitle>
            <SheetDescription>
              Le créneau est réservé directement dans Calendly après votre confirmation.
            </SheetDescription>
          </SheetHeader>
          <form className="space-y-5 p-6" onSubmit={handleBook}>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-medium text-text-secondary sm:col-span-2">
                Nom du client
                <Input
                  value={booking.name}
                  onChange={(event) => updateBooking({ name: event.target.value, confirmed: false })}
                  autoComplete="name"
                  required
                  maxLength={160}
                  className="mt-1"
                />
              </label>
              <label className="text-xs font-medium text-text-secondary">
                Courriel
                <Input
                  type="email"
                  value={booking.email}
                  onChange={(event) => updateBooking({ email: event.target.value, confirmed: false })}
                  autoComplete="email"
                  required
                  maxLength={320}
                  className="mt-1"
                />
              </label>
              <label className="text-xs font-medium text-text-secondary">
                Téléphone (facultatif)
                <Input
                  type="tel"
                  value={booking.phone}
                  onChange={(event) => updateBooking({ phone: event.target.value, confirmed: false })}
                  autoComplete="tel"
                  maxLength={32}
                  className="mt-1"
                />
              </label>
            </div>

            <label htmlFor="booking-event-type" className="block text-xs font-medium text-text-secondary">
              Type de rendez-vous
              <select
                id="booking-event-type"
                value={booking.event_type_uri || defaultEventType}
                onChange={(event) => updateBooking({ event_type_uri: event.target.value, start_time: "", confirmed: false })}
                className={`${SELECT_CLASS} mt-1`}
                required
              >
                <option value="" disabled>Choisir un type</option>
                {eventTypes.map((eventType) => {
                  const uri = eventTypeUri(eventType);
                  const duration = eventTypeDuration(eventType);
                  return <option key={uri} value={uri}>{eventTypeName(eventType)}{duration ? ` · ${duration} min` : ""}</option>;
                })}
              </select>
            </label>

            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="text-xs font-medium text-text-secondary">Créneaux disponibles — 7 prochains jours</p>
                <span className="text-[11px] text-text-tertiary">Fuseau : {booking.timezone}</span>
              </div>
              {availabilityLoading ? (
                <div className="flex items-center gap-2 rounded-lg border border-border p-4 text-sm text-text-secondary" role="status">
                  <Loader2 size={14} className="animate-spin" /> Consultation de Calendly…
                </div>
              ) : availabilityError ? (
                <Notice type="error">{availabilityError}</Notice>
              ) : availability.length ? (
                <div className="grid max-h-64 grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2" role="radiogroup" aria-label="Créneau du rendez-vous">
                  {availability.map((slot) => {
                    const start = slotStart(slot);
                    const selectedSlot = booking.start_time === start;
                    return (
                      <label
                        key={start}
                        className={`cursor-pointer rounded-lg border p-3 text-sm transition-colors ${
                          selectedSlot
                            ? "border-brand-purple bg-brand-purple/10 text-text-primary"
                            : "border-border bg-bg-card text-text-secondary hover:border-border-strong"
                        }`}
                      >
                        <input
                          type="radio"
                          name="booking-slot"
                          value={start}
                          checked={selectedSlot}
                          onChange={() => updateBooking({ start_time: start, confirmed: false })}
                          className="sr-only"
                        />
                        {slot.formatted || formatDateTime(start, { timeZone: booking.timezone })}
                      </label>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-lg border border-border p-4 text-sm text-text-secondary">
                  Aucun créneau disponible pour ce type dans les 7 prochains jours.
                </div>
              )}
            </div>

            {booking.start_time && (
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-brand-purple/30 bg-brand-purple/10 p-4 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked={booking.confirmed}
                  onChange={(event) => updateBooking({ confirmed: event.target.checked })}
                  required
                  className="mt-0.5 h-4 w-4 rounded border-border accent-brand-purple"
                />
                <span>
                  Je confirme la réservation pour <strong className="text-text-primary">{booking.name || "ce client"}</strong>, le{" "}
                  <strong className="text-text-primary">{formatDateTime(booking.start_time, { timeZone: booking.timezone })}</strong>.
                  Un courriel de confirmation et une note CRM seront créés.
                </span>
              </label>
            )}

            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
              <Button type="button" variant="ghost" onClick={() => setBookingOpen(false)} disabled={busyAction === "book"}>
                Fermer
              </Button>
              <Button
                type="submit"
                disabled={
                  busyAction === "book"
                  || !booking.confirmed
                  || !booking.start_time
                  || !booking.name.trim()
                  || !booking.email.trim()
                }
              >
                {busyAction === "book" ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                Confirmer et réserver
              </Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </div>
  );
}
