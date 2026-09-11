import { fail, query } from './security.js';

export const DEFAULT_SETTINGS = Object.freeze({retention_days:90, transcript_retention_days:90,
  recordings_visible:true, transactional_name:'', transactional_reply_to:'', owner_user_id:null});
export function validateCompanySettings(body) {
  const result = {};
  for (const [key,value] of Object.entries(body || {})) {
    if (key === 'company_id') continue;
    if (['retention_days','transcript_retention_days'].includes(key)) {
      if (!Number.isInteger(value) || value < 1 || value > 3650) fail('invalid_retention');
    } else if (key === 'recordings_visible') {
      if (typeof value !== 'boolean') fail('invalid_recording_visibility');
    } else if (key === 'transactional_name') {
      if (typeof value !== 'string' || value.length > 100 || /[<>"\r\n]/.test(value)) fail('invalid_sender_name');
    } else if (key === 'transactional_reply_to') {
      if (typeof value !== 'string' || value.length > 254 || (value && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value))) fail('invalid_reply_to');
    } else fail('unsupported_setting');
    result[key] = typeof value === 'string' ? value.trim() : value;
  }
  if (!Object.keys(result).length) fail('empty_settings');
  return result;
}
export function validateProfile(body) {
  if (Object.keys(body || {}).some(k => !['full_name','avatar_data'].includes(k))) fail('unsupported_profile_field');
  const fullName = body?.full_name;
  if (typeof fullName !== 'string' || !fullName.trim() || fullName.trim().length > 120) fail('invalid_full_name');
  const avatar = body.avatar_data ?? null;
  if (avatar !== null) {
    if (typeof avatar !== 'string' || avatar.length > 180000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar)) fail('invalid_avatar');
    const bytes = Buffer.from(avatar.slice(23), 'base64');
    if (bytes.length > 128 * 1024 || bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) fail('invalid_avatar');
  }
  return {full_name:fullName.trim(), avatar_data:avatar};
}
export function createAccountService({supabase}) {
  return {
    async profile(user) {
      const prefs = await query(supabase.from('account_preferences').select('avatar_data').eq('user_id',user.id).maybeSingle());
      return {full_name:user.profile.full_name, email:user.email, avatar_data:prefs?.avatar_data || null};
    },
    async saveProfile(user, body) {
      const value = validateProfile(body);
      // Exact authenticated identity. Email changes go through Supabase confirmation, never this API.
      await query(supabase.from('account_preferences').upsert({user_id:user.id, avatar_data:value.avatar_data, updated_at:new Date().toISOString()},{onConflict:'user_id'}));
      const row = await query(supabase.from('profiles').update({full_name:value.full_name}).eq('user_id',user.id).select('full_name').single());
      return {...row, email:user.email, avatar_data:value.avatar_data};
    },
    async settings(companyId) {
      const row = await query(supabase.from('company_settings')
        .select('owner_user_id,retention_days,transcript_retention_days,recordings_visible,transactional_name,transactional_reply_to')
        .eq('company_id',companyId).maybeSingle());
      return {...DEFAULT_SETTINGS,...row};
    },
    async saveSettings(companyId, body) {
      const patch = validateCompanySettings(body);
      await query(supabase.from('company_settings').upsert({company_id:companyId},{onConflict:'company_id',ignoreDuplicates:true}));
      await query(supabase.from('company_settings').update({...patch,updated_at:new Date().toISOString()}).eq('company_id',companyId));
      return this.settings(companyId);
    },
    async sessions(user) {
      return query(supabase.rpc('account_sessions',{p_user_id:user.id,p_session_id:user.session_id}));
    },
  };
}

// The delivery address remains the centrally verified EMAIL_FROM. A company may
// customize the display name and Reply-To, never spoof a different From domain.
export async function transactionalSender(supabase, companyId, fallbackFrom) {
  const settings = await query(supabase.from('company_settings').select('transactional_name,transactional_reply_to')
    .eq('company_id',companyId).maybeSingle());
  const address = /<([^<>]+)>/.exec(fallbackFrom)?.[1] || fallbackFrom;
  const patch = validateCompanySettings({transactional_name:settings?.transactional_name || '',transactional_reply_to:settings?.transactional_reply_to || ''});
  return {from:patch.transactional_name ? patch.transactional_name + ' <' + address + '>' : fallbackFrom,
    ...(patch.transactional_reply_to ? {replyTo:patch.transactional_reply_to} : {})};
}
