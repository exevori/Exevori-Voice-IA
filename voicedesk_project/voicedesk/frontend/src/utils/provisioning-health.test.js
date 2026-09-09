import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { provisioningSummary, provisioningDetail, PROVISIONING_CHECK_LABELS } from "./provisioning-health.js";

test("provisioning UI only shows green when all four identified checks actually passed", () => {
  const report = { status: "healthy", checks: Object.keys(PROVISIONING_CHECK_LABELS).map(key => ({ key, state: "ok" })) };
  assert.equal(provisioningSummary(report).variant, "green");
  for (const state of ["unknown", "error", "repairable", undefined]) {
    assert.notEqual(provisioningSummary({ ...report, checks: report.checks.map((row, i) => i === 0 ? { ...row, state } : row) }).variant, "green");
  }
  assert.notEqual(provisioningSummary({ ...report, checks: report.checks.slice(1) }).variant, "green");
  assert.notEqual(provisioningSummary({ ...report, checks: Array(4).fill(report.checks[0]) }).variant, "green");
  assert.notEqual(provisioningSummary(null).variant, "green");
});

test("diagnostic translates actionable states and never prints raw provider error codes", () => {
  assert.match(provisioningDetail("unauthorized"), /refusé/);
  assert.match(provisioningDetail("resource_ownership_conflict"), /bloquée/);
  assert.equal(provisioningDetail("secret internal error"), "Vérification non concluante");
});

test("admin repair requires explicit confirmation/reason and ignores browser-supplied provider IDs", async () => {
  const source = await readFile(new URL("../components/admin/ProvisioningHealthPanel.jsx", import.meta.url), "utf8");
  assert.match(source, /report\.repair\?\.available/);
  assert.match(source, /confirm_company_id: companyId, reason: reason\.trim\(\)/);
  assert.match(source, /required minLength=\{3\} maxLength=\{500\}/);
  assert.match(source, /result\.success/);
  assert.match(source, /setReport\(null\)/);
  assert.match(source, /reader\.current\?\.abort\(\)/);
  assert.doesNotMatch(source, /agent_id:|phone_number_id:/);
});
