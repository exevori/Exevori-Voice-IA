import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { shouldAcceptElevenLabsWebhookSignature } from "./signaturePolicy.js";

test("seule une signature valide est acceptée", () => {
  assert.equal(shouldAcceptElevenLabsWebhookSignature("ok"), true);
});

test("absence, mauvaise signature et rejeu échouent toujours fermés", () => {
  for (const status of [
    "missing",
    "no_secret",
    "bad_signature",
    "stale",
    "invalid_format",
    undefined,
  ]) {
    assert.equal(shouldAcceptElevenLabsWebhookSignature(status), false);
  }
});

test("aucun override de webhook non signé ne reste configuré", () => {
  const policy = fs.readFileSync(
    new URL("./signaturePolicy.js", import.meta.url),
    "utf8"
  );
  const envExample = fs.readFileSync(
    new URL("../../../.env.example", import.meta.url),
    "utf8"
  );
  assert.equal(policy.includes("ALLOW_UNSIGNED_WEBHOOKS"), false);
  assert.equal(envExample.includes("ALLOW_UNSIGNED_WEBHOOKS"), false);
});

test("le handler n'écrit plus les dumps forensiques/signatures", () => {
  const source = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  assert.equal(source.includes("FORENSIC"), false);
  assert.equal(source.includes("SIG_DEBUG"), false);
  assert.equal(source.includes("bodyHead"), false);
  assert.ok(source.includes("shouldAcceptElevenLabsWebhookSignature(sigStatus)"));
});
