const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenantResolutionError extends Error {
  constructor(code = "tenant_resolution_failed") {
    super(code);
    this.name = "TenantResolutionError";
    this.code = code;
  }
}

function normalizeHint(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 256
    ? normalized
    : "";
}

function normalizeUuidHint(value) {
  const normalized = normalizeHint(value);
  return UUID_PATTERN.test(normalized) ? normalized.toLowerCase() : "";
}

function firstHint(...values) {
  for (const value of values) {
    const normalized = normalizeHint(value);
    if (normalized) return normalized;
  }
  return "";
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

async function readCompanyIds(query, code) {
  const { data, error } = await query.limit(50);
  if (error) throw new TenantResolutionError(code);
  return new Set(
    (Array.isArray(data) ? data : [])
      .map(row => row?.company_id)
      .filter(companyId => UUID_PATTERN.test(String(companyId || "")))
  );
}

function unionSets(...sets) {
  return new Set(sets.flatMap(set => [...set]));
}

function intersectSets(left, right) {
  return new Set([...left].filter(value => right.has(value)));
}

/**
 * Resolve an ElevenLabs request without ever falling back to a global tenant.
 *
 * Agent and called-number mappings are resolved independently. When both are
 * available they must agree; an otherwise ambiguous agent can be disambiguated
 * by the tenant phone number.
 */
export async function resolveElevenLabsCompany({
  supabase,
  agentId,
  calledNumber,
  direction = "inbound",
  outboundQueueId,
  outboundAttemptId,
} = {}) {
  if (!supabase) throw new TenantResolutionError("tenant_storage_unavailable");

  const safeAgentId = normalizeHint(agentId);
  const safeCalledNumber = normalizeHint(calledNumber);
  if (!safeAgentId && !safeCalledNumber) return null;

  let agentCompanies = new Set();
  if (safeAgentId) {
    const [phoneAgentCompanies, configAgentCompanies] = await Promise.all([
      readCompanyIds(
        supabase
          .from("phone_numbers")
          .select("company_id")
          .eq("elevenlabs_agent_id", safeAgentId)
          .eq("status", "active"),
        "phone_agent_lookup_failed"
      ),
      readCompanyIds(
        supabase
          .from("assistant_configs")
          .select("company_id")
          .eq("elevenlabs_agent_id", safeAgentId),
        "assistant_agent_lookup_failed"
      ),
    ]);
    agentCompanies = unionSets(phoneAgentCompanies, configAgentCompanies);
  }

  if (direction === "outbound") {
    const safeQueueId = normalizeUuidHint(outboundQueueId);
    const safeAttemptId = normalizeUuidHint(outboundAttemptId);
    if (!safeAgentId || !safeQueueId || !safeAttemptId) return null;

    const [attemptCompanies, queueCompanies] = await Promise.all([
      readCompanyIds(
        supabase
          .from("outbound_call_attempts")
          .select("company_id")
          .eq("id", safeAttemptId)
          .eq("queue_id", safeQueueId),
        "outbound_attempt_lookup_failed"
      ),
      readCompanyIds(
        supabase
          .from("outbound_call_queue")
          .select("company_id")
          .eq("id", safeQueueId)
          .eq("current_attempt_id", safeAttemptId),
        "outbound_queue_lookup_failed"
      ),
    ]);
    const providerScoped = intersectSets(agentCompanies, attemptCompanies);
    const candidates = intersectSets(providerScoped, queueCompanies);
    return candidates.size === 1
      ? { company_id: [...candidates][0] }
      : null;
  }

  let phoneCompanies = new Set();
  if (safeCalledNumber) {
    const [provisionedPhoneCompanies, legacyPhoneCompanies] =
      await Promise.all([
        readCompanyIds(
          supabase
            .from("phone_numbers")
            .select("company_id")
            .eq("phone_number", safeCalledNumber)
            .eq("status", "active"),
          "phone_number_lookup_failed"
        ),
        readCompanyIds(
          supabase
            .from("twilio_configs")
            .select("company_id")
            .eq("phone_number", safeCalledNumber),
          "twilio_number_lookup_failed"
        ),
      ]);
    phoneCompanies = unionSets(
      provisionedPhoneCompanies,
      legacyPhoneCompanies
    );
  }

  let candidates;
  if (agentCompanies.size > 0 && phoneCompanies.size > 0) {
    candidates = intersectSets(agentCompanies, phoneCompanies);
  } else {
    candidates =
      agentCompanies.size > 0 ? agentCompanies : phoneCompanies;
  }

  if (candidates.size !== 1) return null;
  return { company_id: [...candidates][0] };
}

export function extractCustomLlmTenantHints(req) {
  const body = objectValue(req?.body);
  const extra = objectValue(body.elevenlabs_extra_body);
  const bodyDynamicVariables = objectValue(body.dynamic_variables);
  const bodyInitiation = objectValue(
    body.conversation_initiation_client_data
  );
  const bodyInitiationVariables = objectValue(
    bodyInitiation.dynamic_variables
  );
  const bodyCustomExtra = objectValue(body.custom_llm_extra_body);
  const bodyInitiationExtra = objectValue(
    bodyInitiation.custom_llm_extra_body
  );
  const extraDynamicVariables = objectValue(extra.dynamic_variables);
  const extraInitiation = objectValue(
    extra.conversation_initiation_client_data
  );
  const extraInitiationVariables = objectValue(
    extraInitiation.dynamic_variables
  );
  const headers = objectValue(req?.headers);
  const directionHint = firstHint(
    extra.voicedesk_direction,
    extraDynamicVariables.voicedesk_direction,
    extraInitiationVariables.voicedesk_direction,
    bodyCustomExtra.voicedesk_direction,
    bodyInitiationExtra.voicedesk_direction,
    bodyDynamicVariables.voicedesk_direction,
    bodyInitiationVariables.voicedesk_direction,
    body.voicedesk_direction
  ).toLowerCase();

  const outboundQueueId = normalizeUuidHint(firstHint(
    extra.outbound_queue_id,
    extra.queue_id,
    extraDynamicVariables.outbound_queue_id,
    extraDynamicVariables.queue_id,
    extraInitiationVariables.outbound_queue_id,
    bodyCustomExtra.outbound_queue_id,
    bodyCustomExtra.queue_id,
    bodyInitiationExtra.outbound_queue_id,
    bodyDynamicVariables.outbound_queue_id,
    bodyDynamicVariables.queue_id,
    bodyInitiationVariables.outbound_queue_id,
    bodyInitiationVariables.queue_id
  ));
  const outboundAttemptId = normalizeUuidHint(firstHint(
    extra.outbound_attempt_id,
    extra.attempt_id,
    extraDynamicVariables.outbound_attempt_id,
    extraDynamicVariables.attempt_id,
    extraInitiationVariables.outbound_attempt_id,
    bodyCustomExtra.outbound_attempt_id,
    bodyCustomExtra.attempt_id,
    bodyInitiationExtra.outbound_attempt_id,
    bodyDynamicVariables.outbound_attempt_id,
    bodyDynamicVariables.attempt_id,
    bodyInitiationVariables.outbound_attempt_id,
    bodyInitiationVariables.attempt_id
  ));

  return {
    agentId: firstHint(
      headers["x-elevenlabs-agent-id"],
      extra.system__agent_id,
      extra.agent_id,
      extra.elevenlabs_agent_id,
      body.agent_id
    ),
    calledNumber: firstHint(
      headers["x-elevenlabs-called-number"],
      headers["x-elevenlabs-to-number"],
      extra.system__called_number,
      extra.called_number,
      extra.to_number,
      body.called_number
    ),
    callerNumber: firstHint(
      headers["x-elevenlabs-caller-number"],
      extra.system__caller_id,
      extra.caller_id,
      extra.from_number,
      body.caller_number
    ),
    direction: directionHint === "outbound" ? "outbound" : "inbound",
    ...(outboundQueueId ? { outboundQueueId } : {}),
    ...(outboundAttemptId ? { outboundAttemptId } : {}),
  };
}

export function extractPostCallTenantHints(body) {
  const root = objectValue(body);
  const data = objectValue(root.data || root);
  const metadata = objectValue(data.metadata);
  const phoneCall = objectValue(metadata.phone_call);
  const providerBody = objectValue(metadata.body);
  const initiation = objectValue(
    data.conversation_initiation_client_data
  );
  const dynamicVariables = objectValue(initiation.dynamic_variables);

  return {
    agentId: firstHint(
      data.agent_id,
      root.agent_id,
      dynamicVariables.system__agent_id,
      dynamicVariables.system__current_agent_id,
      metadata.agent_id
    ),
    calledNumber: firstHint(
      dynamicVariables.system__called_number,
      phoneCall.agent_number,
      phoneCall.called_number,
      phoneCall.to_number,
      providerBody.Called,
      providerBody.To
    ),
    callerNumber: firstHint(
      dynamicVariables.system__caller_id,
      phoneCall.external_number,
      phoneCall.caller_number,
      metadata.caller_number,
      providerBody.Caller,
      providerBody.From,
      root.caller_number
    ),
    callSid: firstHint(
      dynamicVariables.system__call_sid,
      phoneCall.call_sid,
      providerBody.CallSid,
      data.twilio_call_sid
    ),
  };
}
