import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./Tickets.jsx", import.meta.url), "utf8");

test("ticket UI uses only categories and public statuses accepted by the backend", () => {
  for (const category of [
    "general", "technical", "billing", "feature_request", "bug", "onboarding",
  ]) {
    assert.match(source, new RegExp(`key: "${category}"`));
  }
  assert.doesNotMatch(source, /key: "voice"/);
  assert.doesNotMatch(source, /key: "account"/);
  assert.match(source, /const STATUS_ACTIONS = \["open", "in_progress", "resolved", "closed"\]/);
  assert.match(source, /waiting_client: \{ label: "En attente client"/);
});

test("ticket UI exposes the commercial admin controls and live SLA timer", () => {
  assert.match(source, /\/api\/v1\/tickets\/\$\{ticket\.id\}\/\$\{kind\}/);
  assert.match(source, /Responsable/);
  assert.match(source, /Priorité/);
  assert.match(source, /Statut/);
  assert.match(source, /window\.setInterval\(\(\) => setNowMs\(Date\.now\(\)\)/);
  assert.match(source, /sla_milestone === "first_response"/);
  assert.match(source, /dépassé de/);
});

test("internal notes are clearly admin-only and API failures are never swallowed", () => {
  assert.match(source, /isAdmin && isInternal/);
  assert.match(source, /Note interne \(jamais visible ni envoyée par courriel au client\)/);
  assert.match(source, /if \(!response\.ok\)/);
  assert.match(source, /payload\.message \|\| payload\.error/);
  assert.doesNotMatch(source, /catch\s*\{\s*\}/);
});

test("transactional email links can open a ticket directly", () => {
  assert.match(source, /useSearchParams/);
  assert.match(source, /searchParams\.get\("ticket"\)/);
  assert.match(source, /next\.set\("ticket", ticket\.id\)/);
});
