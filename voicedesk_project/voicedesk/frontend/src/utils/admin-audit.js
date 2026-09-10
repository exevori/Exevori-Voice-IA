export function auditQuery(filters,cursor) {
  const query = new URLSearchParams({limit:"50"});
  for (const key of ["company_id","action","session_id"]) if(filters[key]) query.set(key,filters[key]);
  if (filters.from) query.set("from",new Date(filters.from+"T00:00:00Z").toISOString());
  if (filters.to) {
    const end = new Date(filters.to+"T00:00:00Z"); end.setUTCDate(end.getUTCDate()+1);
    query.set("to",end.toISOString());
  }
  if(cursor)query.set("cursor",cursor);
  return query.toString();
}
export function auditDuration(seconds) {
  const value = Math.max(0,Number(seconds)||0);
  return `${Math.floor(value/60)} min ${Math.floor(value%60)} s`;
}
export const AUDIT_ACTIONS = ["admin_request_started","admin_request_finished","admin_impersonation_started","admin_impersonation_ended",
  "admin_company_suspend_requested","admin_company_suspend_completed","admin_company_reactivate_completed",
  "admin_plan_change_requested","admin_plan_change_response","privacy_data_exported",
  "admin_provisioning_repair_requested","admin_provisioning_repair_completed","admin_provisioning_repair_failed"];
