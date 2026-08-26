import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  extractCustomLlmTenantHints,
  extractPostCallTenantHints,
  resolveElevenLabsCompany,
  TenantResolutionError,
} from "./tenantResolver.js";

const COMPANY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const QUEUE_A = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_A = "22222222-2222-4222-8222-222222222222";

function fakeSupabase(rowsByTable = {}, errorsByTable = {}) {
  return {
    from(table) {
      const filters = [];
      return {
        select() {
          return this;
        },
        eq(column, value) {
          filters.push([column, value]);
          return this;
        },
        async limit() {
          if (errorsByTable[table]) {
            return { data: null, error: errorsByTable[table] };
          }
          const rows = (rowsByTable[table] || []).filter(row =>
            filters.every(([column, value]) => row[column] === value)
          );
          return { data: rows.slice(0, 50), error: null };
        },
      };
    },
  };
}

test("agent unique resolves its company without a default tenant", async () => {
  const company = await resolveElevenLabsCompany({
    supabase: fakeSupabase({
      assistant_configs: [
        { company_id: COMPANY_A, elevenlabs_agent_id: "agent-a" },
      ],
    }),
    agentId: "agent-a",
  });
  assert.deepEqual(company, { company_id: COMPANY_A });
});

test("called number resolves through active and legacy phone mappings", async () => {
  const company = await resolveElevenLabsCompany({
    supabase: fakeSupabase({
      phone_numbers: [
        {
          company_id: COMPANY_A,
          phone_number: "+15145550100",
          status: "active",
        },
      ],
      twilio_configs: [
        { company_id: COMPANY_A, phone_number: "+15145550100" },
      ],
    }),
    calledNumber: "+15145550100",
  });
  assert.deepEqual(company, { company_id: COMPANY_A });
});

test("called number disambiguates a shared agent", async () => {
  const company = await resolveElevenLabsCompany({
    supabase: fakeSupabase({
      assistant_configs: [
        { company_id: COMPANY_A, elevenlabs_agent_id: "shared-agent" },
        { company_id: COMPANY_B, elevenlabs_agent_id: "shared-agent" },
      ],
      phone_numbers: [
        {
          company_id: COMPANY_B,
          phone_number: "+15145550200",
          status: "active",
        },
      ],
    }),
    agentId: "shared-agent",
    calledNumber: "+15145550200",
  });
  assert.deepEqual(company, { company_id: COMPANY_B });
});

test("un appel outbound exige agent, queue et tentative corrélés", async () => {
  const supabase = fakeSupabase({
    phone_numbers: [{
      company_id: COMPANY_A,
      elevenlabs_agent_id: "agent-a",
      status: "active",
    }],
    outbound_call_attempts: [{
      id: ATTEMPT_A,
      queue_id: QUEUE_A,
      company_id: COMPANY_A,
    }],
    outbound_call_queue: [{
      id: QUEUE_A,
      current_attempt_id: ATTEMPT_A,
      company_id: COMPANY_A,
    }],
  });

  assert.deepEqual(
    await resolveElevenLabsCompany({
      supabase,
      agentId: "agent-a",
      calledNumber: "+15145550999",
      direction: "outbound",
      outboundQueueId: QUEUE_A,
      outboundAttemptId: ATTEMPT_A,
    }),
    { company_id: COMPANY_A }
  );
  assert.equal(
    await resolveElevenLabsCompany({
      supabase,
      agentId: "agent-a",
      direction: "outbound",
      outboundQueueId: QUEUE_A,
    }),
    null
  );
});

test("ambiguous, conflicting or absent mappings fail closed", async () => {
  const supabase = fakeSupabase({
    assistant_configs: [
      { company_id: COMPANY_A, elevenlabs_agent_id: "shared-agent" },
      { company_id: COMPANY_B, elevenlabs_agent_id: "shared-agent" },
      { company_id: COMPANY_A, elevenlabs_agent_id: "agent-a" },
    ],
    phone_numbers: [
      {
        company_id: COMPANY_B,
        phone_number: "+15145550300",
        status: "active",
      },
    ],
  });

  assert.equal(
    await resolveElevenLabsCompany({
      supabase,
      agentId: "shared-agent",
    }),
    null
  );
  assert.equal(
    await resolveElevenLabsCompany({
      supabase,
      agentId: "agent-a",
      calledNumber: "+15145550300",
    }),
    null
  );
  assert.equal(
    await resolveElevenLabsCompany({ supabase }),
    null
  );
});

test("storage errors stay distinct from an unmapped tenant", async () => {
  await assert.rejects(
    resolveElevenLabsCompany({
      supabase: fakeSupabase({}, { assistant_configs: { message: "down" } }),
      agentId: "agent-a",
    }),
    error =>
      error instanceof TenantResolutionError &&
      error.code === "assistant_agent_lookup_failed"
  );
});

test("custom LLM hints support authenticated headers and extra body", () => {
  assert.deepEqual(
    extractCustomLlmTenantHints({
      headers: {
        "x-elevenlabs-agent-id": "agent-header",
        "x-elevenlabs-caller-number": "+15145550400",
      },
      body: {
        elevenlabs_extra_body: {
          system__agent_id: "agent-extra",
          system__called_number: "+15145550500",
        },
      },
    }),
    {
      agentId: "agent-header",
      calledNumber: "+15145550500",
      callerNumber: "+15145550400",
      direction: "inbound",
    }
  );
});

test("custom LLM direction is outbound only for the explicit dynamic variable", () => {
  const outboundHints = extractCustomLlmTenantHints({
      body: {
        conversation_initiation_client_data: {
          dynamic_variables: {
            voicedesk_direction: "outbound",
            outbound_queue_id: QUEUE_A,
            outbound_attempt_id: ATTEMPT_A,
          },
        },
      },
    });
  assert.equal(outboundHints.direction, "outbound");
  assert.equal(outboundHints.outboundQueueId, QUEUE_A);
  assert.equal(outboundHints.outboundAttemptId, ATTEMPT_A);
  assert.equal(
    extractCustomLlmTenantHints({
      body: {
        elevenlabs_extra_body: {
          dynamic_variables: { voicedesk_direction: "OUTBOUND" },
        },
      },
    }).direction,
    "outbound"
  );
  for (const value of [undefined, "", "incoming", "outbound-call"]) {
    assert.equal(
      extractCustomLlmTenantHints({
        body: { dynamic_variables: { voicedesk_direction: value } },
      }).direction,
      "inbound"
    );
  }
});

test("post-call hints follow the official data and dynamic-variable shapes", () => {
  assert.deepEqual(
    extractPostCallTenantHints({
      data: {
        agent_id: "agent-official",
        metadata: {
          phone_call: {
            external_number: "+15145550600",
            call_sid: "CA-test",
          },
        },
        conversation_initiation_client_data: {
          dynamic_variables: {
            system__called_number: "+15145550700",
          },
        },
      },
    }),
    {
      agentId: "agent-official",
      calledNumber: "+15145550700",
      callerNumber: "+15145550600",
      callSid: "CA-test",
    }
  );
});

test("runtime handlers contain no global default-company fallback", () => {
  const customLlmHandler = fs.readFileSync(
    new URL("./index.js", import.meta.url),
    "utf8"
  );
  const postCallHandler = fs.readFileSync(
    new URL("../post_call/index.js", import.meta.url),
    "utf8"
  );
  const envExample = fs.readFileSync(
    new URL("../../../.env.example", import.meta.url),
    "utf8"
  );

  for (const source of [customLlmHandler, postCallHandler, envExample]) {
    assert.equal(source.includes("ELEVENLABS_DEFAULT_COMPANY_ID"), false);
  }
  assert.match(customLlmHandler, /resolveElevenLabsCompany/);
  assert.match(postCallHandler, /resolveElevenLabsCompany/);
});
