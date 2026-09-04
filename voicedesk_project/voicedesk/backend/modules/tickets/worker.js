import { randomUUID } from "node:crypto";

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function createTicketWorker({
  service,
  logger = console,
  workerId = process.env.TICKET_WORKER_ID || `ticket-${randomUUID()}`,
  intervalMs = boundedInteger(process.env.TICKET_WORKER_INTERVAL_MS, 60_000, 15_000, 15 * 60_000),
  batchSize = boundedInteger(process.env.TICKET_WORKER_BATCH_SIZE, 20, 1, 100),
  leaseSeconds = boundedInteger(process.env.TICKET_WORKER_LEASE_SECONDS, 120, 30, 600),
  retentionIntervalMs = 24 * 60 * 60 * 1000,
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  if (!service) throw new TypeError("Ticket worker requires the ticket service");

  let timer = null;
  let running = false;
  let lastRunAt = null;
  let lastSuccessAt = null;
  let lastCycleError = null;
  let lastDeliveryError = null;
  let lastRetentionAt = 0;

  async function processEmail(row) {
    try {
      const result = await service.sendEmailOutbox(row);
      if (result?.suppressed) {
        await service.suppressEmail(row, result.reason);
        return "suppressed";
      }
      await service.completeEmail(row, result?.providerMessageId);
      return "sent";
    } catch (error) {
      lastDeliveryError = error?.code || error?.message || "ticket_email_failed";
      try {
        if (error?.permanent) {
          await service.suppressEmail(row, lastDeliveryError);
          return "suppressed";
        }
        await service.failEmail(row, error);
      } catch (transitionError) {
        logger.error?.("[ticket-worker] Could not release email job", {
          job_id: row.id,
          error_code: transitionError?.code || "ticket_email_transition_failed",
        });
      }
      return "failed";
    }
  }

  async function runRetention(nowMs) {
    if (nowMs - lastRetentionAt < retentionIntervalMs) return null;
    const deleted = await service.purgeEmailOutbox(500);
    lastRetentionAt = nowMs;
    return deleted;
  }

  async function runOnce() {
    if (running) return { skipped: true };
    running = true;
    lastRunAt = new Date().toISOString();
    try {
      const enqueued = await service.enqueueSlaAlerts();
      const jobs = await service.claimEmails({
        workerId,
        limit: batchSize,
        leaseSeconds,
      });
      const counts = { sent: 0, suppressed: 0, failed: 0 };
      for (const row of jobs) {
        const outcome = await processEmail(row);
        counts[outcome] += 1;
      }
      if (counts.failed === 0) lastDeliveryError = null;
      const purged = await runRetention(Date.now());
      lastSuccessAt = new Date().toISOString();
      lastCycleError = null;
      return {
        skipped: false,
        enqueued,
        claimed: jobs.length,
        ...counts,
        purged,
      };
    } catch (error) {
      lastCycleError = error?.code || error?.message || "ticket_worker_failed";
      logger.error?.("[ticket-worker] Cycle failed", { error_code: lastCycleError });
      return { skipped: false, error: lastCycleError };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return false;
    void runOnce();
    timer = setTimer(() => void runOnce(), intervalMs);
    timer?.unref?.();
    logger.info?.("[ticket-worker] Started", {
      worker_id: workerId,
      interval_ms: intervalMs,
    });
    return true;
  }

  function stop() {
    if (!timer) return false;
    clearTimer(timer);
    timer = null;
    return true;
  }

  function status() {
    return {
      ready: Boolean(timer) && !lastCycleError,
      started: Boolean(timer),
      running,
      worker_id: workerId,
      last_run_at: lastRunAt,
      last_success_at: lastSuccessAt,
      last_cycle_error: lastCycleError,
      last_delivery_error: lastDeliveryError,
    };
  }

  return { runOnce, start, status, stop };
}
