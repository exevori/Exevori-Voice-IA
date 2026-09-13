import {fail} from '../account/security.js';
export const MISSED_STATUSES=new Set(['busy','no-answer','failed','canceled']);
// Call only behind validateTwilioSignature; no caller-provided company ID.
export async function recordMissedInbound({supabase,body}){
  if(body?.Direction!=='inbound'||!MISSED_STATUSES.has(body.CallStatus))return false;
  if(typeof body.CallSid!=='string'||!/^CA[\da-f]{32}$/i.test(body.CallSid)
    ||typeof body.To!=='string'||!/^\+[1-9]\d{7,14}$/.test(body.To))fail('invalid_call_status');
  const phone=typeof body.From==='string'&&/^\+[1-9]\d{7,14}$/.test(body.From)?body.From:null;
  const {data,error}=await supabase.rpc('record_missed_call_notification',{
    p_sid:body.CallSid,p_to:body.To,p_from:phone,p_status:body.CallStatus,
  }).abortSignal(AbortSignal.timeout(10000));
  if(error||typeof data!=='boolean')fail('missed_call_persistence_unavailable',503);
  return data===true;
}
