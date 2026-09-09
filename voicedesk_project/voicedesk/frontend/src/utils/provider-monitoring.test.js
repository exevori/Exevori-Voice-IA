import test from "node:test";
import assert from "node:assert/strict";
import { historyBuckets, overallStatus, providerRows, PROVIDERS } from "./provider-monitoring.js";
const now = Date.parse("2026-09-09T12:05:00Z");

test("missing, failed, stale or future probes never produce a global green state", () => {
  assert.ok(providerRows(null, now).every(row => row.status === "unknown"));
  const snapshot = { providers: PROVIDERS.map(provider => ({ provider, status: "ok", latency_ms: 12, checked_at: new Date(now).toISOString() })) };
  assert.equal(overallStatus(providerRows(snapshot, now)), "Les six API sont accessibles");
  assert.equal(overallStatus(providerRows(snapshot, now, true)), "Vérification incomplète");
  assert.ok(providerRows(snapshot, now + 151_000).every(row => row.status === "stale" && row.latency_ms === null));
  assert.ok(providerRows(snapshot, now - 31_000).every(row => row.status === "stale"));
  assert.equal(overallStatus([]), "Vérification incomplète");
});

test("not-configured, unauthorized and down states remain distinguishable", () => {
  for (const status of ["not_configured", "unauthorized", "down"]) {
    const snapshot = { providers: [{ provider: "resend", status, checked_at: new Date(now).toISOString(), latency_ms: null }] };
    assert.equal(providerRows(snapshot, now).find(row => row.provider === "resend").status, status);
    assert.notEqual(overallStatus(providerRows(snapshot, now)), "Les six API sont accessibles");
  }
});

test("24-hour history leaves missing buckets unknown and exposes partial coverage", () => {
  const rows = historyBuckets([{ provider: "groq", bucket: "2026-09-09T11:45:00Z", status: "down", sample_count: 14 },
    { provider: "groq", bucket: "2026-09-09T12:00:00Z", status: "ok", sample_count: 2 }], "groq", now);
  assert.equal(rows.length, 97); assert.equal(rows.at(-2).status, "down"); assert.equal(rows.at(-2).partial, false);
  assert.equal(rows.at(-1).status, "ok"); assert.equal(rows.at(-1).partial, true);
  assert.ok(rows.slice(0, -2).every(row => row.status === "unknown" && row.partial));
  assert.equal(rows.at(-1).time - rows[0].time, 24 * 3_600_000);
  assert.ok(historyBuckets([], "supabase", now).every(row => row.status === "unknown"));
});
