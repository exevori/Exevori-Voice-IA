function resultData(result) {
  if (result.error) throw Object.assign(new Error("monitoring_storage_unavailable"), { code: "monitoring_storage_unavailable" });
  return result.data;
}

export function createProviderStore(supabase) {
  const bounded = query => query.abortSignal(AbortSignal.timeout(8000));
  const rpc = async (name, args = {}) => resultData(await bounded(supabase.rpc(name, args)));
  return {
    claimChecks: () => rpc("claim_provider_checks"),
    record: (claim, sample) => rpc("record_provider_check", {
      p_provider: claim.provider, p_token: claim.check_token, p_status: sample.status,
      p_latency_ms: sample.latency_ms, p_detail: sample.detail,
    }),
    claimAlerts: () => rpc("claim_provider_alerts"),
    finishAlert: (job, messageId, error) => rpc("finish_provider_alert", {
      p_id: job.id, p_token: job.claim_token, p_message_id: messageId, p_error: error,
    }),
    history: () => rpc("provider_monitor_history"),
    purge: () => rpc("purge_provider_monitoring"),
    states: async () => resultData(await bounded(supabase.from("provider_monitor_state")
      .select("provider,status,detail,latency_ms,checked_at,down_since").order("provider"))),
    alerts: async () => resultData(await bounded(supabase.from("provider_monitor_alerts")
      .select("id,provider,status,down_since,created_at,updated_at,last_error")
      .order("created_at", { ascending: false }).limit(20))),
  };
}
