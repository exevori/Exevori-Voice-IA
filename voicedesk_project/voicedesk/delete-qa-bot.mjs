// ============================================================
// QA BOT CLEANUP — Suppression propre du compte test
// ============================================================
// Supprime profiles puis auth.users (ordre important)
// ============================================================

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const QA_EMAIL = "qa-bot@garage-tremblay.test";

const { data: list } = await supabase.auth.admin.listUsers();
const user = (list.users || []).find(u => u.email === QA_EMAIL);
if (!user) {
  console.log("ℹ️  Aucun qa-bot trouvé, rien à supprimer.");
  process.exit(0);
}

// 1) Delete profiles
const { error: pErr } = await supabase.from("profiles").delete().eq("user_id", user.id);
if (pErr) console.error("⚠️  profiles delete:", pErr.message);
else console.log("✅ profiles supprimé");

// 2) Delete auth.users
const { error: aErr } = await supabase.auth.admin.deleteUser(user.id);
if (aErr) { console.error("❌ auth.users delete:", aErr); process.exit(1); }
console.log("✅ auth.users supprimé — qa-bot effacé proprement.");
