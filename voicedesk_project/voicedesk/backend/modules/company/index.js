// ============================================================
// EXEVORI VOICE IA — MODULE COMPANY (Phase 6A — Settings)
// Endpoints minimalistes pour Settings → onglet Entreprise.
// PATCH n'autorise QUE certains champs (whitelist).
// ============================================================

import express from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const router = express.Router();

const ALLOWED_FIELDS = [
  "name", "contact_name", "contact_email", "phone",
  "city", "province", "country", "sector", "size", "website",
  "preferred_language",
];

// GET /api/v1/company?company_id=...
router.get("/", async (req, res) => {
  const { company_id } = req.query;
  if (!company_id) return res.status(400).json({ error: "company_id requis" });
  try {
    const { data, error } = await supabase
      .from("companies")
      .select("id, name, contact_name, contact_email, phone, city, province, country, sector, size, website, preferred_language, plan, status, created_at, updated_at")
      .eq("id", company_id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Entreprise introuvable" });
    return res.json({ company: data });
  } catch (err) {
    console.error("[COMPANY] GET error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/v1/company — whitelist stricte
router.patch("/", async (req, res) => {
  const { company_id, ...patch } = req.body;
  if (!company_id) return res.status(400).json({ error: "company_id requis" });

  // Whitelist
  const updates = {};
  for (const key of ALLOWED_FIELDS) {
    if (patch[key] !== undefined) updates[key] = patch[key];
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "Aucun champ valide à mettre à jour" });
  }
  updates.updated_at = new Date().toISOString();

  try {
    const { data, error } = await supabase
      .from("companies")
      .update(updates)
      .eq("id", company_id)
      .select("id, name, contact_name, contact_email, phone, city, province, country, sector, size, website, preferred_language, plan, status, created_at, updated_at")
      .maybeSingle();
    if (error) throw error;
    return res.json({ success: true, company: data });
  } catch (err) {
    console.error("[COMPANY] PATCH error:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
