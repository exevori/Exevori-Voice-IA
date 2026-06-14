// ============================================================
// EXEVORI VOICE IA — MODULE TWILIO CONFIG (Phase 6D)
//
// 1 config Twilio par PME (UNIQUE constraint company_id).
//   GET    /api/v1/twilio-config?company_id=...        → config courante (sans auth_token)
//   PUT    /api/v1/twilio-config                       → upsert (create or replace) avec chiffrement auth_token
//   DELETE /api/v1/twilio-config?company_id=...        → delete
//   POST   /api/v1/twilio-config/test                  → valide credentials AVANT save (GET account Twilio)
//
// Pas d'usage Twilio API ici — c'est Phase 8 (voice webhooks).
// Cette phase = juste config UI + storage sécurisé.
// ============================================================

import express from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { encryptPassword, decryptPassword } from "../../lib/crypto.js";

dotenv.config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const router = express.Router();

// E.164 simple validation: + suivi de 8-15 chiffres
const E164_REGEX = /^\+[1-9]\d{7,14}$/;
const SID_REGEX  = /^AC[a-fA-F0-9]{32}$/;

// Helper: validate creds against Twilio API (GET account)
async function verifyTwilioCreds(sid, token) {
  try {
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 401) return { ok: false, error: "Identifiants Twilio invalides (401)" };
    if (!r.ok) return { ok: false, error: `Twilio HTTP ${r.status}` };
    const data = await r.json();
    return {
      ok: true,
      friendly_name: data.friendly_name || "Compte Twilio",
      status: data.status,
    };
  } catch (e) {
    return { ok: false, error: `Connexion Twilio échouée : ${e.message}` };
  }
}

// GET — config courante (sans auth_token)
router.get("/", async (req, res) => {
  const { company_id } = req.query;
  if (!company_id) return res.status(400).json({ error: "company_id requis" });
  try {
    const { data, error } = await supabase
      .from("twilio_configs")
      .select("id, company_id, account_sid, phone_number, phone_number_sid, forwarding_number, status, last_test_at, last_test_ok, last_test_error, twilio_account_name, created_at, updated_at")
      .eq("company_id", company_id)
      .maybeSingle();
    if (error) throw error;
    return res.json({ config: data || null });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /test — vérifie credentials Twilio sans sauvegarder
router.post("/test", express.json(), async (req, res) => {
  const { account_sid, auth_token } = req.body || {};
  if (!account_sid || !auth_token) return res.status(400).json({ error: "account_sid et auth_token requis" });
  if (!SID_REGEX.test(account_sid))   return res.status(400).json({ error: "Format account_sid invalide (doit commencer par AC + 32 hex)" });
  const r = await verifyTwilioCreds(account_sid, auth_token);
  return res.json(r);
});

// PUT — upsert (create or replace)
router.put("/", express.json(), async (req, res) => {
  const {
    company_id, account_sid, auth_token,
    phone_number, phone_number_sid = null, forwarding_number = null,
  } = req.body || {};

  if (!company_id || !account_sid || !auth_token || !phone_number) {
    return res.status(400).json({ error: "company_id, account_sid, auth_token et phone_number requis" });
  }
  if (!SID_REGEX.test(account_sid))    return res.status(400).json({ error: "Format account_sid invalide" });
  if (!E164_REGEX.test(phone_number))  return res.status(400).json({ error: "phone_number doit être au format E.164 (ex: +14186891234)" });
  if (forwarding_number && !E164_REGEX.test(forwarding_number)) {
    return res.status(400).json({ error: "forwarding_number doit être au format E.164" });
  }

  // Verify with Twilio API
  const verify = await verifyTwilioCreds(account_sid, auth_token);

  // Chiffre auth_token
  let enc;
  try {
    enc = encryptPassword(auth_token);
  } catch (e) {
    return res.status(500).json({ error: `Chiffrement échoué : ${e.message}` });
  }

  const row = {
    company_id,
    account_sid,
    auth_token_encrypted: enc.ciphertext,
    auth_token_iv:        enc.iv,
    auth_token_tag:       enc.tag,
    phone_number,
    phone_number_sid,
    forwarding_number,
    status: verify.ok ? "active" : "error",
    last_test_at: new Date().toISOString(),
    last_test_ok: verify.ok,
    last_test_error: verify.ok ? null : verify.error,
    twilio_account_name: verify.ok ? verify.friendly_name : null,
    updated_at: new Date().toISOString(),
  };

  try {
    const { data, error } = await supabase
      .from("twilio_configs")
      .upsert(row, { onConflict: "company_id" })
      .select("id, company_id, account_sid, phone_number, phone_number_sid, forwarding_number, status, last_test_at, last_test_ok, last_test_error, twilio_account_name, created_at, updated_at")
      .single();
    if (error) throw error;
    return res.json({ success: true, config: data, verified: verify.ok, verify_error: verify.ok ? null : verify.error });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE
router.delete("/", async (req, res) => {
  const { company_id } = req.query;
  if (!company_id) return res.status(400).json({ error: "company_id requis" });
  const { error } = await supabase.from("twilio_configs").delete().eq("company_id", company_id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

export default router;
