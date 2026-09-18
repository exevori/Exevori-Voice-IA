import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { parse } = require("@babel/parser");
const root = fileURLToPath(new URL("../../../../", import.meta.url)).replaceAll("\\", "/").replace(/\/$/, "");
const frontend = "voicedesk_project/voicedesk/frontend/";
const baseline = "8de8785";
const git = (...args) => execFileSync("git", ["-c", `safe.directory=${root}`, "-C", root, ...args], { encoding: "utf8" });
const pages = ["Dashboard", "Calls", "Contacts", "Calendar", "Billing", "Tickets", "Settings", "OnboardingPage", "Admin", "Monitoring", "AdminAudit", "Landing", "Signup", "ForgotPassword", "ResetPassword"];
function networkCalls(code) {
  const calls = [];
  const clean = value => JSON.parse(JSON.stringify(value, (key, val) => ["start", "end", "loc", "extra", "leadingComments", "trailingComments", "innerComments"].includes(key) ? undefined : val));
  const visit = node => {
    if (!node || typeof node !== "object") return;
    const callee = node.callee;
    const name = callee?.name || callee?.property?.name || "";
    if (node.type === "CallExpression" && /^(fetch|fetchJson|requestJson|requestAdminJson|apiRequest|calendarRequest|onboardingRequest|request|signIn|signUp|updateUser|resetPasswordForEmail|exchangeCodeForSession)$/.test(name)) calls.push(JSON.stringify(clean(node)));
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === "object") visit(value);
  };
  visit(parse(code, { sourceType: "module", plugins: ["jsx"] }));
  return calls.sort();
}
for (const page of pages) test(`${page}: network calls and request arguments unchanged`, () => {
  const name = `${frontend}src/pages/${page}.jsx`;
  assert.deepEqual(networkCalls(readFileSync(`${root}/${name}`, "utf8")), networkCalls(git("show", `${baseline}:${name}`)));
});
test("routing, auth context, UI primitives and theme unchanged", () => {
  const changed = git("diff", baseline, "--name-only", "--", `${frontend}src/App.jsx`, `${frontend}src/contexts`, `${frontend}src/components/ui`, `${frontend}tailwind.config.js`).trim();
  assert.equal(changed, "");
});
test("no new hexadecimal color literals in pages", () => {
  const additions = git("diff", baseline, "--unified=0", "--", `${frontend}src/pages`).split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++"));
  assert.equal(additions.some(line => /#[0-9a-f]{3,8}\b/i.test(line)), false);
});
