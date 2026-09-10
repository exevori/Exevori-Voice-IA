import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createImpersonationFetch,restoreCandidate,clientViewProfile,assertVerifiedSession} from "./impersonation.js";
import {auditQuery,auditDuration} from "./admin-audit.js";
const ID="11111111-1111-4111-8111-111111111111";
const COMPANY="22222222-2222-4222-8222-222222222222";
const ctx={token:"test-token",session:{id:ID,expires_at:"2026-09-10T12:30:00Z"}};
function transport(context=ctx) {
  const calls=[];
  return {calls,fetch:createImpersonationFetch({origin:"https://app.example.test",apiBase:"https://api.example.test",
    getContext:()=>context,now:()=>Date.parse("2026-09-10T12:00:00Z"),fetchImpl:async(input,options)=>{
      calls.push({input,options});return new Response("{}");
    }})};
}
test("fetch adapter covers both configured API and same-origin proxy without leaking to providers",async()=>{
  const {calls,fetch}=transport();
  for(const url of ["/api/v1/contacts","https://api.example.test/api/v1/calls","/api/v1/auth/invite"]) {
    await fetch(url,{headers:{Authorization:"Bearer test-token"}});
    assert.equal(calls.at(-1).options.headers.get("X-Impersonation-Session"),ID);
    assert.equal(calls.at(-1).options.redirect,"error");
  }
  for(const url of ["https://api.example.test.evil.test/api/v1/calls","https://project.supabase.co/auth/v1/user",
    "https://stripe.com/api/v1/test","/api/v10/test","/api/v1/auth/me","/api/v1/admin/impersonations/"+ID+"/end"]) {
    await fetch(url,{headers:{Authorization:"Bearer test-token"}});
    assert.equal(new Headers(calls.at(-1).options.headers).has("X-Impersonation-Session"),false);
  }
});
test("Request objects preserve body, method, custom headers and cancellation",async()=>{
  const {calls,fetch}=transport();
  const c=new AbortController();
  const input=new Request("https://api.example.test/api/v1/contacts",{method:"POST",body:"fixture",signal:c.signal,
    headers:{Authorization:"Bearer test-token","X-Custom":"value"}});
  await fetch(input);
  assert.equal(calls[0].input,input);
  assert.equal(calls[0].input.method,"POST");
  assert.equal(await calls[0].input.clone().text(),"fixture");
  assert.equal(calls[0].options.headers.get("X-Custom"),"value");
  assert.equal(calls[0].options.headers.get("X-Impersonation-Session"),ID);
});
test("an expired or mismatched auth context never falls back to unrestricted admin fetch",async()=>{
  const changed=transport();
  await assert.rejects(changed.fetch("/api/v1/calls",{headers:{Authorization:"Bearer other-token"}}));
  assert.equal(changed.calls.length,0);
  const expired=transport({...ctx,session:{...ctx.session,expires_at:"2026-09-10T11:00:00Z"}});
  await assert.rejects(expired.fetch("/api/v1/calls",{headers:{Authorization:"Bearer test-token"}}));
  assert.equal(expired.calls.length,0);
  const ordinary=transport(null);
  await ordinary.fetch("/api/v1/calls",{headers:{Authorization:"Bearer test-token"}});
  assert.equal(new Headers(ordinary.calls[0].options.headers).has("X-Impersonation-Session"),false);
});
test("stored sessions are candidates only for the same authenticated actor",()=>{
  const stored={actor_id:ID,company:{id:COMPANY},session:ctx.session};
  assert.deepEqual(restoreCandidate(JSON.stringify(stored),ID),stored);
  assert.equal(restoreCandidate(JSON.stringify(stored),COMPANY),null);
  assert.equal(restoreCandidate('{"id":"legacy-localstorage"}',ID),null);
  assert.equal(restoreCandidate("bad JSON",ID),null);
});
test("an old backend response or unverified session cannot activate a client view",()=>{
  const session={...ctx.session,company_id:COMPANY,actor_user_id:ID,state:"active"};
  const now=Date.parse("2026-09-10T12:00:00Z");
  assert.doesNotThrow(()=>assertVerifiedSession({id:COMPANY},session,ID,now));
  for(const value of [undefined,{}, {...session,actor_user_id:COMPANY},{...session,company_id:ID},
    {...session,state:"expired"},{...session,expires_at:"bad date"}]) {
    assert.throws(()=>assertVerifiedSession({id:COMPANY},value,ID,now));
  }
});
test("client UI loses global admin commands without losing the actual actor identity",()=>{
  const profile={role:"super_admin",company_id:ID,full_name:"Admin"};
  const effective=clientViewProfile(profile,{company_id:COMPANY},{id:COMPANY,name:"PME"});
  assert.equal(effective.role,"company_admin");assert.equal(effective.company_id,COMPANY);
  assert.equal(effective.full_name,"Admin");assert.equal(profile.role,"super_admin");
  const client={...profile,role:"company_user"};
  assert.equal(clientViewProfile(client,{company_id:COMPANY},{id:COMPANY}),client);
});
test("audit filter dates are UTC with inclusive end day, and durations are readable",()=>{
  const query=new URLSearchParams(auditQuery({from:"2026-09-10",to:"2026-09-10",company_id:COMPANY,session_id:ID},"cursor"));
  assert.equal(query.get("from"),"2026-09-10T00:00:00.000Z");
  assert.equal(query.get("to"),"2026-09-11T00:00:00.000Z");
  assert.equal(query.get("session_id"),ID);
  assert.equal(query.get("limit"),"50");
  assert.equal(auditDuration(125),"2 min 5 s");
});
test("UI entry points use the same server-backed lifecycle and protect the audit route",()=>{
  const auth=readFileSync(new URL("../contexts/AuthContext.jsx",import.meta.url),"utf8");
  const sheet=readFileSync(new URL("../components/admin/CompanyDetailSheet.jsx",import.meta.url),"utf8");
  const switcher=readFileSync(new URL("../components/common/ImpersonationSwitcher.jsx",import.meta.url),"utf8");
  const app=readFileSync(new URL("../App.jsx",import.meta.url),"utf8");
  assert.match(auth,/return data;/); // register → signIn → session.access_token remains supported.
  assert.match(auth,/service|requestAdminJson/);
  assert.match(auth,/sessionStorage\.setItem/);
  assert.doesNotMatch(auth,/localStorage\.setItem/);
  assert.match(auth,/verified\.session\.company_id !== stored\.company\.id/);
  assert.match(auth,/profile\?\.role === "super_admin" \? impersonatedCompany/);
  assert.match(sheet,/await onImpersonate\(company, reason\.trim\(\), requestId\)/);
  assert.match(switcher,/await impersonateCompany\(selected,reason\.trim\(\),requestId\)/);
  assert.match(switcher,/await impersonateCompany\(null\)/);
  assert.match(app,/path="admin\/audit" element={<AdminRoute><AdminAudit/);
});
