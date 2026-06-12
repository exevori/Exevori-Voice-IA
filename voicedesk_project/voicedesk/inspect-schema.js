// Inspect schema for calls / emails / email_drafts / call_transcripts (and friends)
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const tables = ["calls", "outbound_calls", "call_transcripts", "emails", "email_drafts", "appointments"];

for (const t of tables) {
  // Fetch zero rows just to see the shape if any row exists, plus count
  const { data, error, count } = await supabase
    .from(t)
    .select("*", { count: "exact" })
    .limit(1);
  if (error) {
    console.log(`\n=== ${t} ===\nERROR: ${error.message}`);
    continue;
  }
  const sample = data?.[0] || null;
  console.log(`\n=== ${t} (rows=${count ?? 0}) ===`);
  if (sample) {
    for (const [k, v] of Object.entries(sample)) {
      const type = v === null ? "null?" : Array.isArray(v) ? "array" : typeof v;
      const preview = typeof v === "string" ? v.slice(0, 60) : JSON.stringify(v)?.slice(0, 80);
      console.log(`  ${k.padEnd(28)} ${type.padEnd(10)} ${preview ?? ""}`);
    }
  } else {
    // Try inserting a probe to see required columns via error message
    const { error: ie } = await supabase.from(t).insert({}).select();
    console.log("  (empty table)  probe-insert error:", ie?.message || "ok?");
  }
}
