import express from 'express';
import {createClient} from '@supabase/supabase-js';
import {Resend} from 'resend';
import {randomBytes} from 'node:crypto';
import {companyScope, manager, ownAccount, fail, query, route, UUID} from '../account/security.js';
import {transactionalSender} from '../account/service.js';

const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createTeamRouter({supabase, resend, frontendUrl=process.env.FRONTEND_URL, emailFrom=process.env.EMAIL_FROM}) {
  const router = express.Router();
  router.get('/',route(async(req,res)=>{
    const companyId = companyScope(req.user,req.query.company_id);
    const [members,invitations,settings] = await Promise.all([
      query(supabase.from('profiles').select('id,user_id,full_name,email,role,status,created_at')
        .eq('company_id',companyId).order('created_at').limit(500)),
      query(supabase.from('invitations').select('id,email,role,status,expires_at,created_at')
        .eq('company_id',companyId).in('status',['pending','expired']).order('created_at',{ascending:false}).limit(100)),
      query(supabase.from('company_settings').select('owner_user_id').eq('company_id',companyId).maybeSingle()),
    ]);
    res.json({members:members || [], invitations:invitations || [], owner_user_id:settings?.owner_user_id || null});
  }));
  router.post('/invitations',route(async(req,res)=>{
    manager(req.user);
    const companyId = companyScope(req.user,req.body.company_id);
    const role = req.body.role || 'company_user';
    if (!['company_admin','company_user'].includes(role)) fail('invalid_role');
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) fail('invalid_email');
    if (!resend || !emailFrom) fail('email_not_configured',503);
    let origin;
    try { origin = new URL(String(frontendUrl).split(',')[0].trim()); } catch { fail('frontend_not_configured',503); }
    if (origin.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(origin.hostname)) fail('frontend_not_configured',503);
    const [existing, pending, company] = await Promise.all([
      query(supabase.from('profiles').select('id').eq('company_id',companyId).eq('email',email).maybeSingle()),
      query(supabase.from('invitations').select('id').eq('company_id',companyId).eq('email',email).eq('status','pending').gt('expires_at',new Date().toISOString()).limit(1)),
      query(supabase.from('companies').select('name').eq('id',companyId).single()),
    ]);
    if (existing || pending?.length) fail('already_invited_or_member',409);
    const token = randomBytes(32).toString('base64url');
    const sender = await transactionalSender(supabase,companyId,emailFrom);
    const invitation = await query(supabase.from('invitations').insert({
      company_id:companyId,email,role,token,status:'pending',sent_by:req.user.id,
      expires_at:new Date(Date.now()+7*86400000).toISOString(),
    }).select('id,email,role,status,expires_at,created_at').single());
    const url = new URL('/invite/'+token,origin).href;
    let emailSent = false;
    try {
      const result = await resend.emails.send({...sender,to:email,subject:'Invitation à rejoindre '+company.name,
        html:'<p>Vous êtes invité à rejoindre '+escape(company.name)+'.</p><p><a href="'+escape(url)+'">Accepter l’invitation</a></p><p>Ce lien expire dans 7 jours.</p>'});
      emailSent = Boolean(result?.data?.id && !result?.error);
    } catch { /* Confirmed below; never report a successful delivery on failure. */ }
    if (!emailSent) {
      await query(supabase.from('invitations').update({status:'cancelled'}).eq('id',invitation.id).eq('company_id',companyId).eq('status','pending'));
      fail('invitation_delivery_failed',502);
    }
    res.status(201).json({success:true,invitation,email_sent:true});
  }));
  router.post('/invitations/:id/cancel',route(async(req,res)=>{
    manager(req.user);
    if (!UUID.test(req.params.id)) fail('invalid_invitation');
    const invitation = await query(supabase.from('invitations').select('id,company_id').eq('id',req.params.id).maybeSingle());
    if (!invitation) fail('invitation_not_found',404);
    const companyId = companyScope(req.user,invitation.company_id);
    const result = await query(supabase.from('invitations').update({status:'cancelled'})
      .eq('id',invitation.id).eq('company_id',companyId).eq('status','pending').select('id,status').maybeSingle());
    if (!result) fail('invitation_not_pending',409);
    res.json({success:true,invitation:result});
  }));
  router.patch('/members/:user_id',route(async(req,res)=>{
    manager(req.user);
    const companyId = companyScope(req.user,req.body.company_id);
    if (!UUID.test(req.params.user_id) || Object.keys(req.body).some(k=>!['company_id','role','status'].includes(k))) fail('invalid_member_change');
    if (req.body.role !== undefined && !['company_admin','company_user'].includes(req.body.role)) fail('invalid_role');
    if (req.body.status !== undefined && !['active','inactive'].includes(req.body.status)) fail('invalid_status');
    if (!req.body.role && !req.body.status) fail('empty_member_change');
    res.json(await query(supabase.rpc('manage_company_member',{
      p_company_id:companyId,p_actor_id:req.user.id,p_target_id:req.params.user_id,
      p_role:req.body.role || null,p_status:req.body.status || null,p_transfer_owner:false,
    })));
  }));
  router.post('/owner',route(async(req,res)=>{
    ownAccount(req);
    manager(req.user);
    const companyId = companyScope(req.user,req.body.company_id);
    if (!UUID.test(req.body.user_id || '') || req.body.confirm_company_id !== companyId) fail('confirmation_required');
    res.json(await query(supabase.rpc('manage_company_member',{
      p_company_id:companyId,p_actor_id:req.user.id,p_target_id:req.body.user_id,
      p_role:null,p_status:null,p_transfer_owner:true,
    })));
  }));
  return router;
}
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}) : null;
export default createTeamRouter({supabase,resend:process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null});
