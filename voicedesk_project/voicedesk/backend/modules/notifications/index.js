// ============================================================
// VOICEDESK IA — MODULE NOTIFICATIONS
//
// Système unifié de notifications :
//   1. Notifications in-app (table notifications)
//   2. Emails transactionnels (via Resend)
//   3. Préférences par utilisateur (email on/off par type)
//
// Types : info, success, warning, error
// Catégories : ticket, billing, draft, learning, system, mention
// ============================================================

import express from "express";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import { logger } from "../../lib/logger.js";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);
const log = logger.child({ module: "notifications" });

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// GET /api/v1/notifications
// Liste les notifications de l'utilisateur
// ─────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const user_id = req.user?.id;
  const { unread_only = "false", limit = 50, offset = 0 } = req.query;

  if (!user_id) return res.status(401).json({ error: "unauthorized" });

  try {
    let query = supabase
      .from("notifications")
      .select("*", { count: "exact" })
      .eq("user_id", user_id);

    if (unread_only === "true") query = query.eq("read", false);

    const { data, error, count } = await query
      .order("created_at", { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (error) throw error;
    return res.json({ notifications: data || [], total: count || 0, unread_count: await getUnreadCount(user_id) });
  } catch (err) {
    log.error("List error", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/notifications/unread-count
// Badge pour la cloche
// ─────────────────────────────────────────────────────────────
router.get("/unread-count", async (req, res) => {
  const user_id = req.user?.id;
  if (!user_id) return res.status(401).json({ error: "unauthorized" });

  const count = await getUnreadCount(user_id);
  return res.json({ unread_count: count });
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/notifications/:id/read
// ─────────────────────────────────────────────────────────────
router.post("/:id/read", async (req, res) => {
  await supabase
    .from("notifications")
    .update({ read: true, read_at: new Date() })
    .eq("id", req.params.id)
    .eq("user_id", req.user.id);

  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/notifications/mark-all-read
// ─────────────────────────────────────────────────────────────
router.post("/mark-all-read", async (req, res) => {
  await supabase
    .from("notifications")
    .update({ read: true, read_at: new Date() })
    .eq("user_id", req.user.id)
    .eq("read", false);

  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/v1/notifications/:id
// ─────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  await supabase
    .from("notifications")
    .delete()
    .eq("id", req.params.id)
    .eq("user_id", req.user.id);

  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/notifications/preferences
// Préférences de l'utilisateur (email on/off par catégorie)
// ─────────────────────────────────────────────────────────────
router.get("/preferences", async (req, res) => {
  const { data } = await supabase
    .from("notification_preferences")
    .select("*")
    .eq("user_id", req.user.id)
    .single();

  return res.json({
    preferences: data || getDefaultPreferences(),
  });
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/v1/notifications/preferences
// ─────────────────────────────────────────────────────────────
router.patch("/preferences", async (req, res) => {
  const { ticket_email, billing_email, draft_email, learning_email, system_email } = req.body;

  await supabase
    .from("notification_preferences")
    .upsert({
      user_id: req.user.id,
      ticket_email, billing_email, draft_email, learning_email, system_email,
      updated_at: new Date(),
    }, { onConflict: "user_id" });

  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// HELPERS — Appelés depuis les autres modules
// ─────────────────────────────────────────────────────────────

/**
 * Créer une notification (in-app + email selon préférences)
 *
 * Usage depuis d'autres modules :
 *   import { notify } from "../notifications/index.js";
 *   await notify({
 *     user_id, company_id,
 *     type: "info" | "success" | "warning" | "error",
 *     category: "ticket" | "billing" | "draft" | "learning" | "system",
 *     title: "Nouveau brouillon à valider",
 *     body: "Un brouillon de courriel attend votre validation",
 *     link: "/emails?tab=drafts",
 *     email: { subject, html }  // Optionnel - envoyé si préférences le permettent
 *   });
 */
export async function notify({ user_id, company_id, type = "info", category, title, body, link, email }) {
  try {
    // 1. Insérer la notification in-app
    const { data: notif } = await supabase
      .from("notifications")
      .insert({
        user_id, company_id, type, category, title, body, link,
        read: false,
      })
      .select()
      .single();

    log.info("Notification created", { user_id, category, type, title });

    // 2. Envoyer email si la préférence le permet
    if (email && (await shouldSendEmail(user_id, category))) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("email, full_name, preferred_language")
        .eq("user_id", user_id)
        .single();

      if (profile?.email) {
        await resend.emails.send({
          from: process.env.EMAIL_FROM || "VoiceDesk <notifications@voicedesk.ca>",
          to: profile.email,
          subject: email.subject || title,
          html: email.html || `<p>${body}</p>`,
        });
        log.info("Email sent", { user_id, category });
      }
    }

    return notif;
  } catch (err) {
    log.error("Failed to notify", { error: err.message, user_id, category });
    return null;
  }
}

/**
 * Notifier tous les utilisateurs d'une entreprise
 */
export async function notifyCompany(company_id, notification) {
  const { data: users } = await supabase
    .from("profiles")
    .select("user_id")
    .eq("company_id", company_id)
    .eq("status", "active");

  await Promise.all(
    (users || []).map(u => notify({ ...notification, user_id: u.user_id, company_id }))
  );
}

/**
 * Notifier tous les super_admin Exevori
 */
export async function notifyAdmins(notification) {
  const { data: admins } = await supabase
    .from("profiles")
    .select("user_id, company_id")
    .eq("role", "super_admin")
    .eq("status", "active");

  await Promise.all(
    (admins || []).map(a => notify({
      ...notification,
      user_id: a.user_id,
      company_id: a.company_id,
    }))
  );
}

async function getUnreadCount(user_id) {
  const { count } = await supabase
    .from("notifications")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user_id)
    .eq("read", false);
  return count || 0;
}

async function shouldSendEmail(user_id, category) {
  const { data } = await supabase
    .from("notification_preferences")
    .select("*")
    .eq("user_id", user_id)
    .single();

  if (!data) return getDefaultPreferences()[`${category}_email`] !== false;
  return data[`${category}_email`] !== false;
}

function getDefaultPreferences() {
  return {
    ticket_email: true,    // Email pour tickets
    billing_email: true,   // Email pour facturation
    draft_email: false,    // Pas d'email pour brouillons (notif in-app suffit)
    learning_email: false, // Pas d'email pour suggestions IA
    system_email: true,    // Email pour alertes système
  };
}

export default router;
