import assert from "node:assert/strict";
import test from "node:test";

import { createTicketWorker } from "./worker.js";

function baseService(overrides = {}) {
  return {
    enqueueSlaAlerts: async () => 2,
    claimEmails: async () => [],
    sendEmailOutbox: async () => ({ providerMessageId: "email-1" }),
    completeEmail: async () => {},
    suppressEmail: async () => {},
    failEmail: async () => {},
    purgeEmailOutbox: async () => 0,
    ...overrides,
  };
}

test("ticket worker enqueues SLA alerts and settles every claimed delivery", async () => {
  const transitions = [];
  const service = baseService({
    claimEmails: async args => {
      assert.equal(args.workerId, "ticket-test");
      return [
        { id: "send", claimed_by: "ticket-test", attempts: 1 },
        { id: "suppress", claimed_by: "ticket-test", attempts: 1 },
        { id: "fail", claimed_by: "ticket-test", attempts: 1 },
      ];
    },
    sendEmailOutbox: async row => {
      if (row.id === "suppress") return { suppressed: true, reason: "preference" };
      if (row.id === "fail") throw Object.assign(new Error("provider down"), { code: "provider_down" });
      return { providerMessageId: "resend-123" };
    },
    completeEmail: async (row, providerId) => transitions.push(["sent", row.id, providerId]),
    suppressEmail: async (row, reason) => transitions.push(["suppressed", row.id, reason]),
    failEmail: async (row, error) => transitions.push(["failed", row.id, error.code]),
    purgeEmailOutbox: async () => 3,
  });
  const worker = createTicketWorker({
    service,
    workerId: "ticket-test",
    logger: { info() {}, error() {} },
  });

  const result = await worker.runOnce();
  assert.deepEqual(result, {
    skipped: false,
    enqueued: 2,
    claimed: 3,
    sent: 1,
    suppressed: 1,
    failed: 1,
    purged: 3,
  });
  assert.deepEqual(transitions, [
    ["sent", "send", "resend-123"],
    ["suppressed", "suppress", "preference"],
    ["failed", "fail", "provider_down"],
  ]);
});

test("configuration failures remain in the retry path instead of losing email", async () => {
  let suppressed = false;
  let failed;
  const service = baseService({
    claimEmails: async () => [{ id: "permanent", claimed_by: "worker", attempts: 1 }],
    sendEmailOutbox: async () => {
      throw Object.assign(new Error("missing config"), {
        code: "resend_not_configured",
      });
    },
    suppressEmail: async () => { suppressed = true; },
    failEmail: async (_row, error) => { failed = error.code; },
  });
  const worker = createTicketWorker({ service, workerId: "worker", logger: { info() {}, error() {} } });
  const result = await worker.runOnce();
  assert.equal(result.failed, 1);
  assert.equal(suppressed, false);
  assert.equal(failed, "resend_not_configured");
});

test("ticket worker is singleton per instance and never overlaps cycles", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const service = baseService({
    enqueueSlaAlerts: async () => {
      await gate;
      return 0;
    },
  });
  let scheduled;
  const worker = createTicketWorker({
    service,
    setTimer: callback => {
      scheduled = { callback, unref() {} };
      return scheduled;
    },
    clearTimer: () => {},
    logger: { info() {}, error() {} },
  });

  assert.equal(worker.start(), true);
  assert.equal(worker.start(), false);
  const concurrent = await worker.runOnce();
  assert.deepEqual(concurrent, { skipped: true });
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.status().started, true);
  assert.equal(worker.status().ready, true);
  assert.equal(worker.stop(), true);
  assert.equal(worker.stop(), false);
});
