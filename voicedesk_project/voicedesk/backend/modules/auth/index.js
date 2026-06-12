// ============================================================
// VOICEDESK IA — MODULE AUTH
// Authentification + Invitations + Reset mot de passe
// Stack : Supabase Auth + Resend pour emails
// ============================================================

import express from "express";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import crypto from "crypto";
import dotenv from "dotenv";
import { buildInvitationEmail, buildPasswordResetEmail } from "../../../frontend/src/utils/auth-helpers.js";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);
const router = express.Router();

// ─────────────────────────────────────────────────────────────
// POST /api/v1/auth/invite
// Admin Exevori crée une entreprise + envoie invitation
// ─────────────────────────────────────────────────────────────
router.post("/invite", async (req, res) => {
  const {
    company_name, contact_name, contact_email, phone, city,
    sector, plan, sent_by
  } = req.body;

  if (!company_name || !contact_name || !contact_email) {
    return res.status(400).json({ error: "Champs requis manquants" });
  }

  try {
    // 1. Créer l'entreprise
    const { data: company, error: companyErr } = await supabase
      .from("companies")
      .insert({
        name: company_name,
        contact_name,
        contact_email,
        phone,
        city,
        province: "Québec",
        sector,
        plan: plan || "demarrage",
        status: "trial",
      })
      .select()
      .single();

    if (companyErr) throw companyErr;

    // 2. Créer l'abonnement en essai
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 14);

    const PLAN_PRICES = {
      solo: 67, demarrage: 147, essentiel: 297, professionnel: 497, entreprise: 897
    };

    await supabase.from("subscriptions").insert({
      company_id: company.id,
      plan_name: plan || "demarrage",
      monthly_price: PLAN_PRICES[plan] || 147,
      payment_status: "trial",
      trial_ends_at: trialEnd,
    });

    // 3. Créer l'invitation avec token
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await supabase.from("invitations").insert({
      company_id: company.id,
      email: contact_email,
      role: "company_admin",
      token,
      status: "pending",
      sent_by,
      expires_at: expiresAt,
    });

    // 4. Envoyer l'email d'invitation
    const inviteUrl = `${process.env.FRONTEND_URL}/invite/${token}`;
    const emailContent = buildInvitationEmail({
      companyName: company_name,
      contactName: contact_name,
      inviteUrl,
      expiresAt,
    });

    await resend.emails.send({
      from: process.env.EMAIL_FROM || "VoiceDesk <hello@voicedesk.ca>",
      to: contact_email,
      subject: emailContent.subject,
      html: emailContent.html,
    });

    return res.json({
      success: true,
      company_id: company.id,
      invitation_token: token,
    });
  } catch (err) {
    console.error("[AUTH] Invite error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/auth/invite/resend
// Renvoyer une invitation
// ─────────────────────────────────────────────────────────────
router.post("/invite/resend", async (req, res) => {
  const { invitation_id } = req.body;

  try {
    const { data: invitation } = await supabase
      .from("invitations")
      .select("*, companies(name, contact_name)")
      .eq("id", invitation_id)
      .single();

    if (!invitation) return res.status(404).json({ error: "Invitation introuvable" });

    // Régénérer un token et étendre l'expiration
    const newToken = crypto.randomBytes(32).toString("hex");
    const newExpiry = new Date();
    newExpiry.setDate(newExpiry.getDate() + 7);

    await supabase
      .from("invitations")
      .update({ token: newToken, expires_at: newExpiry, status: "pending" })
      .eq("id", invitation_id);

    const inviteUrl = `${process.env.FRONTEND_URL}/invite/${newToken}`;
    const emailContent = buildInvitationEmail({
      companyName: invitation.companies.name,
      contactName: invitation.companies.contact_name,
      inviteUrl,
      expiresAt: newExpiry,
    });

    await resend.emails.send({
      from: process.env.EMAIL_FROM || "VoiceDesk <hello@voicedesk.ca>",
      to: invitation.email,
      subject: emailContent.subject,
      html: emailContent.html,
    });

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/auth/invite/verify/:token
// Vérifier un token d'invitation
// ─────────────────────────────────────────────────────────────
router.get("/invite/verify/:token", async (req, res) => {
  const { token } = req.params;

  try {
    const { data: invitation } = await supabase
      .from("invitations")
      .select("*, companies(name, contact_name)")
      .eq("token", token)
      .single();

    if (!invitation) {
      return res.status(404).json({ valid: false, error: "Token introuvable" });
    }

    if (invitation.status !== "pending") {
      return res.status(400).json({ valid: false, error: "Invitation déjà utilisée ou annulée" });
    }

    if (new Date(invitation.expires_at) < new Date()) {
      await supabase
        .from("invitations")
        .update({ status: "expired" })
        .eq("id", invitation.id);
      return res.status(400).json({ valid: false, error: "Invitation expirée" });
    }

    return res.json({
      valid: true,
      invitation: {
        email: invitation.email,
        company_name: invitation.companies.name,
        contact_name: invitation.companies.contact_name,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/auth/invite/accept
// Accepter une invitation + créer mot de passe
// ─────────────────────────────────────────────────────────────
router.post("/invite/accept", async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password || password.length < 8) {
    return res.status(400).json({ error: "Token et mot de passe (min 8 caractères) requis" });
  }

  try {
    const { data: invitation } = await supabase
      .from("invitations")
      .select("*, companies(*)")
      .eq("token", token)
      .single();

    if (!invitation || invitation.status !== "pending") {
      return res.status(400).json({ error: "Invitation invalide" });
    }

    if (new Date(invitation.expires_at) < new Date()) {
      return res.status(400).json({ error: "Invitation expirée" });
    }

    // Créer le user Supabase Auth
    const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
      email: invitation.email,
      password,
      email_confirm: true,
    });

    if (authErr) throw authErr;

    // Créer le profile
    await supabase.from("profiles").insert({
      user_id: authData.user.id,
      company_id: invitation.company_id,
      full_name: invitation.companies.contact_name,
      email: invitation.email,
      role: invitation.role,
      status: "active",
    });

    // Marquer invitation comme acceptée
    await supabase
      .from("invitations")
      .update({ status: "accepted", accepted_at: new Date() })
      .eq("id", invitation.id);

    // Activer le compte
    await supabase
      .from("companies")
      .update({ status: "active" })
      .eq("id", invitation.company_id);

    return res.json({
      success: true,
      user_id: authData.user.id,
      company_id: invitation.company_id,
    });
  } catch (err) {
    console.error("[AUTH] Accept invite error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/auth/reset-password
// Demander un reset de mot de passe
// ─────────────────────────────────────────────────────────────
router.post("/reset-password", async (req, res) => {
  const { email } = req.body;

  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${process.env.FRONTEND_URL}/reset-password/new`,
    });

    if (error) throw error;

    // Toujours retourner success même si email n'existe pas (sécurité)
    return res.json({
      success: true,
      message: "Si ce courriel existe, vous recevrez un lien de réinitialisation.",
    });
  } catch (err) {
    console.error("[AUTH] Reset password error:", err);
    return res.json({ success: true }); // Ne pas révéler si l'email existe
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/auth/me
// Profil de l'utilisateur connecté (rôle + company)
// ─────────────────────────────────────────────────────────────
router.get("/me", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Non authentifié" });

  const token = authHeader.replace("Bearer ", "");

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Token invalide" });

    const { data: profile } = await supabase
      .from("profiles")
      .select("*, companies(*)")
      .eq("user_id", user.id)
      .single();

    if (!profile) return res.status(404).json({ error: "Profil introuvable" });

    // Mettre à jour last_login_at
    await supabase
      .from("profiles")
      .update({ last_login_at: new Date() })
      .eq("id", profile.id);

    return res.json({
      user_id: user.id,
      profile_id: profile.id,
      email: profile.email,
      full_name: profile.full_name,
      role: profile.role,
      company_id: profile.company_id,
      company: profile.companies,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/auth/logout
// ─────────────────────────────────────────────────────────────
router.post("/logout", async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace("Bearer ", "");

  if (token) {
    await supabase.auth.admin.signOut(token);
  }

  return res.json({ success: true });
});

export default router;
