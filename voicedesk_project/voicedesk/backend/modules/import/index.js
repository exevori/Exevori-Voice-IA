// ============================================================
// VOICEDESK IA — MODULE IMPORT CSV/Excel
// Import intelligent de contacts avec parsing via DeepSeek
// ============================================================

import express from "express";
import { createClient } from "@supabase/supabase-js";
import multer from "multer";
import { parse as csvParse } from "csv-parse/sync";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const AI_GATEWAY_URL = process.env.AI_GATEWAY_URL || "http://localhost:3100";
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// POST /api/v1/import/preview
// Étape 1 — Upload + preview avec détection automatique des colonnes
// ─────────────────────────────────────────────────────────────
router.post("/preview", upload.single("file"), async (req, res) => {
  const { company_id } = req.body;
  const file = req.file;

  if (!company_id || !file) {
    return res.status(400).json({ error: "company_id et fichier requis" });
  }

  try {
    // Parser le CSV
    const content = file.buffer.toString("utf-8");
    let rows;
    try {
      rows = csvParse(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        delimiter: detectDelimiter(content),
      });
    } catch (e) {
      return res.status(400).json({ error: "Format CSV invalide : " + e.message });
    }

    if (rows.length === 0) {
      return res.status(400).json({ error: "Fichier vide" });
    }

    // Détection automatique du mapping colonnes
    const sampleRows = rows.slice(0, 5);
    const columnMapping = await detectColumnMapping(sampleRows);

    // Détection de doublons potentiels
    const duplicates = await findPotentialDuplicates(company_id, rows.slice(0, 50), columnMapping);

    return res.json({
      total_rows: rows.length,
      preview: rows.slice(0, 10),
      headers: Object.keys(rows[0] || {}),
      column_mapping: columnMapping,
      potential_duplicates: duplicates.length,
      sample_duplicates: duplicates.slice(0, 5),
    });
  } catch (err) {
    console.error("[IMPORT] Preview error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/import/execute
// Étape 2 — Exécuter l'import après validation par l'admin
// ─────────────────────────────────────────────────────────────
router.post("/execute", upload.single("file"), async (req, res) => {
  const {
    company_id,
    column_mapping,
    duplicate_action = "skip", // skip | overwrite | create
    default_status = "new",
    default_source = "csv_import",
  } = req.body;
  const file = req.file;

  if (!company_id || !file) {
    return res.status(400).json({ error: "company_id et fichier requis" });
  }

  try {
    const content = file.buffer.toString("utf-8");
    const rows = csvParse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      delimiter: detectDelimiter(content),
    });

    const mapping = typeof column_mapping === "string" ? JSON.parse(column_mapping) : column_mapping;

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    const errors = [];

    // Lookup existing contacts pour détection doublons (id + email + phone + name)
    const { data: existingContacts } = await supabase
      .from("contacts")
      .select("id, full_name, phone, email")
      .eq("company_id", company_id);

    const byEmail = new Map();
    const byPhone = new Map();
    const byName  = new Map();
    (existingContacts || []).forEach((c) => {
      if (c.email)     byEmail.set(c.email.toLowerCase(), c);
      if (c.phone)     byPhone.set(c.phone, c);
      if (c.full_name) byName.set(c.full_name.trim().toLowerCase(), c);
    });

    const findExisting = (contact) => {
      if (contact.email && byEmail.has(contact.email)) return byEmail.get(contact.email);
      if (contact.phone && byPhone.has(contact.phone)) return byPhone.get(contact.phone);
      if (contact.full_name && byName.has(contact.full_name.trim().toLowerCase()))
        return byName.get(contact.full_name.trim().toLowerCase());
      return null;
    };

    const indexNew = (c, id) => {
      const ref = { id, full_name: c.full_name, phone: c.phone, email: c.email };
      if (c.email)     byEmail.set(c.email.toLowerCase(), ref);
      if (c.phone)     byPhone.set(c.phone, ref);
      if (c.full_name) byName.set(c.full_name.trim().toLowerCase(), ref);
    };

    const VALID_STATUS = new Set(["new", "cold", "warm", "hot", "customer"]);
    const VALID_URGENCY = new Set(["low", "normal", "high"]);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // header + 0-based
      try {
        const contact = mapRowToContact(row, mapping, {
          company_id,
          default_status,
          default_source,
        });

        // Au moins un identifiant requis
        if (!contact.full_name && !contact.email && !contact.phone) {
          errors.push({ row: rowNum, message: "Aucun nom, courriel ou téléphone" });
          continue;
        }
        if (!contact.full_name) {
          contact.full_name = contact.email || contact.phone;
        }

        // Validation
        if (contact.status && !VALID_STATUS.has(contact.status)) {
          contact.status = default_status;
        }
        if (contact.urgency && !VALID_URGENCY.has(contact.urgency)) {
          delete contact.urgency;
        }

        const existing = findExisting(contact);

        if (existing) {
          if (duplicate_action === "skip") {
            skipped++;
            continue;
          }
          if (duplicate_action === "overwrite") {
            const patch = { ...contact };
            delete patch.company_id;
            const { error } = await supabase
              .from("contacts")
              .update(patch)
              .eq("id", existing.id);
            if (error) {
              errors.push({ row: rowNum, message: error.message });
            } else {
              updated++;
            }
            continue;
          }
          // duplicate_action === "create" → on continue à insérer
        }

        const { data, error } = await supabase
          .from("contacts")
          .insert(contact)
          .select("id")
          .single();
        if (error) {
          errors.push({ row: rowNum, message: error.message });
        } else {
          imported++;
          indexNew(contact, data.id);
        }
      } catch (e) {
        errors.push({ row: rowNum, message: e.message });
      }
    }

    // Log l'activité
    await supabase.from("activity_logs").insert({
      company_id,
      action: "contacts_imported",
      details: {
        total_rows: rows.length,
        imported,
        updated,
        skipped,
        errors: errors.length,
        duplicate_action,
      },
    });

    return res.json({
      success: true,
      total_rows: rows.length,
      imported,
      updated,
      skipped,
      errors: errors.slice(0, 50),
    });
  } catch (err) {
    console.error("[IMPORT] Execute error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/import/manual
// Saisie manuelle (1-50 contacts en une fois)
// ─────────────────────────────────────────────────────────────
router.post("/manual", async (req, res) => {
  const { company_id, contacts, default_status = "new" } = req.body;

  if (!company_id || !Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ error: "company_id et contacts (array) requis" });
  }

  if (contacts.length > 50) {
    return res.status(400).json({ error: "Maximum 50 contacts par saisie manuelle. Utilisez l'import CSV pour plus." });
  }

  try {
    const records = contacts
      .filter(c => c.full_name)
      .map(c => ({
        company_id,
        full_name: c.full_name,
        first_name: c.first_name,
        last_name: c.last_name,
        email: c.email,
        phone: c.phone,
        company: c.company,
        status: c.status || default_status,
        source: "manual",
        notes: c.notes,
      }));

    const { data, error } = await supabase
      .from("contacts")
      .insert(records)
      .select();

    if (error) throw error;
    return res.json({ success: true, imported: data.length, contacts: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// FONCTIONS UTILITAIRES
// ─────────────────────────────────────────────────────────────

function detectDelimiter(content) {
  const firstLine = content.split("\n")[0];
  const counts = {
    ",": (firstLine.match(/,/g) || []).length,
    ";": (firstLine.match(/;/g) || []).length,
    "\t": (firstLine.match(/\t/g) || []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

async function detectColumnMapping(sampleRows) {
  if (sampleRows.length === 0) return {};

  const headers = Object.keys(sampleRows[0]);
  // Format: { csvHeader: field } — aligné avec ImportWizard frontend
  const mapping = {};

  // Détection heuristique fuzzy — ordre IMPORTANT (plus spécifique d'abord)
  const patterns = {
    notes:       /(notes?|commentaires?|remarques?|description|m[ée]mo)/i,
    next_action: /(prochaine?\s*action|next[\s_-]?action|todo|t[âa]che|follow[\s_-]?up)/i,
    main_need:   /(besoin|need|raison|motif|demande|^objet$|^sujet$)/i,
    first_name:  /(pr[ée]nom|first[\s_-]?name|firstname|given[\s_-]?name)/i,
    last_name:   /(nom de famille|last[\s_-]?name|lastname|surname|family[\s_-]?name)/i,
    email:       /(e?[\s_-]?mail|courriel|adresse courriel)/i,
    phone:       /(t[ée]l[ée]?phone|^t[ée]l\b|^phone|mobile|cellulaire|\bcell\b|portable|num[ée]ro)/i,
    company:     /(entreprise|^company$|compagnie|organisation|business|soci[ée]t[ée]|employeur)/i,
    status:      /(statut|^status$|^[ée]tat$|stage|level)/i,
    urgency:     /(urgence|urgency|priorit[ée]|priority)/i,
    tags:        /(^tags?$|^[ée]tiquettes?$|cat[ée]gories?|labels?)/i,
    budget:      /(budget|montant|prix\s*estim[ée]|estimated[\s_-]?value)/i,
    full_name:   /(nom\s*complet|fullname|full[\s_-]?name|^client$|^customer$|^contact$|^nom$|^name$)/i,
  };

  for (const header of headers) {
    const cleaned = String(header).trim();
    if (!cleaned) continue;
    for (const [field, pattern] of Object.entries(patterns)) {
      if (pattern.test(cleaned)) {
        mapping[header] = field;
        break;
      }
    }
  }

  // Si pas assez de mapping détecté, demander à DeepSeek (best-effort)
  if (Object.keys(mapping).length < 2) {
    try {
      const response = await fetch(`${AI_GATEWAY_URL}/api/ai/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: "parse_import",
          headers,
          sample_rows: sampleRows.slice(0, 3),
        }),
      });

      if (response.ok) {
        const ai = await response.json();
        // ai.mapping attendu en { csvHeader: field }
        if (ai.mapping) {
          for (const [h, f] of Object.entries(ai.mapping)) {
            if (!mapping[h] && f) mapping[h] = f;
          }
        }
      }
    } catch (e) {
      console.warn("[IMPORT] AI mapping failed, using heuristics only");
    }
  }

  return mapping;
}

function mapRowToContact(row, mapping, defaults) {
  const contact = {
    company_id: defaults.company_id,
    status: defaults.default_status,
    source: defaults.default_source,
  };

  const notesParts = [];

  // mapping: { csvHeader: field }
  for (const [csvHeader, field] of Object.entries(mapping || {})) {
    if (!field || field === "ignore") continue;
    const raw = row[csvHeader];
    if (raw == null) continue;
    const value = String(raw).trim();
    if (!value) continue;

    if (field === "tags") {
      const arr = value.split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
      contact.tags = [...new Set([...(contact.tags || []), ...arr])];
    } else if (field === "notes") {
      notesParts.push(`${csvHeader}: ${value}`);
    } else {
      contact[field] = value;
    }
  }

  if (notesParts.length > 0) {
    contact.notes = notesParts.join("\n");
  }

  // Construire full_name si on a first+last mais pas full
  if (!contact.full_name && (contact.first_name || contact.last_name)) {
    contact.full_name = [contact.first_name, contact.last_name].filter(Boolean).join(" ");
  }

  // Nettoyer phone (E.164 best-effort pour numéros nord-américains)
  if (contact.phone) {
    const digits = contact.phone.replace(/[^\d+]/g, "");
    contact.phone = digits.length === 10 ? "+1" + digits : digits;
  }

  // Nettoyer email
  if (contact.email) {
    contact.email = contact.email.toLowerCase();
  }

  // Normaliser status / urgency en minuscules
  if (contact.status) contact.status = contact.status.toLowerCase();
  if (contact.urgency) contact.urgency = contact.urgency.toLowerCase();

  return contact;
}

async function findPotentialDuplicates(company_id, rows, mapping) {
  const { data: existing } = await supabase
    .from("contacts")
    .select("id, full_name, phone, email")
    .eq("company_id", company_id);

  const existingByPhone = new Map();
  const existingByEmail = new Map();
  const existingByName  = new Map();
  (existing || []).forEach((c) => {
    if (c.phone)     existingByPhone.set(c.phone, c);
    if (c.email)     existingByEmail.set(c.email.toLowerCase(), c);
    if (c.full_name) existingByName.set(c.full_name.trim().toLowerCase(), c);
  });

  // Inverser le mapping { csvHeader: field } → { field: csvHeader }
  const fieldToHeader = {};
  for (const [h, f] of Object.entries(mapping || {})) {
    if (f && f !== "ignore") fieldToHeader[f] = h;
  }

  const duplicates = [];
  for (const row of rows) {
    const rawPhone = fieldToHeader.phone ? row[fieldToHeader.phone] : null;
    const rawEmail = fieldToHeader.email ? row[fieldToHeader.email] : null;
    const rawName  = fieldToHeader.full_name ? row[fieldToHeader.full_name] : null;

    const phone = rawPhone
      ? (() => { const d = String(rawPhone).replace(/[^\d+]/g, ""); return d.length === 10 ? "+1" + d : d; })()
      : null;
    const email = rawEmail ? String(rawEmail).toLowerCase().trim() : null;
    const name  = rawName  ? String(rawName).trim().toLowerCase()  : null;

    if (email && existingByEmail.has(email)) {
      duplicates.push({ row, existing: existingByEmail.get(email), matched_on: "email" });
    } else if (phone && existingByPhone.has(phone)) {
      duplicates.push({ row, existing: existingByPhone.get(phone), matched_on: "phone" });
    } else if (name && existingByName.has(name)) {
      duplicates.push({ row, existing: existingByName.get(name), matched_on: "full_name" });
    }
  }
  return duplicates;
}

export default router;
