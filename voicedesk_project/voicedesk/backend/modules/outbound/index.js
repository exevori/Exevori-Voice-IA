// ============================================================
// EXEVORI VOICE IA — MODULE OUTBOUND (Phase 8D)
// Appels sortants : prospection, suivi, validation RDV, annonce
//
// Routes :
//   POST   /api/v1/outbound/campaigns
//   GET    /api/v1/outbound/campaigns
//   GET    /api/v1/outbound/campaigns/:id
//   PATCH  /api/v1/outbound/campaigns/:id
//   DELETE /api/v1/outbound/campaigns/:id
//
//   POST   /api/v1/outbound/campaigns/:id/contacts
//   POST   /api/v1/outbound/campaigns/:id/contacts/import
//   GET    /api/v1/outbound/campaigns/:id/contacts
//   DELETE /api/v1/outbound/campaigns/:id/contacts/:cid
//
//   POST   /api/v1/outbound/campaigns/:id/launch
//   POST   /api/v1/outbound/campaigns/:id/pause
//   POST   /api/v1/outbound/campaigns/:id/resume
//
//   GET    /api/v1/outbound/dnc
//   POST   /api/v1/outbound/dnc
//   DELETE /api/v1/outbound/dnc/:id
//
//   POST   /api/v1/outbound/webhooks/call-status (Twilio)
// ============================================================

import express from "express";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";
import dotenv from "dotenv";
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const XLSX = _require("xlsx");

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Normalise un numéro de téléphone en E.164 (Canada/USA)
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.startsWith("+")) return raw.replace(/\s/g, "");
  return null;
}

// Vérifie si un numéro est dans la liste DNC
async function isOnDNC(company_id, phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  const { data } = await supabase
    .from("dnc_list")
    .select("id")
    .eq("company_id", company_id)
    .eq("phone", normalized)
    .maybeSingle();
  return !!data;
}

// Compte les appels déjà faits aujourd'hui pour cette campagne
async function callsMadeToday(campaign_id) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const { count } = await supabase
    .from("outbound_contacts")
    .select("id", { count: "exact" })
    .eq("campaign_id", campaign_id)
    .in("status", ["called", "no_answer", "interested", "not_interested", "error"])
    .gte("last_called_at", todayStart.toISOString());
  return count || 0;
}

// Vérifie qu'on est dans les heures autorisées
function isWithinCallHours(startHour = 9, endHour = 20) {
  const now = new Date();
  // Heure de l'Est (UTC-4 ou UTC-5)
  const estOffset = -4; // EDT (été)
  const estHour = (now.getUTCHours() + 24 + estOffset) % 24;
  return estHour >= startHour && estHour < endHour;
}

// ─────────────────────────────────────────────────────────────
// CAMPAIGNS — CRUD
// ─────────────────────────────────────────────────────────────

router.post("/campaigns", express.json(), async (req, res) => {
  const { company_id, name, mission_type, script, daily_call_limit, created_by } = req.body || {};
  if (!company_id || !name || !mission_type) {
    return res.status(400).json({ error: "company_id, name et mission_type requis" });
  }
  const validTypes = ["prospecting", "follow_up", "rdv_validation", "announcement"];
  if (!validTypes.includes(mission_type)) {
    return res.status(400).json({ error: `mission_type invalide. Valeurs acceptées : ${validTypes.join(", ")}` });
  }
  const { data, error } = await supabase
    .from("outbound_campaigns")
    .insert({
      company_id,
      name: String(name).slice(0, 200),
      mission_type,
      script: String(script || "").slice(0, 5000),
      daily_call_limit: Math.min(Math.max(parseInt(daily_call_limit) || 10, 1), 50),
      created_by: created_by || null,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true, campaign: data });
});

router.get("/campaigns", async (req, res) => {
  const { company_id } = req.query;
  if (!company_id) return res.status(400).json({ error: "company_id requis" });
  const { data, error } = await supabase
    .from("outbound_campaigns")
    .select("*, outbound_contacts(count)")
    .eq("company_id", company_id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const campaigns = (data || []).map(c => ({
    ...c,
    total_contacts: c.outbound_contacts?.[0]?.count || 0,
    outbound_contacts: undefined,
  }));
  return res.json({ campaigns });
});

router.get("/campaigns/:id", async (req, res) => {
  const { id } = req.params;
  const { company_id } = req.query;
  if (!company_id) return res.status(400).json({ error: "company_id requis" });
  const { data: campaign, error } = await supabase
    .from("outbound_campaigns")
    .select("*")
    .eq("id", id)
    .eq("company_id", company_id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!campaign) return res.status(404).json({ error: "Campagne introuvable" });

  const { data: contacts } = await supabase
    .from("outbound_contacts")
    .select("id, full_name, phone, email, company_name, language, status, call_attempts, last_called_at, outcome, outcome_notes")
    .eq("campaign_id", id)
    .order("created_at", { ascending: true });

  return res.json({ campaign, contacts: contacts || [] });
});

router.patch("/campaigns/:id", express.json(), async (req, res) => {
  const { id } = req.params;
  const { company_id, name, script, daily_call_limit, status } = req.body || {};
  if (!company_id) return res.status(400).json({ error: "company_id requis" });
  const updates = {};
  if (name !== undefined)               updates.name = String(name).slice(0, 200);
  if (script !== undefined)             updates.script = String(script).slice(0, 5000);
  if (daily_call_limit !== undefined)   updates.daily_call_limit = Math.min(Math.max(parseInt(daily_call_limit) || 10, 1), 50);
  if (status !== undefined)             updates.status = status;
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase
    .from("outbound_campaigns")
    .update(updates)
    .eq("id", id)
    .eq("company_id", company_id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true, campaign: data });
});

router.delete("/campaigns/:id", async (req, res) => {
  const { id } = req.params;
  const { company_id } = req.query;
  if (!company_id) return res.status(400).json({ error: "company_id requis" });
  const { data: campaign } = await supabase
    .from("outbound_campaigns")
    .select("status")
    .eq("id", id)
    .eq("company_id", company_id)
    .maybeSingle();
  if (!campaign) return res.status(404).json({ error: "Campagne introuvable" });
  if (campaign.status === "active") {
    return res.status(409).json({ error: "Impossible de supprimer une campagne active. Mettez-la en pause d'abord." });
  }
  const { error } = await supabase
    .from("outbound_campaigns")
    .delete()
    .eq("id", id)
    .eq("company_id", company_id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// CONTACTS — Ajout manuel
// ─────────────────────────────────────────────────────────────

router.post("/campaigns/:id/contacts", express.json(), async (req, res) => {
  const { id: campaign_id } = req.params;
  const { company_id, full_name, phone, email, company_name, notes, language } = req.body || {};
  if (!company_id || !full_name || !phone) {
    return res.status(400).json({ error: "company_id, full_name et phone requis" });
  }
  const normalized = normalizePhone(phone);
  if (!normalized) return res.status(400).json({ error: "Numéro de téléphone invalide" });

  if (await isOnDNC(company_id, normalized)) {
    return res.status(409).json({ error: `Le numéro ${normalized} est dans la liste DNC` });
  }

  const { data, error } = await supabase
    .from("outbound_contacts")
    .insert({
      company_id, campaign_id,
      full_name: String(full_name).slice(0, 200),
      phone: normalized,
      email: email || null,
      company_name: company_name || null,
      notes: notes || null,
      language: language || "fr",
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true, contact: data });
});

// ─────────────────────────────────────────────────────────────
// CONTACTS — Import CSV / Excel
// ─────────────────────────────────────────────────────────────

router.post("/campaigns/:id/contacts/import", upload.single("file"), async (req, res) => {
  const { id: campaign_id } = req.params;
  const { company_id } = req.body;
  const file = req.file;
  if (!company_id || !file) return res.status(400).json({ error: "company_id et file requis" });

  // Vérifier que la campagne appartient bien à la company
  const { data: campaign } = await supabase
    .from("outbound_campaigns")
    .select("id, status")
    .eq("id", campaign_id)
    .eq("company_id", company_id)
    .maybeSingle();
  if (!campaign) return res.status(404).json({ error: "Campagne introuvable" });

  let rows = [];
  try {
    const mime = file.mimetype;
    const name = (file.originalname || "").toLowerCase();

    if (mime === "text/csv" || name.endsWith(".csv")) {
      // Parse CSV manuellement (pas de dépendance supplémentaire)
      const text = file.buffer.toString("utf-8");
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) return res.status(422).json({ error: "CSV vide ou sans données" });
      const headers = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/['"]/g, ""));
      for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(",").map(v => v.trim().replace(/['"]/g, ""));
        const row = {};
        headers.forEach((h, idx) => { row[h] = values[idx] || ""; });
        rows.push(row);
      }
    } else {
      // Excel (.xlsx, .xls)
      const wb = XLSX.read(file.buffer, { type: "buffer" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    }
  } catch (e) {
    return res.status(422).json({ error: `Erreur lecture fichier : ${e.message}` });
  }

  // Mapping flexible des colonnes
  const mapField = (row, ...keys) => {
    for (const k of keys) {
      const found = Object.keys(row).find(rk => rk.toLowerCase().includes(k.toLowerCase()));
      if (found && row[found]) return String(row[found]).trim();
    }
    return null;
  };

  let imported = 0, skipped = 0, dnc_skipped = 0;
  const errors = [];
  const toInsert = [];

  for (const row of rows) {
    const full_name = mapField(row, "nom", "name", "full_name", "prenom", "prénom");
    const phone_raw = mapField(row, "telephone", "téléphone", "phone", "tel", "mobile", "cellulaire");
    if (!full_name || !phone_raw) { skipped++; continue; }
    const phone = normalizePhone(phone_raw);
    if (!phone) { skipped++; errors.push(`Numéro invalide : ${phone_raw}`); continue; }

    // Check DNC
    const onDNC = await isOnDNC(company_id, phone);
    if (onDNC) { dnc_skipped++; continue; }

    toInsert.push({
      company_id, campaign_id,
      full_name: full_name.slice(0, 200),
      phone,
      email:        mapField(row, "email", "courriel") || null,
      company_name: mapField(row, "entreprise", "company", "société") || null,
      notes:        mapField(row, "notes", "note", "commentaire") || null,
      language:     mapField(row, "langue", "language") || "fr",
    });
    imported++;
  }

  if (toInsert.length > 0) {
    const { error } = await supabase.from("outbound_contacts").insert(toInsert);
    if (error) return res.status(500).json({ error: error.message });
  }

  return res.json({
    success: true,
    imported,
    skipped,
    dnc_skipped,
    total_rows: rows.length,
    errors: errors.slice(0, 10),
  });
});

// ─────────────────────────────────────────────────────────────
// CONTACTS — Liste + Suppression
// ─────────────────────────────────────────────────────────────

router.get("/campaigns/:id/contacts", async (req, res) => {
  const { id: campaign_id } = req.params;
  const { company_id, status } = req.query;
  if (!company_id) return res.status(400).json({ error: "company_id requis" });
  let q = supabase.from("outbound_contacts").select("*").eq("campaign_id", campaign_id).eq("company_id", company_id);
  if (status) q = q.eq("status", status);
  const { data, error } = await q.order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ contacts: data || [] });
});

router.delete("/campaigns/:id/contacts/:cid", async (req, res) => {
  const { cid } = req.params;
  const { company_id } = req.query;
  if (!company_id) return res.status(400).json({ error: "company_id requis" });
  const { error } = await supabase.from("outbound_contacts").delete()
    .eq("id", cid).eq("company_id", company_id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// LAUNCH / PAUSE / RESUME
// ─────────────────────────────────────────────────────────────

router.post("/campaigns/:id/launch", express.json(), async (req, res) => {
  const { id } = req.params;
  const { company_id } = req.body || {};
  if (!company_id) return res.status(400).json({ error: "company_id requis" });

  const { data: campaign } = await supabase
    .from("outbound_campaigns").select("*").eq("id", id).eq("company_id", company_id).maybeSingle();
  if (!campaign) return res.status(404).json({ error: "Campagne introuvable" });
  if (campaign.status === "active") return res.status(409).json({ error: "Campagne déjà active" });
  if (!campaign.script || campaign.script.trim().length < 20) {
    return res.status(400).json({ error: "Le script de la campagne est vide ou trop court (minimum 20 caractères)" });
  }
  if (!isWithinCallHours(campaign.call_hours_start, campaign.call_hours_end)) {
    return res.status(400).json({ error: `Les appels sont autorisés entre ${campaign.call_hours_start}h et ${campaign.call_hours_end}h (heure de l'Est)` });
  }

  const todayMade = await callsMadeToday(id);
  if (todayMade >= campaign.daily_call_limit) {
    return res.status(400).json({ error: `Limite quotidienne atteinte (${campaign.daily_call_limit} appels/jour)` });
  }

  // Passer la campagne en active
  await supabase.from("outbound_campaigns").update({ status: "active", updated_at: new Date().toISOString() }).eq("id", id);

  // Lancer les appels en arrière-plan (non bloquant)
  processOutboundCalls(campaign, company_id).catch(e =>
    console.error(`[OUTBOUND] processOutboundCalls error campaign=${id}:`, e.message)
  );

  return res.json({ success: true, message: "Campagne lancée. Les appels démarrent." });
});

router.post("/campaigns/:id/pause", express.json(), async (req, res) => {
  const { id } = req.params;
  const { company_id } = req.body || {};
  if (!company_id) return res.status(400).json({ error: "company_id requis" });
  await supabase.from("outbound_campaigns").update({ status: "paused", updated_at: new Date().toISOString() })
    .eq("id", id).eq("company_id", company_id);
  return res.json({ success: true });
});

router.post("/campaigns/:id/resume", express.json(), async (req, res) => {
  const { id } = req.params;
  const { company_id } = req.body || {};
  if (!company_id) return res.status(400).json({ error: "company_id requis" });
  const { data: campaign } = await supabase
    .from("outbound_campaigns").select("*").eq("id", id).eq("company_id", company_id).maybeSingle();
  if (!campaign) return res.status(404).json({ error: "Campagne introuvable" });
  if (!isWithinCallHours(campaign.call_hours_start, campaign.call_hours_end)) {
    return res.status(400).json({ error: "Hors des heures d'appel autorisées" });
  }
  await supabase.from("outbound_campaigns").update({ status: "active", updated_at: new Date().toISOString() })
    .eq("id", id).eq("company_id", company_id);
  processOutboundCalls(campaign, company_id).catch(e =>
    console.error(`[OUTBOUND] resume error:`, e.message)
  );
  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// MOTEUR D'APPELS — processOutboundCalls
// Lance les appels un par un jusqu'à la limite quotidienne
// ─────────────────────────────────────────────────────────────

async function processOutboundCalls(campaign, company_id) {
  const DELAY_BETWEEN_CALLS_MS = 30_000; // 30 secondes entre chaque appel

  while (true) {
    // Re-vérifier le status de la campagne (peut avoir été mise en pause)
    const { data: fresh } = await supabase
      .from("outbound_campaigns").select("status, daily_call_limit, call_hours_start, call_hours_end")
      .eq("id", campaign.id).maybeSingle();
    if (!fresh || fresh.status !== "active") break;
    if (!isWithinCallHours(fresh.call_hours_start, fresh.call_hours_end)) break;

    // Vérifier limite quotidienne
    const todayMade = await callsMadeToday(campaign.id);
    if (todayMade >= fresh.daily_call_limit) {
      await supabase.from("outbound_campaigns").update({ status: "paused", updated_at: new Date().toISOString() })
        .eq("id", campaign.id);
      console.log(`[OUTBOUND] Limite quotidienne atteinte pour campagne ${campaign.id}`);
      break;
    }

    // Prendre le prochain contact pending
    const { data: contact } = await supabase
      .from("outbound_contacts")
      .select("*")
      .eq("campaign_id", campaign.id)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!contact) {
      // Plus de contacts à appeler
      await supabase.from("outbound_campaigns").update({ status: "completed", updated_at: new Date().toISOString() })
        .eq("id", campaign.id);
      console.log(`[OUTBOUND] Campagne ${campaign.id} terminée — tous les contacts traités`);
      break;
    }

    // Marquer le contact comme "calling"
    await supabase.from("outbound_contacts").update({ status: "calling", last_called_at: new Date().toISOString() })
      .eq("id", contact.id);

    // Initier l'appel Twilio
    try {
      const backendUrl = process.env.PUBLIC_BACKEND_URL || `http://localhost:${process.env.PORT || 8001}`;
      await twilioClient.calls.create({
        to:   contact.phone,
        from: process.env.TWILIO_PHONE_NUMBER,
        url:  `${backendUrl}/api/v1/outbound/webhooks/twiml?contact_id=${contact.id}&campaign_id=${campaign.id}&company_id=${company_id}`,
        statusCallback: `${backendUrl}/api/v1/outbound/webhooks/call-status`,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["completed", "no-answer", "busy", "failed"],
        machineDetection: "Enable",
        timeout: 30,
      });
      await supabase.from("outbound_contacts").update({ call_attempts: contact.call_attempts + 1 }).eq("id", contact.id);
      await supabase.from("outbound_campaigns").update({ calls_made: campaign.calls_made + 1 + todayMade, updated_at: new Date().toISOString() }).eq("id", campaign.id);
      console.log(`[OUTBOUND] Appel initié → ${contact.phone} (${contact.full_name})`);
    } catch (e) {
      console.error(`[OUTBOUND] Twilio error → ${contact.phone}:`, e.message);
      await supabase.from("outbound_contacts").update({
        status: "error",
        outcome_notes: e.message,
        call_attempts: contact.call_attempts + 1,
      }).eq("id", contact.id);
    }

    // Attendre avant le prochain appel
    await new Promise(r => setTimeout(r, DELAY_BETWEEN_CALLS_MS));
  }
}

// ─────────────────────────────────────────────────────────────
// WEBHOOK TWILIO — TwiML pour appel sortant
// Retourne le ConversationRelay avec le script de la campagne
// ─────────────────────────────────────────────────────────────

router.post("/webhooks/twiml", express.urlencoded({ extended: false }), async (req, res) => {
  const { contact_id, campaign_id, company_id } = req.query;
  const { AnsweredBy } = req.body || {};

  // Si répondeur → raccrocher immédiatement
  if (AnsweredBy && AnsweredBy !== "human") {
    res.type("text/xml");
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`);
  }

  // Récupérer la campagne + contact pour le script
  const [{ data: campaign }, { data: contact }] = await Promise.all([
    supabase.from("outbound_campaigns").select("script, mission_type, name").eq("id", campaign_id).maybeSingle(),
    supabase.from("outbound_contacts").select("full_name, language").eq("id", contact_id).maybeSingle(),
  ]);

  const script = campaign?.script || "";
  const contactName = contact?.full_name || "vous";
  const lang = contact?.language === "en" ? "en-CA" : "fr-CA";
  const greeting = lang === "fr-CA"
    ? `Bonjour ${contactName}, je suis Léa, une assistante IA qui appelle au nom d'Exevori.`
    : `Hello ${contactName}, I'm Léa, an AI assistant calling on behalf of Exevori.`;

  const backendUrl = process.env.PUBLIC_BACKEND_URL || `http://localhost:${process.env.PORT || 8001}`;

  res.type("text/xml");
  return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="wss://${backendUrl.replace(/^https?:\/\//, "")}/api/voice/relay/ws"
      welcomeGreeting="${greeting}"
      welcomeGreetingInterruptible="true"
      language="${lang}"
      ttsLanguage="${lang}"
      ttsProvider="ElevenLabs"
      voice="WW0JfNPk5DgcQdM0d6X6-flash_v2_5-1.10_0.50_0.75"
      transcriptionProvider="Deepgram"
      speechModel="nova-2-general"
    >
      <Parameter name="outbound" value="true"/>
      <Parameter name="contact_id" value="${contact_id}"/>
      <Parameter name="campaign_id" value="${campaign_id}"/>
      <Parameter name="company_id" value="${company_id}"/>
      <Parameter name="contact_name" value="${contactName}"/>
      <Parameter name="outbound_script" value="${script.replace(/"/g, "&quot;").slice(0, 2000)}"/>
    </ConversationRelay>
  </Connect>
</Response>`);
});

// ─────────────────────────────────────────────────────────────
// WEBHOOK TWILIO — Status callback (fin d'appel)
// ─────────────────────────────────────────────────────────────

router.post("/webhooks/call-status", express.urlencoded({ extended: false }), async (req, res) => {
  const { CallStatus, CallDuration, To } = req.body || {};

  // Retrouver le contact par numéro
  if (To && CallStatus) {
    const normalized = normalizePhone(To);
    const statusMap = {
      "completed": "called",
      "no-answer": "no_answer",
      "busy":      "no_answer",
      "failed":    "error",
      "canceled":  "error",
    };
    const newStatus = statusMap[CallStatus] || "called";
    if (normalized) {
      await supabase.from("outbound_contacts")
        .update({ status: newStatus })
        .eq("phone", normalized)
        .eq("status", "calling");
    }
  }

  res.status(200).send("OK");
});

// ─────────────────────────────────────────────────────────────
// DNC LIST — CRUD
// ─────────────────────────────────────────────────────────────

router.get("/dnc", async (req, res) => {
  const { company_id } = req.query;
  if (!company_id) return res.status(400).json({ error: "company_id requis" });
  const { data, error } = await supabase.from("dnc_list").select("*")
    .eq("company_id", company_id).order("added_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ dnc: data || [] });
});

router.post("/dnc", express.json(), async (req, res) => {
  const { company_id, phone, reason } = req.body || {};
  if (!company_id || !phone) return res.status(400).json({ error: "company_id et phone requis" });
  const normalized = normalizePhone(phone);
  if (!normalized) return res.status(400).json({ error: "Numéro invalide" });
  const { data, error } = await supabase.from("dnc_list")
    .upsert({ company_id, phone: normalized, reason: reason || null }, { onConflict: "company_id,phone" })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true, entry: data });
});

router.delete("/dnc/:id", async (req, res) => {
  const { id } = req.params;
  const { company_id } = req.query;
  if (!company_id) return res.status(400).json({ error: "company_id requis" });
  const { error } = await supabase.from("dnc_list").delete().eq("id", id).eq("company_id", company_id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

export default router;
