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

test("les trois alias appliquent l'auth avant le parseur JSON", () => {
  const source = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  for (const path of [
    "/llm",
    "/llm/chat/completions",
    "/chat/completions",
  ]) {
    assert.ok(
      source.includes(
        `router.post("${path}", requireCustomLlmAuth, express.json({ limit: "1mb" }), llmHandler);`
      ),
      `${path} doit authentifier avant de parser`
    );
  }
});

test("le router Custom LLM est monté avant le parseur JSON global", () => {
  const serverSource = fs.readFileSync(
    new URL("../../index.js", import.meta.url),
    "utf8"
  );
  const mountIndex = serverSource.indexOf(
    'app.use("/api/v1/elevenlabs", elevenLabsRouter);'
  );
  const globalParserIndex = serverSource.indexOf(
    'app.use(express.json({ limit: "10mb" }));'
  );

  assert.ok(mountIndex >= 0);
  assert.ok(globalParserIndex > mountIndex);
});
