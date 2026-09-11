import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import express from 'express';
import {createClient} from '@supabase/supabase-js';
import {companyScope,verifiedSessionId,requireLiveSession,syncVerifiedProfileEmail} from './security.js';
import {createAssistantSettingsService} from '../config/settingsService.js';
import {assistantIdentity} from '../config/identity.js';
import {createAccountService,validateCompanySettings,validateProfile,transactionalSender} from './service.js';
import {createAccountRouter} from './index.js';
import {createTeamRouter} from '../team/index.js';
import {createInviteAcceptance} from '../auth/inviteAcceptance.js';
import {createRecordingRouter} from '../calls/recording.js';
import {validateConfigPatch} from '../config/validation.js';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const U='33333333-3333-4333-8333-333333333333',S='44444444-4444-4444-8444-444444444444',T='55555555-5555-4555-8555-555555555555';
const user={id:U,role:'company_admin',company_id:A,session_id:S,email:'verified@example.com',profile:{full_name:'Test'}};
test('only confirmed Auth email is synchronized to the exact profile identity',async()=>{
  const database=db(req=>({email:req.body.email}));
  const profile={email:'old@example.com'};
  assert.equal(await syncVerifiedProfileEmail(database.supabase,{id:U,email:'new@example.com'},profile),profile);
  assert.equal(database.requests.length,0);
  const result=await syncVerifiedProfileEmail(database.supabase,{id:U,email:'new@example.com',email_confirmed_at:'2026-09-01'},profile);
  assert.equal(result.email,'new@example.com');
  assert.equal(database.requests[0].url.searchParams.get('user_id'),'eq.'+U);
});
test('assistant settings are durably saved and the existing agent voice is verified after PATCH',async()=>{
  let stored,providerState={agent_id:'agent_test',conversation_config:{}};
  const database=db(req=>{
    if(req.url.pathname.includes('/rpc/')){
      stored={company_id:A,settings_sync_token:req.body.p_token,settings_sync_status:'in_progress',
        assistant_name:'Camille',voice_id:'voice_test',greeting_inbound_fr:'Bonjour',elevenlabs_agent_id:'agent_test'};
      return stored;
    }
    return {...stored,...req.body};
  });
  const providerRequests=[];
  const service=createAssistantSettingsService({...database,apiKey:'test',fetchImpl:async(url,options)=>{
    providerRequests.push({url,...options});
    if(options.method==='PATCH')providerState={agent_id:'agent_test',...JSON.parse(options.body)};
    return new Response(JSON.stringify(providerState),{headers:{'Content-Type':'application/json'}});
  }});
  const result=await service.save(A,{voice_id:'voice_test'});
  assert.equal(result.sync_status,'synced');assert.equal(providerRequests.length,3);
  const patch=JSON.parse(providerRequests[1].body);
  assert.equal(patch.conversation_config.tts.voice_id,'voice_test');
  assert.equal(patch.conversation_config.agent.disable_first_message_interruptions,true);
  assert.equal(patch.conversation_config.agent.tools,undefined);assert.equal(patch.conversation_config.agent.prompt,undefined);
  assert.equal(database.requests.at(-1).url.searchParams.get('settings_sync_token'),'eq.'+stored.settings_sync_token);
});
test('unprovisioned assistant settings never call a provider',async()=>{
  const database=db(req=>({company_id:A,settings_sync_token:req.body.p_token,settings_sync_status:'not_provisioned'}));
  const service=createAssistantSettingsService({...database,fetchImpl:async()=>{throw new Error('not called');}});
  assert.equal((await service.save(A,{tone:'warm'})).sync_status,'not_provisioned');
  assert.equal(database.requests.length,1);
});
test('unknown provider outcome remains visible and never reports a synchronized agent',async()=>{
  let stored;
  const database=db(req=>{
    if(req.url.pathname.includes('/rpc/')){
      stored={company_id:A,settings_sync_token:req.body.p_token,settings_sync_status:'in_progress',elevenlabs_agent_id:'agent_test'};
      return stored;
    }
    return {...stored,...req.body};
  });
  const service=createAssistantSettingsService({...database,apiKey:'test',fetchImpl:async()=>{throw new Error('secret details');}});
  const result=await service.save(A,{tone:'warm'});
  assert.equal(result.sync_status,'failed');assert.equal(result.config.settings_sync_error,'assistant_sync_not_confirmed');
  assert.ok(!JSON.stringify(result).includes('secret'));
});
test('assistant synchronization refuses to modify the master agent',async()=>{
  let stored,calls=0;
  const database=db(req=>{
    if(req.url.pathname.includes('/rpc/')){
      stored={company_id:A,settings_sync_token:req.body.p_token,settings_sync_status:'in_progress',elevenlabs_agent_id:'master'};
      return stored;
    }
    return {...stored,...req.body};
  });
  const service=createAssistantSettingsService({...database,apiKey:'test',masterAgentId:'master',fetchImpl:async()=>{calls++;}});
  assert.equal((await service.save(A,{tone:'warm'})).sync_status,'failed');
  assert.equal(calls,0);
});
test('name and tone are applied in the live Custom LLM without relaxing consent',()=>{
  assert.match(assistantIdentity({assistant_name:'Camille',tone:'warm'}),/Camille/);
  assert.match(assistantIdentity({tone:'warm'}),/chaleureux/);
  assert.match(assistantIdentity({}),/consentement/);
  const source=readFileSync(new URL('../elevenlabs/index.js',import.meta.url),'utf8');
  assert.match(source,/assistantIdentity\(cfg/);assert.match(source,/minSimilarity: cfg\?\.rag_min_similarity/);
});
function db(handler){
  const requests=[];
  const supabase=createClient('https://unit-test.supabase.co','test-service-key',{auth:{persistSession:false,autoRefreshToken:false},
    global:{fetch:async(url,options)=>{
      const req={url:new URL(url),...options,body:options.body?JSON.parse(options.body):null};requests.push(req);
      const result=await handler(req);
      return new Response(JSON.stringify(result?.data===undefined?result:result.data),{status:Number.isInteger(result?.status)?result.status:200,headers:{'Content-Type':'application/json'}});
    }}});
  return {supabase,requests};
}
async function endpoint(t,router,actor=user){
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.user=actor;next();});app.use(router);
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return (path,options={})=>fetch('http://127.0.0.1:'+server.address().port+path,{...options,headers:{'Content-Type':'application/json',...options.headers},...(options.body?{body:JSON.stringify(options.body)}:{})});
}
test('company selection cannot be forged, including arrays and unknown identifiers',()=>{
  assert.equal(companyScope(user,A),A);assert.equal(companyScope(user),A);
  assert.throws(()=>companyScope(user,B),{status:403});
  assert.throws(()=>companyScope(user,[A]),{status:403});
  assert.throws(()=>companyScope({...user,role:'super_admin'},'invalid'),{status:400});
});
test('session ID parser only accepts the already verified actor and a UUID session',()=>{
  const token='header.'+Buffer.from(JSON.stringify({sub:U,session_id:S})).toString('base64url')+'.signature';
  assert.equal(verifiedSessionId(token,U),S);
  for(const value of ['x','h.'+Buffer.from(JSON.stringify({sub:U,session_id:'bad'})).toString('base64url')+'.s','h.'+Buffer.from(JSON.stringify({sub:B,session_id:S})).toString('base64url')+'.s']){
    assert.throws(()=>verifiedSessionId(value,U),{status:401});
  }
});
test('a valid JWT is rejected immediately after its Auth session disappears',async()=>{
  const token='h.'+Buffer.from(JSON.stringify({sub:U,session_id:S})).toString('base64url')+'.s';
  const live=db(()=>true);assert.equal(await requireLiveSession(live.supabase,token,U),S);
  assert.deepEqual(live.requests[0].body,{p_user_id:U,p_session_id:S});
  assert.ok(live.requests[0].signal instanceof AbortSignal);
  await assert.rejects(requireLiveSession(db(()=>false).supabase,token,U),{status:401,code:'session_revoked'});
  await assert.rejects(requireLiveSession(db(()=>({status:400,data:{code:'42883',message:'private SQL'}})).supabase,token,U),{status:503,code:'session_check_unavailable'});
});
test('company preference validation denies owner injection, invalid durations and mail headers',()=>{
  for(const body of [{owner_user_id:U},{retention_days:0},{retention_days:1.5},{transcript_retention_days:3651},
    {recordings_visible:'false'},{transactional_name:'Test\r\nBcc: evil'},{transactional_reply_to:'x@y.fr\nBcc:x@y.fr'}]){
    assert.throws(()=>validateCompanySettings(body),e=>e.status===400);
  }
  assert.equal(validateCompanySettings({retention_days:30}).retention_days,30);
});
test('profile accepts only a bounded name and raster JPEG; never email, role or external URLs',()=>{
  assert.equal(validateProfile({full_name:' Test ',avatar_data:null}).full_name,'Test');
  for(const body of [{full_name:'Test',role:'super_admin'},{full_name:'Test',email:'evil@example.com'},
    {full_name:''},{full_name:'Test',avatar_data:'https://tracker.example/face'},
    {full_name:'Test',avatar_data:'data:image/svg+xml;base64,PHN2Zz4='}]){
    assert.throws(()=>validateProfile(body),e=>e.status===400);
  }
});
test('profile mutation is filtered by authenticated user and never writes unconfirmed email',async()=>{
  const database=db(req=>req.url.pathname.endsWith('/profiles')?{full_name:'New'}:null);
  const result=await createAccountService(database).saveProfile(user,{full_name:'New',avatar_data:null});
  assert.equal(result.email,'verified@example.com');
  const patch=database.requests.find(r=>r.url.pathname.endsWith('/profiles'));
  assert.equal(patch.url.searchParams.get('user_id'),'eq.'+U);
  assert.deepEqual(patch.body,{full_name:'New'});
});
test('saving company preferences never overwrites owner on an upsert or conflict',async()=>{
  const database=db(req=>req.method==='GET'?{owner_user_id:U,retention_days:30}:null);
  const result=await createAccountService(database).saveSettings(A,{retention_days:30});
  assert.equal(result.owner_user_id,U);
  const insert=database.requests.find(r=>r.method==='POST'),patch=database.requests.find(r=>r.method==='PATCH');
  assert.deepEqual(insert.body,{company_id:A});
  assert.match(new Headers(insert.headers).get('prefer'),/ignore-duplicates/);
  assert.equal(patch.url.searchParams.get('company_id'),'eq.'+A);
  assert.equal(patch.body.owner_user_id,undefined);
});
test('transactional customization retains the verified sender address',async()=>{
  const database=db(()=>({transactional_name:'Garage',transactional_reply_to:'reply@example.com'}));
  assert.deepEqual(await transactionalSender(database.supabase,A,'Exevori <verified@exevori.com>'),
    {from:'Garage <verified@exevori.com>',replyTo:'reply@example.com'});
  assert.equal(database.requests[0].url.searchParams.get('company_id'),'eq.'+A);
});
test('company settings reject cross-tenant requests and member mutations before any query',async t=>{
  const database=db(()=>{throw new Error('Must not query');});
  const request=await endpoint(t,createAccountRouter(createAccountService(database)),{...user,role:'company_user'});
  assert.equal((await request('/company-settings?company_id='+B)).status,403);
  assert.equal((await request('/company-settings',{method:'PATCH',body:{company_id:A,retention_days:30}})).status,403);
  assert.equal(database.requests.length,0);
});
test('personal profile and session endpoints cannot run in client impersonation',async t=>{
  const database=db(()=>{throw new Error('Must not query');});
  const request=await endpoint(t,createAccountRouter(createAccountService(database)));
  for(const path of ['/profile','/sessions'])assert.equal((await request(path,{headers:{'X-Impersonation-Session':S}})).status,403);
  assert.equal(database.requests.length,0);
});
test('team invitation/mutation are manager-only and reject legacy invalid roles',async t=>{
  const database=db(()=>{throw new Error('Must not query');});
  const request=await endpoint(t,createTeamRouter(database),{...user,role:'company_user'});
  assert.equal((await request('/invitations',{method:'POST',body:{company_id:A,email:'a@example.com'}})).status,403);
  assert.equal((await request('/members/'+T,{method:'PATCH',body:{company_id:A,status:'inactive'}})).status,403);
  const admin=await endpoint(t,createTeamRouter(database));
  assert.equal((await admin('/members/'+T,{method:'PATCH',body:{company_id:A,role:'company_member'}})).status,400);
  assert.equal((await admin('/members/'+T,{method:'PATCH',body:{company_id:B,status:'inactive'}})).status,403);
});
test('team mutation sends only canonical changes to the serialized server RPC',async t=>{
  const database=db(()=>({success:true}));
  const request=await endpoint(t,createTeamRouter(database));
  assert.equal((await request('/members/'+T,{method:'PATCH',body:{company_id:A,status:'inactive'}})).status,200);
  assert.deepEqual(database.requests[0].body,{p_company_id:A,p_actor_id:U,p_target_id:T,p_role:null,p_status:'inactive',p_transfer_owner:false});
});
test('owner transfer is disabled during impersonation even for the actual super-admin actor',async t=>{
  const database=db(()=>{throw new Error('Must not query');});
  const request=await endpoint(t,createTeamRouter(database));
  assert.equal((await request('/owner',{method:'POST',headers:{'X-Impersonation-Session':S},body:{company_id:A,user_id:T,confirm_company_id:A}})).status,403);
});
test('invitations never disclose capability tokens, and cancel unconfirmed delivery',async t=>{
  const database=db(req=>{
    if(req.url.pathname.endsWith('/profiles'))return null;
    if(req.url.pathname.endsWith('/companies'))return {name:'<script>unsafe</script>'};
    if(req.url.pathname.endsWith('/company_settings'))return null;
    if(req.method==='POST')return {id:T,email:'a@example.com',status:'pending'};
    return [];
  });
  const messages=[];
  const request=await endpoint(t,createTeamRouter({...database,emailFrom:'Verified <verified@example.com>',frontendUrl:'https://app.example.com',
    resend:{emails:{send:async message=>{messages.push(message);return {error:{message:'secret upstream'}};}}}}));
  const response=await request('/invitations',{method:'POST',body:{company_id:A,email:'a@example.com'}});
  assert.equal(response.status,502);
  const result=await response.json();assert.equal(result.error,'invitation_delivery_failed');
  assert.ok(!JSON.stringify(result).includes('secret'));assert.ok(!JSON.stringify(result).includes('invite_url'));
  assert.ok(messages[0].html.includes('&lt;script&gt;'));
  const cancel=database.requests.find(r=>r.method==='PATCH');
  assert.equal(cancel.url.searchParams.get('company_id'),'eq.'+A);
  assert.equal(cancel.url.searchParams.get('status'),'eq.pending');
});
test('invitation acceptance rejects expired and unsupported roles before creating an Auth user',async()=>{
  for(const row of [{status:'pending',expires_at:'2020-01-01',role:'company_user'},
    {status:'pending',expires_at:'2099-01-01',role:'company_member'}]){
    const database=db(()=>row);let creates=0;
    database.supabase.auth.admin.createUser=async()=>{creates++;throw new Error('not called');};
    await assert.rejects(createInviteAcceptance(database)({token:'t'.repeat(32),password:'password-test-123',full_name:'Name'}),{status:400});
    assert.equal(creates,0);
  }
});
test('acceptance uses the atomic RPC, canonical invited role and never activates a company',async()=>{
  const database=db(req=>req.url.pathname.includes('/rpc/')?{success:true,user_id:U,company_id:A}:
    {id:T,email:'a@example.com',company_id:A,status:'pending',expires_at:'2099-01-01',role:'company_user'});
  database.supabase.auth.admin.createUser=async()=>({data:{user:{id:U}},error:null});
  await createInviteAcceptance(database)({token:'t'.repeat(32),password:'password-test-123',full_name:'Name'});
  assert.equal(database.requests.length,2);
  assert.equal(database.requests[1].url.pathname,'/rest/v1/rpc/accept_team_invitation');
  assert.equal(database.requests.some(r=>r.url.pathname.endsWith('/companies')),false);
});
test('unknown invitation commit outcome never triggers destructive Auth compensation',async()=>{
  const database=db(req=>req.url.pathname.includes('/rpc/')?{status:400,data:{code:'unknown',message:'timeout'}}:
    {id:T,email:'a@example.com',company_id:A,status:'pending',expires_at:'2099-01-01',role:'company_user'});
  let deletes=0;
  database.supabase.auth.admin.createUser=async()=>({data:{user:{id:U}},error:null});
  database.supabase.auth.admin.deleteUser=async()=>{deletes++;return {};};
  await assert.rejects(createInviteAcceptance(database)({token:'t'.repeat(32),password:'password-test-123',full_name:'Name'}),{code:'invitation_reconciliation_required'});
  assert.equal(deletes,0);
});
test('recording visibility, acknowledgement and privacy deletion block provider download',async t=>{
  for(const state of ['hidden','unacknowledged','deleted']){
    const database=db(req=>req.url.pathname.endsWith('/calls')?{id:T,company_id:A,elevenlabs_conversation_id:'conv_test',created_at:new Date().toISOString(),retention_days:90}:
      req.url.pathname.endsWith('/company_settings')?{recordings_visible:state!=='hidden'}:state==='deleted'?[{id:S}]:[]);
    let providerCalls=0;
    const request=await endpoint(t,createRecordingRouter({...database,apiKey:'test-key',fetchImpl:async()=>{providerCalls++;throw new Error('not called');}}));
    const response=await request('/'+T+'/recording'+(state==='unacknowledged'?'':'?acknowledge=true'));
    assert.equal(response.status,state==='unacknowledged'?400:403);
    assert.equal(providerCalls,0);
  }
});
test('assistant whitelist blocks provider IDs and preserves mandatory consent',()=>{
  assert.throws(()=>validateConfigPatch({elevenlabs_agent_id:'bad'}),{status:400});
  assert.throws(()=>validateConfigPatch({rag_min_similarity:1.1}),{status:400});
  const patch=validateConfigPatch({greeting_inbound_fr:'Bonjour',rag_min_similarity:0.5});
  assert.equal(patch.rag_min_similarity,0.5);assert.notEqual(patch.greeting_inbound_fr,'Bonjour');
});
test('migration is transactional, protects ownership and uses read-only Auth session bridges',()=>{
  const sql=readFileSync(new URL('../../../migrations/018_account_settings.sql',import.meta.url),'utf8');
  assert.match(sql,/BEGIN;[\s\S]*COMMIT;/);
  for(const table of ['company_settings','account_preferences'])assert.match(sql,new RegExp('ALTER TABLE public\\.'+table+' ENABLE ROW LEVEL SECURITY'));
  assert.match(sql,/FROM PUBLIC, anon, authenticated/);assert.match(sql,/TO service_role/);
  assert.match(sql,/pg_advisory_xact_lock/);assert.match(sql,/last_admin/);assert.match(sql,/owner_required/);
  assert.ok(!/\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+auth\./i.test(sql));
  assert.ok(!/UPDATE\s+public\.companies/i.test(sql));
  assert.match(sql,/FOR UPDATE/);assert.match(sql,/invitation\.expires_at <= now\(\)/);
  assert.match(sql,/BEFORE INSERT ON public\.calls/);
  assert.equal((sql.match(/\$\$/g)||[]).length%2,0);
});
