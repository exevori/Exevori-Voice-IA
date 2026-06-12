// Set a stable password for the testing agent on contact@exevori.com
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const EMAIL = "contact@exevori.com";
const PASSWORD = "Exevori_Test_2026!";

// Find user
const { data: list, error: listErr } = await supabase.auth.admin.listUsers();
if (listErr) { console.error(listErr); process.exit(1); }
const user = (list.users || []).find((u) => u.email === EMAIL);
if (!user) { console.error("User not found:", EMAIL); process.exit(1); }

const { error } = await supabase.auth.admin.updateUserById(user.id, { password: PASSWORD });
if (error) { console.error(error); process.exit(1); }
console.log("OK — password updated for", EMAIL);
console.log("PASSWORD:", PASSWORD);
