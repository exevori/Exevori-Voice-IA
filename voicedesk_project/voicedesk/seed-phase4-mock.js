// ============================================================
// EXEVORI VOICE IA — SEED Phase 4 (Calls + future Emails)
// Réutilisable pour démos client. Idempotent par (company_id, caller_phone, created_at).
// ============================================================

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Garage Tremblay (PME mock seedée précédemment)
const GARAGE_QUERY = await supabase
  .from("companies")
  .select("id, name")
  .ilike("name", "%Tremblay%")
  .maybeSingle();

if (!GARAGE_QUERY.data) {
  console.error("Company 'Garage Tremblay' introuvable. Run seed-pme.js d'abord.");
  process.exit(1);
}

const COMPANY_ID = GARAGE_QUERY.data.id;
console.log("→ Seeding pour:", GARAGE_QUERY.data.name, COMPANY_ID);

// Récupère qq contacts existants (best-effort)
const { data: contacts } = await supabase
  .from("contacts")
  .select("id, full_name, phone")
  .eq("company_id", COMPANY_ID)
  .limit(5);

const pickContact = (i) => (contacts && contacts[i % contacts.length]) || null;

function ts(daysAgo, hour = 10, minute = 30) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

// 7 appels variés (status + intent + confidence + transcripts FR plausibles)
const CALLS = [
  {
    caller_phone: "+14185557701",
    caller_name: "Marie-Hélène Tremblay",
    duration_seconds: 287,
    status: "completed",
    intent: "rdv_pneus",
    outcome: "appointment_booked",
    language_used: "fr-CA",
    ai_summary: "Cliente fidèle. Demande RDV pour pose pneus d'hiver Bridgestone Blizzak sur Toyota RAV4 2021. Disponible mercredi matin. Rappel : prévoir 90 min.",
    confidence_score: 96,
    ai_transcript: [
      { role: "assistant", text: "Bonjour, Garage Tremblay, comment puis-je vous aider ?", ts: 0 },
      { role: "caller",    text: "Bonjour, je voudrais prendre un rendez-vous pour mes pneus d'hiver.", ts: 4 },
      { role: "assistant", text: "Bien sûr. Quel est le modèle de votre véhicule ?", ts: 9 },
      { role: "caller",    text: "Un Toyota RAV4 2021. J'aimerais des Bridgestone Blizzak.", ts: 13 },
      { role: "assistant", text: "Parfait. J'ai une disponibilité mercredi prochain à 9h00 ou jeudi à 14h00. Lequel préférez-vous ?", ts: 20 },
      { role: "caller",    text: "Mercredi à 9h ça fonctionne.", ts: 28 },
      { role: "assistant", text: "Excellent. Je vous confirme RDV mercredi 9h00 pour pose pneus d'hiver. Comptez 90 minutes. Voulez-vous un texto de rappel la veille ?", ts: 32 },
      { role: "caller",    text: "Oui s'il vous plaît, sur ce numéro.", ts: 41 },
      { role: "assistant", text: "C'est noté. Bonne journée et merci de votre fidélité !", ts: 45 },
    ],
    ended_at: ts(1, 9, 5),
    created_at: ts(1, 9, 0),
  },
  {
    caller_phone: "+15145557702",
    caller_name: "François Boulanger",
    duration_seconds: 142,
    status: "completed",
    intent: "info_prix",
    outcome: "info_provided",
    language_used: "fr-CA",
    ai_summary: "Demande de prix pour 4 pneus d'hiver 215/55R17. Client va comparer puis rappeler. Devis envoyé par courriel.",
    confidence_score: 91,
    ai_transcript: [
      { role: "assistant", text: "Garage Tremblay, bonjour !", ts: 0 },
      { role: "caller",    text: "Bonjour, je cherche un prix pour 4 pneus d'hiver, taille 215/55R17.", ts: 3 },
      { role: "assistant", text: "Parfait. Je peux vous proposer 3 gammes : économique à 720$, intermédiaire à 950$ et premium à 1180$ installés. Préférez-vous recevoir le devis détaillé par courriel ?", ts: 9 },
      { role: "caller",    text: "Oui par courriel, francois.b@example.com", ts: 25 },
      { role: "assistant", text: "C'est noté. Le devis vous arrive dans les prochaines minutes. Avez-vous d'autres questions ?", ts: 31 },
      { role: "caller",    text: "Non c'est tout, merci.", ts: 38 },
    ],
    ended_at: ts(2, 14, 22),
    created_at: ts(2, 14, 20),
  },
  {
    caller_phone: "+14185557703",
    caller_name: "Sophie Lavigne",
    duration_seconds: 56,
    status: "transferred",
    intent: "urgence_remorquage",
    outcome: "transferred_human",
    language_used: "fr-CA",
    ai_summary: "Urgence remorquage sur l'autoroute 20. Transférée immédiatement au superviseur de garde. Localisation : km 312, direction est.",
    confidence_score: 88,
    ai_transcript: [
      { role: "caller",    text: "Allo, ma voiture est en panne sur l'autoroute 20 !", ts: 0 },
      { role: "assistant", text: "Je comprends, c'est une urgence. Pouvez-vous me dire où exactement ?", ts: 2 },
      { role: "caller",    text: "Au km 312, direction est. Je suis sur l'accotement.", ts: 6 },
      { role: "assistant", text: "Restez en sécurité. Je vous transfère immédiatement à notre superviseur de garde pour un remorquage prioritaire. Un instant.", ts: 12 },
      { role: "transfer",  text: "Transfert effectué vers superviseur garde (poste 03).", ts: 18 },
    ],
    ended_at: ts(0, 16, 41),
    created_at: ts(0, 16, 40),
  },
  {
    caller_phone: "+15145557704",
    caller_name: "Inconnu",
    duration_seconds: 18,
    status: "abandoned",
    intent: "indetermine",
    outcome: "abandoned",
    language_used: "fr-CA",
    ai_summary: "Appel raccroché après salutation. Numéro probablement composé par erreur.",
    confidence_score: 42,
    ai_transcript: [
      { role: "assistant", text: "Bonjour, Garage Tremblay, comment puis-je vous aider ?", ts: 0 },
      { role: "caller",    text: "(silence puis raccroché)", ts: 8 },
    ],
    ended_at: ts(3, 11, 18),
    created_at: ts(3, 11, 18),
  },
  {
    caller_phone: "+18195557705",
    caller_name: "Jean-Pierre Caron",
    duration_seconds: 198,
    status: "completed",
    intent: "support_freins",
    outcome: "appointment_booked",
    language_used: "fr-CA",
    ai_summary: "Bruit de grincement aux freins arrière sur F-150 2018. RDV inspection lundi 14h. Recommandation : ne pas tarder.",
    confidence_score: 93,
    ai_transcript: [
      { role: "assistant", text: "Garage Tremblay, bonjour.", ts: 0 },
      { role: "caller",    text: "Bonjour, j'ai un bruit bizarre aux freins arrière de mon F-150.", ts: 4 },
      { role: "assistant", text: "Quel type de bruit ? Grincement, craquement, sifflement ?", ts: 11 },
      { role: "caller",    text: "Un grincement, surtout en freinage à basse vitesse.", ts: 18 },
      { role: "assistant", text: "Ça ressemble à des plaquettes en fin de vie. C'est à inspecter rapidement. J'ai lundi 14h ou mardi 10h.", ts: 24 },
      { role: "caller",    text: "Lundi 14h, parfait.", ts: 32 },
      { role: "assistant", text: "C'est confirmé. Pouvez-vous éviter les longs trajets d'ici là ? Si le bruit augmente, appelez-nous.", ts: 36 },
      { role: "caller",    text: "OK merci !", ts: 42 },
    ],
    ended_at: ts(5, 10, 3),
    created_at: ts(5, 10, 0),
  },
  {
    caller_phone: "+15145557706",
    caller_name: "Lyne Bouchard",
    duration_seconds: 65,
    status: "in_progress",
    intent: "info_horaires",
    outcome: null,
    language_used: "fr-CA",
    ai_summary: "Appel en cours — demande d'horaires d'ouverture samedi.",
    confidence_score: 78,
    ai_transcript: [
      { role: "assistant", text: "Garage Tremblay, bonjour !", ts: 0 },
      { role: "caller",    text: "Bonjour, êtes-vous ouverts ce samedi ?", ts: 3 },
      { role: "assistant", text: "Oui, samedi nous sommes ouverts de 8h à 16h. Vous voulez prendre RDV ?", ts: 7 },
    ],
    ended_at: null,
    created_at: ts(0, 17, 22),
  },
  {
    caller_phone: "+14385557707",
    caller_name: "Karim Vendor",
    duration_seconds: 88,
    status: "completed",
    intent: "rappel_promotion",
    outcome: "info_provided",
    language_used: "fr-CA",
    ai_summary: "Client rappelle suite SMS promo pneus -15%. Confirmation des conditions et redirige vers prise RDV en ligne.",
    confidence_score: 89,
    ai_transcript: [
      { role: "caller",    text: "Bonjour, j'ai reçu un texto pour la promo pneus à -15%, c'est encore valide ?", ts: 0 },
      { role: "assistant", text: "Oui, la promotion est valide jusqu'au 30 novembre. Elle s'applique sur les marques participantes — Michelin, Bridgestone et Continental. Voulez-vous prendre RDV maintenant ?", ts: 5 },
      { role: "caller",    text: "Je préfère y penser, est-ce que vous m'envoyez un lien pour réserver en ligne ?", ts: 19 },
      { role: "assistant", text: "Bien sûr. Je vous envoie le lien par texto à ce numéro. À bientôt !", ts: 28 },
    ],
    ended_at: ts(4, 13, 12),
    created_at: ts(4, 13, 11),
  },
];

// Idempotence : delete existing seeded calls for this phone+company, then re-insert.
console.log("→ Cleaning previous mock calls (idempotent)...");
const phones = CALLS.map((c) => c.caller_phone);
const { error: delErr } = await supabase
  .from("calls")
  .delete()
  .eq("company_id", COMPANY_ID)
  .in("caller_phone", phones);
if (delErr) console.warn("delete warn:", delErr.message);

console.log(`→ Inserting ${CALLS.length} mock calls...`);
const records = CALLS.map((c, i) => ({
  ...c,
  company_id: COMPANY_ID,
  contact_id: pickContact(i)?.id || null,
}));

const { error } = await supabase.from("calls").insert(records);
if (error) {
  console.error("INSERT ERROR:", error);
  process.exit(1);
}
console.log("✓ Seeded", CALLS.length, "calls for", GARAGE_QUERY.data.name);
