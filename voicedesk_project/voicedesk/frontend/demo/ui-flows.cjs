// Browser fixtures only. No admin demo login, real account or live provider is created.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
let browser;
(async () => {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: "reduce" });
  const admin = process.argv.includes("--admin");
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
    if (admin && ["/demo/data.js", "/demo/api.js"].includes(url.pathname)) {
      const response = await route.fetch();
      let body = await response.text();
      if (url.pathname.endsWith("data.js")) body = body.replace('role: "company_admin"', 'role: "super_admin"');
      else body = body.replace('if (path.startsWith("/admin") || path.startsWith("/webhooks")) return blocked();', `
        if (read && path === "/admin/dashboard") return result({revenue:{mrr_total:319,arr_estimated:3828},clients:{active:1,total:1},margins:{margin_percent:65,gross_profit:200},tickets:{open:1},alerts:{}});
        if (read && path === "/admin/companies") return result({companies:[{...db.profile.company,calls_count:4,kb_sources_count:2,members_count:1}]});
        if (read && path === "/admin/provider-status") return result({generated_at:created(),storage:"available",history_state:"available",providers:["twilio","elevenlabs","groq","supabase","stripe","resend"].map((provider,i)=>({provider,status:i===3?"unknown":"ok",checked_at:created(),latency_ms:i===3?null:80+i*150})),history:[],alerts:[],email_alerts:{configured:false,worker_started:false}});
        if (read && path === "/admin/audit") return result({items:[{id:"fixture-audit",created_at:created(),company_id:db.profile.company_id,actor_user_id:db.profile.id,action:"impersonation_started",details:{phase:"started"}}],next_cursor:null});
        if (path.startsWith("/admin") || path.startsWith("/webhooks")) return blocked();`);
      return route.fulfill({ response, body });
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(60000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const dir = path.resolve(".demo-vite-cache/screenshots"); fs.mkdirSync(dir, { recursive: true });
  await page.goto("http://127.0.0.1:3000/login");
  await page.getByTestId("login-email-input").fill("client@demo.exevori.test");
  await page.getByTestId("login-password-input").fill("wrong-demo-password");
  await page.getByTestId("login-submit-button").click();
  await page.getByTestId("login-error").waitFor();
  await page.getByTestId("login-password-input").fill("DemoVoice2026!");
  await page.getByTestId("login-submit-button").click();
  await page.waitForURL("**/dashboard");
  if (admin) {
    for (const route of ["admin", "monitoring", "admin/audit"]) {
      await page.goto(`http://127.0.0.1:3000/${route}`);
      await page.locator("h1").first().waitFor();
      await page.waitForTimeout(1000);
      assert.ok(!(await page.locator("body").innerText()).includes("Accès réservé"));
      if (route === "admin/audit") await page.getByText(/Vue chronologique/).click();
      await page.screenshot({ path: path.join(dir, route.replaceAll("/", "-")+".png"), fullPage: true });
      console.log(`${route}: admin fixture rendered`);
    }
  } else {
    await page.goto("http://127.0.0.1:3000/calls");
    await page.getByTestId("calls-table").locator("tbody tr").first().click();
    await page.getByTestId("call-detail-name").waitFor();
    await page.getByTestId("call-section-summary").waitFor();
    await page.screenshot({ path: path.join(dir, "call-detail.png") });
    await page.keyboard.press("Escape");
    await page.goto("http://127.0.0.1:3000/crm");
    await page.getByTestId("contacts-table").locator("tbody tr").first().click();
    await page.getByTestId("detail-name").waitFor();
    await page.getByTestId("detail-archive").click();
    await page.getByTestId("confirm-dialog").waitFor();
    await page.getByTestId("confirm-dialog").getByRole("button", { name: "Annuler" }).click();
    await page.getByTestId("detail-name").waitFor();
    await page.screenshot({ path: path.join(dir, "contact-detail.png") });
    await page.keyboard.press("Escape");
    await page.goto("http://127.0.0.1:3000/config?tab=assistant");
    await page.getByTestId("assistant-name-input").fill("Léa aperçu");
    assert.ok((await page.getByLabel("Aperçu de l’assistante").innerText()).includes("Léa aperçu"));
    await page.screenshot({ path: path.join(dir, "assistant-preview.png"), fullPage: true });
    await page.goto("http://127.0.0.1:3000/onboarding");
    await page.getByLabel("Progression").waitFor();
    await page.screenshot({ path: path.join(dir, "onboarding.png"), fullPage: true });
    console.log("Invalid login, call detail, CRM detail, archive cancellation, assistant preview and onboarding: OK");
  }
  assert.deepEqual(errors, [], "No browser runtime error");
})().catch(error => { console.error(error); process.exitCode=1; }).finally(async () => { await browser?.close(); });
