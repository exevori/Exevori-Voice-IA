// Inputs must come from the authenticated provider body, never client variables.
export function onboardingCallProof(data,now=Date.now()) {
  const phone=data?.metadata?.phone_call;
  const start=data?.metadata?.start_time_unix_secs;
  const duration=data?.metadata?.call_duration_secs;
  if(data?.status!=='done'||phone?.direction!=='inbound'
    ||!/^CA[\da-f]{32}$/i.test(phone.call_sid||'')
    ||!/^\+[1-9]\d{7,14}$/.test(phone.external_number||'')
    ||!/^\+[1-9]\d{7,14}$/.test(phone.agent_number||'')
    ||!Number.isSafeInteger(start)||start<=0||start*1000>now
    ||now-start*1000>25*60*60*1000
    ||!Number.isInteger(duration)||duration<5||duration>1200)return null;
  return {p_from:phone.external_number,p_to:phone.agent_number,
    p_started_at:new Date(start*1000).toISOString(),p_duration:duration};
}
export async function confirmOnboardingCall({supabase,signatureStatus,companyId,callId,data}) {
  if(signatureStatus!=='ok'||!callId)return false;
  const proof=onboardingCallProof(data);
  if(!proof)return false;
  const {data:confirmed,error}=await supabase.rpc('confirm_onboarding_test_call',{
    p_company_id:companyId,p_call_id:callId,...proof,
  }).abortSignal(AbortSignal.timeout(8000));
  if(error)throw new Error('onboarding_confirmation_unavailable');
  return confirmed===true;
}
