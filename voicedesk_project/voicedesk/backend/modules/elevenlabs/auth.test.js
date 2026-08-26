import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  createCustomLlmAuthMiddleware,
  verifyCustomLlmSecret,
} from "./customLlmAuth.js";

function invoke(middleware, headers = {}) {
  const result = { status: 200, body: null, nextCalled: false };
  const req = { headers };
  const res = {
    status(code) {
      result.status = code;
      return this;
    },
    json(body) {
      result.body = body;
      return this;
    },
  };
  middleware(req, res, () => {
    result.nextCalled = true;
  });
  return result;
}

test("comparaison constante accepte uniquement le secret exact", () => {
  const expected = "custom-llm-test-secret-with-sufficient-entropy";
  assert.equal(verifyCustomLlmSecret(expected, expected), true);
  assert.equal(verifyCustomLlmSecret("wrong", expected), false);
  assert.equal(verifyCustomLlmSecret("", expected), false);
  assert.equal(verifyCustomLlmSecret(expected, ""), false);
  assert.equal(verifyCustomLlmSecret("x", expected), false);
});

test("middleware échoue fermé quand la configuration est absente", () => {
  const middleware = createCustomLlmAuthMiddleware({
    getExpectedSecret: () => "",
  });
  const result = invoke(middleware, {
    "x-elevenlabs-custom-llm-secret": "anything",
  });
  assert.equal(result.status, 503);
  assert.equal(result.nextCalled, false);
});

test("middleware refuse secret absent/invalide et accepte header exact", () => {
  const expected = "custom-llm-test-secret-with-sufficient-entropy";
  const middleware = createCustomLlmAuthMiddleware({
    getExpectedSecret: () => expected,
  });

  assert.equal(invoke(middleware).status, 401);
  assert.equal(
    invoke(middleware, {
      "x-elevenlabs-custom-llm-secret": "wrong",
    }).status,
    401
  );

  const accepted = invoke(middleware, {
    "x-elevenlabs-custom-llm-secret": expected,
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.nextCalled, true);

  const bearer = invoke(middleware, {
    authorization: `Bearer ${expected}`,
  });
  assert.equal(bearer.nextCalled, true);
});

test("un mapping par agent lie le secret au header d'agent", () => {
  const middleware = createCustomLlmAuthMiddleware({
    getExpectedSecret: () => "global-secret",
    getAgentSecrets: () => JSON.stringify({
      "agent-a": "agent-a-secret-with-32-characters-aaaa",
      "agent-b": "agent-b-secret-with-32-characters-bbbb",
    }),
  });

  const accepted = invoke(middleware, {
    "x-elevenlabs-agent-id": "agent-a",
    "x-elevenlabs-custom-llm-secret": "agent-a-secret-with-32-characters-aaaa",
  });
  assert.equal(accepted.nextCalled, true);

  assert.equal(invoke(middleware, {
    "x-elevenlabs-agent-id": "agent-b",
    "x-elevenlabs-custom-llm-secret": "agent-a-secret-with-32-characters-aaaa",
  }).status, 401);
  assert.equal(invoke(middleware, {
    "x-elevenlabs-custom-llm-secret": "global-secret",
  }).status, 401);
});

test("la production échoue fermée sans secrets distincts par agent", () => {
  const middleware = createCustomLlmAuthMiddleware({
    getExpectedSecret: () => "legacy-global-secret",
    getAgentSecrets: () => "",
    getNodeEnv: () => "production",
  });
  const result = invoke(middleware, {
    "x-elevenlabs-agent-id": "agent-a",
    "x-elevenlabs-custom-llm-secret": "legacy-global-secret",
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.error, "custom_llm_per_agent_secrets_required");
  assert.equal(result.nextCalled, false);
});

test("un mapping faible, dupliqué ou invalide échoue fermé", () => {
  for (const raw of [
    "{",
    JSON.stringify({ "agent-a": "court" }),
    JSON.stringify({
      "agent-a": "same-secret-with-sufficient-length-123",
      "agent-b": "same-secret-with-sufficient-length-123",
    }),
  ]) {
    const middleware = createCustomLlmAuthMiddleware({
      getAgentSecrets: () => raw,
      getNodeEnv: () => "production",
    });
    const result = invoke(middleware, {
      "x-elevenlabs-agent-id": "agent-a",
      "x-elevenlabs-custom-llm-secret": "same-secret-with-sufficient-length-123",
    });
    assert.equal(result.status, 503);
    assert.equal(result.nextCalled, false);
  }
});

test("les trois alias appliquent l'auth avant le parseur JSON", () => {
  const source = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  for (const path of [
    "/llm",
    "/llm/chat/completions",
    "/chat/completions",
  ]) {
    assert.ok(
      source.includes(
        `router.post("${path}", requireCustomLlmAuth, customLlmRateLimiter, express.json({ limit: "1mb" }), safeLlmHandler);`
      ),
      `${path} doit authentifier avant de parser`
    );
  }
  assert.match(source, /Promise\.resolve\(llmHandler\(req, res\)\)\.catch\(next\)/);
  assert.match(source, /typeof lastUser\?\.content === "string"/);
});

test("le router Custom LLM est monté avant le parseur JSON global", () => {
  const serverSource = fs.readFileSync(
    new URL("../../index.js", import.meta.url),
    "utf8"
  );
  const mountIndex = serverSource.indexOf(
    'app.use("/api/v1/elevenlabs", m2mIngressLimiter, elevenLabsRouter);'
  );
  const globalParserIndex = serverSource.indexOf(
    'app.use(express.json({ limit: "10mb" }));'
  );

  assert.ok(mountIndex >= 0);
  assert.ok(globalParserIndex > mountIndex);
  assert.match(serverSource, /highVolumeMachinePaths\.has\(req\.originalUrl\?\.split\("\?"\)\[0\]\)/);
  assert.doesNotMatch(serverSource, /startsWith\("\/api\/v1\/elevenlabs"\)/);
  assert.match(serverSource, /app\.post\("\/api\/voice\/call-complete",\s*m2mIngressLimiter/);
});
