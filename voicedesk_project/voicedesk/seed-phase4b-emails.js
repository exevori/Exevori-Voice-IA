// ============================================================
// EXEVORI VOICE IA — SEED Phase 4B (Emails + Drafts)
// 5 emails inbox + 3 drafts pending for Garage Tremblay
// Idempotent par (company_id, gmail_message_id).
// ============================================================

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: garage } = await supabase
  .from("companies")
  .select("id, name")
  .ilike("name", "%Tremblay%")
  .maybeSingle();
if (!garage) { console.error("Garage Tremblay missing — run seed-pme.js"); process.exit(1); }
const COMPANY_ID = garage.id;

const { data: contacts } = await supabase
  .from("contacts")
  .select("id, full_name, email")
  .eq("company_id", COMPANY_ID)
  .limit(8);
const pickContact = (i) => (contacts && contacts.length ? contacts[i % contacts.length] : null);

function ts(daysAgo, hour = 10, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

const EMAILS = [
  {
    gmail_message_id: "seed-4b-001",
    from_email: "marie.lavoie@gmail.com",
    from_name: "Marie Lavoie",
    subject: "Demande de prix pour pneus d'hiver Subaru Forester 2022",
    body: "Bonjour,\n\nJ'aimerais avoir un devis pour 4 pneus d'hiver pour ma Subaru Forester 2022, taille 225/60R17. Je préfèrerais des Michelin X-Ice si vous en avez en stock.\n\nMerci !\nMarie",
    received_at: ts(0, 14, 22),
    status: "processed",
    classification: "quote_request",
    confidence: 94,
    level: 2,
    ai_summary: "Demande devis 4 pneus d'hiver Michelin X-Ice 225/60R17 — Subaru Forester 2022. Cliente préfère Michelin.",
  },
  {
    gmail_message_id: "seed-4b-002",
    from_email: "p.gauthier@example.com",
    from_name: "Patrick Gauthier",
    subject: "Confirmation RDV mercredi 9h",
    body: "Bonjour, je confirme bien ma présence mercredi à 9h pour le changement de pneus. Merci !",
    received_at: ts(0, 8, 11),
    status: "processed",
    classification: "appointment_confirmation",
    confidence: 96,
    level: 1, // Accusé auto envoyé, pas de draft
    ai_summary: "Confirmation RDV mercredi 9h (changement pneus).",
  },
  {
    gmail_message_id: "seed-4b-003",
    from_email: "sophie.r@hotmail.com",
    from_name: "Sophie Roy",
    subject: "Question sur garantie pneus achetés en 2024",
    body: "Bonjour,\n\nJ'avais acheté un ensemble de pneus chez vous en octobre 2024 (facture #2024-1187). Un des pneus présente un défaut sur le flanc — est-ce couvert par la garantie ?\n\nJ'aimerais passer cette semaine si possible.\n\nMerci de votre retour,\nSophie",
    received_at: ts(1, 11, 5),
    status: "processed",
    classification: "support_request",
    confidence: 89,
    level: 2,
    ai_summary: "Question garantie pneus achetés oct 2024 (facture #2024-1187). Défaut sur flanc. Demande RDV cette semaine.",
  },
  {
    gmail_message_id: "seed-4b-004",
    from_email: "info@autopartsqc.com",
    from_name: "AutoParts QC (commercial)",
    subject: "Nouveau catalogue 2026 + promotions B2B",
    body: "Cher partenaire, veuillez trouver ci-joint notre catalogue 2026 avec les promotions exclusives revendeurs...",
    received_at: ts(2, 9, 30),
    status: "processed",
    classification: "spam",
    confidence: 78,
    level: 1,
    ai_summary: "Sollicitation commerciale fournisseur — catalogue + promos B2B. À archiver.",
  },
  {
    gmail_message_id: "seed-4b-005",
    from_email: "j.boucher@example.com",
    from_name: "Jérôme Boucher",
    subject: "Bruit aux freins arrière F-150 2018",
    body: "Bonjour,\n\nMon F-150 fait un bruit de grincement aux freins arrière depuis quelques jours. Avez-vous une disponibilité cette semaine pour une inspection ? Idéalement vendredi.\n\nMerci,\nJérôme Boucher",
    received_at: ts(0, 16, 47),
    status: "processed",
    classification: "service_request",
    confidence: 91,
    level: 2,
    ai_summary: "Bruit grincement freins arrière F-150 2018. Demande inspection cette semaine, idéalement vendredi.",
  },
];

// Cleanup idempotent
console.log("→ Cleaning previous seed emails...");
const msgIds = EMAILS.map((e) => e.gmail_message_id);
// Drafts first (FK constraint)
const { data: oldEmails } = await supabase
  .from("emails")
  .select("id")
  .eq("company_id", COMPANY_ID)
  .in("gmail_message_id", msgIds);
if (oldEmails?.length) {
  await supabase.from("email_drafts").delete().in("email_id", oldEmails.map((e) => e.id));
  await supabase.from("emails").delete().in("id", oldEmails.map((e) => e.id));
}

// Insert emails
console.log(`→ Inserting ${EMAILS.length} emails...`);
const emailRecords = EMAILS.map((e, i) => ({
  ...e,
  company_id: COMPANY_ID,
  contact_id: pickContact(i)?.id || null,
}));
const { data: insertedEmails, error: e1 } = await supabase
  .from("emails")
  .insert(emailRecords)
  .select();
if (e1) { console.error("emails insert:", e1); process.exit(1); }

// Build email-by-msgId lookup
const byMsgId = Object.fromEntries(insertedEmails.map((e) => [e.gmail_message_id, e]));

// Drafts — 3 plausibles
const DRAFTS = [
  {
    email_id: byMsgId["seed-4b-001"].id,
    to_email: byMsgId["seed-4b-001"].from_email,
    subject: "Re: Demande de prix pour pneus d'hiver Subaru Forester 2022",
    body: `Bonjour Marie,

Merci pour votre demande. Pour votre Subaru Forester 2022 en 225/60R17, voici notre proposition Michelin X-Ice Snow (disponibles en stock) :

  • 4 pneus Michelin X-Ice Snow 225/60R17 : 1 240 $
  • Pose + équilibrage : 120 $
  • Élimination des anciens pneus : inclus
  • Sous-total : 1 360 $ + taxes

Disponibilité immédiate. Voulez-vous prendre rendez-vous cette semaine ? J'ai des créneaux mercredi et vendredi matin.

Cordialement,
Équipe Garage Tremblay`,
    status: "pending_validation",
    ai_confidence: 88,
    ai_reasoning: "Réponse devis standard avec stock Michelin X-Ice confirmé. Proposition créneaux RDV.",
  },
  {
    email_id: byMsgId["seed-4b-003"].id,
    to_email: byMsgId["seed-4b-003"].from_email,
    subject: "Re: Question sur garantie pneus achetés en 2024",
    body: `Bonjour Sophie,

J'ai retrouvé votre facture #2024-1187. Les pneus achetés en octobre 2024 bénéficient effectivement de la garantie fabricant Bridgestone, qui couvre les défauts structurels du flanc.

Pouvez-vous passer mercredi prochain entre 10h et 16h ? Nous évaluerons le pneu sur place et, si la garantie s'applique, le remplacement sera gratuit (vous repartez avec le neuf le jour même).

Cordialement,
Équipe Garage Tremblay`,
    status: "pending_validation",
    ai_confidence: 75,
    ai_reasoning: "Demande garantie identifiée — facture trouvée. Recommandation : RDV inspection physique avant validation garantie. Confidence moyenne car dépend de l'évaluation visuelle.",
  },
  {
    email_id: byMsgId["seed-4b-005"].id,
    to_email: byMsgId["seed-4b-005"].from_email,
    subject: "Re: Bruit aux freins arrière F-150 2018",
    body: `Bonjour Jérôme,

Un grincement aux freins arrière indique généralement des plaquettes usées. Nous avons une disponibilité vendredi à 10h00 pour une inspection complète (environ 60 minutes).

Si remplacement nécessaire : compter 280-340 $ + taxes selon les pièces.

Confirmez-vous le RDV ?

Cordialement,
Équipe Garage Tremblay`,
    status: "pending_validation",
    ai_confidence: 92,
    ai_reasoning: "Diagnostic clair (plaquettes usées). Créneau vendredi 10h proposé conformément à la demande client.",
  },
];

console.log(`→ Inserting ${DRAFTS.length} drafts...`);
const draftRecords = DRAFTS.map((d) => ({ ...d, company_id: COMPANY_ID }));
const { error: e2 } = await supabase.from("email_drafts").insert(draftRecords);
if (e2) { console.error("drafts insert:", e2); process.exit(1); }

console.log(`✓ Seeded ${EMAILS.length} emails + ${DRAFTS.length} drafts for ${garage.name}`);
