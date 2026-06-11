// ============================================================
// VOICEDESK IA — INTÉGRATION CALENDRIER
// Inspiré de :
//   github.com/ethanwillis/calendly-node-sdk
//   github.com/calendly/buzzwordcrm (sample officiel Calendly v2)
//
// Pipeline VoiceDesk :
//   1. Webhook Calendly → RDV créé/annulé/modifié
//   2. Sync vers table appointments
//   3. Création/lien automatique avec contact CRM
//   4. L'assistant peut consulter dispos via /availability
//   5. L'assistant peut créer un RDV pendant un appel via /book
// ============================================================

import express from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CALENDLY_API_BASE = "https://api.calendly.com";
const CALENDLY_WEBHOOK_SIGNING_KEY = process.env.CALENDLY_WEBHOOK_SIGNING_KEY;

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// POST /api/v1/calendar/webhooks/calendly
// Webhook Calendly — invitee.created / invitee.canceled
// ─────────────────────────────────────────────────────────────
router.post("/webhooks/calendly", express.raw({ type: "application/json" }), async (req, res) => {
  // Vérification de signature
  if (!verifyCalendlySignature(req)) {
    return res.status(401).json({ error: "signature invalide" });
  }

  const payload = JSON.parse(req.body.toString());
  const { event, payload: data } = payload;

  try {
    // Identifier l'entreprise via le calendly_organization_uri
    const company = await getCompanyByCalendlyUri(data.event_type?.uri || data.scheduling_url);
    if (!company) {
      console.log("[CALENDLY] Webhook ignoré — entreprise non liée");
      return res.json({ received: true });
    }

    if (event === "invitee.created") {
      await handleAppointmentCreated(company.id, data);
    } else if (event === "invitee.canceled") {
      await handleAppointmentCanceled(company.id, data);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("[CALENDLY] Webhook error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Handler : Nouveau RDV créé
// ─────────────────────────────────────────────────────────────
async function handleAppointmentCreated(companyId, data) {
  const { invitee, event, questions_and_answers = [] } = data;

  // 1. Trouver ou créer le contact CRM
  let contact = await supabase
    .from("contacts")
    .select("*")
    .eq("company_id", companyId)
    .eq("email", invitee.email)
    .single()
    .then(r => r.data);

  if (!contact) {
    const { data: newContact } = await supabase
      .from("contacts")
      .insert({
        company_id: companyId,
        full_name: invitee.name,
        email: invitee.email,
        phone: extractPhone(questions_and_answers),
        company: extractCompany(questions_and_answers),
        status: "new",
        source: "calendly",
      })
      .select()
      .single();
    contact = newContact;
  }

  // 2. Créer l'enregistrement de RDV
  const startTime = new Date(event.start_time);
  const endTime = new Date(event.end_time);
  const durationMinutes = Math.round((endTime - startTime) / 60000);

  await supabase.from("appointments").insert({
    company_id: companyId,
    contact_id: contact.id,
    calendly_event_id: event.uri,
    calendly_invitee_uri: invitee.uri,
    date: startTime.toISOString().split("T")[0],
    time: startTime.toTimeString().substring(0, 5),
    duration_minutes: durationMinutes,
    type: event.name,
    channel: extractChannel(event.location),
    meet_link: event.location?.join_url || event.location?.location || null,
    status: "confirmed",
    confirmation_sent: false,
    source_direction: "inbound",
    notes: questions_and_answers.map(qa => `${qa.question}: ${qa.answer}`).join("\n"),
  });

  // 3. Mettre à jour le contact
  await supabase
    .from("contacts")
    .update({
      status: "appointment_set",
      last_interaction_at: new Date(),
      next_action: `RDV confirmé le ${startTime.toLocaleDateString("fr-CA")}`,
    })
    .eq("id", contact.id);

  // 4. Note CRM
  await supabase.from("contact_notes").insert({
    company_id: companyId,
    contact_id: contact.id,
    direction: "inbound",
    note: `RDV pris via Calendly: ${event.name} le ${startTime.toLocaleDateString("fr-CA")} à ${startTime.toLocaleTimeString("fr-CA")}`,
    created_by: "calendly_sync",
  });

  console.log(`[CALENDLY] RDV créé: ${event.name} — ${invitee.email}`);
}

// ─────────────────────────────────────────────────────────────
// Handler : RDV annulé
// ─────────────────────────────────────────────────────────────
async function handleAppointmentCanceled(companyId, data) {
  const { event } = data;

  await supabase
    .from("appointments")
    .update({
      status: "cancelled",
      cancelled_at: new Date(),
      cancellation_reason: data.cancellation?.reason || "",
    })
    .eq("company_id", companyId)
    .eq("calendly_event_id", event.uri);

  console.log(`[CALENDLY] RDV annulé: ${event.uri}`);
}

// ─────────────────────────────────────────────────────────────
// GET /api/v1/calendar/availability
// Récupérer les disponibilités Calendly pour l'assistant (appel en cours)
// ─────────────────────────────────────────────────────────────
router.get("/availability", async (req, res) => {
  const { company_id, days_ahead = 7 } = req.query;

  try {
    const { data: config } = await supabase
      .from("integration_configs")
      .select("*")
      .eq("company_id", company_id)
      .eq("provider", "calendly")
      .single();

    if (!config) return res.json({ availability: [], message: "Calendly non configuré" });

    const startTime = new Date().toISOString();
    const endTime = new Date(Date.now() + days_ahead * 86400000).toISOString();

    const eventTypeUri = config.config?.event_type_uri;
    const accessToken = config.config?.access_token;

    const response = await fetch(
      `${CALENDLY_API_BASE}/event_type_available_times?event_type=${encodeURIComponent(eventTypeUri)}&start_time=${startTime}&end_time=${endTime}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const calendlyData = await response.json();

    // Formater pour l'assistant
    const slots = (calendlyData.collection || []).map(slot => ({
      start: slot.start_time,
      formatted: formatSlotForVoice(slot.start_time),
      booking_url: slot.scheduling_url,
    }));

    return res.json({ availability: slots.slice(0, 10) });
  } catch (err) {
    console.error("[CALENDLY] Availability error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/calendar/book
// L'assistant réserve un RDV pendant un appel (Calendly Single-Use Link)
// ─────────────────────────────────────────────────────────────
router.post("/book", async (req, res) => {
  const { company_id, contact_name, contact_email, contact_phone, start_time, type } = req.body;

  try {
    const { data: config } = await supabase
      .from("integration_configs")
      .select("*")
      .eq("company_id", company_id)
      .eq("provider", "calendly")
      .single();

    const eventTypeUri = config.config?.event_type_uri;
    const accessToken = config.config?.access_token;

    // Créer un single-use scheduling link
    const linkResponse = await fetch(`${CALENDLY_API_BASE}/scheduling_links`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        max_event_count: 1,
        owner: eventTypeUri,
        owner_type: "EventType",
      }),
    });

    const linkData = await linkResponse.json();
    const bookingUrl = linkData.resource?.booking_url;

    // L'assistant envoie ce lien par SMS ou par courriel au client
    return res.json({
      success: true,
      booking_url: bookingUrl,
      message: `Je vous envoie un lien par courriel pour confirmer le rendez-vous du ${formatSlotForVoice(start_time)}.`,
    });
  } catch (err) {
    console.error("[CALENDLY] Book error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/calendar/appointments
// Liste des RDV pour le dashboard PME
// ─────────────────────────────────────────────────────────────
router.get("/appointments", async (req, res) => {
  const { company_id, from_date, to_date, status } = req.query;

  let query = supabase
    .from("appointments")
    .select("*, contacts(full_name, email, phone, company)")
    .eq("company_id", company_id);

  if (from_date) query = query.gte("date", from_date);
  if (to_date) query = query.lte("date", to_date);
  if (status) query = query.eq("status", status);

  const { data, error } = await query.order("date", { ascending: true }).order("time", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ appointments: data });
});

// ─────────────────────────────────────────────────────────────
// FONCTIONS UTILITAIRES
// ─────────────────────────────────────────────────────────────

function verifyCalendlySignature(req) {
  if (!CALENDLY_WEBHOOK_SIGNING_KEY) return true; // skip si pas configuré
  const signature = req.headers["calendly-webhook-signature"];
  if (!signature) return false;

  const timestamp = signature.split(",")[0].replace("t=", "");
  const v1 = signature.split(",")[1].replace("v1=", "");

  const payload = `${timestamp}.${req.body.toString()}`;
  const expected = crypto.createHmac("sha256", CALENDLY_WEBHOOK_SIGNING_KEY).update(payload).digest("hex");

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}

async function getCompanyByCalendlyUri(eventTypeUri) {
  if (!eventTypeUri) return null;
  const { data } = await supabase
    .from("integration_configs")
    .select("company_id, companies(*)")
    .eq("provider", "calendly")
    .filter("config->>event_type_uri", "eq", eventTypeUri)
    .single();
  return data?.companies;
}

function extractPhone(qa) {
  const phoneQuestion = qa.find(q => /tél|phone|numéro/i.test(q.question));
  return phoneQuestion?.answer || "";
}

function extractCompany(qa) {
  const companyQuestion = qa.find(q => /entreprise|compagnie|company|organization/i.test(q.question));
  return companyQuestion?.answer || "";
}

function extractChannel(location) {
  if (!location) return "À déterminer";
  if (location.type === "google_conference") return "Google Meet";
  if (location.type === "zoom") return "Zoom";
  if (location.type === "physical") return "En personne";
  if (location.type === "outbound_call") return "Téléphone";
  return location.type || "À déterminer";
}

function formatSlotForVoice(isoTime) {
  const date = new Date(isoTime);
  const days = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  const months = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

  const day = days[date.getDay()];
  const dayNum = date.getDate();
  const month = months[date.getMonth()];
  const hour = date.getHours();
  const minute = date.getMinutes().toString().padStart(2, "0");

  return `${day} ${dayNum} ${month} à ${hour}h${minute === "00" ? "" : minute}`;
}

export default router;
