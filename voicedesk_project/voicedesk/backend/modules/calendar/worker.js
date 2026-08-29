import { randomUUID } from "node:crypto";

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function createCalendarWorkers({
  supabase,
  service,
  logger = console,
  workerId = process.env.CALENDAR_WORKER_ID || `calendar-${randomUUID()}`,
  intervalMs = boundedInteger(process.env.CALENDAR_WORKER_INTERVAL_MS, 5_000, 1_000, 60_000),
  retentionIntervalMs = boundedInteger(
    process.env.CALENDAR_RETENTION_INTERVAL_MS,
    6 * 60 * 60 * 1000,
    60_000,
    7 * 24 * 60 * 60 * 1000
  ),
  batchSize = boundedInteger(process.env.CALENDAR_WORKER_BATCH_SIZE, 20, 1, 100),
} = {}) {
  if (!supabase || !service) throw new Error("Calendar workers require Supabase and the calendar service");

  let timer = null;
  let running = false;
  let lastRunAt = null;
  let lastSuccessAt = null;
  let lastRetentionAt = 0;
  let lastError = null;

  async function claim(name) {
    const { data, error } = await supabase.rpc(name, {
      p_worker_id: workerId,
      p_limit: batchSize,
      p_lease_seconds: 120,
    });
    if (error) throw error;
    return data || [];
  }

  async function processWebhooks() {
    const rows = await claim("claim_calendly_webhook_events");
    for (const row of rows) {
      try {
        const result = await service.processWebhookEvent(row);
        await service.completeWebhook(row, result);
      } catch (error) {
        try {
          await service.failWebhook(row, error);
        } catch (updateError) {
          logger.error?.("[calendar-worker] Could not release webhook job", {
            job_id: row.id,
            error_code: updateError?.code || "webhook_failure_update_failed",
          });
        }
      }
    }
    return rows.length;
  }

  async function processEmails() {
    const rows = await claim("claim_calendar_email_outbox");
    for (const row of rows) {
      try {
        const providerMessageId = await service.sendEmailOutbox(row);
        await service.completeEmail(row, providerMessageId);
      } catch (error) {
        try {
          await service.failEmail(row, error);
        } catch (updateError) {
          logger.error?.("[calendar-worker] Could not release email job", {
            job_id: row.id,
            error_code: updateError?.code || "email_failure_update_failed",
          });
        }
      }
    }
    return rows.length;
  }

  async function runRetention(nowMs) {
    if (nowMs - lastRetentionAt < retentionIntervalMs) return null;
    const { data, error } = await supabase.rpc("purge_expired_calendar_data", {
      p_batch_size: Math.min(500, batchSize * 10),
      p_appointment_retention_days: 730,
    });
    if (error) throw error;
    lastRetentionAt = nowMs;
    return data;
  }

  async function runOnce() {
    if (running) return { skipped: true };
    running = true;
    lastRunAt = new Date().toISOString();
    try {
      const [webhooks, emails] = await Promise.all([
        processWebhooks(),
        processEmails(),
      ]);
      const retention = await runRetention(Date.now());
      lastSuccessAt = new Date().toISOString();
      lastError = null;
      return { skipped: false, webhooks, emails, retention };
    } catch (error) {
      lastError = error?.code || error?.message || "calendar_worker_failed";
      logger.error?.("[calendar-worker] Cycle failed", { error_code: lastError });
      return { skipped: false, error: lastError };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return false;
    void runOnce();
    timer = setInterval(() => void runOnce(), intervalMs);
    timer.unref?.();
    logger.info?.("[calendar-worker] Started", { worker_id: workerId, interval_ms: intervalMs });
    return true;
  }

  function stop() {
    if (!timer) return false;
    clearInterval(timer);
    timer = null;
    return true;
  }

  function status() {
    return {
      ready: Boolean(timer) && !lastError,
      started: Boolean(timer),
      running,
      worker_id: workerId,
      last_run_at: lastRunAt,
      last_success_at: lastSuccessAt,
      last_error: lastError,
    };
  }

  return { runOnce, start, status, stop };
}
