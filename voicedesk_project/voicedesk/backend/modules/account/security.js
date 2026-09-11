export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function fail(code, status = 400) { throw Object.assign(new Error(code), {code, status}); }

// Call only AFTER supabase.auth.getUser(token) has authenticated this JWT.
export function verifiedSessionId(token, userId) {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    if (claims.sub !== userId || !UUID.test(claims.session_id || '')) fail('invalid_session', 401);
    return claims.session_id;
  } catch { fail('invalid_session', 401); }
}
export async function requireLiveSession(supabase, token, userId) {
  const sessionId = verifiedSessionId(token, userId);
  const {data, error} = await supabase.rpc('account_session_active', {p_user_id:userId, p_session_id:sessionId})
    .abortSignal(AbortSignal.timeout(8000));
  if (error) fail('session_check_unavailable', 503);
  if (data !== true) fail('session_revoked', 401);
  return sessionId;
}
export function companyScope(user, supplied) {
  if (!user) fail('unauthorized', 401);
  if (supplied && user.role !== 'super_admin' && supplied !== user.company_id) fail('forbidden_company', 403);
  const companyId = user.role === 'super_admin' ? supplied || user.company_id : user.company_id;
  if (!UUID.test(companyId || '')) fail('company_id_required');
  return companyId;
}
export function manager(user) {
  if (!['company_admin','super_admin'].includes(user?.role)) fail('forbidden', 403);
}
export function ownAccount(req) {
  if (!req.user) fail('unauthorized', 401);
  if (req.get('X-Impersonation-Session')) fail('leave_client_view_first', 403);
  return req.user.id;
}
export async function query(builder) {
  const {data, error} = await builder.abortSignal(AbortSignal.timeout(8000));
  if (error) {
    if (error.code === '42501') fail(error.message, 403);
    if (error.code === '22023') fail(error.message, 400);
    if (error.code === '23505') fail('already_exists', 409);
    fail('settings_unavailable', 503);
  }
  return data;
}
export async function syncVerifiedProfileEmail(supabase, authUser, profile) {
  if (!authUser.email_confirmed_at || !authUser.email || profile.email === authUser.email) return profile;
  const updated = await query(supabase.from('profiles').update({email:authUser.email})
    .eq('user_id',authUser.id).select('email').single());
  if (updated?.email !== authUser.email) fail('profile_sync_unavailable',503);
  return {...profile,email:updated.email};
}
export function route(handler) {
  return async (req, res) => {
    res.set('Cache-Control','no-store');
    try { await handler(req,res); }
    catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      res.status(error.status || 503).json({error:error.code || 'settings_unavailable'});
    }
  };
}
