import {fail,query} from '../account/security.js';

export function createInviteAcceptance({supabase,now=()=>Date.now()}) {
  return async body => {
    const {token,password,full_name} = body || {};
    if (typeof token !== 'string' || token.length < 20 || token.length > 128
      || typeof password !== 'string' || password.length < 12 || password.length > 128
      || typeof full_name !== 'string' || !full_name.trim() || full_name.trim().length > 120) fail('invalid_invitation_input');
    const invitation = await query(supabase.from('invitations').select('id,email,company_id,role,status,expires_at')
      .eq('token',token).maybeSingle());
    if (!invitation || invitation.status !== 'pending' || !(Date.parse(invitation.expires_at) > now())
      || !['company_admin','company_user'].includes(invitation.role)) fail('invalid_invitation');
    const {data:auth,error:authError} = await supabase.auth.admin.createUser({email:invitation.email,password,email_confirm:true});
    if (authError || !auth?.user?.id) fail('invitation_account_creation_failed',409);
    const result = await supabase.rpc('accept_team_invitation',{
      p_token:token,p_user_id:auth.user.id,p_full_name:full_name.trim(),
    }).abortSignal(AbortSignal.timeout(8000));
    if (result.error) {
      // Only compensate a known rolled-back SQL rejection, never a timeout whose
      // commit outcome is unknown. Never remove an existing user's identity.
      if (['22023','23505','23514','42501'].includes(result.error.code)) {
        const lookup = await supabase.from('profiles').select('user_id').eq('user_id',auth.user.id).maybeSingle();
        if (!lookup.error && !lookup.data) {
          const cleanup = await supabase.auth.admin.deleteUser(auth.user.id);
          if (cleanup.error) fail('invitation_reconciliation_required',503);
        }
      }
      fail('invitation_reconciliation_required',503);
    }
    if (result.data?.success !== true || result.data.user_id !== auth.user.id
      || result.data.company_id !== invitation.company_id) fail('invitation_reconciliation_required',503);
    return result.data;
  };
}
