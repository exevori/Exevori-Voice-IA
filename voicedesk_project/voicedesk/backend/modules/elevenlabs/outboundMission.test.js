import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildOutboundMissionPrompt,
  OutboundMissionError,
} from "./outboundMission.js";

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAMPAIGN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONTACT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const QUEUE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ATTEMPT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function fakeSupabase(rowsByTable, errorsByTable = {}) {
  return {
    from(table) {
      const filters = [];
      return {
        select() { return this; },
        eq(column, value) { filters.push([column, value]); return this; },
        async maybeSingle() {
          if (errorsByTable[table]) {
            return { data: null, error: errorsByTable[table] };
          }
          const rows = (rowsByTable[table] || []).filter(row =>
            filters.every(([column, value]) => row[column] === value)
          );
          return { data: rows[0] || null, error: null };
        },
      };
    },
  };
}

function validRows() {
  return {
    outbound_call_attempts: [{
      id: ATTEMPT,
      company_id: COMPANY,
      queue_id: QUEUE,
      status: "in_progress",
    }],
    outbound_call_queue: [{
      id: QUEUE,
      company_id: COMPANY,
      campaign_id: CAMPAIGN,
      outbound_contact_id: CONTACT,
      current_attempt_id: ATTEMPT,
      status: "in_progress",
    }],
    outbound_campaigns: [{
      id: CAMPAIGN,
      company_id: COMPANY,
      name: "Suivi devis",
      mission_type: "follow_up",
      script: "Présenter le suivi du devis et demander si la personne a des questions.",
    }],
    outbound_contacts: [{
      id: CONTACT,
      company_id: COMPANY,
      campaign_id: CAMPAIGN,
      full_name: "Marie Tremblay",
      language: "fr",
    }],
    companies: [{ id: COMPANY, name: "Garage Exemple" }],
  };
}

test("la mission est relue dans le tenant et encadrée par les règles prioritaires", async () => {
  const prompt = await buildOutboundMissionPrompt({
    supabase: fakeSupabase(validRows()),
    companyId: COMPANY,
    queueId: QUEUE,
    attemptId: ATTEMPT,
  });
  assert.match(prompt, /Garage Exemple/);
  assert.match(prompt, /Marie Tremblay/);
  assert.match(prompt, /Présenter le suivi du devis/);
  assert.match(prompt, /RÈGLES PRIORITAIRES/);
});

test("une corrélation inactive ou étrangère ne fournit aucun prompt", async () => {
  const rows = validRows();
  rows.outbound_call_queue[0].status = "completed";
  assert.equal(
    await buildOutboundMissionPrompt({
      supabase: fakeSupabase(rows),
      companyId: COMPANY,
      queueId: QUEUE,
      attemptId: ATTEMPT,
    }),
    null
  );
});

test("une panne de lecture mission reste distincte d'une mission absente", async () => {
  await assert.rejects(
    buildOutboundMissionPrompt({
      supabase: fakeSupabase(validRows(), {
        outbound_campaigns: { message: "down" },
      }),
      companyId: COMPANY,
      queueId: QUEUE,
      attemptId: ATTEMPT,
    }),
    error => error instanceof OutboundMissionError
  );
});
