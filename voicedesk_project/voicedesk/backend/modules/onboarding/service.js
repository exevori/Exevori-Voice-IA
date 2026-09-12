import {companyScope,manager,fail,UUID} from '../account/security.js';
import {prefixRecordingConsentFr,prefixRecordingConsentEn} from '../privacy/consent.js';
import {qaOriginKey} from '../kb/service.js';

const PROGRESS='current_step,completed_steps,setup_data,activation_requested_at,provisioning_status,provisioning_started_at,test_phone,test_started_at,test_expires_at,test_verified_at,test_call_id';
export async function onboardingQuery(builder) {
  const {data,error}=await builder.abortSignal(AbortSignal.timeout(10000));
  if(error) {
    if(error.code==='22023') fail(error.message,409);
    fail('onboarding_unavailable',503);
  }
  return data;
}
export function validateFaq(value=[]) {
  if(!Array.isArray(value)||value.length>20) fail('invalid_faq');
  const seen=new Set();
  return value.map(entry=>{
    const question=typeof entry?.question==='string'?entry.question.trim():'';
    const answer=typeof entry?.answer==='string'?entry.answer.trim():'';
    if(!question||!answer||question.length>500||answer.length>4000) fail('invalid_faq');
    const key=qaOriginKey('onboarding',question);
    if(seen.has(key))fail('duplicate_question');seen.add(key);
    return {question,answer,category:'FAQ'};
  });
}
export function stateView(progress={},config={},numbers=[],now=Date.now()) {
  const ready=progress.provisioning_status==='done' && Boolean(config.elevenlabs_agent_id)
    && numbers.some(n=>n.phone_number===config.twilio_number && n.elevenlabs_agent_id===config.elevenlabs_agent_id && n.status==='active');
  const steps=progress.completed_steps||[];
  const locked=Boolean(progress.activation_requested_at||config.elevenlabs_agent_id)||['in_progress','done'].includes(progress.provisioning_status);
  const currentStep=ready?5:locked?4:![1,2,3].every(n=>steps.includes(n))
    ?[1,2,3].find(n=>!steps.includes(n)):4;
  const lastRenewed=Date.parse(progress.provisioning_started_at);
  const retryAfter=progress.provisioning_status==='in_progress' && Number.isFinite(lastRenewed)
    ?Math.max(0,Math.ceil((lastRenewed+300000-now)/1000)):0;
  const completed=Boolean(progress.test_verified_at);
  return {
    progress:{current_step:completed?5:currentStep,total_steps:5,completed_steps:steps,
      completed_at:progress.test_verified_at||null},
    config:{assistant_name:config.assistant_name||'Léa',tone:config.tone||'professional',
      voice_library_id:progress.setup_data?.['2']?.voice_library_id||null},
    knowledge_entries:progress.setup_data?.['3']?.knowledge_entries||[],
    knowledge_saved:Boolean(progress.setup_data?.['3']),
    area_code:progress.setup_data?.area_code||'581',
    status:progress.provisioning_status||'idle',ready,
    phone_number:ready?config.twilio_number:null,
    retry_after_seconds:retryAfter,
    can_retry:!ready && retryAfter===0,
    error:progress.provisioning_status==='failed'?'provisioning_failed':progress.provisioning_status==='done'&&!ready?'provisioning_inconsistent':null,
    test:{phone:progress.test_phone||'',started_at:progress.test_started_at||null,
      expires_at:progress.test_expires_at||null,verified_at:progress.test_verified_at||null,
      call_id:completed?progress.test_call_id||null:null,
      status:completed?'verified':Date.parse(progress.test_expires_at)>now?'waiting':progress.test_started_at?'expired':'idle'},
  };
}
export function createOnboardingService({supabase,knowledge,provision,env=process.env,now=Date.now}) {
  async function read(companyId) {
    const [progress,config,numbers]=await Promise.all([
      onboardingQuery(supabase.from('onboarding_progress').select(PROGRESS).eq('company_id',companyId).maybeSingle()),
      onboardingQuery(supabase.from('assistant_configs').select('assistant_name,tone,voice_id,twilio_number,elevenlabs_agent_id,system_prompt_voice_fr').eq('company_id',companyId).maybeSingle()),
      onboardingQuery(supabase.from('phone_numbers').select('phone_number,elevenlabs_agent_id,status').eq('company_id',companyId).eq('status','active')),
    ]);
    return {progress:progress||{},config:config||{},numbers:numbers||[]};
  }
  async function state(companyId) {const data=await read(companyId);return stateView(data.progress,data.config,data.numbers,now());}
  async function save(companyId,step,body,user) {
    let data;
    if(step===1) {
      const name=typeof body.assistant_name==='string'?body.assistant_name.trim():'';
      if(!name||name.length>80)fail('invalid_assistant_name');
      const tone=body.tone||'professional';
      if(!['professional','warm','casual','formal'].includes(tone))fail('invalid_tone');
      const company=await onboardingQuery(supabase.from('companies').select('name').eq('id',companyId).single());
      data={assistant_name:name,tone,
        greeting_inbound_fr:prefixRecordingConsentFr('Bonjour, ici '+company.name+'. Je suis '+name+', comment puis-je vous aider ?'),
        greeting_inbound_en:prefixRecordingConsentEn('Hello, this is '+company.name+'. I am '+name+', how may I help you?')};
    } else if(step===2) {
      if(!UUID.test(body.voice_library_id||''))fail('invalid_voice');
      data={voice_library_id:body.voice_library_id};
    } else if(step===3) data={knowledge_entries:validateFaq(body.knowledge_entries)};
    else fail('invalid_step');
    await onboardingQuery(supabase.rpc('save_onboarding_step',{p_company_id:companyId,p_step:step,p_data:data}));
    if(step===3) {
      for(const entry of data.knowledge_entries) {
        await knowledge.createQaSource({companyId,type:'onboarding',...entry,
          originKey:qaOriginKey('onboarding',entry.question),createdBy:user?.profile?.id||null,
          metadata:{created_via:'onboarding_step_3'}});
      }
      await onboardingQuery(supabase.rpc('finish_onboarding_knowledge',{p_company_id:companyId,p_data:data}));
    }
    return state(companyId);
  }
  async function activate(companyId,body) {
    const areaCode=body.area_code||'581';
    if(!['581','418','514'].includes(areaCode))fail('invalid_area_code');
    const current=await read(companyId);
    const view=stateView(current.progress,current.config,current.numbers,now());
    if(view.ready)return view;
    if(!view.can_retry)throw Object.assign(new Error('provisioning_in_progress'),{code:'provisioning_in_progress',status:409,retryAfter:view.retry_after_seconds});
    for(const key of ['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','ELEVENLABS_API_KEY','ELEVENLABS_MASTER_AGENT_ID']) {
      if(!env[key])fail('provisioning_not_configured',503);
    }
    const snapshot=await onboardingQuery(supabase.rpc('prepare_onboarding_activation',{p_company_id:companyId,p_area_code:areaCode}));
    if(!snapshot?.voice_id)fail('onboarding_unavailable',503);
    const result=await provision({companyId,assistantName:snapshot.assistant_name||'Votre assistante',
      voiceId:snapshot.voice_id,systemPrompt:snapshot.system_prompt_voice_fr,areaCode});
    if(!result?.success) {
      const conflict=['provisioning_in_progress','provisioning_retry_required'].includes(result?.code);
      throw Object.assign(new Error('provisioning_failed'),{code:conflict?result.code:'provisioning_failed',status:conflict?409:503,retryAfter:result?.retry_after_seconds});
    }
    return state(companyId);
  }
  async function armTest(companyId,body) {
    const phone=typeof body.test_phone_number==='string'?body.test_phone_number.trim().replace(/[\s().-]/g,''):'';
    if(!/^\+[1-9]\d{7,14}$/.test(phone))fail('invalid_phone');
    await onboardingQuery(supabase.rpc('arm_onboarding_test',{p_company_id:companyId,p_phone:phone}));
    return state(companyId);
  }
  return {state,save,activate,armTest};
}
export function onboardingRoute(handler,{write=false}={}) {
  return async(req,res)=>{
    res.set('Cache-Control','no-store');
    try {
      const companyId=companyScope(req.user,req.method==='GET'?req.query.company_id:req.body?.company_id);
      if(write)manager(req.user);
      await handler(req,res,companyId);
    } catch(error) {
      if(res.headersSent)return;
      if(error.retryAfter)res.set('Retry-After',String(error.retryAfter));
      res.status(error.status||503).json({error:error.code||'onboarding_unavailable',retry_after_seconds:error.retryAfter||0});
    }
  };
}
