import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const toolRequire = createRequire(require.resolve("concurrently/package.json"));
const { parse, quote } = toolRequire("shell-quote");

// GHSA-w7jw-789q-3m8p / CVE-2026-9277. These payloads are only passed to
// quote(); their output is NEVER executed by a shell in this test suite.
test("shell-quote rejects line terminators in externally constructed operator tokens", () => {
  for (const separator of ["\n", "\r", "\u2028", "\u2029"]) {
    assert.throws(() => quote([{ op: `;${separator}SECURITY_TEST_MARKER` }]), TypeError);
    assert.throws(() => quote([{ comment: `comment${separator}SECURITY_TEST_MARKER` }]), TypeError);
  }
});

test("shell-quote rejects an unsafe object returned by the documented env callback", () => {
  const tokens = parse("echo $INPUT", () => ({ op: ";\nSECURITY_TEST_MARKER" }));
  assert.throws(() => quote(tokens), TypeError);
  assert.equal(typeof quote(["echo", "normal argument"]), "string");
});

test("lockfile and concurrently resolution contain no known-vulnerable shell-quote version", async () => {
  const lock = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"));
  const entries = Object.entries(lock.packages).filter(([path]) => /(?:^|\/)node_modules\/shell-quote$/.test(path));
  assert.ok(entries.length > 0);
  for (const [path, entry] of entries) {
    const [major, minor, patch] = entry.version.split(".").map(Number);
    assert.ok(major > 1 || (major === 1 && (minor > 8 || (minor === 8 && patch > 4))), `${path}: ${entry.version}`);
  }
  assert.equal(require("concurrently/package.json").version, "9.2.4");
  assert.equal(toolRequire("shell-quote/package.json").version, "1.9.0");
});
