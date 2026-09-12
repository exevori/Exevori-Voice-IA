import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import express from 'express';
import {createClient} from '@supabase/supabase-js';
import {createOnboardingService,stateView,validateFaq} from './service.js';
import {createOnboardingRouter} from './index.js';
import {onboardingCallProof,confirmOnboardingCall} from './callProof.js';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333';
const actor={id:C,role:'company_admin',company_id:A};
const cfg={assistant_name:'Léa',tone:'warm',voice_id:'voice1',twilio_number:'+15145550123',elevenlabs_agent_id:'agent_test'};
const numbers=[{phone_number:cfg.twilio_number,elevenlabs_agent_id:cfg.elevenlabs_agent_id,status:'active'}];
function db(handler){
  const requests=[];
  const supabase=createClient('https://test.supabase.co','fake-local-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(url,options)=>{
    const req={url:new URL(url),...options,body:options.body?JSON.parse(options.body):null};requests.push(req);
    const result=await handler(req);
    return new Response(JSON.stringify(result?.data===undefined?result:result.data),{status:result?.status||200,headers:{'Content-Type':'application/json'}});
  }}});
  return {supabase,requests};
}
function readRows(req,progress={}){
  if(req.url.pathname.endsWith('/prepare_onboarding_activation'))return cfg;
  if(req.url.pathname.endsWith('/onboarding_progress'))return progress;
  if(req.url.pathname.endsWith('/assistant_configs'))return cfg;
  if(req.url.pathname.endsWith('/phone_numbers'))return numbers;
  if(req.url.pathname.endsWith('/companies'))return {name:'Entreprise test'};
  return true;
}
async function endpoint(t,service,user=actor){
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.user=user;next();});app.use(createOnboardingRouter(service));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return (path,body)=>fetch('http://127.0.0.1:'+server.address().port+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
}
test('resume trusts saved steps, never legacy completed_at alone',()=>{
  assert.equal(stateView().progress.current_step,1);
  assert.equal(stateView({completed_steps:[1]}).progress.current_step,2);
  assert.equal(stateView({completed_steps:[1,2]}).progress.current_step,3);
  assert.equal(stateView({completed_steps:[1,2,3]}).progress.current_step,4);
  const view=stateView({completed_at:'2020-01-01',provisioning_status:'done'},cfg,numbers);
  assert.equal(view.progress.current_step,5);assert.equal(view.progress.completed_at,null);assert.equal(view.test.verified_at,null);
});
test('done without consistent active phone/agent is not ready; no identifiers or internal logs leak',()=>{
  for(const list of [[],[{...numbers[0],status:'released'}],[{...numbers[0],elevenlabs_agent_id:'other'}]]){
    const view=stateView({provisioning_status:'done',provisioning_error:'private'},cfg,list);
    assert.equal(view.ready,false);assert.equal(view.progress.current_step,4);assert.equal(view.error,'provisioning_inconsistent');
    assert.equal(view.phone_number,null);assert.ok(!JSON.stringify(view).includes('agent_test'));assert.ok(!JSON.stringify(view).includes('private'));
  }
});
test('lease heartbeat controls retry independently of the three-minute frontend deadline',()=>{
  const now=Date.now();
  assert.equal(stateView({provisioning_status:'in_progress',provisioning_started_at:new Date(now-180000).toISOString()},cfg,[],now).retry_after_seconds,120);
  assert.equal(stateView({provisioning_status:'in_progress',provisioning_started_at:new Date(now-300001).toISOString()},cfg,[],now).can_retry,true);
});
test('test state resumes its phone/window and only server verification marks completion',()=>{
  const waiting=stateView({test_phone:'+15145550999',test_started_at:'2026-01-01',test_expires_at:'2099-01-01'});
  assert.equal(waiting.test.status,'waiting');assert.equal(waiting.test.phone,'+15145550999');
  assert.equal(stateView({test_started_at:'2020-01-01',test_expires_at:'2020-01-02'}).test.status,'expired');
  assert.equal(stateView({test_verified_at:'2026-01-01',test_call_id:C}).test.call_id,C);
});
test('FAQ validation rejects truncation, missing answers, oversized and duplicate questions',()=>{
  for(const entries of [null,{},Array(21).fill({}),[{question:'q'}],[{question:'x'.repeat(501),answer:'a'}],
    [{question:'q',answer:'a'},{question:' q ',answer:'b'}]])assert.throws(()=>validateFaq(entries));
  assert.deepEqual(validateFaq([{question:' q ',answer:' a ',company_id:B}]),[{question:'q',answer:'a',category:'FAQ'}]);
});
test('state performs only tenant-filtered reads, and query failures are not an idle state',async()=>{
  const database=db(req=>readRows(req,{completed_steps:[1,2]}));
  const result=await createOnboardingService(database).state(A);
  assert.equal(result.progress.current_step,4); // existing agent requires activation reconciliation
  assert.equal(database.requests.length,3);
  for(const req of database.requests){assert.equal(req.method,'GET');assert.equal(req.url.searchParams.get('company_id'),'eq.'+A);}
  await assert.rejects(createOnboardingService(db(()=>({status:400,data:{code:'42703',message:'SQL secret'}}))).state(A),{code:'onboarding_unavailable'});
});
test('all onboarding reads and mutations reject another tenant before accessing service',async t=>{
  let accesses=0;const service=new Proxy({},{get:()=>async()=>{accesses++;throw new Error('unexpected');}});
  const request=await endpoint(t,service);
  for(const path of ['/','/provisioning-status'])assert.equal((await request(path+'?company_id='+B)).status,403);
  for(const path of ['/step/1','/step/2','/step/3','/step/4','/step/5','/test-call','/skip'])
    assert.equal((await request(path,{company_id:B})).status,403);
  assert.equal(accesses,0);
});
test('ordinary members cannot provision, configure or arm a test',async t=>{
  const request=await endpoint(t,{}, {...actor,role:'company_user'});
  for(const path of ['/step/1','/step/2','/step/3','/step/4','/step/5','/test-call','/skip'])
    assert.equal((await request(path,{company_id:A})).status,403);
});
test('legacy skip and forged call IDs cannot finish onboarding',async t=>{
  let reads=0;
  const request=await endpoint(t,{state:async()=>{reads++;return {test:{verified_at:null}};}});
  assert.equal((await request('/skip',{company_id:A,step:5})).status,409);
  assert.equal((await request('/step/4',{company_id:A,call_id:C,twilio_number:'+15145550123'})).status,409);
  assert.equal(reads,1);
});
test('super-admin may explicitly select a tenant, still without bypassing proof',async t=>{
  let selected;
  const request=await endpoint(t,{state:async id=>{selected=id;return {test:{verified_at:'2026-01-01'}};}},{...actor,role:'super_admin'});
  assert.equal((await request('/step/4',{company_id:B})).status,200);assert.equal(selected,B);
});
test('first step saves consent-prefixed greeting and only whitelisted settings atomically',async()=>{
  const database=db(req=>readRows(req));
  await createOnboardingService(database).save(A,1,{assistant_name:'Camille',tone:'warm',elevenlabs_agent_id:'injected'},actor);
  const rpc=database.requests.find(r=>r.url.pathname.includes('/rpc/'));
  assert.equal(rpc.body.p_company_id,A);assert.equal(rpc.body.p_data.elevenlabs_agent_id,undefined);
  assert.match(rpc.body.p_data.greeting_inbound_fr,/intelligence artificielle/);
  assert.equal(database.requests.some(r=>r.method==='PATCH'),false);
});
test('FAQ persists before indexing and cannot advance when one embedding fails',async()=>{
  const events=[],database=db(req=>{events.push(req.url.pathname.split('/').at(-1));return readRows(req);});
  const service=createOnboardingService({...database,knowledge:{createQaSource:async()=>{events.push('embedding');throw new Error('offline');}}});
  await assert.rejects(service.save(A,3,{knowledge_entries:[{question:'q',answer:'a'}]},actor));
  assert.deepEqual(events,['save_onboarding_step','embedding']);
});
test('FAQ retry uses the same RAG origin and completes only after all embeddings',async()=>{
  const events=[],sources=[],database=db(req=>{events.push(req.url.pathname.split('/').at(-1));return readRows(req);});
  const service=createOnboardingService({...database,knowledge:{createQaSource:async source=>{sources.push(source);events.push('embedding');}}});
  await service.save(A,3,{knowledge_entries:[{question:'q',answer:'a'}]},actor);
  assert.deepEqual(events.slice(0,3),['save_onboarding_step','embedding','finish_onboarding_knowledge']);
  assert.equal(sources[0].companyId,A);assert.equal(sources[0].type,'onboarding');assert.ok(sources[0].originKey);
});
test('active provisioning lease never dispatches a second purchase',async()=>{
  let purchases=0;
  const database=db(req=>readRows(req,{provisioning_status:'in_progress',provisioning_started_at:new Date().toISOString(),completed_steps:[1,2,3]}));
  await assert.rejects(createOnboardingService({...database,provision:async()=>{purchases++;}}).activate(A,{area_code:'581'}),{code:'provisioning_in_progress',status:409});
  assert.equal(purchases,0);assert.equal(database.requests.some(r=>r.method==='POST'),false);
});
test('ready activation is idempotent; missing environment never mutates data',async()=>{
  const ready=db(req=>readRows(req,{provisioning_status:'done'}));
  assert.equal((await createOnboardingService(ready).activate(A,{})).ready,true);
  const missing=db(req=>readRows(req,{completed_steps:[1,2,3]}));
  await assert.rejects(createOnboardingService({...missing,env:{}}).activate(A,{}),{code:'provisioning_not_configured'});
  assert.equal(missing.requests.some(r=>r.method==='POST'),false);
});
test('activation preparation never writes the provisioning lock and uses the existing service',async()=>{
  const database=db(req=>readRows(req,{completed_steps:[1,2,3]}));let options;
  const service=createOnboardingService({...database,env:Object.fromEntries(['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','ELEVENLABS_API_KEY','ELEVENLABS_MASTER_AGENT_ID'].map(k=>[k,'fake'])),
    provision:async args=>{options=args;return {success:true};}});
  await service.activate(A,{area_code:'418'});
  assert.deepEqual(database.requests.find(r=>r.method==='POST').body,{p_company_id:A,p_area_code:'418'});
  assert.equal(options.companyId,A);assert.equal(options.areaCode,'418');assert.equal(database.requests.some(r=>r.method==='PATCH'),false);
  assert.equal(options.voiceId,cfg.voice_id);
});
test('test arming normalizes E164 and ignores caller-supplied proof fields',async()=>{
  const database=db(req=>readRows(req));
  await createOnboardingService(database).armTest(A,{test_phone_number:'+1 (514) 555-0999',test_verified_at:'now',call_id:C});
  assert.deepEqual(database.requests[0].body,{p_company_id:A,p_phone:'+15145550999'});
});
function providerData(){return {status:'done',metadata:{start_time_unix_secs:Math.floor(Date.now()/1000)-20,call_duration_secs:15,
  phone_call:{direction:'inbound',call_sid:'CA'+'a'.repeat(32),external_number:'+15145550999',agent_number:'+15145550123'}}};}
test('proof requires actual inbound phone metadata, not text/dynamic variables or arrival timestamp',()=>{
  assert.ok(onboardingCallProof(providerData()));
  for(const mutate of [d=>d.status='failed',d=>d.metadata.phone_call.direction='outbound',d=>delete d.metadata.start_time_unix_secs,
    d=>d.metadata.start_time_unix_secs=Math.floor(Date.now()/1000)+100,d=>d.metadata.call_duration_secs=0,
    d=>d.metadata.phone_call.call_sid='fake',d=>d.metadata.phone_call.agent_number='']){
    const data=providerData();mutate(data);assert.equal(onboardingCallProof(data),null);
  }
});
test('only authenticated webhook proof reaches the server-only RPC; database failure remains retryable',async()=>{
  const database=db(()=>true),data=providerData();
  assert.equal(await confirmOnboardingCall({...database,signatureStatus:'no_secret',companyId:A,callId:C,data}),false);
  assert.equal(database.requests.length,0);
  assert.equal(await confirmOnboardingCall({...database,signatureStatus:'ok',companyId:A,callId:C,data}),true);
  assert.equal(database.requests[0].body.p_company_id,A);assert.equal(database.requests[0].body.p_call_id,C);
  await assert.rejects(confirmOnboardingCall({...db(()=>({status:400,data:{code:'42883'}})),signatureStatus:'ok',companyId:A,callId:C,data}),/unavailable/);
});
test('migration guards ordered steps, retry payload, real call and service-only execution',()=>{
  const sql=readFileSync(new URL('../../../migrations/019_onboarding_resume.sql',import.meta.url),'utf8');
  assert.match(sql,/BEGIN;[\s\S]*COMMIT;/);assert.match(sql,/FOR UPDATE/);
  for(const guard of ['previous_step_required','resume_saved_faq','setup_locked','p_started_at>=p.test_started_at','n.phone_number=p_to','c.company_id=p.company_id','j.twilio_call_sid','FROM PUBLIC,anon,authenticated','TO service_role'])assert.ok(sql.includes(guard),guard);
  assert.doesNotMatch(sql,/SECURITY DEFINER|UPDATE\s+auth\.|INSERT INTO\s+auth\./i);
  const activation=sql.slice(sql.indexOf('FUNCTION public.prepare_onboarding_activation'),sql.indexOf('FUNCTION public.guard_onboarding_config_changes'));
  assert.doesNotMatch(activation,/provisioning_status\s*=/);
  assert.match(sql,/onboarding_activation_locked/);assert.match(sql,/onboarding_config_guard BEFORE UPDATE/);
  assert.equal((sql.match(/\$\$/g)||[]).length%2,0);
});
