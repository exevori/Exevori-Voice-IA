import {fail,UUID,companyScope,ownAccount} from '../account/security.js';
import {transactionalSender} from '../account/service.js';
export const DEFAULT_PREFERENCES={ticket_email:true,billing_email:true,draft_email:false,learning_email:false,system_email:true};
export const INBOX_FIELDS='id,company_id,type,event_type,payload,title,body,link,read,read_at,created_at,companies(name)';
export function inboxScope(req){
  const userId=ownAccount(req);
  const supplied=req.method==='GET'?req.query.company_id:req.body?.company_id;
  const companyId=req.user.role==='super_admin'&&!supplied?null:companyScope(req.user,supplied);
  return {userId,companyId};
}
export function boundedInteger(value,fallback,max){
  if(value===undefined)return fallback;
  if(typeof value!=='string'||!/^\d+$/.test(value))fail('invalid_pagination');
  const number=Number(value);if(!Number.isSafeInteger(number)||number<0||number>max)fail('invalid_pagination');return number;
}
export function preferencePatch(body){
  const result={};
  for(const [key,value] of Object.entries(body||{})){
    if(!Object.hasOwn(DEFAULT_PREFERENCES,key)||typeof value!=='boolean')fail('invalid_preferences');
    result[key]=value;
  }
  if(!Object.keys(result).length)fail('invalid_preferences');return result;
}
async function result(builder){
  const response=await builder.abortSignal(AbortSignal.timeout(10000));
  if(response.error)fail('notifications_unavailable',503);return response;
}
function scoped(builder,{userId,companyId}){
  builder=builder.eq('user_id',userId).is('dismissed_at',null)
    .or('payload_expires_at.is.null,payload_expires_at.gt.'+new Date().toISOString());
  return companyId?builder.eq('company_id',companyId):builder;
}
function unread(builder){return builder.is('read_at',null).not('read','is',true);}
export function createNotificationService({supabase,resend,emailFrom=process.env.EMAIL_FROM,now=()=>new Date()}){
  async function count(scope){const response=await result(unread(scoped(supabase.from('notifications').select('id',{head:true,count:'exact'}),scope)));return response.count||0;}
  async function list(scope,{limit,offset,unreadOnly=false}){
    const asOf=now().toISOString();
    let builder=scoped(supabase.from('notifications').select(INBOX_FIELDS,{count:'exact'}),scope).lte('created_at',asOf);
    if(unreadOnly)builder=unread(builder);
    const response=await result(builder.order('created_at',{ascending:false}).order('id',{ascending:false}).range(offset,offset+limit-1));
    return {notifications:response.data||[],total:response.count||0,unread_count:await count(scope),as_of:asOf};
  }
  async function markOne(scope,id){
    if(!UUID.test(id||''))fail('invalid_notification');
    const response=await result(scoped(supabase.from('notifications').select('id,read,read_at').eq('id',id),scope).maybeSingle());
    if(!response.data)fail('notification_not_found',404);
    if(!response.data.read_at)await result(scoped(supabase.from('notifications').update({read:true,read_at:now().toISOString()}).eq('id',id).is('read_at',null),scope));
    return {success:true};
  }
  async function markAll(scope,before){
    const current=now();const cutoff=before===undefined?current:new Date(before);
    if(typeof before!=='string'&&before!==undefined||!Number.isFinite(cutoff.getTime())||cutoff>current)fail('invalid_cutoff');
    await result(unread(scoped(supabase.from('notifications').update({read:true,read_at:current.toISOString()}).lte('created_at',cutoff.toISOString()),scope)));
    return {success:true};
  }
  async function remove(scope,id){
    if(!UUID.test(id||''))fail('invalid_notification');
    // Preserve the event key to prevent webhook retries from recreating an
    // alert the user dismissed; discard its personal content immediately.
    const timestamp=now().toISOString();
    const response=await result(scoped(supabase.from('notifications').update({dismissed_at:timestamp,
      scrubbed_at:timestamp,read:true,read_at:timestamp,title:'Notification archivée',body:null,link:null,payload:{}}).eq('id',id),scope).select('id').maybeSingle());
    if(!response.data)fail('notification_not_found',404);return {success:true};
  }
  async function preferences(userId){
    const response=await result(supabase.from('notification_preferences').select(Object.keys(DEFAULT_PREFERENCES).join(',')).eq('user_id',userId).maybeSingle());
    return {preferences:{...DEFAULT_PREFERENCES,...response.data}};
  }
  async function savePreferences(userId,body){
    const patch=preferencePatch(body);
    await result(supabase.from('notification_preferences').upsert({user_id:userId},{onConflict:'user_id',ignoreDuplicates:true}));
    await result(supabase.from('notification_preferences').update({...patch,updated_at:now().toISOString()}).eq('user_id',userId));
    return preferences(userId);
  }
  async function sendTest(user){
    if(!resend||!emailFrom)fail('email_not_configured',503);
    if(!user.email)fail('email_unavailable');
    const sender=user.company_id?await transactionalSender(supabase,user.company_id,emailFrom):{from:emailFrom};
    const response=await resend.emails.send({...sender,to:user.email,subject:'Test de notification Exevori',
      text:'Ce message confirme la réception de votre test de courriel transactionnel Exevori.'});
    if(response.error||!response.data?.id)fail('email_delivery_unconfirmed',502);
    return {success:true};
  }
  return {list,count,markOne,markAll,remove,preferences,savePreferences,sendTest};
}
