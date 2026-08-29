import assert from "node:assert/strict";
import test from "node:test";

import { createCalendarWorkers } from "./worker.js";

test("calendar worker claims durable webhook/email rows, completes them and runs retention", async () => {
  const calls = [];
  const webhook = { id: "webhook-1", claimed_by: "worker", attempts: 1 };
  const email = { id: "email-1", claimed_by: "worker", attempts: 1 };
  const supabase = {
    rpc: async (name, args) => {
      calls.push(["rpc", name, args]);
      if (name === "claim_calendly_webhook_events") return { data: [webhook], error: null };
      if (name === "claim_calendar_email_outbox") return { data: [email], error: null };
      if (name === "purge_expired_calendar_data") {
        return { data: { webhooks_deleted: 1 }, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
  };
  const service = {
    processWebhookEvent: async row => {
      calls.push(["process-webhook", row.id]);
      return { ignored: false, appointment_id: "appointment-1" };
    },
    completeWebhook: async (row, result) => calls.push(["complete-webhook", row.id, result]),
    failWebhook: async () => assert.fail("webhook should not fail"),
    sendEmailOutbox: async row => {
      calls.push(["send-email", row.id]);
      return "message-1";
    },
    completeEmail: async (row, id) => calls.push(["complete-email", row.id, id]),
    failEmail: async () => assert.fail("email should not fail"),
  };
  const worker = createCalendarWorkers({
    supabase,
    service,
    workerId: "worker",
    intervalMs: 60_000,
    retentionIntervalMs: 60_000,
    batchSize: 5,
    logger: { info() {}, error() {} },
  });

  const result = await worker.runOnce();
  assert.equal(result.skipped, false);
  assert.equal(result.webhooks, 1);
  assert.equal(result.emails, 1);
  assert.deepEqual(result.retention, { webhooks_deleted: 1 });
  assert.ok(calls.some(call => call[0] === "complete-webhook"));
  assert.ok(calls.some(call => call[0] === "complete-email"));
  assert.equal(worker.status().last_error, null);
  assert.ok(worker.status().last_success_at);
});

test("calendar worker releases failed jobs through the retry transitions", async () => {
  const failures = [];
  const supabase = {
    rpc: async name => {
      if (name === "claim_calendly_webhook_events") {
        return { data: [{ id: "webhook-bad", attempts: 1 }], error: null };
      }
      if (name === "claim_calendar_email_outbox") {
        return { data: [{ id: "email-bad", attempts: 1 }], error: null };
      }
      if (name === "purge_expired_calendar_data") return { data: {}, error: null };
      throw new Error(name);
    },
  };
  const service = {
    processWebhookEvent: async () => { throw new Error("bad webhook"); },
    completeWebhook: async () => assert.fail("must not complete"),
    failWebhook: async (row, error) => failures.push([row.id, error.message]),
    sendEmailOutbox: async () => { throw new Error("bad email"); },
    completeEmail: async () => assert.fail("must not complete"),
    failEmail: async (row, error) => failures.push([row.id, error.message]),
  };
  const worker = createCalendarWorkers({
    supabase,
    service,
    retentionIntervalMs: 60_000,
    logger: { info() {}, error() {} },
  });

  await worker.runOnce();
  assert.deepEqual(failures.sort(), [
    ["email-bad", "bad email"],
    ["webhook-bad", "bad webhook"],
  ]);
});

test("calendar worker never overlaps two cycles", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const supabase = {
    rpc: async name => {
      if (name === "claim_calendly_webhook_events") {
        await gate;
        return { data: [], error: null };
      }
      if (name === "claim_calendar_email_outbox") return { data: [], error: null };
      if (name === "purge_expired_calendar_data") return { data: {}, error: null };
      throw new Error(name);
    },
  };
  const service = {
    processWebhookEvent() {}, completeWebhook() {}, failWebhook() {},
    sendEmailOutbox() {}, completeEmail() {}, failEmail() {},
  };
  const worker = createCalendarWorkers({
    supabase,
    service,
    retentionIntervalMs: 60_000,
    logger: { info() {}, error() {} },
  });

  const first = worker.runOnce();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await worker.runOnce(), { skipped: true });
  release();
  await first;
});
