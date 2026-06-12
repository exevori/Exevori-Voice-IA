// Mint une session JWT pour contact@exevori.com via admin API
// Usage : node test-jwt.js
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const EMAIL = "contact@exevori.com";

// Méthode admin : générer un magic link et extraire le hashed_token,
// puis échanger contre une session (ou utiliser directement le access_token issu)
const { data, error } = await supabase.auth.admin.generateLink({
  type: "magiclink",
  email: EMAIL,
});

if (error) {
  console.error("[GENERATE LINK ERR]", JSON.stringify(error, null, 2));
  process.exit(1);
}

console.log("=== generateLink response ===");
console.log("action_link:", data.properties?.action_link);
console.log("email_otp:", data.properties?.email_otp);
console.log("hashed_token:", data.properties?.hashed_token);
console.log("verification_type:", data.properties?.verification_type);

// Plus simple : utiliser le verifyOtp avec le hashed_token pour obtenir une session
const verify = await supabase.auth.verifyOtp({
  token_hash: data.properties.hashed_token,
  type: "magiclink",
});

if (verify.error) {
  console.error("[VERIFY ERR]", JSON.stringify(verify.error, null, 2));
  process.exit(1);
}

console.log("\n=== SESSION ===");
console.log("access_token:", verify.data.session?.access_token);
console.log("refresh_token:", verify.data.session?.refresh_token);
console.log("user.id:", verify.data.user?.id);
console.log("user.email:", verify.data.user?.email);
