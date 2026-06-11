// ============================================================
// VOICEDESK IA — SCRIPT SEED
//
// Importe tous les mock data dans Supabase pour démarrer
// rapidement en développement.
//
// Usage :
//   npm run seed              → Importer toutes les données
//   npm run seed:clear        → Vider toutes les tables (DEV ONLY)
//   node scripts/seed.js companies contacts  → tables spécifiques
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Mapping fichier mock → table Supabase
//
// NOTE : 4 fichiers data/ ne sont PAS seedés car ce sont des RÉFÉRENCES
// conceptuelles (exemple Exevori/Léa), pas des tables :
//   - assistant-config.json    → structure de référence pour assistant_configs
//   - mock-memory.json         → concept "mémoire d'entreprise" (UI Business Memory)
//   - mock-memory-policy.json  → politique d'apprentissage contrôlé
//   - mock-maturity.json       → indicateur de maturité de l'assistante (UI)
const SEED_MAP = {
  "mock-companies.json":          "companies",
  "mock-profiles.json":           "profiles",
  "mock-invitations.json":        "invitations",
  "mock-subscriptions.json":      "subscriptions",
  "mock-contacts.json":           "contacts",
  "mock-calls.json":              "calls",
  "mock-outbound-calls.json":     "outbound_calls",
  "mock-missions.json":           "missions",
  "mock-emails.json":             "emails",
  "mock-drafts.json":             "email_drafts",
  "mock-appointments.json":       "appointments",
  "mock-calendar-slots.json":     "appointments", // additional
  "mock-knowledge.json":          "knowledge_base",
  "mock-suggestions.json":        "learning_suggestions",
  "mock-onboarding.json":         "onboarding_progress",
  "mock-usage-records.json":      "usage_records",
  "mock-invoices.json":           "invoices",
  "mock-credit-grants.json":      "credit_grants",
  "mock-tickets.json":            "tickets",
  "mock-ticket-messages.json":    "ticket_messages",
};

// Ordre d'insertion (respect des dépendances FK)
const INSERT_ORDER = [
  "companies",
  "profiles",
  "invitations",
  "subscriptions",
  "contacts",
  "calls",
  "missions",
  "outbound_calls",
  "emails",
  "email_drafts",
  "appointments",
  "knowledge_base",
  "learning_suggestions",
  "onboarding_progress",
  "usage_records",
  "invoices",
  "credit_grants",
  "tickets",
  "ticket_messages",
];

const command = process.argv[2];
const specificTables = process.argv.slice(2).filter(a => !a.startsWith("--"));

if (command === "--clear") {
  await clearAllTables();
} else if (command === "--specific" && specificTables.length > 1) {
  await seedSpecific(specificTables.slice(1));
} else {
  await seedAll();
}

async function seedAll() {
  console.log("🌱 Seeding toutes les données mock...\n");

  let totalImported = 0;
  let totalErrors = 0;

  for (const table of INSERT_ORDER) {
    const result = await seedTable(table);
    totalImported += result.imported;
    totalErrors += result.errors;
  }

  console.log(`\n✅ Total : ${totalImported} enregistrements importés`);
  if (totalErrors > 0) console.log(`⚠️  ${totalErrors} erreurs (voir détails ci-dessus)`);
}

async function seedSpecific(tables) {
  for (const table of tables) {
    await seedTable(table);
  }
}

async function seedTable(table) {
  const result = { imported: 0, errors: 0 };

  // Trouver le fichier mock correspondant
  const mockFile = Object.entries(SEED_MAP).find(([_, t]) => t === table)?.[0];
  if (!mockFile) {
    console.log(`⏭️  ${table} — pas de mock`);
    return result;
  }

  const filePath = path.join(DATA_DIR, mockFile);

  try {
    await fs.access(filePath);
  } catch {
    console.log(`⏭️  ${table} — fichier ${mockFile} introuvable`);
    return result;
  }

  try {
    const content = await fs.readFile(filePath, "utf-8");
    let data = JSON.parse(content);

    if (!Array.isArray(data)) data = [data];
    if (data.length === 0) {
      console.log(`⏭️  ${table} — fichier vide`);
      return result;
    }

    // Insérer par batch de 100
    for (let i = 0; i < data.length; i += 100) {
      const batch = data.slice(i, i + 100);
      const { error, count } = await supabase
        .from(table)
        .upsert(batch, { onConflict: "id" })
        .select("id", { count: "exact" });

      if (error) {
        console.error(`❌ ${table} batch ${i}: ${error.message}`);
        result.errors++;
      } else {
        result.imported += batch.length;
      }
    }

    console.log(`✅ ${table.padEnd(30)} ${result.imported.toString().padStart(4)} enregistrements`);
  } catch (err) {
    console.error(`❌ ${table}: ${err.message}`);
    result.errors++;
  }

  return result;
}

async function clearAllTables() {
  console.log("⚠️  ATTENTION : Vidage de toutes les tables (DEV ONLY)\n");

  // Confirmation
  if (process.env.NODE_ENV === "production") {
    console.error("❌ Impossible en production");
    process.exit(1);
  }

  // Ordre inverse pour respecter les FK
  for (const table of [...INSERT_ORDER].reverse()) {
    const { error, count } = await supabase
      .from(table)
      .delete()
      .neq("id", "00000000-0000-0000-0000-000000000000");

    if (error) {
      console.error(`❌ ${table}: ${error.message}`);
    } else {
      console.log(`🗑️  ${table.padEnd(30)} vidé`);
    }
  }

  console.log("\n✅ Toutes les tables vidées");
}
