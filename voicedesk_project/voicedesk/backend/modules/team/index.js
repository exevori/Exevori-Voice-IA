// ============================================================
// EXEVORI VOICE IA — MODULE TEAM (Phase 6A — Settings)
// Endpoints minimalistes pour Settings → onglet Équipe.
//   GET  /api/v1/team?company_id=...           → liste des membres + invitations pendantes
//   POST /api/v1/team/invitations/:id/cancel   → annuler une invitation
//   DELETE /api/v1/team/members/:user_id       → désactiver un membre (status=suspended)
// L'invitation elle-même se crée via le module auth existant.
// ============================================================

import express from "express";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import dotenv from "dotenv";

dotenv.config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const router = express.Router();

// GET /api/v1/team
router.get("/", async (req, res) => {
  const { company_id } = req.query;
  if (!company_id) return res.status(400).json({ error: "company_id requis" });

  try {
    const [membersRes, invitesRes] = await Promise.all([
      supabase.from("profiles")
        .select("id, user_id, full_name, email, role, status, preferred_language, created_at")
        .eq("company_id", company_id)
        .order("created_at", { ascending: true }),
      supabase.from("invitations")
        .select("id, email, role, status, expires_at, created_at")
        .eq("company_id", company_id)
        .in("status", ["pending", "expired"])
        .order("created_at", { ascending: false }),
    ]);
    if (membersRes.error) throw membersRes.error;
    if (invitesRes.error) throw invitesRes.error;

    return res.json({
      members:     membersRes.data || [],
      invitations: invitesRes.data || [],
    });
  } catch (err) {
    console.error("[TEAM] GET error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/team/invitations  — créer une invitation pour une PME EXISTANTE
// body: { company_id, email, role: 'company_admin' | 'company_member' }
// Différent de /auth/invite qui crée un NOUVEAU tenant.
router.post("/invitations", express.json(), async (req, res) => {
  const { company_id, email, role = "company_member" } = req.body;
  if (!company_id || !email) return res.status(400).json({ error: "company_id et email requis" });
  if (!["company_admin", "company_member"].includes(role)) {
    return res.status(400).json({ error: "role invalide (company_admin ou company_member)" });
  }
  const cleanEmail = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: "Courriel invalide" });
  }

  try {
    // Évite les doublons actifs
    const { data: dup } = await supabase
      .from("invitations")
      .select("id, status")
      .eq("company_id", company_id)
      .eq("email", cleanEmail)
      .in("status", ["pending"])
      .maybeSingle();
    if (dup) {
      return res.status(409).json({ error: "Une invitation est déjà en attente pour ce courriel" });
    }
    // Évite d'inviter un membre déjà actif
    const { data: existing } = await supabase
      .from("profiles")
      .select("id, status")
      .eq("company_id", company_id)
      .eq("email", cleanEmail)
      .maybeSingle();
    if (existing) {
      return res.status(409).json({ error: "Ce courriel correspond déjà à un membre de cette entreprise" });
    }

    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(); // 7 jours
    const sent_by = req.user?.id || null; // injecté par requireAuth middleware

    const { data, error } = await supabase
      .from("invitations")
      .insert({
        company_id,
        email: cleanEmail,
        role,
        token,
        status: "pending",
        sent_by,
        expires_at: expiresAt,
      })
      .select("id, email, role, status, expires_at, created_at")
      .single();
    if (error) throw error;

    // Note: envoi email réel via Resend = Phase 6E ou Phase 8.
    // En attendant on retourne l'URL pour debug/preview.
    const inviteUrl = `${process.env.FRONTEND_URL || ""}/invite/${token}`;
    return res.json({
      success: true,
      invitation: data,
      invite_url: inviteUrl,
    });
  } catch (err) {
    console.error("[TEAM] invite error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/team/invitations/:id/cancel
router.post("/invitations/:id/cancel", async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from("invitations")
      .update({ status: "cancelled" })
      .eq("id", id)
      .select("id, status")
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Invitation introuvable" });
    return res.json({ success: true, invitation: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/v1/team/members/:user_id  body: {status: 'active'|'suspended'} ou {role: ...}
router.patch("/members/:user_id", express.json(), async (req, res) => {
  const { user_id } = req.params;
  const { company_id, status, role } = req.body;
  if (!company_id) return res.status(400).json({ error: "company_id requis" });

  const updates = {};
  if (status && ["active", "suspended"].includes(status)) updates.status = status;
  if (role && ["company_admin", "company_member"].includes(role)) updates.role = role;
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "Aucun champ valide" });

  try {
    const { data, error } = await supabase
      .from("profiles")
      .update(updates)
      .eq("user_id", user_id)
      .eq("company_id", company_id) // double check tenant
      .select("id, user_id, full_name, email, role, status")
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Membre introuvable dans cette entreprise" });
    return res.json({ success: true, member: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
