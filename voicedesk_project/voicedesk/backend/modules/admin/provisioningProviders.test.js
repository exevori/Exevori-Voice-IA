import test from "node:test";
import assert from "node:assert/strict";
import { createProvisioningProviders } from "./provisioningProviders.js";

const SID = `PN${"b".repeat(32)}`;
const ACCOUNT = `AC${"a".repeat(32)}`;
const env = { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_AUTH_TOKEN: "fake-private-twilio", ELEVENLABS_API_KEY: "fake-private-eleven" };
const ok = data => new Response(JSON.stringify(data), { status: 200 });

test("Twilio adapter uses only master-account GETs and strips account tokens from results", async () => {
  const calls = [];
  const provider = createProvisioningProviders({ env, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return ok(url.includes("IncomingPhoneNumbers") ? { sid: SID, account_sid: ACCOUNT, phone_number: "+14185550101", status: "in-use", capabilities: { voice: true } }
      : { sid: ACCOUNT, status: "active", auth_token: "never-expose" });
  } });
  const result = await provider.twilioNumber(SID);
  assert.equal(result.data.voice, true); assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.method, "GET"); assert.equal(call.options.redirect, "error");
    assert.ok(call.url.startsWith(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}`));
  }
  assert.equal(JSON.stringify(result).includes("never-expose"), false);
});

test("suspended or mismatched Twilio account cannot validate its numbers", async () => {
  for (const data of [{ sid: ACCOUNT, status: "suspended" }, { sid: "other", status: "active" }]) {
    const provider = createProvisioningProviders({ env, fetchImpl: async () => ok(data) });
    assert.equal((await provider.twilioNumber(SID)).state, "account_inactive_or_mismatch");
  }
});

test("ElevenLabs adapter exposes no prompt, secret or provider credentials", async () => {
  const provider = createProvisioningProviders({ env, fetchImpl: async url => ok(url.includes("phone-numbers")
    ? { provider: "twilio", phone_number: "+14185550101", phone_number_id: "phone_test", assigned_agent: { agent_id: "agent_test", agent_name: "Private name" }, secret: "private" }
    : { agent_id: "agent_test", conversation_config: { prompt: "private prompt" }, secret: "private" }) });
  assert.deepEqual(await provider.agent("agent_test"), { state: "ok", data: { agent_id: "agent_test" } });
  const phone = await provider.phone("phone_test");
  assert.deepEqual(phone.data.assigned_agent, { agent_id: "agent_test" });
  assert.equal(JSON.stringify(phone).includes("private"), false);
});

test("only explicit null assignment is considered unassigned, not malformed or omitted data", async () => {
  for (const row of [{ assigned_agent: null }, {}, { assigned_agent: {} }]) {
    const provider = createProvisioningProviders({ env, fetchImpl: async () => ok(row) });
    assert.equal((await provider.phone("phone_test")).data.assigned_agent === null, row.assigned_agent === null);
  }
});

test("missing keys and invalid opaque IDs cause no provider request", async () => {
  let calls = 0; const fetchImpl = async () => { calls++; return ok({}); };
  const absent = createProvisioningProviders({ env: {}, fetchImpl });
  assert.equal((await absent.twilioNumber(SID)).state, "not_configured");
  assert.equal((await absent.agent("agent_test")).state, "not_configured");
  const provider = createProvisioningProviders({ env, fetchImpl });
  for (const id of ["../admin", "https://evil.invalid", "agent?secret=1", "", null]) {
    assert.equal((await provider.agent(id)).state, "invalid_id");
    assert.equal((await provider.phone(id)).state, "invalid_id");
    assert.equal((await provider.assignPhone(id, "agent_test")).state, "invalid_id");
  }
  assert.equal(calls, 0);
});

test("provider HTTP errors are differentiated without exposing response bodies", async () => {
  for (const [status, expected] of [[404, "missing"], [401, "unauthorized"], [403, "unauthorized"], [429, "unavailable"], [500, "unavailable"]]) {
    const provider = createProvisioningProviders({ env, fetchImpl: async () => new Response("private error", { status }) });
    assert.deepEqual(await provider.agent("agent_test"), { state: expected });
  }
});

test("provider timeout aborts the request and malformed JSON never reports a success", async () => {
  const provider = createProvisioningProviders({ env, timeoutMs: 5, fetchImpl: async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }) });
  assert.equal((await provider.phone("phone_test")).state, "timeout");
  const invalid = createProvisioningProviders({ env, fetchImpl: async () => new Response("not JSON") });
  assert.equal((await invalid.agent("agent_test")).state, "unavailable");
});

test("repair performs only the documented assignment PATCH with server-owned IDs", async () => {
  const calls = [];
  const provider = createProvisioningProviders({ env, fetchImpl: async (url, options) => { calls.push({ url, options }); return ok({ private: "secret" }); } });
  assert.deepEqual(await provider.assignPhone("phone_test", "agent_test"), { state: "ok" });
  assert.equal(calls[0].url, "https://api.elevenlabs.io/v1/convai/phone-numbers/phone_test");
  assert.equal(calls[0].options.method, "PATCH");
  assert.deepEqual(JSON.parse(calls[0].options.body), { agent_id: "agent_test" });
  assert.equal(calls[0].options.redirect, "error");
});
