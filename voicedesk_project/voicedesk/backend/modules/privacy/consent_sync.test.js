import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  RECORDING_CONSENT_NOTICE_FR,
  prefixRecordingConsentFr,
} from "./consent.js";
import {
  getPrivacyConsentSyncStatus,
  startPrivacyConsentSync,
  syncExistingElevenLabsConsent,
} from "./consent_sync.js";

process.env.ELEVENLABS_CUSTOM_LLM_SECRET =
  "test-only-custom-llm-shared-secret";

class AssistantConfigsQuery {
  constructor(rows, error = null) {
    this.rows = rows;
    this.error = error;
    this.notCalls = [];
  }

  select() {
    return this;
  }

  not(...args) {
    this.notCalls.push(args);
    return Promise.resolve({ data: this.rows, error: this.error });
  }
}

function fakeSupabase(rows, error = null) {
  const query = new AssistantConfigsQuery(rows, error);
  return {
    query,
    from(table) {
      assert.equal(table, "assistant_configs");
      return query;
    },
  };
}

test("sync GET puis PATCH le payload officiel et ne retourne aucun agent_id", async () => {
  const supabase = fakeSupabase([
    { elevenlabs_agent_id: "agent-test-one" },
    { elevenlabs_agent_id: "agent-test-one" },
  ]);
  const requests = [];
  const summary = await syncExistingElevenLabsConsent({
    supabase,
    apiKey: "test-only-elevenlabs-key",
    masterAgentId: "agent-test-one",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (options.method === "GET") {
        return {
          ok: true,
          async json() {
            return {
              conversation_config: {
                agent: {
                  first_message: "Comment puis-je vous aider ?",
                  llm: {
                    custom_llm: {
                      api_key: { secret_id: "test-secret-ref" },
                    },
                  },
                  tools: [{ params: { system_tool_type: "end_call" } }],
                },
              },
            };
          },
        };
      }
      return { ok: true };
    },
  });

  assert.deepEqual(summary, {
    examined: 1,
    updated: 1,
    skipped: 0,
    failed: 0,
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.method, "GET");
  assert.equal(requests[1].options.method, "PATCH");
  assert.match(requests[1].url, /\/v1\/convai\/agents\/agent-test-one$/);
  assert.equal(
    requests[1].options.headers["xi-api-key"],
    "test-only-elevenlabs-key"
  );
  const body = JSON.parse(requests[1].options.body);
  assert.deepEqual(body, {
    conversation_config: {
      agent: {
        first_message: prefixRecordingConsentFr(
          "Comment puis-je vous aider ?"
        ),
        disable_first_message_interruptions: true,
      },
    },
  });
  assert.equal(JSON.stringify(summary).includes("agent-test-one"), false);
  assert.deepEqual(supabase.query.notCalls, [
    ["elevenlabs_agent_id", "is", null],
  ]);
});

test("sync est idempotent lorsque message et verrou sont déjà présents", async () => {
  const requests = [];
  const summary = await syncExistingElevenLabsConsent({
    supabase: fakeSupabase([{ elevenlabs_agent_id: "agent-idempotent" }]),
    apiKey: "test-only-elevenlabs-key",
    masterAgentId: null,
    fetchImpl: async (_url, options) => {
      requests.push(options.method);
      return {
        ok: true,
        async json() {
          return {
            conversation_config: {
              agent: {
                first_message: RECORDING_CONSENT_NOTICE_FR,
                disable_first_message_interruptions: true,
                llm: {
                  custom_llm: {
                    api_key: { secret_id: "test-secret-ref" },
                  },
                },
                tools: [{ params: { system_tool_type: "end_call" } }],
              },
            },
          };
        },
      };
    },
  });

  assert.deepEqual(summary, {
    examined: 1,
    updated: 0,
    skipped: 1,
    failed: 0,
  });
  assert.deepEqual(requests, ["GET"]);
});

test("sync échoue fermé si un Custom LLM n'a aucune référence de secret", async () => {
  const requests = [];
  const summary = await syncExistingElevenLabsConsent({
    supabase: fakeSupabase([{ elevenlabs_agent_id: "agent-no-secret" }]),
    apiKey: "test-only-elevenlabs-key",
    masterAgentId: null,
    fetchImpl: async (_url, options) => {
      requests.push(options.method);
      return {
        ok: true,
        async json() {
          return {
            conversation_config: {
              agent: {
                first_message: "Bonjour",
                llm: {
                  custom_llm: {
                    url: "https://example.test/v1/chat/completions",
                  },
                },
              },
            },
          };
        },
      };
    },
  });

  assert.deepEqual(summary, {
    examined: 1,
    updated: 0,
    skipped: 0,
    failed: 1,
  });
  assert.deepEqual(requests, ["GET"]);
});

test("sync ne déclare jamais ready un agent sans Custom LLM", async () => {
  const summary = await syncExistingElevenLabsConsent({
    supabase: fakeSupabase([{ elevenlabs_agent_id: "agent-built-in" }]),
    apiKey: "test-only-elevenlabs-key",
    masterAgentId: null,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          conversation_config: {
            agent: {
              first_message: RECORDING_CONSENT_NOTICE_FR,
              disable_first_message_interruptions: true,
            },
          },
        };
      },
    }),
  });

  assert.deepEqual(summary, {
    examined: 1,
    updated: 0,
    skipped: 0,
    failed: 1,
  });
});

test("sync ne déclare jamais ready un agent sans outil end_call", async () => {
  const summary = await syncExistingElevenLabsConsent({
    supabase: fakeSupabase([{ elevenlabs_agent_id: "agent-no-end-call" }]),
    apiKey: "test-only-elevenlabs-key",
    masterAgentId: null,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          conversation_config: {
            agent: {
              first_message: RECORDING_CONSENT_NOTICE_FR,
              disable_first_message_interruptions: true,
              llm: {
                custom_llm: {
                  api_key: { secret_id: "test-secret-ref" },
                },
              },
            },
          },
        };
      },
    }),
  });

  assert.deepEqual(summary, {
    examined: 1,
    updated: 0,
    skipped: 0,
    failed: 1,
  });
});

test("sync accepte une référence de secret Custom LLM sans lire sa valeur", async () => {
  const requests = [];
  const summary = await syncExistingElevenLabsConsent({
    supabase: fakeSupabase([{ elevenlabs_agent_id: "agent-secret-ref" }]),
    apiKey: "test-only-elevenlabs-key",
    masterAgentId: null,
    fetchImpl: async (_url, options) => {
      requests.push(options.method);
      if (options.method === "GET") {
        return {
          ok: true,
          async json() {
            return {
              conversation_config: {
                agent: {
                  first_message: "Bonjour",
                  llm: {
                    custom_llm: {
                      url: "https://example.test/v1/chat/completions",
                      api_key: { secret_id: "opaque-secret-reference" },
                    },
                  },
                  tools: [{ params: { system_tool_type: "end_call" } }],
                },
              },
            };
          },
        };
      }
      return { ok: true };
    },
  });

  assert.deepEqual(summary, {
    examined: 1,
    updated: 1,
    skipped: 0,
    failed: 0,
  });
  assert.deepEqual(requests, ["GET", "PATCH"]);
});

test("sync échoue fermé sans clé et compte timeout/erreurs sans fuite", async () => {
  await assert.rejects(
    syncExistingElevenLabsConsent({
      supabase: fakeSupabase([]),
      apiKey: "",
      masterAgentId: null,
      fetchImpl: async () => ({ ok: true }),
    }),
    /elevenlabs_not_configured/
  );

  const summary = await syncExistingElevenLabsConsent({
    supabase: fakeSupabase([{ elevenlabs_agent_id: "agent-timeout" }]),
    apiKey: "test-only-elevenlabs-key",
    masterAgentId: null,
    timeoutMs: 100,
    fetchImpl: async (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(new Error("request aborted"))
        );
      }),
  });
  assert.deepEqual(summary, {
    examined: 1,
    updated: 0,
    skipped: 0,
    failed: 1,
  });
  assert.equal(JSON.stringify(summary).includes("agent-timeout"), false);
});

test("sync inclut le master agent même sans agent configuré en base", async () => {
  const urls = [];
  const summary = await syncExistingElevenLabsConsent({
    supabase: fakeSupabase([]),
    apiKey: "test-only-elevenlabs-key",
    masterAgentId: "master-agent-test",
    fetchImpl: async (url, options) => {
      urls.push(url);
      if (options.method === "GET") {
        return {
          ok: true,
          async json() {
            return {
              conversation_config: {
                agent: {
                  llm: {
                    custom_llm: {
                      api_key: { secret_id: "test-secret-ref" },
                    },
                  },
                  tools: [{ params: { system_tool_type: "end_call" } }],
                },
              },
            };
          },
        };
      }
      return { ok: true };
    },
  });
  assert.deepEqual(summary, {
    examined: 1,
    updated: 1,
    skipped: 0,
    failed: 0,
  });
  assert.equal(urls.every(url => url.endsWith("/master-agent-test")), true);
});

test("sync crée le client service-role seulement au moment de l'appel", async () => {
  const createdClients = [];
  const query = fakeSupabase([]).query;
  const summary = await syncExistingElevenLabsConsent({
    supabaseUrl: "https://project-test.supabase.co",
    serviceRoleKey: "test-only-service-role",
    createClientImpl(url, key, options) {
      createdClients.push({ url, key, options });
      return {
        from(table) {
          assert.equal(table, "assistant_configs");
          return query;
        },
      };
    },
    apiKey: "test-only-elevenlabs-key",
    masterAgentId: null,
    fetchImpl: async () => {
      throw new Error("aucun appel externe attendu");
    },
  });

  assert.deepEqual(summary, {
    examined: 0,
    updated: 0,
    skipped: 0,
    failed: 1,
  });
  assert.deepEqual(createdClients, [
    {
      url: "https://project-test.supabase.co",
      key: "test-only-service-role",
      options: {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    },
  ]);
});

test("sync échoue fermé sans secret Custom LLM local", async () => {
  let storageRead = false;
  await assert.rejects(
    syncExistingElevenLabsConsent({
      supabase: {
        from() {
          storageRead = true;
          return fakeSupabase([]).query;
        },
      },
      apiKey: "test-only-elevenlabs-key",
      customLlmSecret: "",
      fetchImpl: async () => ({ ok: true }),
    }),
    /custom_llm_secret_not_configured/
  );
  assert.equal(storageRead, false);
});

test("sync sans client refuse une configuration Supabase incomplète", async () => {
  let factoryCalled = false;
  await assert.rejects(
    syncExistingElevenLabsConsent({
      supabaseUrl: "",
      serviceRoleKey: "",
      createClientImpl() {
        factoryCalled = true;
        return fakeSupabase([]);
      },
      apiKey: "test-only-elevenlabs-key",
      masterAgentId: null,
      fetchImpl: async () => ({ ok: true }),
    }),
    /privacy_storage_unavailable/
  );
  assert.equal(factoryCalled, false);
});

test("le démarrage est fail-safe et ne journalise que les compteurs", async () => {
  const logs = [];
  const summary = await startPrivacyConsentSync({
    maxAttempts: 1,
    recoveryRetryMs: 0,
    logger: {
      warn(message, metadata) {
        logs.push({ level: "warn", message, metadata });
      },
    },
    syncImpl: async () => {
      throw new Error("secret-provider-detail");
    },
  });

  assert.deepEqual(summary, {
    examined: 0,
    updated: 0,
    skipped: 0,
    failed: 1,
  });
  assert.deepEqual(logs, [
    {
      level: "warn",
      message: "Privacy consent sync unavailable",
      metadata: {
        ...summary,
        attempt: 1,
        maxAttempts: 1,
      },
    },
  ]);
  assert.equal(JSON.stringify(logs).includes("secret-provider-detail"), false);
  assert.deepEqual(Object.keys(logs[0].metadata), [
    "examined",
    "updated",
    "skipped",
    "failed",
    "attempt",
    "maxAttempts",
  ]);
  assert.deepEqual(
    {
      status: getPrivacyConsentSyncStatus().status,
      ready: getPrivacyConsentSyncStatus().ready,
      nextRetryAt: getPrivacyConsentSyncStatus().nextRetryAt,
    },
    {
      status: "degraded",
      ready: false,
      nextRetryAt: null,
    }
  );
});

test("le démarrage réussi normalise les compteurs sans exposer le résultat brut", async () => {
  const logs = [];
  const summary = await startPrivacyConsentSync({
    logger: {
      info(message, metadata) {
        logs.push({ message, metadata });
      },
    },
    syncImpl: async () => ({
      examined: 2,
      updated: 1,
      skipped: 1,
      failed: 0,
      agent_id: "must-not-be-logged",
    }),
  });

  assert.deepEqual(summary, {
    examined: 2,
    updated: 1,
    skipped: 1,
    failed: 0,
  });
  assert.deepEqual(logs, [
    {
      message: "Privacy consent sync completed",
      metadata: summary,
    },
  ]);
  assert.equal(JSON.stringify(logs).includes("must-not-be-logged"), false);
  assert.equal(getPrivacyConsentSyncStatus().status, "ready");
  assert.equal(getPrivacyConsentSyncStatus().ready, true);
});

test("le sync retente avec backoff exponentiel borné puis devient ready", async () => {
  const delays = [];
  const statesDuringDelay = [];
  let attempts = 0;

  const summary = await startPrivacyConsentSync({
    maxAttempts: 4,
    retryBaseMs: 100,
    retryMaxMs: 150,
    syncImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("provider detail must stay private");
      if (attempts === 2) {
        return { examined: 2, updated: 1, skipped: 0, failed: 1 };
      }
      return { examined: 2, updated: 1, skipped: 1, failed: 0 };
    },
    sleepImpl: async delayMs => {
      delays.push(delayMs);
      statesDuringDelay.push(getPrivacyConsentSyncStatus());
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 150]);
  assert.equal(
    statesDuringDelay.every(state =>
      state.status === "retry_scheduled"
      && state.ready === false
      && typeof state.nextRetryAt === "string"
    ),
    true
  );
  assert.deepEqual(summary, {
    examined: 2,
    updated: 1,
    skipped: 1,
    failed: 0,
  });
  const readiness = getPrivacyConsentSyncStatus();
  assert.equal(readiness.status, "ready");
  assert.equal(readiness.ready, true);
  assert.equal(readiness.attempt, 3);
  assert.equal(readiness.maxAttempts, 4);
  assert.equal(readiness.nextRetryAt, null);
  assert.deepEqual(readiness.summary, summary);
});

test("le sync borne les reprises et expose un état dégradé sans secret", async () => {
  const delays = [];
  const logs = [];
  let attempts = 0;
  const summary = await startPrivacyConsentSync({
    maxAttempts: 3,
    retryBaseMs: 100,
    retryMaxMs: 1_000,
    recoveryRetryMs: 0,
    syncImpl: async () => {
      attempts += 1;
      throw new Error(`private-provider-error-${attempts}`);
    },
    sleepImpl: async delayMs => {
      delays.push(delayMs);
    },
    logger: {
      warn(message, metadata) {
        logs.push({ message, metadata });
      },
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200]);
  assert.deepEqual(summary, {
    examined: 0,
    updated: 0,
    skipped: 0,
    failed: 1,
  });
  const readiness = getPrivacyConsentSyncStatus();
  assert.equal(readiness.status, "degraded");
  assert.equal(readiness.ready, false);
  assert.equal(readiness.attempt, 3);
  assert.equal(readiness.nextRetryAt, null);
  assert.equal(JSON.stringify(logs).includes("private-provider-error"), false);
});

test("aucun agent configuré ne peut produire une readiness verte", async () => {
  const summary = await startPrivacyConsentSync({
    maxAttempts: 1,
    recoveryRetryMs: 0,
    syncImpl: async () => ({
      examined: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
    }),
  });

  assert.deepEqual(summary, {
    examined: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  });
  assert.equal(getPrivacyConsentSyncStatus().status, "degraded");
  assert.equal(getPrivacyConsentSyncStatus().ready, false);
});

test("un état dégradé programme une nouvelle fenêtre de récupération", async () => {
  const timers = [];
  let calls = 0;
  let recovered;
  const recoveryObserved = new Promise(resolve => {
    recovered = resolve;
  });
  const fakeSetTimer = (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    timers.push(timer);
    return timer;
  };

  await startPrivacyConsentSync({
    maxAttempts: 1,
    recoveryRetryMs: 60_000,
    setTimer: fakeSetTimer,
    clearTimer() {},
    syncImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary provider outage");
      recovered();
      return { examined: 1, updated: 1, skipped: 0, failed: 0 };
    },
  });

  assert.equal(getPrivacyConsentSyncStatus().status, "degraded");
  assert.equal(typeof getPrivacyConsentSyncStatus().nextRetryAt, "string");
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 60_000);

  timers[0].callback();
  await recoveryObserved;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(getPrivacyConsentSyncStatus().status, "ready");
  assert.equal(getPrivacyConsentSyncStatus().ready, true);
});

test("deux démarrages concurrents partagent le même run non bloquant", async () => {
  let releaseAttempt;
  let calls = 0;
  const waitingAttempt = new Promise(resolve => {
    releaseAttempt = resolve;
  });
  const syncImpl = async () => {
    calls += 1;
    await waitingAttempt;
    return { examined: 1, updated: 0, skipped: 1, failed: 0 };
  };

  const firstRun = startPrivacyConsentSync({ syncImpl });
  const secondRun = startPrivacyConsentSync({
    syncImpl: async () => {
      throw new Error("must never start a second external sync");
    },
  });

  assert.strictEqual(secondRun, firstRun);
  assert.equal(calls, 1);
  assert.equal(getPrivacyConsentSyncStatus().status, "running");
  releaseAttempt();
  await firstRun;
  assert.equal(getPrivacyConsentSyncStatus().ready, true);
});

test("le health check expose la readiness du consentement sans identifiant", () => {
  const serverSource = fs.readFileSync(
    new URL("../../index.js", import.meta.url),
    "utf8"
  );
  assert.ok(serverSource.includes("getPrivacyConsentSyncStatus()"));
  assert.ok(serverSource.includes("privacy_consent_sync: {"));
  assert.ok(serverSource.includes("next_retry_at:"));
});

test("provisioning et appels sortants imposent l'annonce de consentement", () => {
  const provisioning = fs.readFileSync(
    new URL("../onboarding/provision_service.js", import.meta.url),
    "utf8"
  );
  const outboundWorker = fs.readFileSync(
    new URL("../outbound/worker.js", import.meta.url),
    "utf8"
  );
  const legacyVoiceOutbound = new URL(
    "../../voice/outbound.js",
    import.meta.url
  );
  const postCall = fs.readFileSync(
    new URL("../post_call/index.js", import.meta.url),
    "utf8"
  );

  assert.ok(provisioning.includes("disable_first_message_interruptions: true"));
  assert.ok(
    provisioning.includes(
      "...masterConfig.conversation_config?.agent?.prompt"
    )
  );
  assert.ok(
    provisioning.includes(
      "/v1/convai/agents/${ELEVENLABS_MASTER_AGENT_ID}/duplicate"
    )
  );
  assert.ok(provisioning.includes("...masterConfig.conversation_config"));
  assert.equal(provisioning.includes("platform_settings.webhook"), false);
  assert.equal(provisioning.includes("POSTCALL_WEBHOOK_URL"), false);
  assert.ok(outboundWorker.includes("prefixRecordingConsentFr("));
  assert.ok(outboundWorker.includes("prefixRecordingConsentEn("));
  assert.ok(outboundWorker.includes("conversation_config_override"));
  assert.ok(outboundWorker.includes("agent: { first_message: greeting }"));
  assert.equal(fs.existsSync(legacyVoiceOutbound), false);
  const refusalDetection = postCall.indexOf(
    "const consentRefused = transcriptHasConsentRefusal(transcript)"
  );
  const refusalCleanup = postCall.indexOf(
    '"enqueue_consent_refusal_cleanup"'
  );
  const durableIngestion = postCall.indexOf(
    "ingestion = await enqueuePostCallEvent"
  );
  assert.ok(refusalDetection >= 0);
  assert.ok(refusalCleanup > refusalDetection);
  assert.ok(durableIngestion > refusalCleanup);
});
