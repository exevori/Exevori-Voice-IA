// ============================================================
// QA BOT — Compte test isolé pour testing_agent_v3_fork
// ============================================================
// Email     : qa-bot@garage-tremblay.test
// Password  : QaBot_Test_2026!
// Rôle      : company_admin (LIMITÉ — pas super_admin)
// Company   : Garage Tremblay (af5f079f-6fc2-4d70-8c8d-51d83d301906)
// Isolation : RLS via current_company_id() → aucun accès aux autres companies
// Idempotent: skip si user existe déjà
// ============================================================

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const QA_EMAIL = "qa-bot@garage-tremblay.test";
const QA_PASSWORD = "QaBot_Test_2026!";
const GARAGE_COMPANY_ID = "af5f079f-6fc2-4d70-8c8d-51d83d301906";

// 1) Vérifier que le user n'existe pas déjà (idempotent)
const { data: list, error: listErr } = await supabase.auth.admin.listUsers();
if (listErr) { console.error("❌ listUsers:", listErr); process.exit(1); }

let userId;
const existing = (list.users || []).find(u => u.email === QA_EMAIL);
if (existing) {
  console.log("⚠️  QA bot existe déjà — réutilisation. user_id=", existing.id);
  userId = existing.id;
} else {
  // 2) Créer auth.users via API admin (bcrypt auto)
  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
    email: QA_EMAIL,
    password: QA_PASSWORD,
    email_confirm: true,
    app_metadata: {
      company_id: GARAGE_COMPANY_ID,
      role: "company_admin"
    },
    user_metadata: {
      is_qa_bot: true,
      purpose: "automated_testing_only"
    }
  });
  if (authErr) { console.error("❌ auth.users:", authErr); process.exit(1); }
  userId = authData.user.id;
  console.log("✅ auth.users créé — user_id=", userId);
}

// 3) Vérifier / créer le profile
const { data: existingProfile } = await supabase
  .from("profiles")
  .select("id, role, company_id")
  .eq("user_id", userId)
  .maybeSingle();

let profileId;
if (existingProfile) {
  console.log("⚠️  Profile existe déjà — réutilisation. profile_id=", existingProfile.id);
  profileId = existingProfile.id;
  // Vérification sécurité
  if (existingProfile.role !== "company_admin" || existingProfile.company_id !== GARAGE_COMPANY_ID) {
    console.error("❌ SÉCURITÉ: Le profile existant n'a pas les bons droits!", existingProfile);
    process.exit(1);
  }
} else {
  const { data: profile, error: profErr } = await supabase
    .from("profiles")
    .insert({
      user_id: userId,
      company_id: GARAGE_COMPANY_ID,
      full_name: "QA Bot (Automated Testing)",
      email: QA_EMAIL,
      role: "company_admin",
      status: "active",
      preferred_language: "fr-CA"
    })
    .select()
    .single();
  if (profErr) { console.error("❌ profiles:", profErr); process.exit(1); }
  profileId = profile.id;
  console.log("✅ profiles créé — profile_id=", profileId);
}

console.log("\n🎉 QA bot prêt:");
console.log("   EMAIL     :", QA_EMAIL);
console.log("   PASS      :", QA_PASSWORD);
console.log("   ROLE      : company_admin (Garage Tremblay UNIQUEMENT)");
console.log("   USER_ID   :", userId);
console.log("   PROFILE_ID:", profileId);
console.log("   COMPANY_ID:", GARAGE_COMPANY_ID);
