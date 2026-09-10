const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const IMPERSONATION_KEY = "voicedesk_admin_session_v1";
export function assertVerifiedSession(company,session,actorId,now=Date.now()) {
  if (!UUID.test(company?.id) || !UUID.test(session?.id) || session?.company_id !== company.id
      || session?.actor_user_id !== actorId || session?.state !== "active" || session?.ended_at
      || !Number.isFinite(Date.parse(session?.expires_at)) || Date.parse(session.expires_at) <= now) {
    throw new Error("Le serveur n’a pas confirmé une session de vue client active. Actualisez puis réessayez.");
  }
}
export function clientViewProfile(profile,session,company) {
  if (profile?.role !== "super_admin" || !session || session.company_id !== company?.id) return profile;
  return {...profile,role:"company_admin",company_id:company.id,company:{...company}};
}
export function restoreCandidate(raw,actorId) {
  try {
    const value = JSON.parse(raw);
    return value?.actor_id === actorId && UUID.test(value?.session?.id) && UUID.test(value?.company?.id) ? value : null;
  } catch { return null; }
}

// Only our authenticated API receives this header, never provider requests.
export function createImpersonationFetch({fetchImpl,apiBase="",origin,getContext,now=Date.now}) {
  const api = new URL(`${apiBase.replace(/\/$/,"")}/api/v1/`,origin);
  const local = new URL("/api/v1/",origin);
  return (input,options={}) => {
    const request = typeof Request !== "undefined" && input instanceof Request;
    const url = new URL(request ? input.url : String(input),origin);
    const target = [api,local].find(base=>url.origin===base.origin && url.pathname.startsWith(base.pathname));
    if (!target) return fetchImpl(input,options);
    const relative = url.pathname.slice(target.pathname.length);
    if (["auth/me","auth/logout"].includes(relative) || relative.startsWith("admin/impersonations/")) return fetchImpl(input,options);
    const ctx = getContext();
    const headers = new Headers(options.headers ?? (request ? input.headers : undefined));
    if (!ctx?.session || !headers.has("Authorization")) return fetchImpl(input,options);
    if (headers.get("Authorization") !== `Bearer ${ctx.token}`) return Promise.reject(new Error("La session a changé. Actualisez la page."));
    if (Date.parse(ctx.session.expires_at) <= now()) return Promise.reject(new Error("La vue client a expiré. Revenez à l’administration."));
    headers.set("X-Impersonation-Session",ctx.session.id);
    return fetchImpl(input,{...options,headers,redirect:"error"});
  };
}
