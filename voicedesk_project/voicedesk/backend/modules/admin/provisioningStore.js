import { adminError } from "./companyService.js";

const PHONE_FIELDS = "id,company_id,phone_number,status,twilio_phone_sid,elevenlabs_agent_id,elevenlabs_phone_number_id,updated_at";
const LOCK_MS = 5 * 60 * 1000; // Same lease protocol as onboarding/provision_service.js.

export function createProvisioningStore(supabase, { now = () => new Date() } = {}) {
  async function checked(query) {
    const result = await query.abortSignal(AbortSignal.timeout(8000));
    if (result.error) throw adminError("provisioning_database_unavailable");
    return result.data;
  }
  return {
    async read(companyId) {
      const [company, phones, assistant, twilio, onboarding] = await Promise.all([
        checked(supabase.from("companies").select("id,status").eq("id", companyId).maybeSingle()),
        checked(supabase.from("phone_numbers").select(PHONE_FIELDS).eq("company_id", companyId)
          .in("status", ["active", "suspended"]).order("id").limit(2)),
        checked(supabase.from("assistant_configs").select("company_id,twilio_number,elevenlabs_agent_id")
          .eq("company_id", companyId).maybeSingle()),
        checked(supabase.from("twilio_configs").select("company_id,phone_number,phone_number_sid,account_sid,status")
          .eq("company_id", companyId).maybeSingle()),
        checked(supabase.from("onboarding_progress").select("provisioning_status,provisioning_started_at")
          .eq("company_id", companyId).maybeSingle()),
      ]);
      if (!company) throw adminError("company_not_found", 404);
      return { company, phones: phones || [], assistant, twilio, onboarding };
    },
    async hasOtherOwner(companyId, phone) {
      const keys = [
        ["phone_numbers", "phone_number", phone.phone_number],
        ["phone_numbers", "twilio_phone_sid", phone.twilio_phone_sid],
        ["phone_numbers", "elevenlabs_phone_number_id", phone.elevenlabs_phone_number_id],
        ["phone_numbers", "elevenlabs_agent_id", phone.elevenlabs_agent_id],
        ["assistant_configs", "elevenlabs_agent_id", phone.elevenlabs_agent_id],
        ["assistant_configs", "twilio_number", phone.phone_number],
        ["twilio_configs", "phone_number", phone.phone_number],
        ["twilio_configs", "phone_number_sid", phone.twilio_phone_sid],
      ];
      const results = await Promise.all(keys.filter(([, , value]) => Boolean(value)).map(([table, key, value]) =>
        checked(supabase.from(table).select("company_id").eq(key, value)
          .or(`company_id.neq.${companyId},company_id.is.null`).limit(1))));
      return results.some(rows => rows?.length > 0);
    },
    async acquire(companyId) {
      const started = now().toISOString();
      const stale = new Date(now().getTime() - LOCK_MS).toISOString();
      const row = await checked(supabase.from("onboarding_progress").update({
        provisioning_status: "in_progress", provisioning_started_at: started, provisioning_error: null,
      }).eq("company_id", companyId)
        .or(`provisioning_status.neq.in_progress,provisioning_status.is.null,provisioning_started_at.is.null,provisioning_started_at.lt.${stale}`)
        .select("provisioning_started_at").maybeSingle());
      if (!row) throw adminError("provisioning_in_progress", 409);
      return row.provisioning_started_at;
    },
    async renew(companyId, token) {
      const row = await checked(supabase.from("onboarding_progress").update({ provisioning_started_at: now().toISOString() })
        .eq("company_id", companyId).eq("provisioning_status", "in_progress").eq("provisioning_started_at", token)
        .select("provisioning_started_at").maybeSingle());
      if (!row) throw adminError("provisioning_lock_lost", 409);
      return row.provisioning_started_at;
    },
    async finish(companyId, token, success) {
      const row = await checked(supabase.from("onboarding_progress").update({
        provisioning_status: success ? "done" : "failed",
        provisioning_error: success ? null : "Contrôle ou réparation incomplet : consulter le diagnostic administrateur",
      }).eq("company_id", companyId).eq("provisioning_status", "in_progress").eq("provisioning_started_at", token)
        .select("company_id").maybeSingle());
      if (!row) throw adminError("provisioning_lock_lost", 409);
    },
    async fillAssistant(companyId, before, phone) {
      const changes = {};
      if (before.twilio_number == null) changes.twilio_number = phone.phone_number;
      if (before.elevenlabs_agent_id == null) changes.elevenlabs_agent_id = phone.elevenlabs_agent_id;
      let query = supabase.from("assistant_configs").update({ ...changes, updated_at: now().toISOString() }).eq("company_id", companyId);
      for (const key of ["twilio_number", "elevenlabs_agent_id"]) {
        query = before[key] == null ? query.is(key, null) : query.eq(key, before[key]);
      }
      if (!await checked(query.select("company_id").maybeSingle())) throw adminError("provisioning_changed_retry", 409);
    },
    async audit(companyId, actor, action, details = {}) {
      await checked(supabase.from("audit_log").insert({ company_id: companyId, actor_user_id: actor.id,
        actor_role: "super_admin", entity_type: "company", entity_id: companyId,
        request_id: actor.requestId, action, details }));
    },
  };
}
