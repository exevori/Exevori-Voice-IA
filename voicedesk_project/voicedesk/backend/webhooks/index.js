// ============================================================
// VOICEDESK IA — WEBHOOKS EXTERNES
//
// Gère les webhooks entrants depuis :
//   • Gmail Push API (nouveaux courriels)
//   • Twilio Status Callbacks (statut appels)
//   • Resend (delivery + bounce events)
// ============================================================

import express from "express";
import { createClient } from "@supabase/supabase-js";
import { logger } from "../lib/logger.js";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const log = logger.child({ module: "webhooks" });
const router = express.Router();

// ─────────────────────────────────────────────────────────────
// POST /webhooks/gmail-push
// Reçu de Google Cloud Pub/Sub quand Gmail détecte un nouveau email
// ─────────────────────────────────────────────────────────────
router.post("/gmail-push", async (req, res) => {
  // Google envoie un payload pub/sub : { message: { data: base64 }, subscription: "..." }
  try {
    const message = req.body.message;
    if (!message) return res.status(200).send();

    const data = JSON.parse(Buffer.from(message.data, "base64").toString());
    const { emailAddress, historyId } = data;

    log.info("Gmail push received", { emailAddress, historyId });

    // Trouver à quelle company appartient ce gmail
    const { data: integration } = await supabase
      .from("integration_configs")
      .select("company_id, config")
      .eq("provider", "gmail")
      .filter("config->>email", "eq", emailAddress)
      .single();

    if (!integration) {
      log.warn("Gmail push ignored — no matching company", { emailAddress });
      return res.status(200).send();
    }

    const accessToken = integration.config?.access_token;
    if (!accessToken) {
      log.warn("Gmail token missing", { company_id: integration.company_id });
      return res.status(200).send();
    }

    // Fetch les nouveaux messages depuis Gmail API
    const historyResponse = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${historyId}&historyTypes=messageAdded`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!historyResponse.ok) {
      log.error("Gmail API error", { status: historyResponse.status });
      return res.status(200).send();
    }

    const history = await historyResponse.json();
    const newMessageIds = (history.history || [])
      .flatMap(h => h.messagesAdded || [])
      .map(m => m.message.id);

    // Pour chaque nouveau message, fetch détails et forward au module email
    for (const messageId of newMessageIds) {
      try {
        const msgResponse = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        const msg = await msgResponse.json();
        const headers = msg.payload?.headers || [];
        const getHeader = name => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;

        const fromHeader = getHeader("From");
        const fromMatch = fromHeader?.match(/(.+?)\s*<(.+?)>/) || [null, null, fromHeader];

        // Forward au module email
        await fetch(`${process.env.BACKEND_URL || "http://localhost:3000"}/api/v1/emails/incoming`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            company_id: integration.company_id,
            from_email: fromMatch[2] || fromHeader,
            from_name: fromMatch[1]?.trim() || "",
            subject: getHeader("Subject") || "(sans sujet)",
            body: extractBody(msg.payload),
            message_id: messageId,
            received_at: new Date().toISOString(),
          }),
        });
      } catch (e) {
        log.error("Failed to process Gmail message", { messageId, error: e.message });
      }
    }

    return res.status(200).send();
  } catch (err) {
    log.error("Gmail push error", { error: err.message });
    return res.status(200).send(); // Always 200 to avoid retries
  }
});

// ─────────────────────────────────────────────────────────────
// POST /webhooks/twilio/status
// Statut des appels Twilio (initiated, ringing, answered, completed, busy, failed)
// ─────────────────────────────────────────────────────────────
router.post("/twilio/status", express.urlencoded({ extended: true }), async (req, res) => {
  const {
    CallSid, CallStatus, From, To, Duration,
    Direction, AnsweredBy, Timestamp,
  } = req.body;

  log.info("Twilio status callback", { CallSid, CallStatus, Direction, AnsweredBy });

  try {
    // Trouver l'appel correspondant (inbound ou outbound)
    const table = Direction === "outbound-api" ? "outbound_calls" : "calls";

    const updates = {
      status: mapTwilioStatus(CallStatus),
    };

    if (CallStatus === "completed") {
      updates.duration_seconds = parseInt(Duration) || 0;
      updates.ended_at = new Date();
    }
    if (AnsweredBy) {
      updates.answered_by = AnsweredBy; // human, machine, fax, unknown
    }

    await supabase
      .from(table)
      .update(updates)
      .eq("twilio_call_sid", CallSid);

    return res.status(200).send("OK");
  } catch (err) {
    log.error("Twilio status error", { error: err.message, CallSid });
    return res.status(200).send("OK");
  }
});

// ─────────────────────────────────────────────────────────────
// POST /webhooks/twilio/amd
// AMD (Answering Machine Detection) - répondeur ou humain ?
// ─────────────────────────────────────────────────────────────
router.post("/twilio/amd", express.urlencoded({ extended: true }), async (req, res) => {
  const { CallSid, AnsweredBy } = req.body;

  log.info("AMD result", { CallSid, AnsweredBy });

  await supabase
    .from("outbound_calls")
    .update({ answered_by: AnsweredBy })
    .eq("twilio_call_sid", CallSid);

  return res.status(200).send("OK");
});

// ─────────────────────────────────────────────────────────────
// POST /webhooks/resend
// Events Resend : delivered, bounced, complained, opened, clicked
// ─────────────────────────────────────────────────────────────
router.post("/resend", async (req, res) => {
  const event = req.body;
  log.info("Resend event", { type: event.type, email_id: event.data?.email_id });

  // Pour les bounces/complaints, on peut blacklister
  if (event.type === "email.bounced" || event.type === "email.complained") {
    const email = event.data?.to;
    if (email) {
      log.warn("Email blacklisted", { email, reason: event.type });
      // Ici on pourrait ajouter à une table email_blacklist
    }
  }

  return res.json({ received: true });
});

// ─────────────────────────────────────────────────────────────
// POST /webhooks/calendly
// Webhook Calendly (invitee.created / invitee.canceled)
// Forward vers module calendar
// ─────────────────────────────────────────────────────────────
router.post("/calendly", express.raw({ type: "application/json" }), async (req, res) => {
  // Le module calendar gère déjà ce webhook
  // Cette route est ici pour le routing global propre
  log.info("Calendly webhook forwarded");
  return res.status(200).json({ received: true });
});

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function extractBody(payload) {
  if (!payload) return "";

  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64").toString("utf-8");
      }
      if (part.mimeType === "text/html" && part.body?.data) {
        return Buffer.from(part.body.data, "base64").toString("utf-8");
      }
      // Récursion pour multipart
      if (part.parts) {
        const recursive = extractBody(part);
        if (recursive) return recursive;
      }
    }
  }

  return "";
}

function mapTwilioStatus(status) {
  const map = {
    queued: "queued",
    initiated: "calling",
    ringing: "ringing",
    "in-progress": "in_progress",
    completed: "completed",
    busy: "busy",
    "no-answer": "no_answer",
    failed: "failed",
    canceled: "cancelled",
  };
  return map[status] || status;
}

export default router;
