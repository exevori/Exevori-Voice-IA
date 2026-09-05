import assert from "node:assert/strict";
import test from "node:test";
import { elevenLabsDashboardUrl, money, requestAdminJson, stripeLabel } from "./admin-company.js";

test("unknown cost and unverified Stripe states cannot be displayed as zero or paid", () => {
  assert.equal(money(null), "Non disponible");
  assert.equal(money(undefined), "Non disponible");
  assert.notEqual(money(0), "Non disponible");
  assert.equal(stripeLabel({ state: "unavailable", subscription_status: "active" }), "Stripe indisponible");
  assert.equal(stripeLabel({ state: "verified", subscription_status: "past_due" }), "Paiement en retard");
  assert.equal(stripeLabel({ state: "mismatch" }), "Rattachement Stripe incohérent");
});

test("dashboard links only accept opaque agent identifiers on the fixed ElevenLabs origin", () => {
  assert.equal(elevenLabsDashboardUrl("agent_valid"), "https://elevenlabs.io/app/agents/agents/agent_valid");
  for (const invalid of [null, "../settings", "javascript:alert(1)", "x?token=secret", "https://other.test"]) assert.equal(elevenLabsDashboardUrl(invalid), null);
});

test("admin API helper exposes readable failure messages and never swallows non-JSON errors", async () => {
  await assert.rejects(requestAdminJson("/test", { fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: "subscription_inactive" }) }) }), /abonnement doit être actif/);
  await assert.rejects(requestAdminJson("/test", { fetchImpl: async () => ({ json: async () => { throw new Error("JSON parse"); } }) }), /réponse illisible/);
});

test("admin requests preserve bearer authentication, JSON body and stable request ID", async () => {
  let request;
  const data = await requestAdminJson("/test", { token: "qa-token", method: "POST", body: "{}", headers: { "X-Request-Id": "request-id" }, fetchImpl: async (url, options) => { request = { url, ...options }; return { ok: true, json: async () => ({ success: true }) }; } });
  assert.equal(request.headers.Authorization, "Bearer qa-token");
  assert.equal(request.headers["Content-Type"], "application/json");
  assert.equal(request.headers["X-Request-Id"], "request-id");
  assert.equal(data.success, true);
});
