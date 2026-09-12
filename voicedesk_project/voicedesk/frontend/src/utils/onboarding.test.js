import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {onboardingRequest,pollOnboarding,POLL_MS,TIMEOUT_MS} from './onboarding.js';
test('requests send only current tenant and preserve readable non-JSON failures',async()=>{
  let request;
  await onboardingRequest('/step/1',{token:'test',companyId:'A',body:{company_id:'B',assistant_name:'Léa'},fetchImpl:async(url,options)=>{
    request={url,...options};return new Response('{}');
  }});
  assert.equal(JSON.parse(request.body).company_id,'A');assert.equal(request.headers.Authorization,'Bearer test');
  await assert.rejects(onboardingRequest('',{fetchImpl:async()=>new Response('bad gateway',{status:502})}),/illisible/);
});
test('polls every three seconds without automatic mutation and stops on readiness',async()=>{
  let time=0,reads=0;const delays=[],states=[];
  const result=await pollOnboarding({kind:'activation',now:()=>time,
    sleep:async ms=>{delays.push(ms);time+=ms;},onState:state=>states.push(state),
    request:async()=>({ready:++reads===3,status:'in_progress'})});
  assert.equal(result.ready,true);assert.deepEqual(delays,[3000,3000]);assert.equal(states.length,3);
});
test('three-minute deadline is visible and never auto-retries provisioning',async()=>{
  let time=0,reads=0;
  await assert.rejects(pollOnboarding({kind:'activation',now:()=>time,sleep:async ms=>{time+=ms;},onState:()=>{},
    request:async()=>{reads++;return {ready:false};}}),{code:'polling_timeout'});
  assert.equal(time,TIMEOUT_MS);assert.equal(reads,TIMEOUT_MS/POLL_MS);
});
test('failure and expired test stop polling, and verified call is the only test success',async()=>{
  for(const [kind,state,code] of [['activation',{error:'provisioning_failed'},'provisioning_failed'],['test',{test:{status:'expired'}},'test_expired']]){
    await assert.rejects(pollOnboarding({kind,request:async()=>state,onState:()=>{}}),{code});
  }
  const state={test:{verified_at:'2026-09-12'}};
  assert.equal(await pollOnboarding({kind:'test',request:async()=>state,onState:()=>{}}),state);
});
test('aborted company/session poll cannot publish stale results',async()=>{
  const controller=new AbortController();let published=0;
  await assert.rejects(pollOnboarding({kind:'activation',signal:controller.signal,
    request:async()=>{controller.abort();return {ready:true};},onState:()=>{published++;}}),{name:'AbortError'});
  assert.equal(published,0);
});
test('UI resumes state, gates real test, removes friendly enum and links actual support',()=>{
  const source=readFileSync(new URL('../pages/OnboardingPage.jsx',import.meta.url),'utf8');
  assert.match(source,/key=\{effectiveCompanyId\+':\'\+token\}/);
  assert.match(source,/Boolean\(state\.test\.verified_at\)/);assert.match(source,/request\(''\)/);
  assert.match(source,/submit\('\/test-call'/);assert.match(source,/to="\/support"/);
  assert.doesNotMatch(source,/24\/7|value="friendly"|\/skip/);
});
