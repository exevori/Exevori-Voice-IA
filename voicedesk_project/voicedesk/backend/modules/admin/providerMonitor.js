import express from "express";
import { randomUUID } from "node:crypto";
import { PROVIDERS, FAILED_PROVIDER_STATUSES } from "./providerProbes.js";

export function createProviderAlertSender({ env = process.env, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const recipients = (env.MONITORING_ALERT_EMAIL || "").split(",").map(value => value.trim()).filter(Boolean);
  const configured = Boolean(env.RESEND_API_KEY && env.EMAIL_FROM && recipients.length > 0 && recipients.length <= 10
    && recipients.every(email => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)));
  return {
    configured,
    async send({ provider, downSince, key }) {
      if (!configured) throw new Error("monitoring_email_not_configured");
      if (!PROVIDERS.includes(provider) || !Number.isFinite(Date.parse(downSince))) throw new Error("invalid_monitoring_alert");
      const timestamp = new Date(downSince).toISOString();
      const response = await fetchImpl("https://api.resend.com/emails", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: recipients,
          subject: `[VoiceDesk] Incident API ${provider} : échec observé pendant plus de 5 minutes`,
          text: `VoiceDesk a observé un échec continu de vérification de l'API ${provider}, commencé à ${timestamp}, pendant plus de cinq minutes. L'alerte peut être livrée après le rétablissement. Consultez le monitoring pour l'état actuel et vérifiez les accès fournisseur. Ce contrôle d'accès ne prouve pas une panne globale du fournisseur.`,
        }),
      });
      if (!response.ok) { await response.body?.cancel?.(); throw new Error("monitoring_email_send_failed"); }
      const data = await response.json();
      if (typeof data.id !== "string" || !data.id) throw new Error("monitoring_email_send_failed");
      return data.id;
    },
  };
}

export function createProviderMonitor({ store, probes, sender, now = () => new Date(), logger = console } = {}) {
  let inFlight = null;
  let lastCycle = null;
  let lastCycleAt = 0;
  let emergency = null;
  let timer = null;
  let lastPurgeAt = 0;
  let deliveryError = null;

  async function emergencyCheck(samples) {
    const sample = samples.find(row => row.provider === "supabase");
    const time = now().getTime();
    if (!sample || !FAILED_PROVIDER_STATUSES.has(sample.status)) { emergency = null; return; }
    if (!emergency || time - emergency.lastAt > 150_000) {
      emergency = { since: time, lastAt: time, sent: false, firstAttemptAt: null,
        key: `monitoring/emergency/supabase/${randomUUID()}` };
    }
    emergency.lastAt = time;
    if (time - emergency.since <= 300_000 || emergency.sent || !sender.configured) return;
    if (emergency.firstAttemptAt !== null && time - emergency.firstAttemptAt > 23 * 3_600_000) {
      deliveryError = "emergency_delivery_window_expired"; return;
    }
    emergency.firstAttemptAt ??= time;
    try {
      await sender.send({ provider: "supabase", downSince: new Date(emergency.since).toISOString(), key: emergency.key });
      emergency.sent = true;
      deliveryError = null;
    } catch { deliveryError = "emergency_email_send_failed"; }
  }

  async function deliver() {
    if (!sender.configured) return;
    const jobs = await store.claimAlerts();
    let anyFailed = false;
    await Promise.all(jobs.map(async job => {
      let messageId = null;
      try {
        messageId = await sender.send({ provider: job.provider, downSince: job.down_since, key: `monitoring/incident/${job.id}` });
      } catch { anyFailed = true; }
      const finished = await store.finishAlert(job, messageId, messageId ? null : "monitoring_email_send_failed");
      if (!finished) throw new Error("monitoring_alert_lease_lost");
    }));
    deliveryError = anyFailed ? "monitoring_email_send_failed" : null;
  }

  async function cycle() {
    let samples = [];
    try {
      if (!store) throw new Error("monitoring_storage_unavailable");
      const claims = await store.claimChecks();
      samples = await Promise.all(claims.map(async claim => {
        const sample = await probes.probe(claim.provider);
        if (!await store.record(claim, sample)) throw new Error("monitoring_check_lease_lost");
        return sample;
      }));
      const states = await store.states();
      // If a database probe failed while storage still works, the durable
      // incident/outbox takes precedence over the emergency in-memory path.
      emergency = null;
      let maintenanceError = null;
      try {
        await deliver();
        if (now().getTime() - lastPurgeAt > 3_600_000) {
          await store.purge(); lastPurgeAt = now().getTime();
        }
      } catch { maintenanceError = "monitoring_alert_or_retention_unavailable"; }
      return { providers: states, storage: "available", maintenance_error: maintenanceError };
    } catch {
      logger.error?.("[monitoring] Persistent monitoring unavailable; running read-only probes");
      samples = await probes.probeAll();
      await emergencyCheck(samples);
      return { providers: samples, storage: "unavailable", maintenance_error: "monitoring_storage_unavailable" };
    }
  }

  async function runOnce() {
    if (inFlight) return inFlight;
    if (lastCycle && now().getTime() - lastCycleAt < 45_000) return lastCycle;
    inFlight = cycle().then(result => {
      lastCycle = result; lastCycleAt = now().getTime(); return result;
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  async function snapshot() {
    const result = await runOnce();
    let history = [], alerts = [], historyState = "unavailable";
    if (result.storage === "available") {
      try {
        [history, alerts] = await Promise.all([store.history(), store.alerts()]);
        historyState = "available";
      } catch { /* Keep live probes visible, but never fake an empty history. */ }
    }
    return { ...result, history, history_state: historyState, alerts,
      generated_at: now().toISOString(), sample_interval_seconds: 60, stale_after_seconds: 150,
      email_alerts: { configured: sender.configured, delivery_error: deliveryError,
        emergency_sent: emergency?.sent === true, worker_started: Boolean(timer) } };
  }
  function start() {
    if (timer) return false;
    void runOnce().catch(() => logger.error?.("[monitoring] Cycle failed"));
    timer = setInterval(() => void runOnce().catch(() => logger.error?.("[monitoring] Cycle failed")), 60_000);
    timer.unref?.(); return true;
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { runOnce, snapshot, start, stop };
}

export function createProviderMonitorRouter(monitor) {
  const router = express.Router();
  router.get("/provider-status", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "unauthorized" });
    if (req.user.role !== "super_admin") return res.status(403).json({ error: "forbidden" });
    res.set("Cache-Control", "no-store");
    try { return res.json(await monitor.snapshot()); }
    catch { return res.status(503).json({ error: "monitoring_unavailable" }); }
  });
  return router;
}
