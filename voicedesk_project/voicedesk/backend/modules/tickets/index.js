// ============================================================
// VOICEDESK IA — MODULE TICKETING PRO
// Inspiré de :
//   github.com/mvpstack/helpin (Supabase + Next.js)
//   github.com/flowinquiry-team/flowinquiry (SLA tracking)
//
// Pipeline VoiceDesk :
//   1. PME ouvre ticket depuis son dashboard
//   2. Catégorie + priorité + description
//   3. SLA calculé automatiquement selon priorité
//   4. Admin Exevori voit, assigne, répond
//   5. Notes internes invisibles au client
//   6. Tracking SLA + alertes si dépassement
//   7. Fermeture + évaluation satisfaction (optionnel)
// ============================================================

import express from "express";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);

const router = express.Router();

// ── SLA PAR PRIORITÉ (en heures) ──────────────────────────────
const SLA = {
  urgent: { first_response_hours: 1,  resolution_hours: 4    },
  high:   { first_response_hours: 4,  resolution_hours: 24   },
  normal: { first_response_hours: 24, resolution_hours: 72   },
  low:    { first_response_hours: 48, resolution_hours: 168  },
};

// ─────────────────────────────────────────────────────────────
// POST /api/v1/tickets
// Le client (PME) crée un ticket
// ─────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  const {
    company_id, subject, description, category = "general", priority = "normal",
    created_by_user_id, created_by_name, created_by_email,
  } = req.body;

  if (!company_id || !subject) {
    return res.status(400).json({ error: "company_id et subject requis" });
  }

  try {
    // Génération du numéro de ticket
    const ticketNumber = await generateTicketNumber();

    // Calcul SLA
    const sla = SLA[priority] || SLA.normal;
    const now = new Date();
    const slaFirstResponse = new Date(now.getTime() + sla.first_response_hours * 3600000);
    const slaResolution = new Date(now.getTime() + sla.resolution_hours * 3600000);

    const { data: ticket } = await supabase
      .from("tickets")
      .insert({
        company_id, ticket_number: ticketNumber,
        subject, description, category, priority,
        status: "open",
        created_by_user_id, created_by_name, created_by_email,
        sla_first_response_due: slaFirstResponse,
        sla_resolution_due: slaResolution,
      })
      .select()
      .single();

    // Message initial dans le thread
    if (description) {
      await supabase.from("ticket_messages").insert({
        ticket_id: ticket.id,
        company_id,
        author_user_id: created_by_user_id,
        author_name: created_by_name,
        author_role: "client",
        body: description,
      });
    }

    // Notification admin Exevori
    await notifyAdmins(ticket);

    return res.json({ success: true, ticket });
  } catch (err) {
    console.error("[TICKETS] Create error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/tickets
// Liste des tickets (filtres : status, priority, category, assigned)
// ─────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const { company_id, status, priority, category, assigned_to, limit = 50 } = req.query;

  try {
    let query = supabase
      .from("tickets")
      .select("*, companies(name, contact_name), assigned_to:profiles!assigned_to_user_id(full_name, email)");

    if (company_id) query = query.eq("company_id", company_id);
    if (status) query = query.eq("status", status);
    if (priority) query = query.eq("priority", priority);
    if (category) query = query.eq("category", category);
    if (assigned_to) query = query.eq("assigned_to_user_id", assigned_to);

    const { data, error } = await query
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(parseInt(limit));

    if (error) throw error;

    // Calcul SLA status pour chaque ticket
    const now = new Date();
    const tickets = (data || []).map(t => ({
      ...t,
      sla_status: calculateSLAStatus(t, now),
    }));

    return res.json({ tickets });
  } catch (err) {
    console.error("[TICKETS] List error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/tickets/:id
// Détail d'un ticket avec messages
// ─────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  const { is_admin = false } = req.query;

  try {
    const { data: ticket } = await supabase
      .from("tickets")
      .select("*, companies(*)")
      .eq("id", id)
      .single();

    if (!ticket) return res.status(404).json({ error: "ticket introuvable" });

    // Récupérer les messages (filtrer les internes si pas admin)
    let messagesQuery = supabase
      .from("ticket_messages")
      .select("*, attachments:ticket_attachments(*)")
      .eq("ticket_id", id);

    if (!is_admin) {
      messagesQuery = messagesQuery.eq("is_internal", false);
    }

    const { data: messages } = await messagesQuery.order("created_at", { ascending: true });

    return res.json({
      ticket: { ...ticket, sla_status: calculateSLAStatus(ticket, new Date()) },
      messages: messages || [],
    });
  } catch (err) {
    console.error("[TICKETS] Get error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/tickets/:id/messages
// Ajouter un message à un ticket
// ─────────────────────────────────────────────────────────────
router.post("/:id/messages", async (req, res) => {
  const { id } = req.params;
  const { author_user_id, author_name, author_role, body, is_internal = false, attachments = [] } = req.body;

  try {
    const { data: ticket } = await supabase
      .from("tickets")
      .select("*")
      .eq("id", id)
      .single();

    if (!ticket) return res.status(404).json({ error: "ticket introuvable" });

    const { data: message } = await supabase
      .from("ticket_messages")
      .insert({
        ticket_id: id,
        company_id: ticket.company_id,
        author_user_id, author_name, author_role,
        body, is_internal, attachments,
      })
      .select()
      .single();

    // Mise à jour du ticket
    const updates = { updated_at: new Date() };

    // Si première réponse Exevori → enregistrer first_response_at
    if (author_role === "exevori_agent" && !ticket.first_response_at) {
      updates.first_response_at = new Date();
    }

    // Si message client + status was 'waiting_client' → repasser en 'in_progress'
    if (author_role === "client" && ticket.status === "waiting_client") {
      updates.status = "in_progress";
    }

    // Si message Exevori + status was 'open' → 'in_progress'
    if (author_role === "exevori_agent" && ticket.status === "open") {
      updates.status = "in_progress";
    }

    await supabase.from("tickets").update(updates).eq("id", id);

    // Notification l'autre partie
    if (!is_internal) {
      await notifyTicketUpdate(ticket, message, author_role);
    }

    return res.json({ success: true, message });
  } catch (err) {
    console.error("[TICKETS] Message error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/v1/tickets/:id/assign
// Assigner un ticket à un agent Exevori
// ─────────────────────────────────────────────────────────────
router.patch("/:id/assign", async (req, res) => {
  const { id } = req.params;
  const { assigned_to_user_id, assigned_to_name } = req.body;

  await supabase
    .from("tickets")
    .update({
      assigned_to_user_id, assigned_to_name,
      status: "in_progress",
      updated_at: new Date(),
    })
    .eq("id", id);

  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/v1/tickets/:id/status
// Changer le statut d'un ticket
// ─────────────────────────────────────────────────────────────
router.patch("/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status, resolution_summary } = req.body;

  const validStatuses = ["open", "in_progress", "waiting_client", "resolved", "closed"];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: "statut invalide" });
  }

  const updates = { status, updated_at: new Date() };
  if (status === "resolved") {
    updates.resolved_at = new Date();
    if (resolution_summary) updates.resolution_summary = resolution_summary;
  }
  if (status === "closed") {
    updates.closed_at = new Date();
  }

  await supabase.from("tickets").update(updates).eq("id", id);

  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/v1/tickets/:id/priority
// Changer la priorité (recalcule SLA)
// ─────────────────────────────────────────────────────────────
router.patch("/:id/priority", async (req, res) => {
  const { id } = req.params;
  const { priority } = req.body;

  if (!SLA[priority]) return res.status(400).json({ error: "priorité invalide" });

  const sla = SLA[priority];
  const now = new Date();
  const slaFirstResponse = new Date(now.getTime() + sla.first_response_hours * 3600000);
  const slaResolution = new Date(now.getTime() + sla.resolution_hours * 3600000);

  await supabase
    .from("tickets")
    .update({
      priority,
      sla_first_response_due: slaFirstResponse,
      sla_resolution_due: slaResolution,
      updated_at: new Date(),
    })
    .eq("id", id);

  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/tickets/:id/rate
// Le client évalue la résolution (1-5 étoiles)
// ─────────────────────────────────────────────────────────────
router.post("/:id/rate", async (req, res) => {
  const { id } = req.params;
  const { satisfaction_rating, feedback } = req.body;

  if (satisfaction_rating < 1 || satisfaction_rating > 5) {
    return res.status(400).json({ error: "rating doit être entre 1 et 5" });
  }

  await supabase
    .from("tickets")
    .update({ satisfaction_rating, updated_at: new Date() })
    .eq("id", id);

  if (feedback) {
    await supabase.from("ticket_messages").insert({
      ticket_id: id,
      author_role: "client",
      body: `Évaluation: ${satisfaction_rating}/5\n\n${feedback}`,
    });
  }

  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/tickets/stats
// Statistiques pour dashboard admin
// ─────────────────────────────────────────────────────────────
router.get("/stats/overview", async (req, res) => {
  const { company_id } = req.query;

  try {
    let query = supabase.from("tickets").select("status, priority, sla_first_response_due, first_response_at, sla_resolution_due, resolved_at, satisfaction_rating");
    if (company_id) query = query.eq("company_id", company_id);

    const { data } = await query;
    const now = new Date();

    const stats = {
      total: data?.length || 0,
      open: 0, in_progress: 0, waiting_client: 0, resolved: 0, closed: 0,
      by_priority: { urgent: 0, high: 0, normal: 0, low: 0 },
      sla_breached: 0,
      sla_at_risk: 0,
      avg_first_response_minutes: 0,
      avg_resolution_hours: 0,
      avg_satisfaction: 0,
    };

    let responseTimeSum = 0, responseTimeCount = 0;
    let resolutionTimeSum = 0, resolutionTimeCount = 0;
    let satisfactionSum = 0, satisfactionCount = 0;

    (data || []).forEach(t => {
      stats[t.status] = (stats[t.status] || 0) + 1;
      stats.by_priority[t.priority] = (stats.by_priority[t.priority] || 0) + 1;

      const slaStatus = calculateSLAStatus(t, now);
      if (slaStatus === "breached") stats.sla_breached++;
      if (slaStatus === "at_risk") stats.sla_at_risk++;

      if (t.first_response_at && t.sla_first_response_due) {
        const created = new Date(t.sla_first_response_due);
        const responded = new Date(t.first_response_at);
        responseTimeSum += (responded - created) / 60000;
        responseTimeCount++;
      }

      if (t.resolved_at) {
        const resolutionMs = new Date(t.resolved_at) - new Date(t.sla_first_response_due);
        resolutionTimeSum += resolutionMs / 3600000;
        resolutionTimeCount++;
      }

      if (t.satisfaction_rating) {
        satisfactionSum += t.satisfaction_rating;
        satisfactionCount++;
      }
    });

    stats.avg_first_response_minutes = responseTimeCount > 0 ? Math.round(responseTimeSum / responseTimeCount) : 0;
    stats.avg_resolution_hours = resolutionTimeCount > 0 ? Math.round(resolutionTimeSum / resolutionTimeCount) : 0;
    stats.avg_satisfaction = satisfactionCount > 0 ? (satisfactionSum / satisfactionCount).toFixed(1) : 0;

    return res.json(stats);
  } catch (err) {
    console.error("[TICKETS] Stats error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// FONCTIONS UTILITAIRES
// ─────────────────────────────────────────────────────────────

async function generateTicketNumber() {
  const year = new Date().getFullYear();
  const { count } = await supabase
    .from("tickets")
    .select("*", { count: "exact", head: true });
  const num = String((count || 0) + 1).padStart(5, "0");
  return `T-${year}-${num}`;
}

function calculateSLAStatus(ticket, now) {
  if (ticket.status === "resolved" || ticket.status === "closed") {
    return "completed";
  }

  // Vérifier le SLA de première réponse
  if (!ticket.first_response_at && ticket.sla_first_response_due) {
    const dueDate = new Date(ticket.sla_first_response_due);
    const hoursUntilDue = (dueDate - now) / 3600000;
    if (hoursUntilDue < 0) return "breached";
    if (hoursUntilDue < 1) return "at_risk";
  }

  // Vérifier le SLA de résolution
  if (ticket.sla_resolution_due) {
    const dueDate = new Date(ticket.sla_resolution_due);
    const hoursUntilDue = (dueDate - now) / 3600000;
    if (hoursUntilDue < 0) return "breached";
    if (hoursUntilDue < 4) return "at_risk";
  }

  return "on_track";
}

async function notifyAdmins(ticket) {
  try {
    const { data: admins } = await supabase
      .from("profiles")
      .select("email, full_name")
      .eq("role", "super_admin")
      .eq("status", "active");

    if (!admins?.length) return;

    const priorityLabel = { urgent: "🔴 URGENT", high: "🟠 Haute", normal: "🔵 Normale", low: "⚪ Basse" }[ticket.priority];

    await Promise.all(admins.map(admin =>
      resend.emails.send({
        from: `VoiceDesk Tickets <tickets@voicedesk.ca>`,
        to: admin.email,
        subject: `[${ticket.ticket_number}] ${priorityLabel} — ${ticket.subject}`,
        html: `
          <h2>Nouveau ticket de support</h2>
          <p><strong>${ticket.ticket_number}</strong> — ${ticket.subject}</p>
          <p><strong>Priorité :</strong> ${priorityLabel}</p>
          <p><strong>Catégorie :</strong> ${ticket.category}</p>
          <p><strong>Client :</strong> ${ticket.created_by_name} (${ticket.created_by_email})</p>
          <hr>
          <p>${ticket.description || "Pas de description"}</p>
          <p><a href="${process.env.FRONTEND_URL}/admin/tickets/${ticket.id}">Voir le ticket →</a></p>
        `,
      })
    ));
  } catch (err) {
    console.error("[TICKETS] Notify admins error:", err);
  }
}

async function notifyTicketUpdate(ticket, message, authorRole) {
  try {
    if (authorRole === "exevori_agent") {
      // Notifier le client
      if (ticket.created_by_email) {
        await resend.emails.send({
          from: `VoiceDesk Support <tickets@voicedesk.ca>`,
          to: ticket.created_by_email,
          subject: `[${ticket.ticket_number}] Nouvelle réponse — ${ticket.subject}`,
          html: `
            <p>Nous avons répondu à votre ticket :</p>
            <blockquote>${message.body}</blockquote>
            <p><a href="${process.env.FRONTEND_URL}/tickets/${ticket.id}">Voir le ticket →</a></p>
          `,
        });
      }
    } else if (authorRole === "client") {
      // Notifier l'agent assigné
      if (ticket.assigned_to_user_id) {
        const { data: agent } = await supabase
          .from("profiles")
          .select("email")
          .eq("user_id", ticket.assigned_to_user_id)
          .single();

        if (agent?.email) {
          await resend.emails.send({
            from: `VoiceDesk Tickets <tickets@voicedesk.ca>`,
            to: agent.email,
            subject: `[${ticket.ticket_number}] Réponse du client`,
            html: `
              <p>${ticket.created_by_name} a répondu :</p>
              <blockquote>${message.body}</blockquote>
              <p><a href="${process.env.FRONTEND_URL}/admin/tickets/${ticket.id}">Voir le ticket →</a></p>
            `,
          });
        }
      }
    }
  } catch (err) {
    console.error("[TICKETS] Notify update error:", err);
  }
}

// ─────────────────────────────────────────────────────────────
// CRON — Vérification SLA toutes les 15 minutes
// Alertes si SLA dépassé ou à risque
// ─────────────────────────────────────────────────────────────
export async function checkSLABreaches() {
  const now = new Date();
  const { data: tickets } = await supabase
    .from("tickets")
    .select("*, companies(name, contact_email)")
    .in("status", ["open", "in_progress", "waiting_client"]);

  const breached = [];
  const atRisk = [];

  (tickets || []).forEach(t => {
    const slaStatus = calculateSLAStatus(t, now);
    if (slaStatus === "breached") breached.push(t);
    if (slaStatus === "at_risk") atRisk.push(t);
  });

  if (breached.length > 0) {
    console.log(`[TICKETS] SLA BREACHED : ${breached.length} tickets`);
    // Notification escalade équipe Exevori
  }

  return { breached: breached.length, at_risk: atRisk.length };
}

export default router;
