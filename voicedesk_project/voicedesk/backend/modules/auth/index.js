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
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { createInviteAcceptance } from "./inviteAcceptance.js";
import { route } from "../account/security.js";

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
// ============================================================
// EXEVORI VOICE IA — Endpoint POST /api/v1/auth/register
// Fichier : coller dans backend/modules/auth/index.js
//           AVANT le bloc router.post("/invite"
//
// Import à ajouter en haut si absent :
//   import { Resend } from "resend";
//   const resend = new Resend(process.env.RESEND_API_KEY);
// ============================================================

router.post("/register", async (req, res) => {
  const {
    company_name, contact_name, contact_email,
    password, phone = "", city = "Québec", plan = "demarrage",
  } = req.body;

  if (!company_name || !contact_name || !contact_email || !password)
    return res.status(400).json({ error: "Champs obligatoires manquants" });

  if (password.length < 8)
    return res.status(400).json({ error: "Mot de passe min 8 caractères" });

  // Deployment guard: do not create an Auth user/company against a missing migration.
  const {error: settingsSchemaError} = await supabase.from("company_settings").select("company_id").limit(0);
  if (settingsSchemaError) return res.status(503).json({error:"registration_temporarily_unavailable"});

  const { data: existing } = await supabase
    .from("profiles").select("id").eq("email", contact_email).maybeSingle();
  if (existing) return res.status(409).json({ error: "Un compte existe déjà avec ce courriel" });

  const PLAN_PRICES = { solo: 79, demarrage: 159, essentiel: 319, professionnel: 529 };
  let companyId = null, userId = null;

  try {
    // 1. Créer la company
    const { data: company, error: cErr } = await supabase
      .from("companies").insert({
        name: company_name, contact_name, contact_email,
        phone, city, province: "Québec", plan,
        status: "trial", billing_country: "CA",
        created_at: new Date().toISOString(),
      }).select().single();
    if (cErr) throw new Error(`Company : ${cErr.message}`);
    companyId = company.id;

    // 2. Créer le user Supabase Auth
    const { data: auth, error: aErr } = await supabase.auth.admin.createUser({
      email: contact_email, password, email_confirm: true,
      user_metadata: { company_name, contact_name },
    });
    if (aErr) throw new Error(`Auth : ${aErr.message}`);
    userId = auth.user.id;

    // 3. Profil
    const { error: pErr } = await supabase.from("profiles").insert({
      user_id: userId, company_id: companyId,
      full_name: contact_name, email: contact_email,
      role: "company_admin", status: "active",
    });
    if (pErr) throw new Error(`Profil : ${pErr.message}`);
    const {error: ownerError} = await supabase.from("company_settings").insert({company_id:companyId,owner_user_id:userId});
    if (ownerError) throw new Error("Initialisation du propriétaire impossible");

    // 4. Subscription trial 14 jours
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 14);
    const { error: sErr } = await supabase.from("subscriptions").insert({
      company_id: companyId, plan_name: plan,
      monthly_price: PLAN_PRICES[plan] || 159,
      payment_status: "trial",
      trial_ends_at: trialEnd.toISOString(),
    });
    if (sErr) throw new Error(`Abonnement : ${sErr.message}`);

    // 5. assistant_configs vide
    const { error: cfgErr } = await supabase.from("assistant_configs").insert({
      company_id: companyId, assistant_name: "Léa",
      tone: "professional", language_primary: "fr-CA",
      created_at: new Date().toISOString(),
    });
    if (cfgErr) throw new Error(`Configuration assistante : ${cfgErr.message}`);

    // 6. onboarding_progress
    const { error: oErr } = await supabase.from("onboarding_progress").insert({
      company_id: companyId, current_step: 1,
      completed_steps: [], provisioning_status: "idle",
    });
    if (oErr) throw new Error(`Onboarding : ${oErr.message}`);

    // 7. Email de bienvenue (non bloquant)
    try {
      const firstName = contact_name.split(" ")[0];
      await resend.emails.send({
        from: process.env.EMAIL_FROM || "VoiceDesk <bonjour@voicedesk.ca>",
        to:   contact_email,
        subject: `Bienvenue dans VoiceDesk AI, ${firstName} !`,
        html: `<div style="font-family:Arial;max-width:540px;margin:auto">
          <div style="background:#1E3A5F;padding:24px 32px">
            <h1 style="color:#fff;margin:0;font-size:22px">Bienvenue, ${firstName} !</h1>
          </div>
          <div style="padding:24px 32px">
            <p style="color:#374151">Votre compte <strong>${company_name}</strong> est prêt.</p>
            <p style="color:#374151">Complétez la configuration pour obtenir votre numéro dédié.</p>
            <a href="${process.env.FRONTEND_URL}/onboarding"
               style="display:inline-block;background:#3B82F6;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">
              Configurer mon assistante →
            </a>
          </div>
          <div style="padding:16px 32px;background:#F9FAFB;text-align:center">
            <p style="color:#9CA3AF;font-size:11px;margin:0">Exevori · VoiceDesk AI · Lévis, Québec</p>
          </div>
        </div>`,
      });
    } catch {}

    return res.status(201).json({ success: true, company_id: companyId, user_id: userId });

  } catch (err) {
    // Rollback
    if (userId) { try { await supabase.auth.admin.deleteUser(userId); } catch {} }
    if (companyId) { try { await supabase.from("companies").delete().eq("id", companyId); } catch {} }
    return res.status(500).json({ error: err.message });
  }
});

router.post("/invite", requireAuth, requireRole("super_admin"), async (req, res) => {
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
router.post("/invite/resend", requireAuth, requireRole("super_admin"), async (req, res) => {
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
const acceptInvitation = createInviteAcceptance({supabase});
router.post("/invite/accept", route(async(req,res) => {
  res.json(await acceptInvitation(req.body));
}));

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
router.get("/me", requireAuth, (req,res) => {
  const {profile,id,email} = req.user;
  res.set("Cache-Control","no-store").json({
    user_id:id,profile_id:profile.id,email,full_name:profile.full_name,role:profile.role,
    company_id:profile.company_id,company:profile.companies,
  });
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
