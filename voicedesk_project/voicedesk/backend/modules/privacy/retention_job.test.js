import assert from "node:assert/strict";
import test from "node:test";

process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "local-test-service-role";

const {
  millisecondsUntilNextRun,
  runPrivacyRetentionCycle,
  startPrivacyRetentionJob,
  stopPrivacyRetentionJob,
} = await import("./retention_job.js");

test("millisecondsUntilNextRun schedules the next 03:00 UTC", () => {
  assert.equal(
    millisecondsUntilNextRun(new Date("2026-07-27T02:30:00.000Z")),
    30 * 60 * 1000
  );
  assert.equal(
    millisecondsUntilNextRun(new Date("2026-07-27T03:30:00.000Z")),
    23.5 * 60 * 60 * 1000
  );
});

test("runPrivacyRetentionCycle drains full local and provider batches", async () => {
  const calls = [];
  let purgeCall = 0;
  let providerCall = 0;
  const client = {
    async rpc(name, args) {
      calls.push(["rpc", name, args]);
      purgeCall += 1;
      return {
        data: {
          calls_deleted: purgeCall === 1 ? 500 : 2,
          call_recording_transcripts_cleared:
            purgeCall === 1 ? 500 : 2,
          learning_suggestions_deleted: purgeCall === 1 ? 12 : 1,
          external_deletions_enqueued: purgeCall === 1 ? 500 : 2,
        },
        error: null,
      };
    },
  };
  const processExternalDeletions = async (options) => {
    calls.push(["providers", options.batchSize, options.supabase === client]);
    providerCall += 1;
    return {
      claimed: providerCall === 1 ? 7 : 1,
      completed: providerCall === 1 ? 7 : 1,
      retry: 0,
      failed: 0,
      pending: false,
    };
  };

  const result = await runPrivacyRetentionCycle({
    client,
    processExternalDeletions,
    batchSize: 1000,
    providerBatchSize: 7,
  });

  assert.deepEqual(calls, [
    ["rpc", "purge_expired_privacy_data", { p_batch_size: 500 }],
    ["rpc", "purge_expired_privacy_data", { p_batch_size: 500 }],
    ["providers", 7, true],
    ["providers", 7, true],
  ]);
  assert.equal(result.purge.calls_deleted, 502);
  assert.equal(result.purge.call_recording_transcripts_cleared, 502);
  assert.equal(result.purge.learning_suggestions_deleted, 13);
  assert.equal(result.purge.batches, 2);
  assert.equal(result.external_deletions.completed, 8);
  assert.equal(result.external_deletions.batches, 2);
  assert.equal(result.backlog_possible, false);
});

test("terminal provider failures do not create an endless retention backlog", async () => {
  const client = {
    async rpc() {
      return { data: {}, error: null };
    },
  };

  const result = await runPrivacyRetentionCycle({
    client,
    processExternalDeletions: async () => ({
      claimed: 1,
      completed: 0,
      retry: 0,
      failed: 1,
      pending: false,
    }),
    providerBatchSize: 25,
  });

  assert.equal(result.external_deletions.failed, 1);
  assert.equal(result.external_deletions.pending, false);
  assert.equal(result.backlog_possible, false);
});

test("runPrivacyRetentionCycle reports a possible backlog at safety limits", async () => {
  const client = {
    async rpc() {
      return { data: { calls_deleted: 10 }, error: null };
    },
  };

  const result = await runPrivacyRetentionCycle({
    client,
    batchSize: 10,
    maxPurgeBatches: 1,
    providerBatchSize: 5,
    maxProviderBatches: 1,
    processExternalDeletions: async () => ({
      claimed: 5,
      completed: 5,
      retry: 0,
      failed: 0,
      pending: true,
    }),
  });

  assert.equal(result.purge.backlog_possible, true);
  assert.equal(result.external_deletions.backlog_possible, true);
  assert.equal(result.backlog_possible, true);
});

test("runPrivacyRetentionCycle fails closed when the purge RPC fails", async () => {
  let providerCalled = false;
  const client = {
    async rpc() {
      return { data: null, error: new Error("migration missing") };
    },
  };

  await assert.rejects(
    runPrivacyRetentionCycle({
      client,
      processExternalDeletions: async () => {
        providerCalled = true;
      },
    }),
    /migration missing/
  );
  assert.equal(providerCalled, false);
});

test("the scheduler is singleton and stoppable", () => {
  const timers = [];
  const fakeSetTimer = (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    timers.push(timer);
    return timer;
  };
  const fakeClearTimer = (timer) => {
    timer.cleared = true;
  };

  const started = startPrivacyRetentionJob({
    now: () => new Date("2026-07-27T02:30:00.000Z"),
    setTimer: fakeSetTimer,
  });
  const duplicate = startPrivacyRetentionJob({ setTimer: fakeSetTimer });

  assert.equal(started, true);
  assert.equal(duplicate, false);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 30 * 60 * 1000);
  assert.equal(stopPrivacyRetentionJob(fakeClearTimer), true);
  assert.equal(timers[0].cleared, true);
});

test("the scheduler retries after five minutes when a backlog may remain", async () => {
  const timers = [];
  const fakeSetTimer = (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    timers.push(timer);
    return timer;
  };
  const client = {
    async rpc() {
      return { data: { calls_deleted: 10 }, error: null };
    },
  };

  startPrivacyRetentionJob({
    client,
    processExternalDeletions: async () => ({
      claimed: 0,
      completed: 0,
      retry: 0,
      failed: 0,
      pending: false,
    }),
    batchSize: 10,
    maxPurgeBatches: 1,
    now: () => new Date("2026-07-27T02:30:00.000Z"),
    setTimer: fakeSetTimer,
  });

  assert.equal(timers[0].delay, 30 * 60 * 1000);
  await timers[0].callback();
  assert.equal(timers[1].delay, 5 * 60 * 1000);
  assert.equal(stopPrivacyRetentionJob(() => {}), true);
});
