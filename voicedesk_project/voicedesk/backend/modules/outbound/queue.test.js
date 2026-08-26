import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OutboundQueueError,
  createOutboundQueue,
  enqueueOutboundCampaign,
} from "./queue.js";

const fixedNow = new Date("2026-08-20T12:00:00.000Z");

function storageWithRpc(responses = {}) {
  const calls = [];
  const updates = [];
  return {
    calls,
    updates,
    async rpc(name, args) {
      calls.push({ name, args });
      const response = responses[name];
      if (typeof response === "function") return response(args);
      return response || { data: null, error: null };
    },
    from(table) {
      const operation = { table, values: null, filters: [] };
      const builder = {
        update(values) { operation.values = values; return builder; },
        eq(column, value) { operation.filters.push([column, value]); return builder; },
        select() { return builder; },
        async maybeSingle() {
          updates.push(operation);
          return { data: { id: "updated" }, error: null };
        },
      };
      return builder;
    },
  };
}

test("enqueueOutboundCampaign calls migration 012 RPC and returns status counts", async () => {
  const storage = storageWithRpc({
    enqueue_outbound_campaign: {
      data: [
        { queue_id: "q1", queue_status: "pending" },
        { queue_id: "q2", queue_status: "blocked", block_reason: "dnc" },
        { queue_id: "q3", queue_status: "pending" },
      ],
      error: null,
    },
  });
  const result = await enqueueOutboundCampaign({
    supabase: storage,
    campaignId: "campaign-1",
    companyId: "company-1",
    scheduledFor: fixedNow,
    maxAttempts: 4,
  });
  assert.deepEqual(result.counts, { pending: 2, blocked: 1 });
  assert.equal(result.total, 3);
  assert.equal(result.activeTotal, 2);
  assert.equal(result.hasActiveWork, true);
  assert.deepEqual(storage.calls[0], {
    name: "enqueue_outbound_campaign",
    args: {
      p_campaign_id: "campaign-1",
      p_company_id: "company-1",
      p_scheduled_for: fixedNow.toISOString(),
      p_max_attempts: 4,
    },
  });
});

test("queue claims, begins and acknowledges through exact migration 012 RPCs", async () => {
  const storage = storageWithRpc({
    claim_next_outbound_call: { data: [{ id: "queue-1" }], error: null },
    begin_outbound_call_attempt: { data: [{ id: "attempt-1" }], error: null },
    mark_outbound_call_dispatched: { data: { success: true }, error: null },
    release_stale_outbound_claims: {
      data: [{ requeued: 2, dispatch_unknown: 1 }],
      error: null,
    },
  });
  const queue = createOutboundQueue({
    supabase: storage,
    workerId: "worker-test",
    leaseSeconds: 180,
    reservedMinutes: 2,
    now: () => fixedNow,
  });

  assert.deepEqual(await queue.claimNext(), { id: "queue-1" });
  assert.deepEqual(
    await queue.beginAttempt(
      { id: "queue-1" },
      "2026-08-20",
      new Date("2026-08-21T13:00:00Z")
    ),
    { id: "attempt-1" }
  );
  await queue.markDispatched(
    { id: "attempt-1" },
    { conversationId: "conv-1", callSid: "CA1" },
    3_600
  );
  await queue.recoverStale(50);

  assert.deepEqual(storage.calls, [
    {
      name: "claim_next_outbound_call",
      args: {
        p_worker_id: "worker-test",
        p_lease_seconds: 180,
        p_reserved_minutes: 2,
      },
    },
    {
      name: "begin_outbound_call_attempt",
      args: {
        p_queue_id: "queue-1",
        p_worker_id: "worker-test",
        p_local_call_date: "2026-08-20",
        p_next_allowed_at: "2026-08-21T13:00:00.000Z",
      },
    },
    {
      name: "mark_outbound_call_dispatched",
      args: {
        p_attempt_id: "attempt-1",
        p_worker_id: "worker-test",
        p_elevenlabs_conversation_id: "conv-1",
        p_twilio_call_sid: "CA1",
        p_provider_timeout_seconds: 3_600,
      },
    },
    {
      name: "release_stale_outbound_claims",
      args: { p_batch_size: 50 },
    },
  ]);
});

test("provider outcomes use one atomic dispatch-failure RPC", async () => {
  const storage = storageWithRpc({
    fail_outbound_call_dispatch: { data: { success: true }, error: null },
    quarantine_outbound_provider_failure: {
      data: { success: true },
      error: null,
    },
  });
  const queue = createOutboundQueue({
    supabase: storage,
    workerId: "worker-test",
    now: () => fixedNow,
  });
  const attempt = { id: "attempt-1" };
  await queue.markRetryable(attempt, {
    code: "rate limited",
    retryAt: new Date("2026-08-20T12:00:30Z"),
  });
  await queue.markPermanentFailure(attempt, "unprocessable entity");
  await queue.markDispatchUnknown(attempt, "request timeout", {
    conversationId: "conv-partial",
    callSid: null,
  });
  await queue.markConfigurationFailure(attempt, {
    code: "agent missing",
    retryAt: new Date("2026-08-20T12:15:00Z"),
  });

  assert.deepEqual(storage.calls.map(call => call.args), [
    {
      p_attempt_id: "attempt-1",
      p_worker_id: "worker-test",
      p_failure_class: "retryable_failure",
      p_error_code: "rate_limited",
      p_retry_at: "2026-08-20T12:00:30.000Z",
      p_elevenlabs_conversation_id: null,
      p_twilio_call_sid: null,
    },
    {
      p_attempt_id: "attempt-1",
      p_worker_id: "worker-test",
      p_failure_class: "failed",
      p_error_code: "unprocessable_entity",
      p_retry_at: null,
      p_elevenlabs_conversation_id: null,
      p_twilio_call_sid: null,
    },
    {
      p_attempt_id: "attempt-1",
      p_worker_id: "worker-test",
      p_failure_class: "dispatch_unknown",
      p_error_code: "request_timeout",
      p_retry_at: null,
      p_elevenlabs_conversation_id: "conv-partial",
      p_twilio_call_sid: null,
    },
    {
      p_attempt_id: "attempt-1",
      p_worker_id: "worker-test",
      p_error_code: "agent_missing",
      p_retry_at: "2026-08-20T12:15:00.000Z",
    },
  ]);
  assert.equal(storage.updates.length, 0);
});

test("preflight defer/block transitions are tenant- and worker-scoped", async () => {
  const storage = storageWithRpc();
  const queue = createOutboundQueue({
    supabase: storage,
    workerId: "worker-test",
    now: () => fixedNow,
  });
  const job = { id: "queue-1", company_id: "company-1" };
  await queue.defer(job, {
    code: "outside hours",
    retryAt: new Date("2026-08-20T13:00:00Z"),
  });
  await queue.block(job, "dnc blocked");

  assert.equal(storage.updates.length, 0);
  assert.deepEqual(storage.calls, [
    {
      name: "transition_claimed_outbound_call",
      args: {
        p_queue_id: "queue-1",
        p_company_id: "company-1",
        p_worker_id: "worker-test",
        p_action: "defer",
        p_error_code: "outside_hours",
        p_retry_at: "2026-08-20T13:00:00.000Z",
      },
    },
    {
      name: "transition_claimed_outbound_call",
      args: {
        p_queue_id: "queue-1",
        p_company_id: "company-1",
        p_worker_id: "worker-test",
        p_action: "block",
        p_error_code: "dnc_blocked",
        p_retry_at: null,
      },
    },
  ]);
});

test("reservation defaults from OUTBOUND_RESERVED_MINUTES and is clamped to 1..30", async () => {
  const previous = process.env.OUTBOUND_RESERVED_MINUTES;
  process.env.OUTBOUND_RESERVED_MINUTES = "99";
  try {
    const storage = storageWithRpc();
    const queue = createOutboundQueue({
      supabase: storage,
      workerId: "worker-test",
    });
    await queue.claimNext();
    assert.equal(storage.calls[0].args.p_reserved_minutes, 30);
  } finally {
    if (previous === undefined) delete process.env.OUTBOUND_RESERVED_MINUTES;
    else process.env.OUTBOUND_RESERVED_MINUTES = previous;
  }
});

test("RPC errors are normalized and an empty begin result is rejected", async () => {
  const storage = storageWithRpc({
    claim_next_outbound_call: { data: null, error: new Error("db unavailable") },
    begin_outbound_call_attempt: { data: [], error: null },
  });
  const queue = createOutboundQueue({
    supabase: storage,
    workerId: "worker-test",
  });
  await assert.rejects(queue.claimNext(), error => {
    assert.ok(error instanceof OutboundQueueError);
    assert.equal(error.code, "outbound_claim_failed");
    return true;
  });
  await assert.rejects(
    queue.beginAttempt({ id: "queue-1" }, "2026-08-20"),
    error => error.code === "outbound_attempt_not_created"
  );
});
