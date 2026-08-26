// ============================================================
// EXEVORI VOICE IA — MODULE OUTBOUND V1
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
//   GET    /api/v1/outbound/settings
//   PATCH  /api/v1/outbound/settings
//
//   POST   /api/v1/outbound/manual-review/:queueId/resolve (super_admin)
//
// Les callbacks fournisseur passent exclusivement par le webhook ElevenLabs
// signé /api/voice/call-complete.
// ============================================================

import express from "express";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import ExcelJS from "exceljs";
import { parse as parseCsv } from "csv-parse/sync";
import { canonicalizeBusinessHours } from "../voice/businessHours.js";
import { mapImportField } from "./importMapping.js";
import { enqueueOutboundCampaign } from "./queue.js";
import { getOutboundWorkerStatus } from "./worker.js";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function isSuperAdmin(req) {
  return req.user?.role === "super_admin";
}

function requireOutboundManager(req, res, next) {
  if (!["super_admin", "company_admin"].includes(req.user?.role)) {
    return res.status(403).json({ error: "forbidden" });
  }
  return next();
}

function requireSuperAdmin(req, res, next) {
  if (!isSuperAdmin(req)) {
    return res.status(403).json({ error: "forbidden" });
  }
  return next();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(value || ""));
}

function hasTenantMismatch(req, requestedCompanyId) {
  return !isSuperAdmin(req)
    && requestedCompanyId
    && requestedCompanyId !== req.user?.company_id;
}

function getTargetCompanyId(req, requestedCompanyId) {
  return isSuperAdmin(req)
    ? requestedCompanyId || null
    : req.user?.company_id || null;
}

function campaignAcceptsContacts(campaign) {
  return ["draft", "paused"].includes(campaign?.status);
}

function requireReadyOutboundWorker(res) {
  const worker = getOutboundWorkerStatus();
  if (!worker.ready) {
    res.status(503).json({
      error: "outbound_worker_unavailable",
      message: "Le moteur d'appels sortants n'est pas prêt. Réessayez dans un instant.",
    });
    return false;
  }
  return true;
}

async function findTenantResource(table, id, req, columns = "*") {
  const requestedCompanyId = req.query?.company_id || req.body?.company_id || null;
  if (isSuperAdmin(req) && !requestedCompanyId) {
    return { status: 400, message: "company_id requis pour un super_admin" };
  }
  if (!isSuperAdmin(req) && requestedCompanyId
      && requestedCompanyId !== req.user?.company_id) {
    return { status: 403, message: "Accès interdit à cette entreprise" };
  }
  const tenantCompanyId = isSuperAdmin(req)
    ? requestedCompanyId
    : req.user?.company_id;
  if (!tenantCompanyId) {
    return { status: 403, message: "Contexte entreprise introuvable" };
  }
  const { data, error } = await supabase
    .from(table)
    .select(columns)
    .eq("id", id)
    .eq("company_id", tenantCompanyId)
    .maybeSingle();

  if (error) return { status: 500, message: error.message };
  if (!data) return { status: 404, message: "Ressource introuvable" };
  if (!isSuperAdmin(req) && data.company_id !== req.user?.company_id) {
    return { status: 403, message: "Accès interdit à cette entreprise" };
  }
  if (isSuperAdmin(req) && !requestedCompanyId) {
    return { status: 400, message: "company_id requis pour un super_admin" };
  }
  if (isSuperAdmin(req) && requestedCompanyId && data.company_id !== requestedCompanyId) {
    return { status: 403, message: "AccÃ¨s interdit hors du contexte entreprise actif" };
  }
  return { status: 200, data };
}

// Normalise un numéro de téléphone en E.164 (Canada/USA)
function normalizePhone(raw) {
  if (!raw) return null;
  let normalized = String(raw).trim().replace(/[()\s.-]/g, "");
  if (normalized.startsWith("00")) {
    normalized = `+${normalized.slice(2)}`;
  } else if (!normalized.startsWith("+")) {
    const digits = normalized.replace(/\D/g, "");
    if (digits.length === 10) normalized = `+1${digits}`;
    else if (digits.length === 11 && digits.startsWith("1")) normalized = `+${digits}`;
    else return null;
  }
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}

// Vérifie la DNC sans jamais transformer une panne de stockage en autorisation.
async function checkDNC(company_id, phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return { blocked: true, error: "invalid_phone" };
  const { data, error } = await supabase
    .from("dnc_list")
    .select("id")
    .eq("company_id", company_id)
    .eq("phone", normalized)
    .maybeSingle();
  if (error) return { blocked: true, error: error.message };
  return { blocked: Boolean(data), error: null };
}

function normalizeTimeZone(value) {
  const timeZone = String(value || "").trim();
  if (!timeZone || timeZone.length > 128) return null;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return null;
  }
}

function normalizeAfterHoursMessage(value) {
  const message = String(value || "").trim();
  return message.length >= 1 && message.length <= 1000 ? message : null;
}

function hasOpenWindow(schedule) {
  return Object.values(schedule || {}).some(
    windows => Array.isArray(windows) && windows.length > 0
  );
}

async function loadOutboundPhoneNumber(companyId, phoneNumberId) {
  if (!phoneNumberId) return { data: null, error: null };
  const { data, error } = await supabase
    .from("phone_numbers")
    .select("id, company_id, status, elevenlabs_agent_id, elevenlabs_phone_number_id")
    .eq("id", phoneNumberId)
    .eq("company_id", companyId)
    .eq("status", "active")
    .maybeSingle();
  if (error) return { data: null, error: "outbound_phone_lookup_failed" };
  if (
    !data?.elevenlabs_agent_id
    || !data?.elevenlabs_phone_number_id
  ) {
    return { data: null, error: "outbound_phone_not_provisioned" };
  }
  return { data, error: null };
}

// ─────────────────────────────────────────────────────────────
// HORAIRES VOCAUX — configuration tenant
// ─────────────────────────────────────────────────────────────

router.get("/settings", async (req, res) => {
  const requestedCompanyId = req.query?.company_id;
  if (hasTenantMismatch(req, requestedCompanyId)) {
    return res.status(403).json({ error: "Accès interdit à cette entreprise" });
  }
  const companyId = getTargetCompanyId(req, requestedCompanyId);
  if (!companyId) return res.status(400).json({ error: "company_id requis" });

  const [settingsResult, phonesResult] = await Promise.all([
    supabase
      .from("voice_call_settings")
      .select([
        "company_id",
        "timezone",
        "business_hours",
        "outbound_business_hours",
        "after_hours_message_fr",
        "after_hours_message_en",
        "updated_at",
      ].join(","))
      .eq("company_id", companyId)
      .maybeSingle(),
    supabase
      .from("phone_numbers")
      .select("id, phone_number, status, elevenlabs_agent_id, elevenlabs_phone_number_id")
      .eq("company_id", companyId)
      .eq("status", "active")
      .order("created_at", { ascending: true }),
  ]);
  if (settingsResult.error || phonesResult.error) {
    return res.status(503).json({ error: "voice_settings_unavailable" });
  }
  if (!settingsResult.data) {
    return res.status(404).json({ error: "voice_settings_not_configured" });
  }
  const outboundPhoneNumbers = (phonesResult.data || []).map(phone => ({
    id: phone.id,
    phone_number: phone.phone_number,
    ready: Boolean(
      phone.elevenlabs_agent_id && phone.elevenlabs_phone_number_id
    ),
  }));
  return res.json({
    settings: settingsResult.data,
    outbound_phone_numbers: outboundPhoneNumbers,
  });
});

router.patch("/settings", requireOutboundManager, express.json(), async (req, res) => {
  const requestedCompanyId = req.body?.company_id;
  if (hasTenantMismatch(req, requestedCompanyId)) {
    return res.status(403).json({ error: "Accès interdit à cette entreprise" });
  }
  const companyId = getTargetCompanyId(req, requestedCompanyId);
  if (!companyId) return res.status(400).json({ error: "company_id requis" });

  const updates = { company_id: companyId, updated_at: new Date().toISOString() };
  try {
    if (req.body?.timezone !== undefined) {
      const timeZone = normalizeTimeZone(req.body.timezone);
      if (!timeZone) return res.status(400).json({ error: "invalid_business_timezone" });
      updates.timezone = timeZone;
    }
    if (req.body?.business_hours !== undefined) {
      updates.business_hours = canonicalizeBusinessHours(req.body.business_hours);
    }
    if (req.body?.outbound_business_hours !== undefined) {
      const schedule = canonicalizeBusinessHours(req.body.outbound_business_hours);
      if (!schedule || !hasOpenWindow(schedule)) {
        return res.status(400).json({ error: "outbound_business_hours_never_open" });
      }
      updates.outbound_business_hours = schedule;
    }
    for (const field of ["after_hours_message_fr", "after_hours_message_en"]) {
      if (req.body?.[field] === undefined) continue;
      const message = normalizeAfterHoursMessage(req.body[field]);
      if (!message) return res.status(400).json({ error: `invalid_${field}` });
      updates[field] = message;
    }
  } catch (error) {
    return res.status(400).json({ error: error?.code || "invalid_business_hours" });
  }

  if (Object.keys(updates).length === 2) {
    return res.status(400).json({ error: "Aucune modification fournie" });
  }
  const { data, error } = await supabase
    .from("voice_call_settings")
    .upsert(updates, { onConflict: "company_id" })
    .select()
    .single();
  if (error) return res.status(503).json({ error: "voice_settings_unavailable" });
  return res.json({ success: true, settings: data });
});

// ─────────────────────────────────────────────────────────────
// CAMPAIGNS — CRUD
// ─────────────────────────────────────────────────────────────

router.post("/campaigns", requireOutboundManager, express.json(), async (req, res) => {
  const {
    company_id,
    name,
    mission_type,
    script,
    daily_call_limit,
    created_by,
    outbound_phone_number_id,
  } = req.body || {};
  if (hasTenantMismatch(req, company_id)) {
    return res.status(403).json({ error: "Accès interdit à cette entreprise" });
  }
  const companyId = getTargetCompanyId(req, company_id);
  if (!companyId || !name || !mission_type) {
    return res.status(400).json({ error: "company_id, name et mission_type requis" });
  }
  const validTypes = ["prospecting", "follow_up", "rdv_validation", "announcement"];
  if (!validTypes.includes(mission_type)) {
    return res.status(400).json({ error: `mission_type invalide. Valeurs acceptées : ${validTypes.join(", ")}` });
  }
  const phoneLookup = await loadOutboundPhoneNumber(
    companyId,
    outbound_phone_number_id
  );
  if (phoneLookup.error) {
    return res.status(400).json({ error: phoneLookup.error });
  }
  const { data, error } = await supabase
    .from("outbound_campaigns")
    .insert({
      company_id: companyId,
      name: String(name).slice(0, 200),
      mission_type,
      script: String(script || "").slice(0, 5000),
      daily_call_limit: Math.min(Math.max(parseInt(daily_call_limit) || 10, 1), 50),
      outbound_phone_number_id: phoneLookup.data?.id || null,
      created_by: isSuperAdmin(req) ? created_by || null : req.user?.profile?.id || null,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true, campaign: data });
});

router.get("/campaigns", async (req, res) => {
  const { company_id } = req.query;
  if (hasTenantMismatch(req, company_id)) {
    return res.status(403).json({ error: "Accès interdit à cette entreprise" });
  }
  const companyId = getTargetCompanyId(req, company_id);
  if (!companyId) return res.status(400).json({ error: "company_id requis" });
  let query = supabase
    .from("outbound_campaigns")
    .select("*, outbound_contacts(count)");
  if (companyId) query = query.eq("company_id", companyId);
  const { data, error } = await query.order("created_at", { ascending: false });
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
  if (hasTenantMismatch(req, company_id)) {
    return res.status(403).json({ error: "Accès interdit à cette entreprise" });
  }
  const lookup = await findTenantResource("outbound_campaigns", id, req);
  if (!lookup.data) return res.status(lookup.status).json({ error: lookup.message });
  const campaign = lookup.data;

  const { data: contacts } = await supabase
    .from("outbound_contacts")
    .select("id, full_name, phone, email, company_name, language, status, call_attempts, last_called_at, outcome, outcome_notes")
    .eq("campaign_id", id)
    .eq("company_id", campaign.company_id)
    .order("created_at", { ascending: true });

  return res.json({ campaign, contacts: contacts || [] });
});

router.patch("/campaigns/:id", requireOutboundManager, express.json(), async (req, res) => {
  const { id } = req.params;
  const {
    company_id,
    name,
    script,
    daily_call_limit,
    status,
    outbound_phone_number_id,
  } = req.body || {};
  if (hasTenantMismatch(req, company_id)) {
    return res.status(403).json({ error: "Accès interdit à cette entreprise" });
  }
  const lookup = await findTenantResource(
    "outbound_campaigns",
    id,
    req,
    "id, company_id, status"
  );
  if (!lookup.data) return res.status(lookup.status).json({ error: lookup.message });
  const updates = {};
  const editsConfiguration = [
    name,
    script,
    daily_call_limit,
    outbound_phone_number_id,
  ].some(value => value !== undefined);
  if (editsConfiguration && lookup.data.status !== "draft") {
    return res.status(409).json({
      error: "campaign_configuration_locked",
      message: "La configuration ne peut être modifiée qu'avant le premier lancement.",
    });
  }
  if (name !== undefined)               updates.name = String(name).slice(0, 200);
  if (script !== undefined)             updates.script = String(script).slice(0, 5000);
  if (daily_call_limit !== undefined)   updates.daily_call_limit = Math.min(Math.max(parseInt(daily_call_limit) || 10, 1), 50);
  if (outbound_phone_number_id !== undefined) {
    const phoneLookup = await loadOutboundPhoneNumber(
      lookup.data.company_id,
      outbound_phone_number_id
    );
    if (phoneLookup.error) {
      return res.status(400).json({ error: phoneLookup.error });
    }
    updates.outbound_phone_number_id = phoneLookup.data?.id || null;
  }
  if (status !== undefined) {
    const sameStatus = status === lookup.data.status;
    const canCancel = status === "cancelled"
      && campaignAcceptsContacts(lookup.data);
    if (!sameStatus && !canCancel) {
      return res.status(400).json({
        error: "Utilisez les routes launch, pause ou resume pour changer cet état",
      });
    }
    updates.status = status;
  }
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase
    .from("outbound_campaigns")
    .update(updates)
    .eq("id", id)
    .eq("company_id", lookup.data.company_id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Campagne introuvable" });
  return res.json({ success: true, campaign: data });
});

router.delete("/campaigns/:id", requireOutboundManager, async (req, res) => {
  const { id } = req.params;
  const { company_id } = req.query;
  if (hasTenantMismatch(req, company_id)) {
    return res.status(403).json({ error: "Accès interdit à cette entreprise" });
  }
  const lookup = await findTenantResource("outbound_campaigns", id, req, "id, company_id, status");
  if (!lookup.data) return res.status(lookup.status).json({ error: lookup.message });
  const campaign = lookup.data;
  if (campaign.status === "active") {
    return res.status(409).json({ error: "Impossible de supprimer une campagne active. Mettez-la en pause d'abord." });
  }
  const { data: activeQueue, error: queueError } = await supabase
    .from("outbound_call_queue")
    .select("id")
    .eq("company_id", campaign.company_id)
    .eq("campaign_id", campaign.id)
    .in("status", [
      "claimed",
      "dispatching",
      "in_progress",
      "dispatch_unknown",
      "manual_review",
    ])
    .limit(1)
    .maybeSingle();
  if (queueError) {
    return res.status(503).json({ error: "outbound_queue_unavailable" });
  }
  if (activeQueue) {
    return res.status(409).json({
      error: "Un appel de cette campagne est encore en cours ou à réconcilier",
    });
  }
  const { data: deleted, error } = await supabase
    .from("outbound_campaigns")
    .delete()
    .eq("id", id)
    .eq("company_id", campaign.company_id)
    .select("id")
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!deleted) return res.status(404).json({ error: "Campagne introuvable" });
  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// CONTACTS — Ajout manuel
// ─────────────────────────────────────────────────────────────

router.post("/campaigns/:id/contacts", requireOutboundManager, express.json(), async (req, res) => {
  const { id: campaign_id } = req.params;
  const { company_id, full_name, phone, email, company_name, notes, language } = req.body || {};
  if (hasTenantMismatch(req, company_id)) {
    return res.status(403).json({ error: "Accès interdit à cette entreprise" });
  }
  if (!full_name || !phone) {
    return res.status(400).json({ error: "full_name et phone requis" });
  }
  const campaignLookup = await findTenantResource(
    "outbound_campaigns",
    campaign_id,
    req,
    "id, company_id, status"
  );
  if (!campaignLookup.data) {
    return res.status(campaignLookup.status).json({ error: campaignLookup.message });
  }
  if (!campaignAcceptsContacts(campaignLookup.data)) {
    return res.status(409).json({
      error: "Les contacts ne peuvent être modifiés que dans une campagne en brouillon ou en pause",
    });
  }
  const companyId = campaignLookup.data.company_id;
  const normalized = normalizePhone(phone);
  if (!normalized) return res.status(400).json({ error: "Numéro de téléphone invalide" });

  const dncCheck = await checkDNC(companyId, normalized);
  if (dncCheck.error) {
    return res.status(503).json({ error: "Vérification DNC indisponible" });
  }
  if (dncCheck.blocked) {
    return res.status(409).json({ error: `Le numéro ${normalized} est dans la liste DNC` });
  }

  const { data, error } = await supabase
    .from("outbound_contacts")
    .insert({
      company_id: companyId,
      campaign_id,
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

router.post("/campaigns/:id/contacts/import", requireOutboundManager, upload.single("file"), async (req, res) => {
  const { id: campaign_id } = req.params;
  const { company_id } = req.body || {};
  const file = req.file;
  if (hasTenantMismatch(req, company_id)) {
    return res.status(403).json({ error: "Accès interdit à cette entreprise" });
  }
  if (!file) return res.status(400).json({ error: "file requis" });

  // Vérifier que la campagne appartient bien à la company
  const campaignLookup = await findTenantResource(
    "outbound_campaigns",
    campaign_id,
    req,
    "id, company_id, status"
  );
  if (!campaignLookup.data) {
    return res.status(campaignLookup.status).json({ error: campaignLookup.message });
  }
  if (!campaignAcceptsContacts(campaignLookup.data)) {
    return res.status(409).json({
      error: "Les contacts ne peuvent être importés que dans une campagne en brouillon ou en pause",
    });
  }
  const companyId = campaignLookup.data.company_id;

  let rows = [];
  try {
    const mime = file.mimetype;
    const name = (file.originalname || "").toLowerCase();

    if (mime === "text/csv" || name.endsWith(".csv")) {
      const text = file.buffer.toString("utf-8");
      rows = parseCsv(text, {
        bom: true,
        columns: headers => headers.map(header => (
          String(header || "").trim().toLowerCase()
        )),
        skip_empty_lines: true,
        trim: true,
        relax_column_count: false,
      });
      if (rows.length === 0) {
        return res.status(422).json({ error: "CSV vide ou sans données" });
      }
    } else if (name.endsWith(".xlsx")) {
      // Excel (.xlsx) — exceljs ne supporte PAS l'ancien format binaire .xls
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(file.buffer);
      const ws = wb.worksheets[0];
      if (!ws) return res.status(422).json({ error: "Fichier Excel vide" });

      // Normalise une cellule exceljs en string (équivalent au comportement xlsx)
      const cellToString = (v) => {
        if (v === null || v === undefined) return "";
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
        if (v instanceof Date) return v.toISOString();
        // Hyperlink { text, hyperlink }
        if (typeof v === "object" && "text" in v) return String(v.text ?? "");
        // Rich text { richText: [{ text }, ...] }
        if (typeof v === "object" && Array.isArray(v.richText)) {
          return v.richText.map(r => r.text || "").join("");
        }
        // Formula { formula, result }
        if (typeof v === "object" && "result" in v) return cellToString(v.result);
        // Erreur { error }
        if (typeof v === "object" && "error" in v) return "";
        return String(v);
      };

      // 1re ligne = en-têtes
      const headerRow = ws.getRow(1);
      const headers = [];
      headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        headers[colNumber - 1] = cellToString(cell.value).trim();
      });

      // Lignes suivantes = données ; defval="" pour les cellules vides
      const lastRow = ws.actualRowCount || ws.rowCount;
      for (let r = 2; r <= lastRow; r++) {
        const dataRow = ws.getRow(r);
        // Skip lignes entièrement vides
        const allEmpty = dataRow.values
          .slice(1)
          .every(v => v === null || v === undefined || cellToString(v).trim() === "");
        if (allEmpty) continue;

        const row = {};
        for (let c = 0; c < headers.length; c++) {
          const key = headers[c];
          if (!key) continue;
          const cell = dataRow.getCell(c + 1);
          row[key] = cellToString(cell.value);
        }
        rows.push(row);
      }
    } else {
      return res.status(415).json({ error: "Format accepté : CSV ou Excel .xlsx" });
    }
  } catch (e) {
    return res.status(422).json({ error: `Erreur lecture fichier : ${e.message}` });
  }

  let imported = 0, skipped = 0, dnc_skipped = 0;
  const errors = [];
  const toInsert = [];

  for (const row of rows) {
    const full_name = mapImportField(
      row,
      "full_name",
      "full name",
      "nom complet",
      "contact name",
      "nom",
      "name",
      "prenom",
      "prénom"
    );
    const phone_raw = mapImportField(
      row,
      "phone",
      "phone number",
      "telephone",
      "téléphone",
      "numero de telephone",
      "tel",
      "mobile",
      "cellulaire"
    );
    if (!full_name || !phone_raw) { skipped++; continue; }
    const phone = normalizePhone(phone_raw);
    if (!phone) { skipped++; errors.push(`Numéro invalide : ${phone_raw}`); continue; }

    // Check DNC
    const dncCheck = await checkDNC(companyId, phone);
    if (dncCheck.error) {
      return res.status(503).json({ error: "Vérification DNC indisponible" });
    }
    if (dncCheck.blocked) { dnc_skipped++; continue; }

    toInsert.push({
      company_id: companyId,
      campaign_id,
      full_name: full_name.slice(0, 200),
      phone,
      email:        mapImportField(row, "email", "courriel") || null,
      company_name: mapImportField(
        row,
        "company_name",
        "company name",
        "nom entreprise",
        "entreprise",
        "company",
        "société"
      ) || null,
      notes:        mapImportField(row, "notes", "note", "commentaire") || null,
      language:     mapImportField(row, "langue", "language") || "fr",
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
  if (hasTenantMismatch(req, company_id)) {
    return res.status(403).json({ error: "Accès interdit à cette entreprise" });
  }
  const campaignLookup = await findTenantResource(
    "outbound_campaigns",
    campaign_id,
    req,
    "id, company_id, status"
  );
  if (!campaignLookup.data) {
    return res.status(campaignLookup.status).json({ error: campaignLookup.message });
  }
  let q = supabase
    .from("outbound_contacts")
    .select("*")
    .eq("campaign_id", campaign_id)
    .eq("company_id", campaignLookup.data.company_id);
  if (status) q = q.eq("status", status);
  const { data, error } = await q.order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ contacts: data || [] });
});

router.delete("/campaigns/:id/contacts/:cid", requireOutboundManager, async (req, res) => {
  const { id: campaignId, cid } = req.params;
  const { company_id } = req.query;
  if (hasTenantMismatch(req, company_id)) {
    return res.status(403).json({ error: "Accès interdit à cette entreprise" });
  }
  const campaignLookup = await findTenantResource(
    "outbound_campaigns",
    campaignId,
    req,
    "id, company_id, status"
  );
  if (!campaignLookup.data) {
    return res.status(campaignLookup.status).json({ error: campaignLookup.message });
  }
  if (!campaignAcceptsContacts(campaignLookup.data)) {
    return res.status(409).json({
      error: "Les contacts ne peuvent être retirés que d’une campagne en brouillon ou en pause",
    });
  }
  const contactLookup = await findTenantResource(
    "outbound_contacts",
    cid,
    req,
    "id, company_id, campaign_id"
  );
  if (!contactLookup.data) {
    return res.status(contactLookup.status).json({ error: contactLookup.message });
  }
  if (contactLookup.data.campaign_id !== campaignId) {
    return res.status(404).json({ error: "Contact introuvable dans cette campagne" });
  }
  const { data: nonTerminalQueue, error: queueError } = await supabase
    .from("outbound_call_queue")
    .select("id")
    .eq("company_id", campaignLookup.data.company_id)
    .eq("campaign_id", campaignId)
    .eq("outbound_contact_id", cid)
    .in("status", [
      "pending",
      "claimed",
      "dispatching",
      "in_progress",
      "retry_scheduled",
      "dispatch_unknown",
      "manual_review",
    ])
    .limit(1)
    .maybeSingle();
  if (queueError) {
    return res.status(503).json({ error: "outbound_queue_unavailable" });
  }
  if (nonTerminalQueue) {
    return res.status(409).json({
      error: "outbound_contact_has_active_queue",
      message: "Ce contact est encore en file, en appel ou en réconciliation.",
    });
  }
  const { data, error } = await supabase.from("outbound_contacts").delete()
    .eq("id", cid)
    .eq("campaign_id", campaignId)
    .eq("company_id", campaignLookup.data.company_id)
    .select("id")
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Contact introuvable" });
  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// LAUNCH / PAUSE / RESUME
// ─────────────────────────────────────────────────────────────

router.post("/campaigns/:id/launch", requireOutboundManager, express.json(), async (req, res) => {
  const requestedCompanyId = req.body?.company_id;
  if (hasTenantMismatch(req, requestedCompanyId)) {
    return res.status(403).json({ error: "Accès interdit à cette entreprise" });
  }
  const companyId = getTargetCompanyId(req, requestedCompanyId);
  if (!companyId) {
    return res.status(400).json({ error: "company_id requis" });
  }

  const campaignLookup = await findTenantResource(
    "outbound_campaigns",
    req.params.id,
    req
  );
  if (!campaignLookup.data) {
    return res.status(campaignLookup.status).json({ error: campaignLookup.message });
  }
  if (campaignLookup.data.company_id !== companyId) {
    return res.status(403).json({ error: "Accès interdit à cette entreprise" });
  }
  if (campaignLookup.data.status === "active") {
    return res.status(409).json({ error: "Campagne déjà active" });
  }
  if (campaignLookup.data.status !== "draft") {
    return res.status(409).json({
      error: "Seule une campagne en brouillon peut être lancée",
    });
  }
  if (!requireReadyOutboundWorker(res)) return;
  if (
    typeof campaignLookup.data.script !== "string"
    || campaignLookup.data.script.trim().length < 20
  ) {
    return res.status(400).json({
      error: "Le script de la campagne doit contenir au moins 20 caractères",
    });
  }

  const scheduledFor = req.body?.scheduled_for
    ? new Date(req.body.scheduled_for)
    : new Date();
  if (Number.isNaN(scheduledFor.getTime())) {
    return res.status(400).json({ error: "scheduled_for invalide" });
  }

  try {
    const queued = await enqueueOutboundCampaign({
      supabase,
      campaignId: campaignLookup.data.id,
      companyId,
      scheduledFor,
      maxAttempts: req.body?.max_attempts,
    });
    if (!queued.hasActiveWork) {
      return res.status(409).json({
        error: "Aucun contact admissible à l’appel",
        blocked: queued.counts.blocked || 0,
      });
    }
    return res.status(202).json({
      success: true,
      queued: queued.counts.pending || 0,
      active: queued.activeTotal,
      blocked: queued.counts.blocked || 0,
      total: queued.total,
      message: "Campagne placée dans la file d'appels durable.",
    });
  } catch (error) {
    console.error("[OUTBOUND] durable campaign enqueue failed");
    return res.status(503).json({
      error: "outbound_queue_unavailable",
      message: "La file d'appels est temporairement indisponible.",
    });
  }

});

router.post("/campaigns/:id/pause", requireOutboundManager, express.json(), async (req, res) => {
  const { id } = req.params;
  const { company_id } = req.body || {};
  if (hasTenantMismatch(req, company_id)) {
    return res.status(403).json({ error: "Accès interdit à cette entreprise" });
  }
  const lookup = await findTenantResource(
    "outbound_campaigns",
    id,
    req,
    "id, company_id, status"
  );
  if (!lookup.data) return res.status(lookup.status).json({ error: lookup.message });
  if (lookup.data.status !== "active") {
    return res.status(409).json({ error: "Seule une campagne active peut être mise en pause" });
  }
  const { data, error } = await supabase
    .from("outbound_campaigns")
    .update({ status: "paused", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("company_id", lookup.data.company_id)
    .select("id")
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Campagne introuvable" });
  return res.json({ success: true });
});

router.post("/campaigns/:id/resume", requireOutboundManager, express.json(), async (req, res) => {
  const resumeRequestedCompanyId = req.body?.company_id;
  if (hasTenantMismatch(req, resumeRequestedCompanyId)) {
    return res.status(403).json({ error: "Accès interdit à cette entreprise" });
  }
  const resumeCompanyId = getTargetCompanyId(req, resumeRequestedCompanyId);
  if (!resumeCompanyId) {
    return res.status(400).json({ error: "company_id requis" });
  }
  const resumeLookup = await findTenantResource(
    "outbound_campaigns",
    req.params.id,
    req
  );
  if (!resumeLookup.data) {
    return res.status(resumeLookup.status).json({ error: resumeLookup.message });
  }
  if (resumeLookup.data.company_id !== resumeCompanyId) {
    return res.status(403).json({ error: "Accès interdit à cette entreprise" });
  }
  if (resumeLookup.data.status !== "paused") {
    return res.status(409).json({
      error: "Seule une campagne en pause peut être reprise",
    });
  }
  if (!requireReadyOutboundWorker(res)) return;
  if (
    typeof resumeLookup.data.script !== "string"
    || resumeLookup.data.script.trim().length < 20
  ) {
    return res.status(400).json({
      error: "Le script de la campagne doit contenir au moins 20 caractères",
    });
  }

  try {
    const queued = await enqueueOutboundCampaign({
      supabase,
      campaignId: resumeLookup.data.id,
      companyId: resumeCompanyId,
      scheduledFor: new Date(),
      maxAttempts: req.body?.max_attempts,
    });
    if (!queued.hasActiveWork) {
      return res.status(409).json({
        error: "Aucun contact admissible à l’appel",
        blocked: queued.counts.blocked || 0,
      });
    }
    return res.status(202).json({
      success: true,
      queued: queued.counts.pending || 0,
      active: queued.activeTotal,
      blocked: queued.counts.blocked || 0,
      total: queued.total,
      message: "Campagne reprise par la file d'appels durable.",
    });
  } catch {
    console.error("[OUTBOUND] durable campaign resume failed");
    return res.status(503).json({
      error: "outbound_queue_unavailable",
      message: "La file d'appels est temporairement indisponible.",
    });
  }

});

// ─────────────────────────────────────────────────────────────
// DNC LIST — CRUD
// ─────────────────────────────────────────────────────────────

// Une réponse fournisseur ambiguë reste en quarantaine jusqu'à ce qu'un
// super administrateur ait vérifié l'état dans ElevenLabs/Twilio.
router.get("/manual-reviews", requireSuperAdmin, async (req, res) => {
  const companyId = req.query?.company_id;
  if (!isUuid(companyId)) {
    return res.status(400).json({ error: "company_id requis" });
  }

  const { data: queues, error: queueError } = await supabase
    .from("outbound_call_queue")
    .select([
      "id",
      "company_id",
      "campaign_id",
      "outbound_contact_id",
      "current_attempt_id",
      "status",
      "last_error_code",
      "created_at",
      "updated_at",
    ].join(","))
    .eq("company_id", companyId)
    .eq("status", "manual_review")
    .order("updated_at", { ascending: true })
    .limit(100);
  if (queueError) {
    return res.status(503).json({ error: "manual_review_unavailable" });
  }
  if (!queues?.length) return res.json({ reviews: [] });

  const unique = values => [...new Set(values.filter(Boolean))];
  const campaignIds = unique(queues.map(queue => queue.campaign_id));
  const contactIds = unique(queues.map(queue => queue.outbound_contact_id));
  const attemptIds = unique(queues.map(queue => queue.current_attempt_id));
  const [campaignResponse, contactResponse, attemptResponse] = await Promise.all([
    supabase.from("outbound_campaigns")
      .select("id,name")
      .eq("company_id", companyId)
      .in("id", campaignIds),
    supabase.from("outbound_contacts")
      .select("id,full_name,phone")
      .eq("company_id", companyId)
      .in("id", contactIds),
    attemptIds.length
      ? supabase.from("outbound_call_attempts")
        .select([
          "id",
          "status",
          "elevenlabs_conversation_id",
          "twilio_call_sid",
          "error_code",
          "started_at",
        ].join(","))
        .eq("company_id", companyId)
        .in("id", attemptIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (campaignResponse.error || contactResponse.error || attemptResponse.error) {
    return res.status(503).json({ error: "manual_review_unavailable" });
  }

  const byId = rows => new Map((rows || []).map(row => [row.id, row]));
  const campaigns = byId(campaignResponse.data);
  const contacts = byId(contactResponse.data);
  const attempts = byId(attemptResponse.data);
  return res.json({
    reviews: queues.map(queue => {
      const campaign = campaigns.get(queue.campaign_id) || null;
      const contact = contacts.get(queue.outbound_contact_id) || null;
      const attempt = attempts.get(queue.current_attempt_id) || null;
      return {
        queue_id: queue.id,
        company_id: queue.company_id,
        status: queue.status,
        campaign: campaign ? { id: campaign.id, name: campaign.name } : null,
        contact: contact ? {
          id: contact.id,
          full_name: contact.full_name,
          phone: contact.phone,
        } : null,
        provider: attempt ? {
          conversation_id: attempt.elevenlabs_conversation_id,
          call_sid: attempt.twilio_call_sid,
          attempt_status: attempt.status,
          error_code: attempt.error_code,
          started_at: attempt.started_at,
        } : null,
        last_error_code: queue.last_error_code,
        created_at: queue.created_at,
        updated_at: queue.updated_at,
      };
    }),
  });
});

router.post(
  "/manual-review/:queueId/resolve",
  requireOutboundManager,
  requireSuperAdmin,
  express.json(),
  async (req, res) => {
    const { queueId } = req.params;
    const { company_id, resolution } = req.body || {};
    const allowed = new Set([
      "confirmed_not_dispatched",
      "confirmed_completed",
      "confirmed_failed",
    ]);
    if (!isUuid(queueId) || !isUuid(company_id) || !allowed.has(resolution)) {
      return res.status(400).json({ error: "invalid_manual_review_resolution" });
    }

    const lookup = await findTenantResource(
      "outbound_call_queue",
      queueId,
      req,
      "id, company_id, status"
    );
    if (!lookup.data) {
      return res.status(lookup.status).json({ error: lookup.message });
    }
    if (lookup.data.status !== "manual_review") {
      return res.status(409).json({ error: "queue_not_awaiting_manual_review" });
    }

    const { data, error } = await supabase.rpc("resolve_outbound_manual_review", {
      p_queue_id: queueId,
      p_resolution: resolution,
      p_actor_user_id: req.user.id,
    });
    if (error) {
      const status = error.code === "42501" ? 403
        : error.code === "P0002" ? 404
          : error.code === "22023" ? 400
            : error.code === "55000" ? 409
              : 503;
      return res.status(status).json({ error: "manual_review_resolution_failed" });
    }
    return res.json(data || { success: true });
  }
);

router.get("/dnc", async (req, res) => {
  const { company_id } = req.query;
  if (hasTenantMismatch(req, company_id)) {
    return res.status(403).json({ error: "Accès interdit à cette entreprise" });
  }
  const companyId = getTargetCompanyId(req, company_id);
  if (!companyId) return res.status(400).json({ error: "company_id requis" });
  let query = supabase.from("dnc_list").select("*");
  query = query.eq("company_id", companyId);
  const { data, error } = await query.order("added_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ dnc: data || [] });
});

router.post("/dnc", requireOutboundManager, express.json(), async (req, res) => {
  const { company_id, phone, reason } = req.body || {};
  if (hasTenantMismatch(req, company_id)) {
    return res.status(403).json({ error: "Accès interdit à cette entreprise" });
  }
  const companyId = getTargetCompanyId(req, company_id);
  if (!companyId || !phone) return res.status(400).json({ error: "company_id et phone requis" });
  const normalized = normalizePhone(phone);
  if (!normalized) return res.status(400).json({ error: "Numéro invalide" });
  const { data, error } = await supabase.from("dnc_list")
    .upsert({
      company_id: companyId,
      phone: normalized,
      reason: reason || null,
      source: "manual",
    }, { onConflict: "company_id,phone" })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true, entry: data });
});

router.delete("/dnc/:id", requireOutboundManager, async (req, res) => {
  const { id } = req.params;
  const { company_id } = req.query;
  if (hasTenantMismatch(req, company_id)) {
    return res.status(403).json({ error: "Accès interdit à cette entreprise" });
  }
  const lookup = await findTenantResource(
    "dnc_list",
    id,
    req,
    "id, company_id, phone, source"
  );
  if (!lookup.data) return res.status(lookup.status).json({ error: lookup.message });

  const { data: refusedContact, error: consentError } = await supabase
    .from("contacts")
    .select("id")
    .eq("company_id", lookup.data.company_id)
    .eq("phone", lookup.data.phone)
    .eq("call_consent", false)
    .neq("status", "anonymized")
    .is("merged_into_contact_id", null)
    .limit(1)
    .maybeSingle();
  if (consentError) {
    return res.status(503).json({ error: "Vérification du consentement indisponible" });
  }
  if (refusedContact) {
    return res.status(409).json({
      error: "call_consent_revoked",
      message: "Réautorisez d’abord les appels dans la fiche CRM.",
    });
  }

  const { data, error } = await supabase
    .from("dnc_list")
    .delete()
    .eq("id", id)
    .eq("company_id", lookup.data.company_id)
    .select("id")
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Entrée DNC introuvable" });
  return res.json({ success: true });
});

export default router;
