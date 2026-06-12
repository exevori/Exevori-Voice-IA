// ============================================================
// SEED — Garage Tremblay (Lévis) — PME démo Phase 2
// Lancement : node infra/scripts/seed-garage-tremblay.js
// ============================================================

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const COMPANY_NAME = "Garage Tremblay";
const today = new Date();
const isoNow = today.toISOString();
const minsAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
const daysFromNow = (d) => {
  const dt = new Date();
  dt.setDate(dt.getDate() + d);
  return dt.toISOString().slice(0, 10);
};

async function safe(label, fn) {
  try {
    const res = await fn();
    if (res.error) {
      console.error(`❌ ${label}:`, res.error.message);
      process.exit(1);
    }
    console.log(`✅ ${label}`);
    return res.data;
  } catch (err) {
    console.error(`❌ ${label}:`, err.message);
    process.exit(1);
  }
}

// ── 1) Cleanup si déjà existante ─────────────────────────────
console.log("\n=== CLEANUP ===");
const { data: existing } = await supabase
  .from("companies")
  .select("id")
  .eq("name", COMPANY_NAME)
  .maybeSingle();

if (existing) {
  console.log(`⚠️  Supprime PME existante (id=${existing.id})…`);
  const cid = existing.id;
  // Order: dependents first
  for (const tbl of [
    "learning_suggestions", "knowledge_base", "appointments",
    "email_drafts", "emails", "calls", "outbound_calls",
    "contact_notes", "contacts", "assistant_configs",
    "subscriptions", "profiles",
  ]) {
    await supabase.from(tbl).delete().eq("company_id", cid);
  }
  await supabase.from("companies").delete().eq("id", cid);
  console.log("✅ Cleanup OK");
}

// ── 2) Company ────────────────────────────────────────────────
console.log("\n=== INSERT ===");
const company = await safe("company", () =>
  supabase.from("companies").insert({
    name: COMPANY_NAME,
    contact_name: "Sylvain Tremblay",
    contact_email: "sylvain@garage-tremblay.ca",
    phone: "+14186891234",
    city: "Lévis",
    province: "Québec",
    country: "CA",
    sector: "Automobile — Mécanique",
    size: "PME (5-15 employés)",
    plan: "essentiel",
    status: "active",
    preferred_language: "fr-CA",
    assistant_name: "Marie",
  }).select().single()
);
const COMPANY_ID = company.id;
console.log(`   ↳ company_id = ${COMPANY_ID}`);

// ── 3) Subscription ──────────────────────────────────────────
await safe("subscription", () =>
  supabase.from("subscriptions").insert({
    company_id: COMPANY_ID,
    plan_name: "essentiel",
    plan_label: "Essentiel",
    monthly_price: 319.00,
    billing_cycle: "monthly",
    payment_status: "active",
    minutes_included: 1000,
    minutes_used_current_period: 234.5,
    overage_rate_usd: 0.25,
    current_period_start: daysFromNow(-12),
    current_period_end: daysFromNow(18),
    next_payment_date: daysFromNow(18),
  })
);

// ── 4) Assistant config ──────────────────────────────────────
await safe("assistant_config", () =>
  supabase.from("assistant_configs").insert({
    company_id: COMPANY_ID,
    assistant_name: "Marie",
    assistant_gender: "feminine",
    voice_id: "nova",
    voice_model: "flash_v2_5",
    tone: "professional",
    language_primary: "fr-CA",
    greeting_inbound_fr: "Bonjour, Garage Tremblay, ici Marie. Comment puis-je vous aider?",
    greeting_inbound_en: "Hello, Garage Tremblay, this is Marie. How can I help you?",
    email_from: "marie@garage-tremblay.ca",
    transfer_phone: "+14186891234",
    transfer_triggers: ["urgence", "remorquage", "humain"],
  })
);

// ── 5) Contacts (6) ──────────────────────────────────────────
const contacts = await safe("contacts (6)", () =>
  supabase.from("contacts").insert([
    { company_id: COMPANY_ID, full_name: "Jean-Philippe Côté", first_name: "Jean-Philippe", last_name: "Côté", email: "jp.cote@gmail.com", phone: "+14185553301", status: "hot", source: "call", main_need: "Changement pneus + freins", urgency: "high", tags: ["pneus", "freins"], last_interaction_at: minsAgo(15) },
    { company_id: COMPANY_ID, full_name: "Marie-Claude Bélanger", first_name: "Marie-Claude", last_name: "Bélanger", email: "mc.belanger@outlook.com", phone: "+14185554567", status: "warm", source: "call", main_need: "Diagnostic moteur", urgency: "normal", tags: ["diagnostic"], last_interaction_at: minsAgo(180) },
    { company_id: COMPANY_ID, full_name: "Patrick Lemieux", first_name: "Patrick", last_name: "Lemieux", email: "p.lemieux@hotmail.ca", phone: "+14185556789", status: "customer", source: "manual", main_need: "Entretien régulier", urgency: "low", tags: ["entretien"], last_interaction_at: minsAgo(60 * 24 * 3) },
    { company_id: COMPANY_ID, full_name: "Stéphanie Roy", first_name: "Stéphanie", last_name: "Roy", email: "s.roy@gmail.com", phone: "+14185559012", status: "warm", source: "email", main_need: "Pneus hiver — devis", urgency: "normal", tags: ["pneus"], last_interaction_at: minsAgo(60 * 5) },
    { company_id: COMPANY_ID, full_name: "François Pelletier", first_name: "François", last_name: "Pelletier", phone: "+14185553344", status: "new", source: "call", main_need: "Premier contact", urgency: "normal", last_interaction_at: minsAgo(45) },
    { company_id: COMPANY_ID, full_name: "Nadia Lévesque", first_name: "Nadia", last_name: "Lévesque", email: "nadia@levesque.ca", phone: "+14185557788", status: "cold", source: "csv_import", main_need: "Inspection achat usagé", urgency: "low", tags: ["inspection"], last_interaction_at: minsAgo(60 * 24 * 14) },
  ]).select()
);

// ── 6) Calls (4 today) ───────────────────────────────────────
await safe("calls (4 today)", () =>
  supabase.from("calls").insert([
    { company_id: COMPANY_ID, contact_id: contacts[0].id, caller_phone: contacts[0].phone, caller_name: contacts[0].full_name, duration_seconds: 312, status: "completed", intent: "rdv_pneus_freins", outcome: "appointment_booked", language_used: "fr-CA", ai_summary: "Client demande RDV pour changement de pneus d'hiver + inspection des freins. RDV confirmé jeudi 10h.", confidence_score: 94, ended_at: minsAgo(15), created_at: minsAgo(20) },
    { company_id: COMPANY_ID, contact_id: contacts[4].id, caller_phone: contacts[4].phone, caller_name: contacts[4].full_name, duration_seconds: 154, status: "completed", intent: "info_pneus", outcome: "info_provided", language_used: "fr-CA", ai_summary: "Premier appel — demande infos prix pneus hiver. Devis envoyé par email.", confidence_score: 88, ended_at: minsAgo(45), created_at: minsAgo(50) },
    { company_id: COMPANY_ID, contact_id: contacts[1].id, caller_phone: contacts[1].phone, caller_name: contacts[1].full_name, duration_seconds: 410, status: "completed", intent: "diagnostic_moteur", outcome: "appointment_booked", language_used: "fr-CA", ai_summary: "Bruit anormal moteur — RDV diagnostic vendredi 14h. Transféré technicien.", confidence_score: 91, ended_at: minsAgo(180), created_at: minsAgo(187) },
    { company_id: COMPANY_ID, caller_phone: "+14185559876", duration_seconds: 0, status: "in_progress", intent: null, language_used: "fr-CA", created_at: minsAgo(2) },
  ])
);

// ── 7) Emails + draft ────────────────────────────────────────
const emails = await safe("emails (2)", () =>
  supabase.from("emails").insert([
    { company_id: COMPANY_ID, contact_id: contacts[3].id, gmail_message_id: "gmail-msg-001-" + Date.now(), from_email: contacts[3].email, from_name: contacts[3].full_name, subject: "Demande devis pneus hiver Honda Civic 2020", body: "Bonjour, j'aimerais un devis pour 4 pneus d'hiver pour ma Honda Civic 2020...", received_at: minsAgo(90), status: "processed", classification: "quote_request", confidence: 92, level: 2, ai_summary: "Demande devis 4 pneus hiver Honda Civic 2020." },
    { company_id: COMPANY_ID, gmail_message_id: "gmail-msg-002-" + Date.now(), from_email: "info@distributeur-pneus.com", from_name: "Distributeur Pneus QC", subject: "Nouveau catalogue pneus hiver 2026", body: "Cher partenaire...", received_at: minsAgo(60 * 6), status: "received", classification: "newsletter", confidence: 99, level: 1 },
  ]).select()
);

await safe("email_drafts (1 pending)", () =>
  supabase.from("email_drafts").insert({
    company_id: COMPANY_ID,
    email_id: emails[0].id,
    to_email: contacts[3].email,
    subject: "Re: Demande devis pneus hiver Honda Civic 2020",
    body: "Bonjour Stéphanie,\n\nMerci pour votre demande. Voici notre devis pour 4 pneus d'hiver Michelin X-Ice Snow pour Honda Civic 2020:\n\n- 4 pneus 215/55R16: 1 196$ + tx\n- Pose et balancement: 120$\n- Total: 1 316$ + tx\n\nDisponibilité immédiate. Souhaitez-vous prendre rendez-vous?\n\nMarie\nGarage Tremblay",
    status: "pending_validation",
    ai_confidence: 89,
    ai_reasoning: "Réponse standard devis pneus avec calcul automatique selon catalogue Michelin X-Ice Snow.",
  })
);

// ── 8) Appointments (2 upcoming) ─────────────────────────────
await safe("appointments (2)", () =>
  supabase.from("appointments").insert([
    { company_id: COMPANY_ID, contact_id: contacts[0].id, source: "call", date: daysFromNow(2), time: "10:00", duration_min: 90, type: "Pneus + freins", status: "confirmed", channel: "phone", notes: "Pneus d'hiver Michelin + inspection complète freins" },
    { company_id: COMPANY_ID, contact_id: contacts[1].id, source: "call", date: daysFromNow(3), time: "14:00", duration_min: 60, type: "Diagnostic moteur", status: "pending", channel: "phone", notes: "Bruit anormal au démarrage à froid" },
  ])
);

// ── 9) Knowledge base (4) ────────────────────────────────────
await safe("knowledge_base (4)", () =>
  supabase.from("knowledge_base").insert([
    { company_id: COMPANY_ID, question: "Quelles sont vos heures d'ouverture?", answer: "Lundi au vendredi 7h30 à 18h, samedi 8h à 14h, fermé dimanche.", category: "horaires", status: "active", usage_count: 47 },
    { company_id: COMPANY_ID, question: "Combien coûte un changement de pneus?", answer: "Pose + balancement: 120$ pour 4 pneus. Pneus à partir de 159$/unité selon modèle.", category: "tarifs", status: "active", usage_count: 89 },
    { company_id: COMPANY_ID, question: "Faites-vous le remorquage?", answer: "Non, nous ne faisons pas de remorquage. Nous recommandons CAA-Québec (1-800-222-4357).", category: "services", status: "active", usage_count: 12 },
    { company_id: COMPANY_ID, question: "Quels modes de paiement acceptez-vous?", answer: "Comptant, débit Interac, Visa, Mastercard. Pas d'Amex. Financement disponible pour réparations majeures.", category: "paiement", status: "active", usage_count: 23 },
  ])
);

// ── 10) Learning suggestion (1 pending) ──────────────────────
await safe("learning_suggestion (1)", () =>
  supabase.from("learning_suggestions").insert({
    company_id: COMPANY_ID,
    type: "new_faq",
    question: "Faites-vous l'inspection mécanique pour achat de véhicule usagé?",
    proposed_answer: "Oui, nous offrons l'inspection prélivraison pour achat de véhicule usagé. Forfait complet 89$ — diagnostic 60 points avec rapport écrit. Sur rendez-vous.",
    source: "calls_repeated",
    occurrences: 5,
    confidence: 87,
    status: "pending",
  })
);

console.log("\n🎉 PME démo créée avec succès !");
console.log("===================================");
console.log(`company_id      : ${COMPANY_ID}`);
console.log(`name            : ${COMPANY_NAME}`);
console.log(`contact         : Sylvain Tremblay`);
console.log(`assistant_name  : Marie`);
console.log(`contacts        : 6 (hot/warm/customer/new/cold)`);
console.log(`calls today     : 4 (3 complétés + 1 en cours)`);
console.log(`emails          : 2 + 1 draft pending`);
console.log(`appointments    : 2 upcoming`);
console.log(`knowledge_base  : 4 FAQ`);
console.log(`suggestions     : 1 pending`);
console.log("===================================\n");
