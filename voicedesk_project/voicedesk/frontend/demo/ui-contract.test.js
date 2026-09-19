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
test("auth context, UI primitives and theme unchanged", () => {
  const changed = git("diff", baseline, "--name-only", "--", `${frontend}src/contexts`, `${frontend}src/components/ui`, `${frontend}tailwind.config.js`).trim();
  assert.equal(changed, "");
});
test("only the three approved hidden-module routes redirect to dashboard", () => {
  const name = `${frontend}src/App.jsx`;
  const original = git("show", `${baseline}:${name}`);
  let expected = original;
  for (const [path, page] of [["emails", "Emails"], ["analytics", "Reports"], ["reports", "Reports"]]) {
    const previous = `<Route path="${path}" element={<${page} />} />`;
    assert.equal(expected.split(previous).length, 2, `${path}: exactly one original route`);
    expected = expected.replace(previous, `<Route path="${path}" element={<Navigate to="/dashboard" replace />} />`);
    assert.ok(readFileSync(`${root}/${frontend}src/pages/${page}.jsx`, "utf8").length, `${page} page retained`);
  }
  const normalized = code => JSON.parse(JSON.stringify(parse(code, { sourceType: "module", plugins: ["jsx"] }),
    (key, value) => ["start", "end", "loc", "extra", "comments", "leadingComments", "trailingComments", "innerComments"].includes(key) ? undefined : value));
  assert.deepEqual(normalized(readFileSync(`${root}/${name}`, "utf8")), normalized(expected));
});
test("client navigation exposes outbound and keeps non-V1 modules hidden", () => {
  const code = readFileSync(`${root}/${frontend}src/components/layout/Layout.jsx`, "utf8");
  const declarations = parse(code, { sourceType: "module", plugins: ["jsx"] }).program.body
    .filter(node => node.type === "VariableDeclaration").flatMap(node => node.declarations);
  const items = declarations.find(node => node.id.name === "NAV_ITEMS").init.elements;
  const field = (item, name) => item.properties.find(property => property.key.name === name)?.value;
  const paths = items.map(item => field(item, "path").value);
  assert.equal(paths.filter(path => path === "/outbound").length, 1);
  assert.equal(field(items.find(item => field(item, "path").value === "/outbound"), "key").value, "outbound");
  for (const path of ["/emails", "/analytics", "/reports"]) assert.equal(paths.includes(path), false);
  for (const locale of ["fr", "en"]) {
    const translations = JSON.parse(readFileSync(`${root}/${frontend}src/i18n/locales/${locale}.json`, "utf8"));
    assert.ok(translations.navigation.outbound);
  }
});
test("no new hexadecimal color literals in pages", () => {
  const additions = git("diff", baseline, "--unified=0", "--", `${frontend}src/pages`).split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++"));
  assert.equal(additions.some(line => /#[0-9a-f]{3,8}\b/i.test(line)), false);
});
