import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { cleanHtml, extractText } from "./processing.js";
import { createRagService } from "./rag.js";
import { createSafeFetch } from "./safeFetch.js";
import { createKnowledgeService } from "./service.js";

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 2;
const DEFAULT_LEASE_SECONDS = 120;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function cleanError(error) {
  return String(error?.message || error || "knowledge_processing_failed")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .slice(0, 2_000);
}

async function loadSource(supabase, job) {
  const { data, error } = await supabase
    .from("knowledge_sources")
    .select("*")
    .eq("id", job.source_id)
    .eq("company_id", job.company_id)
    .maybeSingle();
  if (error) throw new Error(`kb_source_read_failed:${error.message}`);
  if (!data) throw new Error("kb_source_not_found");
  return data;
}

async function downloadUpload(supabase, source) {
  if (!source.storage_path) throw new Error("kb_storage_path_missing");
  const { data, error } = await supabase.storage
    .from("kb-uploads")
    .download(source.storage_path);
  if (error || !data) {
    throw new Error(`kb_storage_download_failed:${error?.message || "empty_file"}`);
  }
  const buffer = Buffer.from(await data.arrayBuffer());
  return extractText(buffer, source.mime_type, source.name);
}

async function scrapeSource(safeFetcher, source) {
  if (!source.url) throw new Error("kb_source_url_missing");
  const response = await safeFetcher(source.url);
  if (!response.ok) throw new Error(`kb_scrape_http_${response.status}`);
  const text = cleanHtml(await response.text());
  if (text.length < 100) throw new Error("kb_scrape_content_too_short");
  return text;
}

export async function processKnowledgeJob({
  job,
  supabase,
  knowledgeService,
  ragService,
  safeFetcher,
}) {
  const source = await loadSource(supabase, job);

  if (job.job_type === "embed_source") {
    const result = await ragService.embedChunksOfSource({
      source_id: source.id,
      company_id: source.company_id,
    });
    if (!result.embedded_count || !result.embeddings_ready_at) {
      throw new Error("kb_source_has_no_chunks_to_embed");
    }
    const { error } = await supabase
      .from("knowledge_sources")
      .update({
        status: "ready",
        error_message: null,
        embeddings_ready_at: result.embeddings_ready_at,
        chunks_count: result.total_chunks || result.embedded_count,
        processing_started_at: null,
      })
      .eq("id", source.id)
      .eq("company_id", source.company_id);
    if (error) throw new Error(`kb_source_ready_failed:${error.message}`);
    return result;
  }

  let content;
  if (job.job_type === "extract_upload") {
    content = await downloadUpload(supabase, source);
  } else if (job.job_type === "scrape_url") {
    content = await scrapeSource(safeFetcher, source);
  } else {
    throw new Error(`kb_job_type_unsupported:${job.job_type}`);
  }

  return knowledgeService.replaceSourceContent({
    sourceId: source.id,
    companyId: source.company_id,
    content,
    sourceMetadata: source.metadata || {},
    chunkMetadata: {
      ingestion_job_id: job.id,
      ingestion_type: job.job_type,
    },
  });
}

export function createKnowledgeWorker({
  supabase,
  knowledgeService,
  ragService,
  safeFetcher,
  logger = console,
  workerId = process.env.KB_WORKER_ID || `kb-${process.pid}-${randomUUID()}`,
  intervalMs = boundedInteger(
    process.env.KB_WORKER_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
    250,
    300_000
  ),
  batchSize = boundedInteger(
    process.env.KB_WORKER_BATCH_SIZE,
    DEFAULT_BATCH_SIZE,
    1,
    10
  ),
  leaseSeconds = boundedInteger(
    process.env.KB_WORKER_LEASE_SECONDS,
    DEFAULT_LEASE_SECONDS,
    30,
    900
  ),
  schedule = setInterval,
  cancelSchedule = clearInterval,
} = {}) {
  if (!supabase || typeof supabase.rpc !== "function" || typeof supabase.from !== "function") {
    throw new TypeError("supabase.from/rpc sont requis");
  }
  if (!knowledgeService?.replaceSourceContent) {
    throw new TypeError("knowledgeService.replaceSourceContent est requis");
  }
  if (!ragService?.embedChunksOfSource) {
    throw new TypeError("ragService.embedChunksOfSource est requis");
  }
  if (typeof safeFetcher !== "function") throw new TypeError("safeFetcher est requis");

  const state = {
    ready: false,
    started: false,
    running: false,
    worker_id: workerId,
    last_run_at: null,
    last_success_at: null,
    last_error: null,
    processed_jobs: 0,
    failed_jobs: 0,
  };
  let timer = null;

  async function updateSourceAfterFailure(job, nextStatus, message) {
    const terminal = nextStatus !== "retry";
    const { error } = await supabase
      .from("knowledge_sources")
      .update({
        status: terminal ? "error" : "pending",
        error_message: message,
        processing_started_at: null,
      })
      .eq("id", job.source_id)
      .eq("company_id", job.company_id);
    if (error) {
      logger.error?.("Knowledge source failure status could not be persisted", {
        job_id: job.id,
        source_id: job.source_id,
        error_code: error.code || "kb_source_failure_update_failed",
      });
    }
  }

  async function handleJob(job) {
    try {
      const result = await processKnowledgeJob({
        job,
        supabase,
        knowledgeService,
        ragService,
        safeFetcher,
      });
      const { data: completed, error } = await supabase.rpc(
        "complete_kb_processing_job",
        { p_job_id: job.id, p_worker_id: workerId }
      );
      if (error || completed !== true) {
        throw new Error(`kb_job_complete_failed:${error?.message || "lease_lost"}`);
      }
      state.processed_jobs += 1;
      return result;
    } catch (error) {
      const message = cleanError(error);
      const retryDelay = Math.min(900, 30 * (2 ** Math.max(0, job.attempts - 1)));
      const { data: nextStatus, error: failError } = await supabase.rpc(
        "fail_kb_processing_job",
        {
          p_job_id: job.id,
          p_worker_id: workerId,
          p_error: message,
          p_retry_delay_seconds: retryDelay,
        }
      );
      if (!failError && nextStatus) {
        await updateSourceAfterFailure(job, nextStatus, message);
      }
      state.failed_jobs += 1;
      logger.warn?.("Knowledge job failed", {
        job_id: job.id,
        source_id: job.source_id,
        status: nextStatus || "unknown",
        error_code: error?.code || message.split(":", 1)[0],
      });
      return null;
    }
  }

  async function runOnce() {
    if (state.running) return { skipped: true, reason: "already_running" };
    state.running = true;
    state.last_run_at = new Date().toISOString();
    try {
      const { data: jobs, error } = await supabase.rpc(
        "claim_kb_processing_jobs",
        {
          p_worker_id: workerId,
          p_limit: batchSize,
          p_lease_seconds: leaseSeconds,
        }
      );
      if (error) throw new Error(`kb_job_claim_failed:${error.message}`);
      await Promise.all((jobs || []).map(handleJob));
      state.ready = true;
      state.last_success_at = new Date().toISOString();
      state.last_error = null;
      return { claimed: jobs?.length || 0 };
    } catch (error) {
      state.ready = false;
      state.last_error = cleanError(error);
      logger.error?.("Knowledge worker cycle failed", {
        error_code: error?.code || state.last_error.split(":", 1)[0],
      });
      return { error: state.last_error };
    } finally {
      state.running = false;
    }
  }

  function start() {
    if (state.started) return;
    state.started = true;
    // Readiness becomes true only after the first successful database cycle.
    state.ready = false;
    void runOnce();
    timer = schedule(() => void runOnce(), intervalMs);
    timer?.unref?.();
  }

  function stop() {
    if (timer) cancelSchedule(timer);
    timer = null;
    state.started = false;
    state.running = false;
    state.ready = false;
  }

  function status() {
    return { ...state };
  }

  return { runOnce, start, status, stop };
}

let defaultWorker = null;

function createDefaultWorker(logger = console) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const fireworksKey = process.env.FIREWORKS_API_KEY;
  if (!supabaseUrl || !serviceRoleKey || !fireworksKey) {
    throw new Error("kb_worker_configuration_missing");
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const ragService = createRagService({ supabase });
  const knowledgeService = createKnowledgeService({ supabase, ragService });
  return createKnowledgeWorker({
    supabase,
    ragService,
    knowledgeService,
    safeFetcher: createSafeFetch(),
    logger,
  });
}

export function startKnowledgeWorker({ logger } = {}) {
  if (!defaultWorker) defaultWorker = createDefaultWorker(logger);
  defaultWorker.start();
  return defaultWorker;
}

export function getKnowledgeWorkerStatus() {
  return defaultWorker?.status() || {
    ready: false,
    started: false,
    running: false,
    last_error: "not_started",
  };
}

export default createKnowledgeWorker;
