// ============================================================
// EXEVORI VOICE IA — PURGE DE RÉTENTION (LOI 25)
// ============================================================

import { createClient } from "@supabase/supabase-js";
import { logger } from "../../lib/logger.js";
import { processPrivacyExternalDeletions } from "./index.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_PROVIDER_BATCH_SIZE = 25;
const DEFAULT_MAX_PURGE_BATCHES = 50;
const DEFAULT_MAX_OUTBOUND_PURGE_BATCHES = 50;
const DEFAULT_MAX_POST_CALL_PURGE_BATCHES = 50;
const DEFAULT_MAX_PROVIDER_BATCHES = 100;
const RUN_HOUR_UTC = 3;
const BACKLOG_RETRY_MS = 5 * 60 * 1000;

const PURGE_COUNT_KEYS = [
  "audit_rows_deleted",
  "calls_transcripts_cleared",
  "call_recording_transcripts_cleared",
  "outbound_transcripts_cleared",
  "call_recordings_deleted",
  "calls_deleted",
  "outbound_calls_deleted",
  "learning_suggestions_deleted",
  "external_deletions_enqueued",
  "external_deletions_deleted",
  "audit_rows_inserted",
];

let retentionTimer = null;
let retentionRunInProgress = false;

function createDefaultSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("privacy_storage_unavailable");
  }
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export function millisecondsUntilNextRun(
  now = new Date(),
  runHourUtc = RUN_HOUR_UTC
) {
  const next = new Date(now);
  next.setUTCHours(runHourUtc, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

export async function runPrivacyRetentionCycle({
  client,
  processExternalDeletions = processPrivacyExternalDeletions,
  batchSize = DEFAULT_BATCH_SIZE,
  providerBatchSize = DEFAULT_PROVIDER_BATCH_SIZE,
  maxPurgeBatches = DEFAULT_MAX_PURGE_BATCHES,
  maxOutboundPurgeBatches = DEFAULT_MAX_OUTBOUND_PURGE_BATCHES,
  maxPostCallPurgeBatches = DEFAULT_MAX_POST_CALL_PURGE_BATCHES,
  maxProviderBatches = DEFAULT_MAX_PROVIDER_BATCHES,
} = {}) {
  const storage = client || createDefaultSupabase();
  const safeBatchSize = Math.max(
    1,
    Math.min(500, Number.parseInt(batchSize, 10) || DEFAULT_BATCH_SIZE)
  );
  const safeProviderBatchSize = Math.max(
    1,
    Math.min(
      100,
      Number.parseInt(providerBatchSize, 10) || DEFAULT_PROVIDER_BATCH_SIZE
    )
  );
  const safeMaxPurgeBatches = Math.max(
    1,
    Math.min(
      250,
      Number.parseInt(maxPurgeBatches, 10) || DEFAULT_MAX_PURGE_BATCHES
    )
  );
  const safeMaxProviderBatches = Math.max(
    1,
    Math.min(
      500,
      Number.parseInt(maxProviderBatches, 10) ||
        DEFAULT_MAX_PROVIDER_BATCHES
    )
  );
  const safeMaxOutboundPurgeBatches = Math.max(
    1,
    Math.min(
      250,
      Number.parseInt(maxOutboundPurgeBatches, 10)
        || DEFAULT_MAX_OUTBOUND_PURGE_BATCHES
    )
  );
  const safeMaxPostCallPurgeBatches = Math.max(
    1,
    Math.min(
      250,
      Number.parseInt(maxPostCallPurgeBatches, 10)
        || DEFAULT_MAX_POST_CALL_PURGE_BATCHES
    )
  );

  const purgeTotals = Object.fromEntries(
    PURGE_COUNT_KEYS.map(key => [key, 0])
  );
  let purgeBatches = 0;
  let purgeBacklogPossible = false;

  for (; purgeBatches < safeMaxPurgeBatches; purgeBatches += 1) {
    const { data: purgeResult, error: purgeError } = await storage.rpc(
      "purge_expired_privacy_data",
      { p_batch_size: safeBatchSize }
    );
    if (purgeError) throw purgeError;

    const result =
      purgeResult && typeof purgeResult === "object" ? purgeResult : {};
    for (const key of PURGE_COUNT_KEYS) {
      const count = Number(result[key]);
      if (Number.isFinite(count) && count > 0) purgeTotals[key] += count;
    }

    const batchWasFull = [
      "audit_rows_deleted",
      "calls_transcripts_cleared",
      "call_recording_transcripts_cleared",
      "outbound_transcripts_cleared",
      "call_recordings_deleted",
      "calls_deleted",
      "outbound_calls_deleted",
      "learning_suggestions_deleted",
      "external_deletions_deleted",
    ].some(key => Number(result[key] || 0) >= safeBatchSize);
    if (!batchWasFull) {
      purgeBatches += 1;
      break;
    }
    purgeBacklogPossible = purgeBatches + 1 >= safeMaxPurgeBatches;
  }

  const outboundQueueMetadata = {
    deleted: 0,
    batches: 0,
    backlog_possible: false,
  };
  for (
    ;
    outboundQueueMetadata.batches < safeMaxOutboundPurgeBatches;
    outboundQueueMetadata.batches += 1
  ) {
    const { data: rows, error } = await storage.rpc(
      "purge_expired_outbound_queue_metadata",
      {
        p_batch_size: safeBatchSize,
        p_company_id: null,
      }
    );
    if (error) throw error;

    const deletedThisBatch = (Array.isArray(rows) ? rows : rows ? [rows] : [])
      .reduce((total, row) => {
        const count = Number(row?.affected);
        return total + (Number.isFinite(count) && count > 0 ? count : 0);
      }, 0);
    outboundQueueMetadata.deleted += deletedThisBatch;
    if (deletedThisBatch < safeBatchSize) {
      outboundQueueMetadata.batches += 1;
      break;
    }
    outboundQueueMetadata.backlog_possible =
      outboundQueueMetadata.batches + 1 >= safeMaxOutboundPurgeBatches;
  }

  const postCallJobs = {
    deleted: 0,
    batches: 0,
    backlog_possible: false,
  };
  for (
    ;
    postCallJobs.batches < safeMaxPostCallPurgeBatches;
    postCallJobs.batches += 1
  ) {
    const { data: rows, error } = await storage.rpc(
      "purge_expired_post_call_processing_jobs",
      {
        p_batch_size: safeBatchSize,
        p_company_id: null,
      }
    );
    if (error) throw error;

    const deletedThisBatch = (Array.isArray(rows) ? rows : rows ? [rows] : [])
      .reduce((total, row) => {
        const count = Number(row?.deleted_count);
        return total + (Number.isFinite(count) && count > 0 ? count : 0);
      }, 0);
    postCallJobs.deleted += deletedThisBatch;
    if (deletedThisBatch < safeBatchSize) {
      postCallJobs.batches += 1;
      break;
    }
    postCallJobs.backlog_possible =
      postCallJobs.batches + 1 >= safeMaxPostCallPurgeBatches;
  }

  const providerTotals = {
    claimed: 0,
    completed: 0,
    retry: 0,
    failed: 0,
    pending: false,
  };
  let providerBatches = 0;
  let providerBacklogPossible = false;

  for (
    ;
    providerBatches < safeMaxProviderBatches;
    providerBatches += 1
  ) {
    const providerResult = await processExternalDeletions({
      supabase: storage,
      batchSize: safeProviderBatchSize,
    });
    for (const key of ["claimed", "completed", "retry", "failed"]) {
      const count = Number(providerResult?.[key]);
      if (Number.isFinite(count) && count > 0) providerTotals[key] += count;
    }
    providerTotals.pending ||= providerResult?.pending === true;

    const claimed = Number(providerResult?.claimed || 0);
    if (claimed < safeProviderBatchSize) {
      providerBatches += 1;
      break;
    }
    providerBacklogPossible =
      providerBatches + 1 >= safeMaxProviderBatches;
  }

  const backlogPossible =
    purgeBacklogPossible ||
    outboundQueueMetadata.backlog_possible ||
    postCallJobs.backlog_possible ||
    providerBacklogPossible ||
    providerTotals.pending;

  return {
    purge: {
      ...purgeTotals,
      batches: purgeBatches,
      backlog_possible: purgeBacklogPossible,
    },
    outbound_queue_metadata: outboundQueueMetadata,
    post_call_jobs: postCallJobs,
    external_deletions: {
      ...providerTotals,
      batches: providerBatches,
      backlog_possible: providerBacklogPossible,
    },
    backlog_possible: backlogPossible,
  };
}

async function runScheduledCycle(options) {
  if (retentionRunInProgress) {
    logger.warn("Privacy retention skipped: previous run still active");
    return;
  }

  retentionRunInProgress = true;
  try {
    const result = await runPrivacyRetentionCycle(options);
    logger.info("Privacy retention cycle completed", {
      purge: result.purge,
      outbound_queue_metadata: result.outbound_queue_metadata,
      post_call_jobs: result.post_call_jobs,
      external_deletions: result.external_deletions,
    });
    return result;
  } catch (error) {
    logger.error("Privacy retention cycle failed", {
      error: error?.message || String(error),
    });
    return { backlog_possible: true };
  } finally {
    retentionRunInProgress = false;
  }
}

export function startPrivacyRetentionJob({
  client,
  processExternalDeletions = processPrivacyExternalDeletions,
  batchSize = DEFAULT_BATCH_SIZE,
  providerBatchSize = DEFAULT_PROVIDER_BATCH_SIZE,
  maxPurgeBatches = DEFAULT_MAX_PURGE_BATCHES,
  maxOutboundPurgeBatches = DEFAULT_MAX_OUTBOUND_PURGE_BATCHES,
  maxPostCallPurgeBatches = DEFAULT_MAX_POST_CALL_PURGE_BATCHES,
  maxProviderBatches = DEFAULT_MAX_PROVIDER_BATCHES,
  now = () => new Date(),
  setTimer = setTimeout,
} = {}) {
  if (retentionTimer) return false;
  const storage = client || createDefaultSupabase();

  const scheduleNext = (delayOverride = null) => {
    const delay =
      delayOverride === null
        ? millisecondsUntilNextRun(now())
        : delayOverride;
    retentionTimer = setTimer(async () => {
      retentionTimer = null;
      const result = await runScheduledCycle({
        client: storage,
        processExternalDeletions,
        batchSize,
        providerBatchSize,
        maxPurgeBatches,
        maxOutboundPurgeBatches,
        maxPostCallPurgeBatches,
        maxProviderBatches,
      });
      scheduleNext(result?.backlog_possible ? BACKLOG_RETRY_MS : null);
    }, delay);
    retentionTimer?.unref?.();
  };

  scheduleNext();
  logger.info("Privacy retention job scheduled", {
    run_hour_utc: RUN_HOUR_UTC,
    frequency_hours: DAY_MS / (60 * 60 * 1000),
  });
  return true;
}

export function stopPrivacyRetentionJob(clearTimer = clearTimeout) {
  if (!retentionTimer) return false;
  clearTimer(retentionTimer);
  retentionTimer = null;
  return true;
}
