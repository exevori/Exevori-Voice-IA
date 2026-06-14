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
import { Resend } from "resend";
import crypto from "node:crypto";
import dotenv from "dotenv";

dotenv.config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

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

    // Lookup company name for email branding
    const { data: companyRow } = await supabase
      .from("companies").select("name").eq("id", company_id).maybeSingle();
    const companyName = companyRow?.name || "Exevori";

    const inviteUrl = `${process.env.FRONTEND_URL || ""}/invite/${token}`;

    // Envoi du courriel d'invitation via Resend (best-effort — n'empêche pas la création si Resend down)
    let email_sent = false, email_error = null;
    try {
      const html = `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1a1a1a">
          <div style="background:linear-gradient(135deg,#7c3aed,#ec4899);color:white;padding:18px 22px;border-radius:12px 12px 0 0">
            <div style="font-size:11px;opacity:.85;letter-spacing:.08em;text-transform:uppercase">Exevori Voice IA</div>
            <div style="font-size:18px;font-weight:600;margin-top:4px">Invitation à rejoindre ${companyName}</div>
          </div>
          <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;padding:22px;border-radius:0 0 12px 12px">
            <p style="margin:0 0 12px;font-size:14px">Bonjour,</p>
            <p style="margin:0 0 16px;font-size:14px;line-height:1.55">
              Vous avez été invité(e) à rejoindre <strong>${companyName}</strong> sur Exevori Voice IA en tant que
              <strong>${role === "company_admin" ? "administrateur" : "membre"}</strong>.
            </p>
            <p style="text-align:center;margin:24px 0">
              <a href="${inviteUrl}" style="display:inline-block;background:#7c3aed;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px">Accepter l'invitation</a>
            </p>
            <p style="margin:0 0 6px;font-size:11px;color:#6b7280">Ce lien expire dans 7 jours.</p>
            <p style="margin:0;font-size:11px;color:#9ca3af">Si vous n'attendiez pas cette invitation, ignorez ce courriel.</p>
          </div>
        </div>
      `;
      const r = await resend.emails.send({
        from: process.env.EMAIL_FROM || "Exevori <onboarding@resend.dev>",
        to: cleanEmail,
        subject: `Invitation Exevori — ${companyName}`,
        html,
      });
      if (r?.error) { email_error = r.error.message || String(r.error); }
      else { email_sent = true; }
    } catch (e) {
      email_error = e.message;
      console.error("[TEAM] Resend invite failed:", e.message);
    }

    return res.json({
      success: true,
      invitation: data,
      invite_url: inviteUrl,
      email_sent,
      email_error,
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
