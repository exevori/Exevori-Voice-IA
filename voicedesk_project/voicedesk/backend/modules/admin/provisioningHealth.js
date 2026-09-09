import { adminError } from "./companyService.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE = /^[A-Za-z0-9_-]{1,200}$/;
const check = (key, state, code = state) => ({ key, state, code });
const unavailable = state => ["not_configured", "unauthorized", "timeout", "unavailable"].includes(state);

export function createProvisioningHealthService({ store, providers, authorizeRepair, now = () => new Date() }) {
  async function inspect(companyId, { underLock = false } = {}) {
    if (!UUID.test(companyId || "")) throw adminError("invalid_company_id", 400);
    const snapshot = await store.read(companyId);
    const checks = [];
    const repairs = [];
    const phone = snapshot.phones.length === 1 ? snapshot.phones[0] : null;
    const localIssues = [];
    if (!phone) localIssues.push(snapshot.phones.length ? "multiple_phone_numbers" : "phone_number_missing");
    if (phone) {
      if (phone.company_id !== companyId || phone.status !== "active") localIssues.push("phone_not_active_or_owned");
      if (!/^\+[1-9]\d{7,14}$/.test(phone.phone_number || "") || !/^PN[0-9a-f]{32}$/i.test(phone.twilio_phone_sid || "")
        || !OPAQUE.test(phone.elevenlabs_agent_id || "") || !OPAQUE.test(phone.elevenlabs_phone_number_id || "")) localIssues.push("resource_identifiers_missing_or_invalid");
      const t = snapshot.twilio;
      if (!t || t.phone_number !== phone.phone_number || t.phone_number_sid !== phone.twilio_phone_sid
        || t.account_sid !== providers.masterAccount || t.status !== "active") localIssues.push("twilio_config_mismatch");
      const a = snapshot.assistant;
      if (!a) localIssues.push("assistant_config_missing");
      else if ((a.twilio_number != null && a.twilio_number !== phone.phone_number)
        || (a.elevenlabs_agent_id != null && a.elevenlabs_agent_id !== phone.elevenlabs_agent_id)) localIssues.push("assistant_config_mismatch");
      else if (a.twilio_number == null || a.elevenlabs_agent_id == null) repairs.push("restore_assistant_references");
      if (await store.hasOtherOwner(companyId, phone)) localIssues.push("resource_ownership_conflict");
    }
    if (!snapshot.onboarding) localIssues.push("onboarding_missing");
    if (!underLock && snapshot.onboarding && snapshot.onboarding.provisioning_status !== "done") {
      const started = Date.parse(snapshot.onboarding.provisioning_started_at);
      const stale = Number.isFinite(started) && started < now().getTime() - 5 * 60 * 1000;
      if (snapshot.onboarding.provisioning_status === "in_progress" && !stale) localIssues.push("provisioning_in_progress");
      else repairs.push("reconcile_provisioning_status");
    }
    checks.push(check("database", localIssues.length ? "error" : repairs.length ? "repairable" : "ok",
      localIssues[0] || (repairs.includes("restore_assistant_references") ? "assistant_references_missing"
        : repairs.length ? "provisioning_status_incomplete" : "consistent")));
    // Keep the complete list of local inconsistencies, not just the first one.
    checks[0].issues = localIssues;
    if (phone) {
      const [twilio, agent, elPhone] = await Promise.all([
        providers.twilioNumber(phone.twilio_phone_sid), providers.agent(phone.elevenlabs_agent_id), providers.phone(phone.elevenlabs_phone_number_id),
      ]);
      const twilioOk = twilio.state === "ok" && twilio.data?.sid === phone.twilio_phone_sid
        && twilio.data?.account_sid === providers.masterAccount && twilio.data?.phone_number === phone.phone_number
        && twilio.data?.status === "in-use" && twilio.data?.voice === true;
      checks.push(check("twilio", twilioOk ? "ok" : unavailable(twilio.state) ? "unknown" : "error", twilioOk ? "number_active" : twilio.state === "ok" ? "number_mismatch_or_inactive" : twilio.state));
      const agentOk = agent.state === "ok" && agent.data?.agent_id === phone.elevenlabs_agent_id;
      checks.push(check("elevenlabs_agent", agentOk ? "ok" : unavailable(agent.state) ? "unknown" : "error", agentOk ? "agent_exists" : agent.state === "ok" ? "agent_mismatch" : agent.state));
      const el = elPhone.data;
      const elMatches = elPhone.state === "ok" && el?.phone_number_id === phone.elevenlabs_phone_number_id
        && el?.phone_number === phone.phone_number && el?.provider === "twilio";
      const linked = elMatches && el.assigned_agent?.agent_id === phone.elevenlabs_agent_id;
      const unassigned = elMatches && el.assigned_agent === null;
      if (unassigned) repairs.push("link_unassigned_number");
      checks.push(check("elevenlabs_link", linked ? "ok" : unassigned ? "repairable" : unavailable(elPhone.state) ? "unknown" : "error",
        linked ? "number_linked" : unassigned ? "number_unassigned" : elPhone.state === "ok" ? "phone_or_assignment_mismatch" : elPhone.state));
    } else {
      for (const key of ["twilio", "elevenlabs_agent", "elevenlabs_link"]) checks.push(check(key, "unknown", "no_unique_phone"));
    }
    const blocked = checks.some(row => ["unknown", "error"].includes(row.state));
    const companyActive = ["active", "trial"].includes(snapshot.company.status);
    const available = !blocked && repairs.length > 0 && companyActive;
    const report = { company_id: companyId, checked_at: now().toISOString(),
      status: checks.every(row => row.state === "ok") ? "healthy" : checks.some(row => row.state === "error" || row.state === "repairable") ? "unhealthy" : "unknown",
      checks, repair: { available, actions: available ? repairs : [],
        blocked_reason: !companyActive ? "company_access_inactive" : blocked ? "manual_review_or_provider_recovery_required" : null },
    };
    return { report, snapshot, phone };
  }

  async function getHealth(companyId, actor) {
    const { report } = await inspect(companyId);
    await store.audit(companyId, actor, "admin_provisioning_health_viewed", { status: report.status });
    return report;
  }

  async function repair(companyId, actor, reason) {
    // The browser never supplies resource IDs or decides which operations run.
    const initial = await inspect(companyId);
    if (initial.report.status === "healthy") {
      await store.audit(companyId, actor, "admin_provisioning_repair_noop", { reason });
      return { success: true, changed: false, health: initial.report };
    }
    if (!initial.report.repair.available) throw adminError("provisioning_repair_blocked", 409);
    await authorizeRepair(companyId);
    await store.audit(companyId, actor, "admin_provisioning_repair_requested", { reason, actions: initial.report.repair.actions });
    let token = await store.acquire(companyId);
    let finished = false;
    try {
      const fresh = await inspect(companyId, { underLock: true });
      if (!fresh.report.repair.available && fresh.report.status !== "healthy") throw adminError("provisioning_changed_retry", 409);
      if (JSON.stringify(fresh.phone) !== JSON.stringify(initial.phone)) throw adminError("provisioning_changed_retry", 409);
      // Recheck subscription/access after taking the provisioning lease.
      await authorizeRepair(companyId);
      const actions = [...fresh.report.repair.actions];
      if (initial.report.repair.actions.includes("reconcile_provisioning_status")) actions.push("reconcile_provisioning_status");
      if (actions.includes("link_unassigned_number")) {
        token = await store.renew(companyId, token);
        // Last read before PATCH: never overwrite an assignment set elsewhere.
        const last = await providers.phone(fresh.phone.elevenlabs_phone_number_id);
        if (last.state !== "ok" || last.data?.assigned_agent !== null || last.data.phone_number !== fresh.phone.phone_number
          || last.data.phone_number_id !== fresh.phone.elevenlabs_phone_number_id || last.data.provider !== "twilio") throw adminError("provisioning_changed_retry", 409);
        token = await store.renew(companyId, token);
        const result = await providers.assignPhone(fresh.phone.elevenlabs_phone_number_id, fresh.phone.elevenlabs_agent_id);
        if (result.state !== "ok") throw adminError("provisioning_repair_unconfirmed");
      }
      if (actions.includes("restore_assistant_references")) {
        token = await store.renew(companyId, token);
        await store.fillAssistant(companyId, fresh.snapshot.assistant, fresh.phone);
      }
      const verified = await inspect(companyId, { underLock: true });
      const success = verified.report.status === "healthy";
      await store.finish(companyId, token, success); finished = true;
      await store.audit(companyId, actor, "admin_provisioning_repair_completed", { success, actions });
      return { success, changed: actions.length > 0, health: verified.report };
    } catch (error) {
      if (!finished) {
        try { await store.finish(companyId, token, false); } catch { /* Never overwrite another lease. */ }
      }
      try { await store.audit(companyId, actor, "admin_provisioning_repair_failed", { code: error.code || "unconfirmed" }); } catch { /* Requested audit already exists. */ }
      throw error;
    }
  }
  return { getHealth, repair };
}
