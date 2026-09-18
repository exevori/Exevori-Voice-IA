// Optional local UI check. Uses an already installed Playwright via NODE_PATH.
// Never connects to the production app or Supabase.
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
let browser;
(async () => {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname) ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(60000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const output = path.resolve(".demo-vite-cache/screenshots");
  fs.mkdirSync(output, { recursive: true });
  await page.goto("http://127.0.0.1:3000/login", { waitUntil: "domcontentloaded" });
  await page.getByTestId("login-email-input").fill("client@demo.exevori.test");
  await page.getByTestId("login-password-input").fill("DemoVoice2026!");
  await page.getByTestId("login-submit-button").click();
  await page.waitForURL("**/dashboard");
  const pages = process.argv.slice(2).length ? process.argv.slice(2) : ["dashboard", "calls", "crm", "calendar", "billing", "support", "config", "landing", "signup", "forgot-password"];
  for (const route of pages) {
    await page.goto(`http://127.0.0.1:3000/${route}`);
    await page.waitForFunction(() => document.querySelector("h1, h2, [role='alert']"), { timeout: 30000 });
    await page.waitForTimeout(1000);
    if (errors.length) console.log(errors);
    assert.ok((await page.locator("body").innerText()).length > 150, `${route}: empty screen`);
    await page.screenshot({ path: path.join(output, `${route.replaceAll("/", "-")}.png`), fullPage: true });
    console.log(`${route}: visible; errors=${errors.length}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:3000/dashboard");
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(output, "dashboard-mobile.png"), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  console.log(`mobile horizontal overflow: ${overflow}`);
  await browser.close();
  assert.deepEqual(errors, [], "Browser runtime errors");
  assert.equal(overflow, false, "Mobile horizontal overflow");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
