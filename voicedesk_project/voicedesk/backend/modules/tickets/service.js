const HOUR_MS = 60 * 60 * 1000;

export const TICKET_CATEGORIES = Object.freeze([
  "general",
  "billing",
  "technical",
  "feature_request",
  "bug",
  "onboarding",
]);

export const TICKET_PRIORITIES = Object.freeze(["low", "normal", "high", "urgent"]);
export const TICKET_STATUSES = Object.freeze(["open", "in_progress", "resolved", "closed"]);
export const ACTIVE_TICKET_STATUSES = Object.freeze(["open", "in_progress", "waiting_client"]);

export const TICKET_SLA = Object.freeze({
  urgent: Object.freeze({ firstResponseHours: 1, resolutionHours: 4 }),
  high: Object.freeze({ firstResponseHours: 4, resolutionHours: 24 }),
  normal: Object.freeze({ firstResponseHours: 24, resolutionHours: 72 }),
  low: Object.freeze({ firstResponseHours: 48, resolutionHours: 168 }),
});

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function calculateTicketSla(ticket, nowValue = new Date()) {
  const now = validDate(nowValue) || new Date();
  if (["resolved", "closed"].includes(ticket?.status)) {
    return {
      sla_status: "completed",
      sla_deadline: null,
      sla_milestone: null,
      sla_remaining_ms: null,
    };
  }

  const milestones = [];
  if (!ticket?.first_response_at) {
    const deadline = validDate(ticket?.sla_first_response_due);
    if (deadline) {
      milestones.push({
        milestone: "first_response",
        deadline,
        remainingMs: deadline.getTime() - now.getTime(),
        riskWindowMs: HOUR_MS,
      });
    }
  }
  const resolutionDeadline = validDate(ticket?.sla_resolution_due);
  if (resolutionDeadline) {
    milestones.push({
      milestone: "resolution",
      deadline: resolutionDeadline,
      remainingMs: resolutionDeadline.getTime() - now.getTime(),
      riskWindowMs: 4 * HOUR_MS,
    });
  }

  if (!milestones.length) {
    return {
      sla_status: "on_track",
      sla_deadline: null,
      sla_milestone: null,
      sla_remaining_ms: null,
    };
  }

  milestones.sort((left, right) => left.remainingMs - right.remainingMs);
  const next = milestones[0];
  const status = milestones.some(item => item.remainingMs <= 0)
    ? "breached"
    : milestones.some(item => item.remainingMs <= item.riskWindowMs)
      ? "at_risk"
      : "on_track";

  return {
    sla_status: status,
    sla_deadline: next.deadline.toISOString(),
    sla_milestone: next.milestone,
    sla_remaining_ms: next.remainingMs,
  };
}

function cleanText(value, maxLength) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, maxLength) : null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeFrontendUrl(value) {
  const firstOrigin = String(value || "").split(",")[0]?.trim();
  if (!firstOrigin) return null;
  try {
    const parsed = new URL(firstOrigin);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function emailAddress(value) {
  const email = cleanText(value, 320)?.toLowerCase() || null;
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function ticketServiceError(code, message, status = 500, permanent = false) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.permanent = permanent;
  return error;
}

function queryError(error, fallbackCode) {
  if (!error) return null;
  const wrapped = ticketServiceError(
    error.code || fallbackCode,
    error.message || fallbackCode,
    500
  );
  wrapped.cause = error;
  return wrapped;
}

function priorityLabel(priority) {
  return {
    urgent: "Urgente",
    high: "Haute",
    normal: "Moyenne",
    low: "Basse",
  }[priority] || "Moyenne";
}

function categoryLabel(category) {
  return {
    general: "Question générale",
    billing: "Facturation",
    technical: "Problème technique",
    feature_request: "Demande de fonctionnalité",
    bug: "Anomalie",
    onboarding: "Démarrage",
  }[category] || "Support";
}

function milestoneLabel(milestone) {
  return milestone === "first_response" ? "première réponse" : "résolution";
}

function formatDeadline(value) {
  const date = validDate(value);
  if (!date) return "non définie";
  return date.toLocaleString("fr-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function createTicketService({
  supabase,
  resend,
  frontendUrl = process.env.FRONTEND_URL,
  emailFrom = process.env.EMAIL_FROM || "VoiceDesk <bonjour@voicedesk.ca>",
  logger = console,
} = {}) {
  if (!supabase?.from || !supabase?.rpc) {
    throw new TypeError("Ticket service requires a Supabase client");
  }

  const applicationUrl = normalizeFrontendUrl(frontendUrl);

  async function createTicket({
    companyId,
    actorUserId,
    actorName,
    actorEmail,
    actorRole,
    subject,
    description,
    category,
    priority,
  }) {
    const { data, error } = await supabase.rpc("create_support_ticket", {
      p_company_id: companyId,
      p_actor_user_id: actorUserId,
      p_actor_name: actorName,
      p_actor_email: actorEmail,
      p_actor_role: actorRole,
      p_subject: subject,
      p_description: description,
      p_category: category,
      p_priority: priority,
    });
    if (error) throw queryError(error, "ticket_create_failed");
    if (!data?.ticket || !data?.message) {
      throw ticketServiceError("ticket_create_failed", "Ticket transaction returned no row");
    }
    return data;
  }

  async function appendMessage({
    ticketId,
    companyId,
    actorUserId,
    actorName,
    actorRole,
    body,
    isInternal,
  }) {
    const { data, error } = await supabase.rpc("append_support_ticket_message", {
      p_ticket_id: ticketId,
      p_company_id: companyId,
      p_actor_user_id: actorUserId,
      p_actor_name: actorName,
      p_actor_role: actorRole,
      p_body: body,
      p_is_internal: isInternal === true,
    });
    if (error) throw queryError(error, "ticket_message_failed");
    if (!data?.ticket || !data?.message) {
      throw ticketServiceError("ticket_message_failed", "Message transaction returned no row");
    }
    return data;
  }

  async function enqueueSlaAlerts() {
    const { data, error } = await supabase.rpc("enqueue_ticket_sla_alerts");
    if (error) throw queryError(error, "ticket_sla_enqueue_failed");
    return Number(data) || 0;
  }

  async function claimEmails({ workerId, limit, leaseSeconds }) {
    const { data, error } = await supabase.rpc("claim_ticket_email_outbox", {
      p_worker_id: workerId,
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throw queryError(error, "ticket_email_claim_failed");
    return data || [];
  }

  async function loadRecipient(row, ticket) {
    let profile = null;
    if (row.recipient_kind === "profile") {
      const result = await supabase
        .from("profiles")
        .select("user_id, full_name, email, role, status")
        .eq("user_id", row.recipient_user_id)
        .maybeSingle();
      if (result.error) throw queryError(result.error, "ticket_recipient_read_failed");
      profile = result.data;
      if (!profile || profile.status !== "active") {
        return { suppressed: true, reason: "recipient_profile_inactive" };
      }
    } else if (row.recipient_kind === "ticket_creator") {
      if (ticket.created_by_user_id) {
        const result = await supabase
          .from("profiles")
          .select("user_id, company_id, full_name, email, role, status")
          .eq("user_id", ticket.created_by_user_id)
          .eq("company_id", ticket.company_id)
          .maybeSingle();
        if (result.error) throw queryError(result.error, "ticket_recipient_read_failed");
        profile = result.data;
        if (profile && profile.status !== "active") {
          return { suppressed: true, reason: "recipient_profile_inactive" };
        }
      }
      profile ||= {
        user_id: ticket.created_by_user_id,
        full_name: ticket.created_by_name,
        email: ticket.created_by_email,
        status: "active",
      };
    } else {
      return { suppressed: true, reason: "recipient_kind_invalid" };
    }

    const email = emailAddress(profile?.email);
    if (!email) return { suppressed: true, reason: "recipient_email_invalid" };

    if (profile?.user_id) {
      const preferenceResult = await supabase
        .from("notification_preferences")
        .select("ticket_email")
        .eq("user_id", profile.user_id)
        .maybeSingle();
      if (preferenceResult.error) {
        throw queryError(preferenceResult.error, "ticket_preferences_read_failed");
      }
      if (preferenceResult.data?.ticket_email === false) {
        return { suppressed: true, reason: "ticket_email_disabled" };
      }
    }

    return {
      suppressed: false,
      email,
      name: cleanText(profile?.full_name, 200) || "",
    };
  }

  async function sendEmailOutbox(row) {
    if (!resend?.emails?.send) {
      throw ticketServiceError(
        "resend_not_configured",
        "Resend is not configured",
        503
      );
    }
    if (!applicationUrl) {
      throw ticketServiceError(
        "ticket_frontend_url_missing",
        "FRONTEND_URL is missing or invalid",
        503
      );
    }

    const ticketResult = await supabase
      .from("tickets")
      .select("id, company_id, ticket_number, subject, description, category, priority, status, created_by_user_id, created_by_name, created_by_email, assigned_to_name")
      .eq("id", row.ticket_id)
      .eq("company_id", row.company_id)
      .maybeSingle();
    if (ticketResult.error) throw queryError(ticketResult.error, "ticket_email_ticket_read_failed");
    const ticket = ticketResult.data;
    if (!ticket) return { suppressed: true, reason: "ticket_deleted" };

    let message = null;
    if (row.message_id) {
      const messageResult = await supabase
        .from("ticket_messages")
        .select("id, ticket_id, company_id, author_name, author_role, body, is_internal")
        .eq("id", row.message_id)
        .eq("ticket_id", ticket.id)
        .eq("company_id", ticket.company_id)
        .maybeSingle();
      if (messageResult.error) {
        throw queryError(messageResult.error, "ticket_email_message_read_failed");
      }
      message = messageResult.data;
      if (!message) return { suppressed: true, reason: "ticket_message_deleted" };
      if (message.is_internal) return { suppressed: true, reason: "internal_note_never_emailed" };
    }

    const recipient = await loadRecipient(row, ticket);
    if (recipient.suppressed) return recipient;

    const companyResult = await supabase
      .from("companies")
      .select("name")
      .eq("id", ticket.company_id)
      .maybeSingle();
    if (companyResult.error) throw queryError(companyResult.error, "ticket_company_read_failed");
    const companyName = cleanText(companyResult.data?.name, 200) || "Client VoiceDesk";
    const link = `${applicationUrl}/tickets?ticket=${encodeURIComponent(ticket.id)}`;
    const excerpt = cleanText(message?.body || ticket.description, 3000) || "Aucun détail fourni.";
    const safeExcerpt = escapeHtml(excerpt).replaceAll("\n", "<br>");

    let subject;
    let heading;
    let intro;
    if (row.email_kind === "new_ticket") {
      subject = `[${ticket.ticket_number}] Nouveau ticket — ${ticket.subject}`;
      heading = "Nouveau ticket de support";
      intro = `${companyName} a ouvert une demande ${priorityLabel(ticket.priority).toLowerCase()}.`;
    } else if (row.email_kind === "client_reply") {
      subject = `[${ticket.ticket_number}] Réponse du client — ${ticket.subject}`;
      heading = "Nouvelle réponse du client";
      intro = `${message?.author_name || ticket.created_by_name || "Le client"} a répondu au ticket.`;
    } else if (row.email_kind === "agent_reply") {
      subject = `[${ticket.ticket_number}] Nouvelle réponse — ${ticket.subject}`;
      heading = "L’équipe Exevori vous a répondu";
      intro = `${message?.author_name || "Un membre de l’équipe"} a ajouté une réponse à votre demande.`;
    } else if (["sla_at_risk", "sla_breached"].includes(row.email_kind)) {
      const breached = row.email_kind === "sla_breached";
      subject = `[${breached ? "SLA DÉPASSÉ" : "SLA À RISQUE"}] ${ticket.ticket_number} — ${ticket.subject}`;
      heading = breached ? "Alerte : SLA dépassé" : "Attention : SLA bientôt atteint";
      intro = `L’objectif de ${milestoneLabel(row.context?.sla_milestone)} est prévu pour ${formatDeadline(row.context?.sla_deadline)}.`;
    } else {
      return { suppressed: true, reason: "email_kind_invalid" };
    }

    const safeSubject = cleanText(subject, 250);
    const html = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#1f2937">
      <h1 style="font-size:22px">${escapeHtml(heading)}</h1>
      <p>Bonjour ${escapeHtml(recipient.name)},</p>
      <p>${escapeHtml(intro)}</p>
      <div style="border-left:4px solid #7c3aed;padding:12px 16px;background:#f8fafc;margin:18px 0">
        <strong>${escapeHtml(ticket.ticket_number)} — ${escapeHtml(ticket.subject)}</strong><br>
        <span style="color:#64748b">${escapeHtml(categoryLabel(ticket.category))} · Priorité ${escapeHtml(priorityLabel(ticket.priority))}</span>
        ${message || row.email_kind === "new_ticket" ? `<p>${safeExcerpt}</p>` : ""}
      </div>
      <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#7c3aed;color:white;text-decoration:none;padding:10px 16px;border-radius:8px">Ouvrir le ticket</a></p>
      <p style="color:#64748b;font-size:12px">Message transactionnel envoyé par VoiceDesk AI.</p>
    </div>`;
    const text = `${heading}\n\n${intro}\n\n${ticket.ticket_number} — ${ticket.subject}\n${categoryLabel(ticket.category)} · Priorité ${priorityLabel(ticket.priority)}\n\n${excerpt}\n\n${link}`;

    const result = await resend.emails.send({
      from: emailFrom,
      to: recipient.email,
      subject: safeSubject,
      html,
      text,
    }, {
      idempotencyKey: row.idempotency_key,
    });
    if (result?.error) {
      const error = ticketServiceError(
        result.error.name || "resend_email_rejected",
        result.error.message || "Resend rejected the ticket email",
        502
      );
      error.providerStatusCode = result.error.statusCode;
      throw error;
    }
    return {
      suppressed: false,
      providerMessageId: result?.data?.id || result?.id || null,
    };
  }

  async function completeEmail(row, providerMessageId) {
    const { data, error } = await supabase.rpc("complete_ticket_email_outbox", {
      p_job_id: row.id,
      p_worker_id: row.claimed_by,
      p_provider_message_id: providerMessageId || null,
    });
    if (error) throw queryError(error, "ticket_email_complete_failed");
    if (data !== true) throw ticketServiceError("ticket_email_claim_lost", "Ticket email claim was lost");
  }

  async function suppressEmail(row, reason) {
    const { data, error } = await supabase.rpc("suppress_ticket_email_outbox", {
      p_job_id: row.id,
      p_worker_id: row.claimed_by,
      p_reason: cleanText(reason, 1000) || "recipient_suppressed",
    });
    if (error) throw queryError(error, "ticket_email_suppress_failed");
    if (data !== true) throw ticketServiceError("ticket_email_claim_lost", "Ticket email claim was lost");
  }

  async function failEmail(row, error) {
    const attempts = Math.max(1, Number(row.attempts) || 1);
    const retryDelay = Math.min(3600, 60 * (2 ** Math.min(attempts - 1, 6)));
    const { data, error: updateError } = await supabase.rpc("fail_ticket_email_outbox", {
      p_job_id: row.id,
      p_worker_id: row.claimed_by,
      p_error: cleanText(error?.code || error?.message, 1000) || "ticket_email_failed",
      p_retry_delay_seconds: retryDelay,
    });
    if (updateError) throw queryError(updateError, "ticket_email_failure_update_failed");
    return data;
  }

  async function purgeEmailOutbox(batchSize = 500) {
    const { data, error } = await supabase.rpc("purge_ticket_email_outbox", {
      p_batch_size: batchSize,
    });
    if (error) throw queryError(error, "ticket_email_purge_failed");
    return Number(data) || 0;
  }

  return {
    appendMessage,
    claimEmails,
    completeEmail,
    createTicket,
    enqueueSlaAlerts,
    failEmail,
    purgeEmailOutbox,
    sendEmailOutbox,
    suppressEmail,
  };
}

export { escapeHtml, normalizeFrontendUrl };
