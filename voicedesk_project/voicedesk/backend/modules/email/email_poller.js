// ============================================================
// EXEVORI VOICE IA — Polling courriel automatique (IMAP)
// Fichier : backend/modules/email/email_poller.js
//
// Import à ajouter dans backend/index.js :
//   import { startEmailPoller } from "./modules/email/email_poller.js";
//   startEmailPoller();  // après server.listen(...)
// ============================================================

import imaps from "imap-simple";
import { createClient } from "@supabase/supabase-js";
import { decryptPassword } from "../../lib/crypto.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const POLL_INTERVAL_MS = 2 * 60 * 1000; // toutes les 2 minutes
const APP_URL          = process.env.APP_PUBLIC_URL || "http://localhost:8001";

// ─────────────────────────────────────────────────────────────
// Démarre le polling pour TOUS les comptes email actifs
// ─────────────────────────────────────────────────────────────
export function startEmailPoller() {
  console.log("[email-poller] Démarrage — intervalle 2 minutes");
  pollAll(); // premier passage immédiat
  setInterval(pollAll, POLL_INTERVAL_MS);
}

async function pollAll() {
  try {
    const { data: accounts } = await supabase
      .from("email_accounts")
      .select("id, company_id, imap_host, imap_port, imap_user, imap_password_enc, imap_tls")
      .eq("active", true);

    if (!accounts?.length) return;

    for (const account of accounts) {
      try {
        await pollAccount(account);
      } catch (err) {
        console.error(`[email-poller] Erreur compte ${account.imap_user}:`, err.message);
      }
    }
  } catch (err) {
    console.error("[email-poller] Erreur globale:", err.message);
  }
}

async function pollAccount(account) {
  const password = decryptPassword(account.imap_password_enc);

  const config = {
    imap: {
      user:     account.imap_user,
      password,
      host:     account.imap_host,
      port:     account.imap_port || 993,
      tls:      account.imap_tls !== false,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 10000,
    },
  };

  const connection = await imaps.connect(config);
  await connection.openBox("INBOX");

  // Récupérer les emails non lus depuis les dernières 24h
  const since = new Date();
  since.setDate(since.getDate() - 1);

  const searchCriteria   = ["UNSEEN", ["SINCE", since]];
  const fetchOptions     = { bodies: ["HEADER.FIELDS (FROM TO SUBJECT DATE)", "TEXT"], markSeen: false };
  const messages         = await connection.search(searchCriteria, fetchOptions);

  await connection.end();

  for (const msg of messages) {
    try {
      await processEmail(msg, account);
    } catch (err) {
      console.error("[email-poller] Erreur traitement email:", err.message);
    }
  }

  if (messages.length > 0) {
    console.log(`[email-poller] ${account.imap_user} → ${messages.length} nouveau(x) courriel(s) traité(s)`);
  }
}

async function processEmail(msg, account) {
  const header = msg.parts.find(p => p.which === "HEADER.FIELDS (FROM TO SUBJECT DATE)");
  const body   = msg.parts.find(p => p.which === "TEXT");

  if (!header) return;

  const from    = header.body.from?.[0]  || "";
  const subject = header.body.subject?.[0] || "(sans objet)";
  const date    = header.body.date?.[0]   || new Date().toISOString();
  const text    = body?.body || "";

  // Extraire l'adresse email de l'expéditeur
  const fromEmail = from.match(/<([^>]+)>/)?.[1] || from.trim();

  // Vérifier si ce message n'est pas déjà traité
  const { data: existing } = await supabase
    .from("emails")
    .select("id")
    .eq("company_id", account.company_id)
    .eq("message_id_header", `${fromEmail}-${date}`)
    .maybeSingle();

  if (existing) return; // déjà traité

  // Appeler le endpoint /incoming existant pour déclencher la classification IA
  try {
    const res = await fetch(`${APP_URL}/api/v1/emails/incoming`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company_id:       account.company_id,
        email_account_id: account.id,
        from_email:       fromEmail,
        from_name:        from.replace(/<[^>]+>/, "").trim() || fromEmail,
        subject,
        body_text:        text.slice(0, 5000),
        received_at:      date,
        message_id_header: `${fromEmail}-${date}`,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[email-poller] /incoming error: ${res.status} — ${err}`);
    }
  } catch (fetchErr) {
    console.error("[email-poller] Fetch /incoming failed:", fetchErr.message);
  }
}
