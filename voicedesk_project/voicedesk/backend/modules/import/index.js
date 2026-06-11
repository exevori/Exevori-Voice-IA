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
  const { company_id, column_mapping, skip_duplicates = "true", default_status = "new", default_source = "csv_import" } = req.body;
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
    let skipped = 0;
    let errors = [];

    // Lookup existing contacts pour détection doublons
    const { data: existingContacts } = await supabase
      .from("contacts")
      .select("phone, email")
      .eq("company_id", company_id);

    const existingPhones = new Set((existingContacts || []).map(c => c.phone).filter(Boolean));
    const existingEmails = new Set((existingContacts || []).map(c => c.email).filter(Boolean));

    // Importer par batch de 100
    const BATCH_SIZE = 100;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const records = [];

      for (const row of batch) {
        try {
          const contact = mapRowToContact(row, mapping, {
            company_id,
            default_status,
            default_source,
          });

          if (!contact.full_name) {
            errors.push({ row: i + records.length + 1, error: "Nom manquant" });
            continue;
          }

          // Skip si doublon
          if (skip_duplicates === "true" || skip_duplicates === true) {
            if (contact.phone && existingPhones.has(contact.phone)) {
              skipped++;
              continue;
            }
            if (contact.email && existingEmails.has(contact.email)) {
              skipped++;
              continue;
            }
          }

          records.push(contact);

          // Ajouter aux sets pour éviter les doublons dans le même batch
          if (contact.phone) existingPhones.add(contact.phone);
          if (contact.email) existingEmails.add(contact.email);
        } catch (e) {
          errors.push({ row: i + records.length + 1, error: e.message });
        }
      }

      if (records.length > 0) {
        const { error } = await supabase.from("contacts").insert(records);
        if (error) {
          errors.push({ batch: i, error: error.message });
        } else {
          imported += records.length;
        }
      }
    }

    // Log l'activité
    await supabase.from("activity_logs").insert({
      company_id,
      action: "contacts_imported",
      details: {
        total_rows: rows.length,
        imported,
        skipped,
        errors: errors.length,
      },
    });

    return res.json({
      success: true,
      total_rows: rows.length,
      imported,
      skipped,
      errors: errors.slice(0, 20),
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
  const mapping = {};

  // Détection heuristique de base
  const patterns = {
    full_name: /^(nom|name|nom complet|full[\s_-]?name|fullname|client|customer)$/i,
    first_name: /^(pr[ée]nom|first[\s_-]?name|firstname|given[\s_-]?name)$/i,
    last_name: /^(nom de famille|last[\s_-]?name|lastname|surname|family[\s_-]?name)$/i,
    email: /^(e?[\s_-]?mail|courriel|courriel[\s_-]?[ée]lectronique)$/i,
    phone: /^(t[ée]l[ée]?phone|t[ée]l|phone|mobile|cellulaire|cell)$/i,
    company: /^(entreprise|company|compagnie|organisation|business)$/i,
    notes: /^(notes?|commentaires?|remarques?|description)$/i,
    status: /^(statut|status|[ée]tat)$/i,
  };

  for (const header of headers) {
    for (const [field, pattern] of Object.entries(patterns)) {
      if (pattern.test(header.trim())) {
        mapping[field] = header;
        break;
      }
    }
  }

  // Si pas assez de mapping détecté, demander à DeepSeek
  if (Object.keys(mapping).length < 3) {
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
        if (ai.mapping) Object.assign(mapping, ai.mapping);
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

  for (const [field, csvColumn] of Object.entries(mapping)) {
    if (csvColumn && row[csvColumn]) {
      contact[field] = String(row[csvColumn]).trim();
    }
  }

  // Construire full_name si on a first+last mais pas full
  if (!contact.full_name && (contact.first_name || contact.last_name)) {
    contact.full_name = [contact.first_name, contact.last_name].filter(Boolean).join(" ");
  }

  // Nettoyer phone
  if (contact.phone) {
    contact.phone = contact.phone.replace(/[^\d+]/g, "");
    if (contact.phone.length === 10) contact.phone = "+1" + contact.phone;
  }

  // Nettoyer email
  if (contact.email) {
    contact.email = contact.email.toLowerCase();
  }

  return contact;
}

async function findPotentialDuplicates(company_id, rows, mapping) {
  const { data: existing } = await supabase
    .from("contacts")
    .select("id, full_name, phone, email")
    .eq("company_id", company_id);

  const existingByPhone = new Map();
  const existingByEmail = new Map();
  (existing || []).forEach(c => {
    if (c.phone) existingByPhone.set(c.phone, c);
    if (c.email) existingByEmail.set(c.email.toLowerCase(), c);
  });

  const duplicates = [];
  for (const row of rows) {
    const phone = mapping.phone && row[mapping.phone]
      ? String(row[mapping.phone]).replace(/[^\d+]/g, "")
      : null;
    const email = mapping.email && row[mapping.email]
      ? String(row[mapping.email]).toLowerCase()
      : null;

    if (phone && existingByPhone.has(phone)) {
      duplicates.push({ row, existing: existingByPhone.get(phone), matched_on: "phone" });
    } else if (email && existingByEmail.has(email)) {
      duplicates.push({ row, existing: existingByEmail.get(email), matched_on: "email" });
    }
  }
  return duplicates;
}

export default router;
