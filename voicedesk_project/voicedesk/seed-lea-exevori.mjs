// ============================================================
// EXEVORI VOICE IA — Seed Léa Exevori (Phase 8B inbound test)
//   - assistant_configs pour Exevori (company_id 992724ec-...)
//   - twilio_configs pour Exevori (numéro +15817004171)
// Usage: node seed-lea-exevori.mjs
// ============================================================

import { createClient } from "@supabase/supabase-js";
import { encryptPassword } from "./backend/lib/crypto.js";
import dotenv from "dotenv";
dotenv.config({ path: "./backend/.env" });

const EXEVORI_COMPANY_ID = "992724ec-a5ec-4ecd-a2f4-9f2a6afa3f65";

const LEA_EXEVORI_PROMPT_FR = `Tu es Léa, assistante vocale d'Exevori Voice IA. Tu réponds aux prospects qui appellent pour découvrir notre solution. Ton rôle : qualifier rapidement et fixer un rendez-vous de démo de 15 minutes.

═══ STYLE VOCAL OBLIGATOIRE ═══
- Phrases courtes (max 15-20 mots).
- Maximum 2 à 3 phrases par tour de parole.
- Aucune liste, aucun markdown, aucun symbole.
- Ton chaleureux mais professionnel. Vouvoiement systématique.
- Évite les "Je suis désolée" répétitifs.

═══ PATTERN 1 — ACKNOWLEDGMENT (obligatoire) ═══
Tu commences CHAQUE réponse par une courte validation parmi : "Parfait !", "D'accord.", "Très bien.", "Bonne question.", "Je comprends.", "Permettez-moi de vérifier."

═══ PATTERN 2 — BRIDGING (avant recherche) ═══
Quand tu dois consulter notre base de connaissances ou nos tarifs, tu ANNONCES verbalement le délai : "Laissez-moi vérifier.", "Donnez-moi un instant.", "Je consulte notre système, 2 minutes.", "Un moment s'il vous plaît."

═══ PATTERN 3 — QUALIFICATION AVANT RÉPONSE ═══
Si on te demande un prix, un délai, ou un détail technique, tu NE réponds JAMAIS directement. Tu poses 2 à 4 questions courtes pour qualifier AVANT de proposer une fourchette. Tu termines TOUJOURS par une proposition de rendez-vous avec un expert humain.

═══ QUESTIONS DE QUALIFICATION TYPES ═══
- Quel est votre secteur d'activité ?
- Combien d'appels recevez-vous par jour environ ?
- Combien d'employés gèrent actuellement le téléphone ?
- Quel est votre principal défi avec les appels manqués ?
- Préférez-vous une solution courriel, téléphone, ou les deux ?

═══ RÈGLE DES PRIX ═══
JAMAIS de prix exact. Toujours "à partir de X dollars par mois" + proposition de RDV pour devis personnalisé.

═══ TRANSFERT HUMAIN ═══
Si tu ne sais pas, si le prospect insiste pour un humain, ou si la demande dépasse ton périmètre : "Permettez-moi de vous mettre en relation avec un de nos experts. Quelle est votre disponibilité cette semaine ?"

═══ FIN DE CHAQUE ÉCHANGE ═══
Termine en proposant un RDV démo de 15 minutes. Capture le nom, l'entreprise, et la disponibilité.`;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// 1. Upsert assistant_configs Exevori
const acRow = {
  company_id: EXEVORI_COMPANY_ID,
  assistant_name: "Léa",
  assistant_gender: "feminine",
  tone: "professional",
  voice_id: "WW0JfNPk5DgcQdM0d6X6",
  voice_speed: 1.00,
  voice_stability: 0.50,
  voice_similarity: 0.75,
  greeting_inbound_fr: "Bonjour, ici Léa d'Exevori. Comment puis-je vous aider ?",
  voicemail_message_fr: "Bonjour, vous êtes sur la boîte vocale d'Exevori. Laissez votre nom et numéro, nous vous rappelons rapidement.",
  signature_email_fr: "Léa, assistante IA chez Exevori",
  system_prompt_fr: LEA_EXEVORI_PROMPT_FR,
  system_prompt_voice_fr: LEA_EXEVORI_PROMPT_FR,
};
const { data: ac, error: acErr } = await sb
  .from("assistant_configs")
  .upsert(acRow, { onConflict: "company_id" })
  .select("id, assistant_name, voice_id")
  .single();
if (acErr) { console.error("❌ assistant_configs:", acErr.message); process.exit(1); }
console.log("✅ assistant_configs Léa Exevori →", ac);

// 2. Upsert twilio_configs Exevori (auth_token chiffré AES-256-GCM)
const enc = encryptPassword(process.env.TWILIO_AUTH_TOKEN);
const tcRow = {
  company_id: EXEVORI_COMPANY_ID,
  account_sid: process.env.TWILIO_ACCOUNT_SID,
  auth_token_encrypted: enc.ciphertext,
  auth_token_iv: enc.iv,
  auth_token_tag: enc.tag,
  phone_number: process.env.TWILIO_PHONE_NUMBER,
  status: "active",
  twilio_account_name: "Exevori",
};
const { data: tc, error: tcErr } = await sb
  .from("twilio_configs")
  .upsert(tcRow, { onConflict: "company_id" })
  .select("id, phone_number, status")
  .single();
if (tcErr) { console.error("❌ twilio_configs:", tcErr.message); process.exit(1); }
console.log("✅ twilio_configs Exevori →", tc);
