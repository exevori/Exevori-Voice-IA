import { createClient } from "@supabase/supabase-js";

import {
  hasConsentTerminationCapability,
  prefixRecordingConsentFr,
} from "./consent.js";

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_RETRY_BASE_MS = 30_000;
const DEFAULT_RETRY_MAX_MS = 30 * 60 * 1_000;
const DEFAULT_RECOVERY_RETRY_MS = 6 * 60 * 60 * 1_000;

const EMPTY_SUMMARY = Object.freeze({
  examined: 0,
  updated: 0,
  skipped: 0,
  failed: 0,
});

let activeSyncRun = null;
let recoveryTimer = null;
let consentSyncState = {
  status: "idle",
  ready: false,
  attempt: 0,
  maxAttempts: 0,
  startedAt: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  nextRetryAt: null,
  summary: { ...EMPTY_SUMMARY },
};

function normalizeSummary(result, fallbackFailed = 0) {
  const count = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0
      ? Math.trunc(parsed)
      : fallback;
  };
  return {
    examined: count(result?.examined),
    updated: count(result?.updated),
    skipped: count(result?.skipped),
    failed: count(result?.failed, fallbackFailed),
  };
}

function positiveInteger(value, fallback, { min = 1, max = Infinity } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function defaultSleep(delayMs) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

function snapshotState() {
  return {
    ...consentSyncState,
    summary: { ...consentSyncState.summary },
  };
}

function getCustomLlmConfig(agentConfig) {
  return (
    agentConfig?.llm?.custom_llm
    || agentConfig?.prompt?.llm?.custom_llm
    || null
  );
}

function hasCustomLlmCredential(customLlm) {
  if (!customLlm || typeof customLlm !== "object") return false;
  const credential = customLlm.api_key;
  return (
    (typeof credential === "string" && credential.trim().length > 0)
    || (
      credential
      && typeof credential === "object"
      && (
        typeof credential.secret_id === "string"
        || typeof credential.env_var_label === "string"
      )
    )
  );
}

/**
 * Etat sans secret exploitable par un health/readiness check.
 * `ready` ne devient vrai que lorsque tous les agents ont ete synchronises.
 */
export function getPrivacyConsentSyncStatus() {
  return snapshotState();
}

function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(100, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)
  );
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

async function requestElevenLabs({
  fetchImpl,
  apiKey,
  agentId,
  method,
  body,
  timeoutMs,
}) {
  const timeout = createTimeoutSignal(timeoutMs);
  try {
    const response = await fetchImpl(
      `${ELEVENLABS_API_BASE}/v1/convai/agents/${encodeURIComponent(agentId)}`,
      {
        method,
        signal: timeout.signal,
        headers: {
          "xi-api-key": apiKey,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }
    );
    if (!response.ok) throw new Error("elevenlabs_request_failed");
    return method === "GET" ? response.json() : null;
  } catch {
    throw new Error("elevenlabs_request_failed");
  } finally {
    timeout.clear();
  }
}

/**
 * Synchronise l'annonce de consentement sur les agents existants.
 * Le client service-role est créé ici, jamais au chargement du module.
 */
export async function syncExistingElevenLabsConsent({
  supabase,
  createClientImpl = createClient,
  supabaseUrl = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  fetchImpl = globalThis.fetch,
  apiKey = process.env.ELEVENLABS_API_KEY,
  customLlmSecret = process.env.ELEVENLABS_CUSTOM_LLM_SECRET,
  masterAgentId = process.env.ELEVENLABS_MASTER_AGENT_ID,
  timeoutMs = process.env.PRIVACY_PROVIDER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch_unavailable");
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("elevenlabs_not_configured");
  }
  if (
    typeof customLlmSecret !== "string"
    || !customLlmSecret.trim()
  ) {
    throw new Error("custom_llm_secret_not_configured");
  }

  let storage = supabase;
  if (!storage) {
    if (
      typeof supabaseUrl !== "string" ||
      !supabaseUrl.trim() ||
      typeof serviceRoleKey !== "string" ||
      !serviceRoleKey.trim()
    ) {
      throw new Error("privacy_storage_unavailable");
    }
    storage = createClientImpl(supabaseUrl.trim(), serviceRoleKey.trim(), {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  const { data, error } = await storage
    .from("assistant_configs")
    .select("elevenlabs_agent_id")
    .not("elevenlabs_agent_id", "is", null);
  if (error) throw new Error("assistant_configs_read_failed");

  const configuredAgentIds = (data || [])
    .map(config => config?.elevenlabs_agent_id)
    .filter(value => typeof value === "string" && value.trim())
    .map(value => value.trim());
  if (typeof masterAgentId === "string" && masterAgentId.trim()) {
    configuredAgentIds.push(masterAgentId.trim());
  }
  const agentIds = [...new Set(configuredAgentIds)];
  if (agentIds.length === 0) {
    return {
      examined: 0,
      updated: 0,
      skipped: 0,
      failed: 1,
    };
  }
  const summary = {
    examined: agentIds.length,
    updated: 0,
    skipped: 0,
    failed: 0,
  };

  for (const agentId of agentIds) {
    try {
      const agent = await requestElevenLabs({
        fetchImpl,
        apiKey,
        agentId,
        method: "GET",
        timeoutMs,
      });
      const currentAgentConfig = agent?.conversation_config?.agent || {};
      const customLlm = getCustomLlmConfig(currentAgentConfig);
      if (
        !hasCustomLlmCredential(customLlm)
        || !hasConsentTerminationCapability(agent)
      ) {
        // Ne jamais publier une annonce "prête" si le Custom LLM ne peut pas
        // s'authentifier. La valeur du secret reste volontairement opaque.
        summary.failed += 1;
        continue;
      }
      const firstMessage = prefixRecordingConsentFr(
        currentAgentConfig.first_message || ""
      );
      if (
        currentAgentConfig.first_message === firstMessage &&
        currentAgentConfig.disable_first_message_interruptions === true
      ) {
        summary.skipped += 1;
        continue;
      }

      await requestElevenLabs({
        fetchImpl,
        apiKey,
        agentId,
        method: "PATCH",
        timeoutMs,
        body: {
          conversation_config: {
            agent: {
              first_message: firstMessage,
              disable_first_message_interruptions: true,
            },
          },
        },
      });
      summary.updated += 1;
    } catch {
      summary.failed += 1;
    }
  }

  return summary;
}

export function startPrivacyConsentSync({
  logger,
  syncImpl = syncExistingElevenLabsConsent,
  syncOptions,
  maxAttempts = process.env.PRIVACY_CONSENT_SYNC_MAX_ATTEMPTS
    || DEFAULT_MAX_ATTEMPTS,
  retryBaseMs = process.env.PRIVACY_CONSENT_SYNC_RETRY_BASE_MS
    || DEFAULT_RETRY_BASE_MS,
  retryMaxMs = process.env.PRIVACY_CONSENT_SYNC_RETRY_MAX_MS
    || DEFAULT_RETRY_MAX_MS,
  recoveryRetryMs = process.env.PRIVACY_CONSENT_SYNC_RECOVERY_MS
    || DEFAULT_RECOVERY_RETRY_MS,
  sleepImpl = defaultSleep,
  nowImpl = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (activeSyncRun) return activeSyncRun;
  if (recoveryTimer) {
    clearTimer(recoveryTimer);
    recoveryTimer = null;
  }

  const attemptsLimit = positiveInteger(maxAttempts, DEFAULT_MAX_ATTEMPTS, {
    max: 20,
  });
  const baseDelay = positiveInteger(
    retryBaseMs,
    DEFAULT_RETRY_BASE_MS,
    { min: 100, max: 24 * 60 * 60 * 1_000 }
  );
  const maximumDelay = positiveInteger(
    retryMaxMs,
    DEFAULT_RETRY_MAX_MS,
    { min: baseDelay, max: 24 * 60 * 60 * 1_000 }
  );
  const parsedRecoveryDelay = Number(recoveryRetryMs);
  const recoveryDelay =
    Number.isFinite(parsedRecoveryDelay) && parsedRecoveryDelay === 0
      ? 0
      : positiveInteger(
          recoveryRetryMs,
          DEFAULT_RECOVERY_RETRY_MS,
          { min: 60_000, max: 7 * 24 * 60 * 60 * 1_000 }
        );
  const startedAtMs = Number(nowImpl());
  const safeStartedAtMs = Number.isFinite(startedAtMs)
    ? startedAtMs
    : Date.now();

  const run = async () => {
    let lastSummary = { ...EMPTY_SUMMARY };

    for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
      const attemptAtMs = Number(nowImpl());
      const safeAttemptAtMs = Number.isFinite(attemptAtMs)
        ? attemptAtMs
        : Date.now();
      consentSyncState = {
        ...consentSyncState,
        status: "running",
        ready: false,
        attempt,
        maxAttempts: attemptsLimit,
        startedAt: new Date(safeStartedAtMs).toISOString(),
        lastAttemptAt: new Date(safeAttemptAtMs).toISOString(),
        nextRetryAt: null,
        summary: { ...lastSummary },
      };

      try {
        lastSummary = normalizeSummary(await syncImpl(syncOptions));
      } catch {
        lastSummary = normalizeSummary(null, 1);
      }

      if (lastSummary.examined > 0 && lastSummary.failed === 0) {
        const successAtMs = Number(nowImpl());
        const safeSuccessAtMs = Number.isFinite(successAtMs)
          ? successAtMs
          : Date.now();
        consentSyncState = {
          ...consentSyncState,
          status: "ready",
          ready: true,
          lastSuccessAt: new Date(safeSuccessAtMs).toISOString(),
          nextRetryAt: null,
          summary: { ...lastSummary },
        };
        logger?.info?.("Privacy consent sync completed", lastSummary);
        return lastSummary;
      }

      if (attempt === attemptsLimit) {
        const recoveryAtMs = Number(nowImpl());
        const safeRecoveryAtMs = Number.isFinite(recoveryAtMs)
          ? recoveryAtMs
          : Date.now();
        consentSyncState = {
          ...consentSyncState,
          status: "degraded",
          ready: false,
          nextRetryAt: recoveryDelay > 0
            ? new Date(safeRecoveryAtMs + recoveryDelay).toISOString()
            : null,
          summary: { ...lastSummary },
        };
        logger?.warn?.("Privacy consent sync unavailable", {
          ...lastSummary,
          attempt,
          maxAttempts: attemptsLimit,
        });
        if (recoveryDelay > 0 && !recoveryTimer) {
          recoveryTimer = setTimer(() => {
            recoveryTimer = null;
            void startPrivacyConsentSync({
              logger,
              syncImpl,
              syncOptions,
              maxAttempts: attemptsLimit,
              retryBaseMs: baseDelay,
              retryMaxMs: maximumDelay,
              recoveryRetryMs: recoveryDelay,
              sleepImpl,
              nowImpl,
              setTimer,
              clearTimer,
            });
          }, recoveryDelay);
          recoveryTimer?.unref?.();
        }
        return lastSummary;
      }

      const retryDelay = Math.min(
        maximumDelay,
        baseDelay * (2 ** (attempt - 1))
      );
      const retryScheduledAtMs = Number(nowImpl());
      const safeRetryScheduledAtMs = Number.isFinite(retryScheduledAtMs)
        ? retryScheduledAtMs
        : Date.now();
      consentSyncState = {
        ...consentSyncState,
        status: "retry_scheduled",
        ready: false,
        nextRetryAt: new Date(
          safeRetryScheduledAtMs + retryDelay
        ).toISOString(),
        summary: { ...lastSummary },
      };
      logger?.warn?.("Privacy consent sync retry scheduled", {
        ...lastSummary,
        attempt,
        maxAttempts: attemptsLimit,
        retryInMs: retryDelay,
      });
      try {
        await sleepImpl(retryDelay);
      } catch {
        consentSyncState = {
          ...consentSyncState,
          status: "degraded",
          ready: false,
          nextRetryAt: null,
          summary: { ...lastSummary },
        };
        logger?.warn?.("Privacy consent sync unavailable", {
          ...lastSummary,
          attempt,
          maxAttempts: attemptsLimit,
        });
        return lastSummary;
      }
    }

    return lastSummary;
  };

  activeSyncRun = run().finally(() => {
    activeSyncRun = null;
  });
  return activeSyncRun;
}
