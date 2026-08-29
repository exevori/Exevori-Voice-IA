import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CalendlyApiError,
  cancelScheduledEvent,
  exchangeAuthorizationCode,
  refreshAccessToken,
  requestInviteeDataDeletion,
  resourceUuid,
} from "./client.js";
import {
  decryptCalendarSecret,
  encryptCalendarSecret,
  pkceChallenge,
  randomBase64Url,
  sha256Hex,
} from "./secrets.js";

const ORIGINAL_ENV = {
  CALENDLY_CLIENT_ID: process.env.CALENDLY_CLIENT_ID,
  CALENDLY_CLIENT_SECRET: process.env.CALENDLY_CLIENT_SECRET,
  CALENDLY_REDIRECT_URI: process.env.CALENDLY_REDIRECT_URI,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
};

test.after(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("OAuth code exchange uses PKCE, form encoding and confidential-client Basic auth", async () => {
  process.env.CALENDLY_CLIENT_ID = "client-id";
  process.env.CALENDLY_CLIENT_SECRET = "client-secret";
  process.env.CALENDLY_REDIRECT_URI = "https://api.example.test/api/v1/calendar/oauth/callback";
  let request;
  const payload = await exchangeAuthorizationCode({
    code: "authorization-code",
    codeVerifier: "pkce-verifier",
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 7200,
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(payload.access_token, "access");
  assert.equal(request.url, "https://auth.calendly.com/oauth/token");
  assert.equal(request.options.method, "POST");
  assert.equal(
    request.options.headers.Authorization,
    `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`
  );
  assert.equal(request.options.headers["Content-Type"], "application/x-www-form-urlencoded");
  const form = new URLSearchParams(request.options.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "authorization-code");
  assert.equal(form.get("code_verifier"), "pkce-verifier");
  assert.equal(form.get("redirect_uri"), process.env.CALENDLY_REDIRECT_URI);
});

test("refresh performs one provider attempt and classifies an ambiguous network failure", async () => {
  process.env.CALENDLY_CLIENT_ID = "client-id";
  process.env.CALENDLY_CLIENT_SECRET = "client-secret";
  let calls = 0;
  await assert.rejects(
    refreshAccessToken({
      refreshToken: "single-use-token",
      fetchImpl: async () => {
        calls += 1;
        throw new Error("socket closed after write");
      },
    }),
    error => error instanceof CalendlyApiError
      && error.code === "calendly_network_error"
  );
  assert.equal(calls, 1);
});

test("cancellation uses the documented endpoint without an invented request body", async () => {
  let request;
  await cancelScheduledEvent({
    accessToken: "access",
    eventUri: "https://api.calendly.com/scheduled_events/event_123",
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return new Response("{}", { status: 201 });
    },
  });
  assert.equal(
    request.url,
    "https://api.calendly.com/scheduled_events/event_123/cancellation"
  );
  assert.equal(request.options.method, "POST");
  assert.equal("body" in request.options, false);
});

test("data-compliance deletion sends only the reviewed email array", async () => {
  let body;
  await requestInviteeDataDeletion({
    accessToken: "access",
    emails: ["person@example.test"],
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response("{}", { status: 202 });
    },
  });
  assert.deepEqual(body, { emails: ["person@example.test"] });
});

test("Calendly resource parsing rejects look-alike origins", () => {
  assert.equal(
    resourceUuid("https://api.calendly.com/scheduled_events/event_123", "scheduled_events"),
    "event_123"
  );
  assert.throws(
    () => resourceUuid(
      "https://api.calendly.com.attacker.test/scheduled_events/event_123",
      "scheduled_events"
    ),
    error => error.code === "invalid_calendly_resource_uri"
  );
});

test("calendar secrets use authenticated encryption bound to their tenant context", () => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const encrypted = encryptCalendarSecret("sensitive-token", "access:company-a");
  assert.notEqual(encrypted.ciphertext, "sensitive-token");
  assert.equal(
    decryptCalendarSecret(encrypted, "access:company-a"),
    "sensitive-token"
  );
  assert.throws(() => decryptCalendarSecret(encrypted, "access:company-b"));

  const verifier = "verifier-value";
  const expectedChallenge = createHash("sha256")
    .update(verifier)
    .digest("base64url");
  assert.equal(pkceChallenge(verifier), expectedChallenge);
  assert.equal(sha256Hex("state").length, 64);
  assert.match(randomBase64Url(32), /^[A-Za-z0-9_-]+$/);
});
