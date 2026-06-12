// Liste les companies qui s'appellent "Exevori" + leurs détails clés
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: cos } = await supabase
  .from("companies")
  .select("id, name, contact_name, contact_email, city, plan, status, assistant_name, created_at")
  .ilike("name", "%exevori%")
  .order("created_at", { ascending: true });

for (const c of cos) {
  // Count related rows
  const [{ count: profiles }, { count: subs }, { count: configs }, { count: contacts }] = await Promise.all([
    supabase.from("profiles").select("*", { count: "exact", head: true }).eq("company_id", c.id),
    supabase.from("subscriptions").select("*", { count: "exact", head: true }).eq("company_id", c.id),
    supabase.from("assistant_configs").select("*", { count: "exact", head: true }).eq("company_id", c.id),
    supabase.from("contacts").select("*", { count: "exact", head: true }).eq("company_id", c.id),
  ]);
  console.log("─".repeat(70));
  console.log(`id           : ${c.id}`);
  console.log(`name         : ${c.name}`);
  console.log(`contact      : ${c.contact_name || "—"} <${c.contact_email || "—"}>`);
  console.log(`city / plan  : ${c.city || "—"} / ${c.plan || "—"} / ${c.status}`);
  console.log(`assistant    : ${c.assistant_name || "—"}`);
  console.log(`created_at   : ${c.created_at}`);
  console.log(`linked rows  : profiles=${profiles} subs=${subs} assistant_configs=${configs} contacts=${contacts}`);
}
