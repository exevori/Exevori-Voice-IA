import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  InboundPolicyError,
  resolveInboundPolicy,
} from "./inboundPolicy.js";

const WEEKDAYS = {
  monday: { open: "09:00", close: "17:00" },
  tuesday: { open: "09:00", close: "17:00" },
  wednesday: { open: "09:00", close: "17:00" },
  thursday: { open: "09:00", close: "17:00" },
  friday: { open: "09:00", close: "17:00" },
};

function createSupabaseDouble(result) {
  const state = { tables: [], selections: [], filters: [] };
  return {
    state,
    client: {
      from(table) {
        state.tables.push(table);
        return {
          select(columns) {
            state.selections.push(columns);
            return {
              eq(column, value) {
                state.filters.push([column, value]);
                return {
                  async maybeSingle() {
                    return result;
                  },
                };
              },
            };
          },
        };
      },
    },
  };
}

test("un appel entrant ouvert ne reçoit aucune restriction", async () => {
  const { client, state } = createSupabaseDouble({
    data: {
      timezone: "America/Toronto",
      business_hours: WEEKDAYS,
      after_hours_message_fr: "Fermé jusqu'à {next_open}.",
    },
    error: null,
  });

  const policy = await resolveInboundPolicy({
    supabase: client,
    companyId: "company-a",
    now: "2026-01-05T15:00:00Z",
  });

  assert.equal(policy.isOpen, true);
  assert.equal(policy.promptSuffix, "");
  assert.deepEqual(state.tables, ["voice_call_settings"]);
  assert.deepEqual(state.filters, [["company_id", "company-a"]]);
});

test("un appel entrant fermé reçoit le message configuré et la prochaine ouverture", async () => {
  const { client } = createSupabaseDouble({
    data: {
      timezone: "America/Toronto",
      business_hours: WEEKDAYS,
      after_hours_message_fr: "Nous sommes fermés jusqu'à {next_open}.",
    },
    error: null,
  });

  const policy = await resolveInboundPolicy({
    supabase: client,
    companyId: "company-a",
    now: "2026-01-05T23:00:00Z",
  });

  assert.equal(policy.isAfterHours, true);
  assert.equal(policy.nextOpenLabel, "demain à 9 h");
  assert.equal(policy.message, "Nous sommes fermés jusqu'à demain à 9 h.");
  assert.match(policy.promptSuffix, /PRIORITÉ ÉLEVÉE/);
  assert.match(policy.promptSuffix, /ne déclenche pas de transfert humain/i);
});

test("la direction outbound contourne la politique sans requête DB", async () => {
  let queried = false;
  const policy = await resolveInboundPolicy({
    supabase: {
      from() {
        queried = true;
        throw new Error("ne doit pas être appelé");
      },
    },
    companyId: "company-a",
    direction: " OUTBOUND ",
  });

  assert.equal(queried, false);
  assert.equal(policy.direction, "outbound");
  assert.equal(policy.isAfterHours, false);
});

test("toute direction absente ou inconnue est traitée comme inbound", async () => {
  for (const direction of [undefined, "", "external", "INCOMING"]) {
    const { client } = createSupabaseDouble({ data: null, error: null });
    const policy = await resolveInboundPolicy({
      supabase: client,
      companyId: "company-a",
      direction,
    });
    assert.equal(policy.direction, "inbound");
  }
});

test("une PME sans configuration conserve Léa disponible", async () => {
  const { client } = createSupabaseDouble({ data: null, error: null });
  const policy = await resolveInboundPolicy({
    supabase: client,
    companyId: "company-a",
  });

  assert.equal(policy.configured, false);
  assert.equal(policy.isOpen, true);
  assert.equal(policy.promptSuffix, "");
});

test("une panne ou configuration invalide remonte une erreur neutre", async () => {
  const storageFailure = createSupabaseDouble({
    data: null,
    error: { code: "08006", message: "secret detail" },
  });
  await assert.rejects(
    resolveInboundPolicy({
      supabase: storageFailure.client,
      companyId: "company-a",
    }),
    error =>
      error instanceof InboundPolicyError
      && error.code === "voice_call_settings_lookup_failed"
  );

  const invalidSettings = createSupabaseDouble({
    data: {
      timezone: "Fuseau/Invalide",
      business_hours: WEEKDAYS,
      after_hours_message_fr: "secret detail",
    },
    error: null,
  });
  await assert.rejects(
    resolveInboundPolicy({
      supabase: invalidSettings.client,
      companyId: "company-a",
    }),
    error =>
      error instanceof InboundPolicyError
      && error.code === "invalid_voice_call_settings"
  );
});

test("le Custom LLM applique la politique après résolution tenant et avant le prompt final", () => {
  const source = fs.readFileSync(
    new URL("../elevenlabs/index.js", import.meta.url),
    "utf8"
  );
  const tenantIndex = source.indexOf("const companyId = company.company_id");
  const policyIndex = source.indexOf("await resolveInboundPolicy");
  const promptIndex = source.indexOf("const llmMessages = [");

  assert.ok(source.includes('from "../voice/inboundPolicy.js"'));
  assert.ok(source.includes("direction,"));
  assert.ok(tenantIndex >= 0);
  assert.ok(policyIndex > tenantIndex);
  assert.ok(promptIndex > policyIndex);
  assert.ok(source.includes("inbound business-hours policy unavailable"));
});
