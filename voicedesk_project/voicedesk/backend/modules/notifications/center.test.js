import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import express from 'express';
import {createClient} from '@supabase/supabase-js';
import {createNotificationService,preferencePatch,boundedInteger} from './service.js';
import {createNotificationRouter} from './index.js';
import {recordMissedInbound} from './missedCall.js';
import {runNotificationMaintenance} from './maintenance.js';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',U='33333333-3333-4333-8333-333333333333',N='44444444-4444-4444-8444-444444444444';
const user={id:U,role:'company_admin',company_id:A,email:'verified@example.com'},scope={userId:U,companyId:A};
function db(handler){
  const requests=[];
  const supabase=createClient('https://unit-test.supabase.co','fake-service-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(url,options)=>{
    const req={url:new URL(url),...options,body:options.body?JSON.parse(options.body):null};requests.push(req);
    const result=await handler(req);
    return new Response(req.method==='HEAD'?null:JSON.stringify(result?.data===undefined?result:result.data),
      {status:result?.status||200,headers:{'Content-Type':'application/json',...(result?.count!==undefined?{'Content-Range':'0-0/'+result.count}:{})}});
  }}});return {supabase,requests};
}
async function endpoint(t,service,actor=user){
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.user=actor;next();});app.use(createNotificationRouter(service));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return (path,options={})=>fetch('http://127.0.0.1:'+server.address().port+path,{...options,headers:{'Content-Type':'application/json',...options.headers},...(options.body?{body:JSON.stringify(options.body)}:{})});
}
test('pagination and preference patches reject injection and arbitrary fields',()=>{
  for(const value of ['-1','NaN','1.5',['2'],'999999'])assert.throws(()=>boundedInteger(value,20,100));
  assert.equal(boundedInteger(undefined,20,100),20);
  for(const body of [{ticket_email:'true'},{user_id:U},{company_id:B},{},null])assert.throws(()=>preferencePatch(body));
  assert.deepEqual(preferencePatch({ticket_email:false}),{ticket_email:false});
});
test('all inbox queries are bound to both authenticated recipient and company',async()=>{
  const database=db(req=>req.method==='HEAD'?{count:2,data:null}:{count:1,data:[{id:N}]});
  const service=createNotificationService({...database,now:()=>new Date('2026-09-13T12:00:00Z')});
  const data=await service.list(scope,{limit:25,offset:0,unreadOnly:true});
  assert.equal(data.unread_count,2);assert.equal(data.as_of,'2026-09-13T12:00:00.000Z');
  for(const req of database.requests){assert.equal(req.url.searchParams.get('user_id'),'eq.'+U);assert.equal(req.url.searchParams.get('company_id'),'eq.'+A);}
  assert.match(database.requests[0].url.searchParams.get('order'),/created_at.desc,id.desc/);
  assert.equal(database.requests[0].url.searchParams.get('read_at'),'is.null');
});
test('foreign notification IDs reveal neither existence nor content',async()=>{
  const database=db(()=>null),service=createNotificationService(database);
  await assert.rejects(service.markOne(scope,N),{status:404});
  await assert.rejects(service.remove(scope,N),{status:404});
  assert.equal(database.requests.filter(r=>r.method==='PATCH').length,1);
  assert.equal(database.requests.at(-1).body.body,null);
  assert.equal(database.requests.at(-1).body.event_key,undefined);
  for(const req of database.requests)assert.equal(req.url.searchParams.get('user_id'),'eq.'+U);
});
test('mark-one confirms storage before reporting success, and preserves original read timestamp',async()=>{
  const database=db(req=>req.method==='GET'?{id:N,read:false,read_at:null}:null);
  await createNotificationService(database).markOne(scope,N);
  const patch=database.requests[1];assert.equal(patch.body.read,true);assert.ok(patch.body.read_at);
  assert.equal(patch.url.searchParams.get('company_id'),'eq.'+A);assert.equal(patch.url.searchParams.get('read_at'),'is.null');
  const already=db(()=>({id:N,read:true,read_at:'2026-01-01'}));
  await createNotificationService(already).markOne(scope,N);assert.equal(already.requests.length,1);
  const failure=db(req=>req.method==='GET'?{id:N,read:false}: {status:400,data:{code:'42501',message:'secret'}});
  await assert.rejects(createNotificationService(failure).markOne(scope,N),{code:'notifications_unavailable'});
});
test('mark-all uses the server snapshot cutoff, leaving later arrivals unread',async()=>{
  const database=db(()=>null),service=createNotificationService({...database,now:()=>new Date('2026-09-13T12:00:01Z')});
  await service.markAll(scope,'2026-09-13T12:00:00Z');
  assert.equal(database.requests[0].url.searchParams.get('created_at'),'lte.2026-09-13T12:00:00.000Z');
  assert.equal(database.requests[0].url.searchParams.get('user_id'),'eq.'+U);
  for(const invalid of ['2099-01-01','no',null,{}])await assert.rejects(service.markAll(scope,invalid),{code:'invalid_cutoff'});
});
test('database outages never appear as an empty inbox or zero unread count',async()=>{
  const service=createNotificationService(db(()=>({status:500,data:{message:'private SQL'}})));
  await assert.rejects(service.count(scope),{status:503,code:'notifications_unavailable'});
  await assert.rejects(service.list(scope,{limit:10,offset:0}),{status:503});
});
test('retention is bounded and retryable; expired content is filtered even before maintenance runs',async()=>{
  let batches=0;const database=db(()=>++batches===1?500:7);
  assert.deepEqual(await runNotificationMaintenance(database),{scrubbed:507,backlog:false});
  assert.deepEqual(await runNotificationMaintenance({...db(()=>500),maxBatches:2}),{scrubbed:1000,backlog:true});
  await assert.rejects(runNotificationMaintenance(db(()=>({status:500,data:{error:'down'}}))),/unavailable/);
  const reads=db(()=>[]);await createNotificationService(reads).list(scope,{limit:10,offset:0});
  for(const req of reads.requests){assert.equal(req.url.searchParams.get('dismissed_at'),'is.null');assert.match(req.url.searchParams.get('or'),/payload_expires_at.gt/);}
});
test('cross-tenant selection and client impersonation are denied before all personal actions',async t=>{
  let calls=0;const service=new Proxy({},{get:()=>async()=>{calls++;throw new Error('unexpected');}});
  const request=await endpoint(t,service);
  assert.equal((await request('/?company_id='+B)).status,403);
  assert.equal((await request('/mark-all-read',{method:'POST',body:{company_id:B}})).status,403);
  for(const path of ['/','/unread-count','/preferences'])assert.equal((await request(path,{headers:{'X-Impersonation-Session':N}})).status,403);
  assert.equal((await request('/send-test',{method:'POST',headers:{'X-Impersonation-Session':N}})).status,403);
  assert.equal(calls,0);
});
test('super-admin reads only their own recipient inbox, not every user',async t=>{
  let actual;
  const request=await endpoint(t,{list:async selected=>{actual=selected;return {notifications:[]};}},{...user,role:'super_admin'});
  assert.equal((await request('/?limit=10')).status,200);assert.deepEqual(actual,{userId:U,companyId:null});
});
test('partial preference changes do not reset other categories or change owner',async()=>{
  const database=db(req=>req.method==='GET'?{ticket_email:false,billing_email:false}:null);
  const result=await createNotificationService(database).savePreferences(U,{ticket_email:false});
  assert.equal(result.preferences.billing_email,false);
  assert.deepEqual(database.requests[0].body,{user_id:U});
  assert.equal(database.requests[1].body.billing_email,undefined);assert.equal(database.requests[1].url.searchParams.get('user_id'),'eq.'+U);
});
test('transactional email test uses verified identity, no body-selected recipient, and checks delivery result',async t=>{
  let actual;
  const request=await endpoint(t,{sendTest:async actor=>{actual=actor;return {success:true};}});
  assert.equal((await request('/send-test',{method:'POST',body:{email:'evil@example.com'}})).status,200);
  assert.equal(actual.email,'verified@example.com');
  const service=createNotificationService({...db(()=>null),emailFrom:'Verified <verified@example.com>',resend:{emails:{send:async()=>({error:{message:'secret'}})}}});
  await assert.rejects(service.sendTest(user),{code:'email_delivery_unconfirmed',status:502});
});
test('mail test is rate-limited per authenticated user',async t=>{
  let sends=0;const request=await endpoint(t,{sendTest:async()=>{sends++;return {success:true};}});
  for(let i=0;i<3;i++)assert.equal((await request('/send-test',{method:'POST'})).status,200);
  assert.equal((await request('/send-test',{method:'POST'})).status,429);assert.equal(sends,3);
});
test('signed missed callback routing never accepts body company IDs, outbound status or fake SID',async()=>{
  const database=db(()=>true),body={Direction:'inbound',CallStatus:'no-answer',CallSid:'CA'+'a'.repeat(32),To:'+15145550123',From:'+15145550999',company_id:B};
  assert.equal(await recordMissedInbound({...database,body}),true);
  assert.equal(database.requests[0].body.p_company_id,undefined);assert.equal(database.requests[0].body.p_to,body.To);
  assert.equal(await recordMissedInbound({...database,body:{...body,Direction:'outbound-api'}}),false);
  await assert.rejects(recordMissedInbound({...database,body:{...body,CallSid:'fake'}}),{status:400});
  await assert.rejects(recordMissedInbound({...db(()=>({status:400,data:{code:'42883'}})),body}),{status:503});
});
test('critical events are transactional, deduplicated, service-only and exclude internal notes',()=>{
  const sql=readFileSync(new URL('../../../migrations/020_notification_center.sql',import.meta.url),'utf8');
  for(const event of ['ticket_created','ticket_reply','provisioning_completed','provisioning_failed','payment_failed','quota_reached','important_missed_call'])assert.ok(sql.includes(event),event);
  assert.match(sql,/BEGIN;[\s\S]*COMMIT;/);assert.match(sql,/ON CONFLICT \(user_id,event_key\)/);
  assert.match(sql,/IF NEW.is_internal IS TRUE THEN RETURN NEW/);assert.match(sql,/p.company_id=p_company/);
  assert.match(sql,/NEW.author_role='exevori_agent' THEN 'tenant' ELSE 'admins'/);
  assert.match(sql,/pg_advisory_xact_lock/);assert.match(sql,/FROM PUBLIC,anon,authenticated/);
  assert.doesNotMatch(sql,/SECURITY DEFINER|UPDATE public\.subscriptions|UPDATE public\.profiles|UPDATE public\.companies/i);
  assert.match(sql,/status IN \('completed','transferred'\)/);assert.match(sql,/phone_number=p_to AND status='active'/);
  assert.equal((sql.match(/\$\$/g)||[]).length%2,0);
});
test('Twilio signature protection still precedes the callback and Stripe DB errors remain retryable',()=>{
  const main=readFileSync(new URL('../../index.js',import.meta.url),'utf8');
  assert.ok(main.indexOf('validateTwilioSignature\n')<main.indexOf('app.use("/webhooks", webhooksRouter)'));
  const webhook=readFileSync(new URL('../../webhooks/index.js',import.meta.url),'utf8');assert.match(webhook,/recordMissedInbound/);
  const billing=readFileSync(new URL('../billing/index.js',import.meta.url),'utf8');
  assert.match(billing,/if \(updateError\) throw new Error\("payment_failure_persistence_unavailable"\)/);
});
