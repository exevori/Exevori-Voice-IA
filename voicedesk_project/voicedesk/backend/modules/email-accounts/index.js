// ============================================================
// EXEVORI VOICE IA — MODULE EMAIL ACCOUNTS (Phase 6B)
//
// Endpoints :
//   POST   /api/v1/email-accounts                  → create (+ imap_config)
//   GET    /api/v1/email-accounts                  → list par company
//   DELETE /api/v1/email-accounts/:id              → cascade imap_configs
//   POST   /api/v1/email-accounts/test-connection  → tester credentials AVANT save
//
// PATCH (édition) reporté Phase 6E (workflow V1 : delete + recreate).
// ============================================================

import express from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { encryptPassword, decryptPassword } from "../../lib/crypto.js";
import nodemailer from "nodemailer";
import imaps from "imap-simple";

dotenv.config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Templates providers (Zoho / Gmail / Outlook / Custom)
// Le frontend pré-remplit l'UI avec ces valeurs au choix du provider
// ─────────────────────────────────────────────────────────────
const PROVIDER_TEMPLATES = {
  zoho: {
    label: "Zoho Mail",
    imap_host: "imap.zoho.com",   imap_port: 993, imap_use_tls: true,
    smtp_host: "smtp.zoho.com",   smtp_port: 465, smtp_use_tls: true,
    help_url:  "https://www.zoho.com/mail/help/app-passwords.html",
    help_text: "Créez un mot de passe d'application dans Zoho (Mes comptes → Mots de passe d'application).",
  },
  gmail: {
    label: "Gmail / Google Workspace",
    imap_host: "imap.gmail.com",  imap_port: 993, imap_use_tls: true,
    smtp_host: "smtp.gmail.com",  smtp_port: 465, smtp_use_tls: true,
    help_url:  "https://support.google.com/accounts/answer/185833",
    help_text: "Activez la double authentification puis créez un mot de passe d'application Gmail.",
  },
  outlook: {
    label: "Outlook / Microsoft 365",
    imap_host: "outlook.office365.com", imap_port: 993, imap_use_tls: true,
    smtp_host: "smtp.office365.com",    smtp_port: 587, smtp_use_tls: true,  // STARTTLS sur 587
    help_url:  "https://support.microsoft.com/account-billing/app-passwords",
    help_text: "Activez la double auth Microsoft puis créez un mot de passe d'application.",
  },
  custom: {
    label: "Personnalisé (Hostpapa, OVH, cPanel, etc.)",
    imap_host: "", imap_port: 993, imap_use_tls: true,
    smtp_host: "", smtp_port: 465, smtp_use_tls: true,
    help_url:  "",
    help_text: "Renseignez manuellement les serveurs IMAP et SMTP fournis par votre hébergeur.",
  },
};

// GET templates (publié pour le wizard frontend)
router.get("/providers", (req, res) => res.json({ templates: PROVIDER_TEMPLATES }));

// ─────────────────────────────────────────────────────────────
// Helper: tester une connexion IMAP + SMTP
// Retourne {imap_ok, smtp_ok, error?}
// ─────────────────────────────────────────────────────────────
async function testImapSmtp({ imap_host, imap_port, imap_use_tls, smtp_host, smtp_port, smtp_use_tls, username, password }) {
  const result = { imap_ok: false, smtp_ok: false };

  // IMAP test
  try {
    const conn = await imaps.connect({
      imap: {
        user: username,
        password,
        host: imap_host,
        port: imap_port,
        tls: imap_use_tls,
        authTimeout: 8000,
        tlsOptions: { rejectUnauthorized: false }, // tolérant pour PMEs avec certifs auto-signés (Hostpapa parfois)
      },
    });
    await conn.openBox("INBOX");
    await conn.end();
    result.imap_ok = true;
  } catch (e) {
    result.imap_error = `IMAP: ${e.message}`;
  }

  // SMTP test (verify uniquement, pas d'envoi réel)
  try {
    const transporter = nodemailer.createTransport({
      host: smtp_host,
      port: smtp_port,
      secure: smtp_port === 465,            // SSL implicite sur 465
      requireTLS: smtp_use_tls && smtp_port !== 465, // STARTTLS sur 587
      auth: { user: username, pass: password },
      connectionTimeout: 8000,
      tls: { rejectUnauthorized: false },
    });
    await transporter.verify();
    result.smtp_ok = true;
  } catch (e) {
    result.smtp_error = `SMTP: ${e.message}`;
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// POST /test-connection — utile AVANT de cliquer Save
// body: {imap_host, imap_port, imap_use_tls, smtp_host, smtp_port, smtp_use_tls, username, password}
// ─────────────────────────────────────────────────────────────
router.post("/test-connection", express.json(), async (req, res) => {
  const cfg = req.body || {};
  const required = ["imap_host", "smtp_host", "username", "password"];
  for (const k of required) {
    if (!cfg[k]) return res.status(400).json({ error: `Champ requis manquant: ${k}` });
  }
  try {
    const r = await testImapSmtp({
      imap_host: cfg.imap_host,
      imap_port: cfg.imap_port || 993,
      imap_use_tls: cfg.imap_use_tls !== false,
      smtp_host: cfg.smtp_host,
      smtp_port: cfg.smtp_port || 465,
      smtp_use_tls: cfg.smtp_use_tls !== false,
      username: cfg.username,
      password: cfg.password,
    });
    return res.json({ success: r.imap_ok && r.smtp_ok, ...r });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST / — create email account + imap_config (transaction-like)
// body: {
//   company_id, provider, email, display_name?, signature?, tone?, auto_reply_threshold?, mode?, kb_filter?,
//   is_primary?,
//   imap: { imap_host, imap_port, imap_use_tls, smtp_host, smtp_port, smtp_use_tls, username, password }
// }
// ─────────────────────────────────────────────────────────────
router.post("/", express.json(), async (req, res) => {
  const {
    company_id, provider = "imap", email, display_name = null,
    signature = null, tone = "friendly", auto_reply_threshold = 0.85,
    mode = "draft_only", kb_filter = {}, is_primary = false, imap,
  } = req.body || {};

  if (!company_id || !email || !imap) {
    return res.status(400).json({ error: "company_id, email et imap requis" });
  }
  if (!imap.imap_host || !imap.smtp_host || !imap.username || !imap.password) {
    return res.status(400).json({ error: "imap.imap_host, imap.smtp_host, imap.username, imap.password requis" });
  }

  // Si is_primary → reset les autres
  if (is_primary) {
    await supabase.from("email_accounts")
      .update({ is_primary: false })
      .eq("company_id", company_id)
      .eq("is_primary", true);
  }

  // 1) Crée email_accounts
  const { data: account, error: aErr } = await supabase
    .from("email_accounts")
    .insert({
      company_id, provider, email, display_name,
      signature, tone, auto_reply_threshold, mode, kb_filter,
      is_primary, status: "active",
    })
    .select()
    .single();
  if (aErr) {
    if (aErr.code === "23505") return res.status(409).json({ error: "Ce courriel est déjà connecté pour cette entreprise" });
    return res.status(500).json({ error: aErr.message });
  }

  // 2) Chiffre le password + crée imap_configs
  let enc;
  try {
    enc = encryptPassword(imap.password);
  } catch (e) {
    // Rollback email_accounts
    await supabase.from("email_accounts").delete().eq("id", account.id);
    return res.status(500).json({ error: `Chiffrement échoué : ${e.message}` });
  }

  const { data: imapRow, error: iErr } = await supabase
    .from("imap_configs")
    .insert({
      email_account_id: account.id,
      company_id,
      imap_host: imap.imap_host,
      imap_port: imap.imap_port || 993,
      imap_use_tls: imap.imap_use_tls !== false,
      smtp_host: imap.smtp_host,
      smtp_port: imap.smtp_port || 465,
      smtp_use_tls: imap.smtp_use_tls !== false,
      username: imap.username,
      password_encrypted: enc.ciphertext,
      password_iv: enc.iv,
      password_tag: enc.tag,
    })
    .select("id, imap_host, imap_port, smtp_host, smtp_port, username, last_test_ok, last_test_at")
    .single();
  if (iErr) {
    await supabase.from("email_accounts").delete().eq("id", account.id);
    return res.status(500).json({ error: iErr.message });
  }

  return res.json({ success: true, account: { ...account, imap: imapRow } });
});

// ─────────────────────────────────────────────────────────────
// GET / — list par company
// ─────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const { company_id } = req.query;
  if (!company_id) return res.status(400).json({ error: "company_id requis" });

  try {
    const { data, error } = await supabase
      .from("email_accounts")
      .select(`
        id, company_id, provider, email, display_name, status, is_primary,
        signature, tone, auto_reply_threshold, mode, kb_filter,
        last_sync_at, sync_error, created_at, updated_at,
        imap_configs (id, imap_host, imap_port, smtp_host, smtp_port, username, last_test_ok, last_test_at, last_test_error)
      `)
      .eq("company_id", company_id)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true });
    if (error) throw error;
    return res.json({ accounts: data || [] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /:id — cascade imap_configs via FK
// ─────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("email_accounts").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

export default router;
