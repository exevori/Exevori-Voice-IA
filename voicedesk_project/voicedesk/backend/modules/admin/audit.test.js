import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createClient} from "@supabase/supabase-js";
import express from "express";
import {createAdminAuditService,createAdminAuditRouter,parseAuditFilters,safeAuditDetails,sessionView} from "./audit.js";
import {createAdminAuditMiddleware,auditRoute} from "../../middleware/adminAudit.js";
const A="11111111-1111-4111-8111-111111111111", B="22222222-2222-4222-8222-222222222222";
const ADMIN="33333333-3333-4333-8333-333333333333", SESSION="44444444-4444-4444-8444-444444444444";
const NOW=new Date("2026-09-10T12:10:00Z");
const active={id:SESSION,company_id:A,actor_user_id:ADMIN,reason:"Support",started_at:"2026-09-10T12:00:00Z",expires_at:"2026-09-10T12:30:00Z",ended_at:null,end_reason:null};

function database(result,{status=200}={}) {
  const requests=[];
  const client=createClient("https://unit-test.supabase.co","test-service-key",{
    auth:{persistSession:false,autoRefreshToken:false},
    global:{fetch:async (url,options)=>{
      requests.push({url:new URL(url),...options,body:options.body ? JSON.parse(options.body):null});
      return new Response(JSON.stringify(typeof result==="function" ? result(requests.at(-1)):result),{status,headers:{"Content-Type":"application/json"}});
    }},
  });
  return {requests,service:createAdminAuditService({supabase:client,now:()=>NOW})};
}
test("filters reject invalid dates, UUIDs, arrays and filter/cursor injection",()=>{
  for(const q of [{company_id:B+",id.eq."+A},{actor_user_id:[]},{session_id:"x"},{action:["x"]},{action:"x,action.neq.x"},
    {from:"2026-02-30T00:00:00Z"},{from:"today"},{limit:["50"]},{limit:"-1"},{cursor:"x);delete"},
    {from:"2026-09-11T00:00:00Z",to:"2026-09-10T00:00:00Z"},
    {cursor:Buffer.from(JSON.stringify({id:A,at:"x),id.neq.x"})).toString("base64url")}]) {
    assert.throws(()=>parseAuditFilters(q),e=>e.status===400);
  }
  assert.equal(parseAuditFilters({limit:"999"}).limit,100);
});
test("real Supabase query uses exact filters, bounded keyset pagination and a safe projection",async()=>{
  const at="2026-09-10T12:00:00.123456+00:00";
  const rows=[{id:A,created_at:at,details:{method:"GET",password:"never",nested:{api_key:"never"}}},{id:B,created_at:at,details:{}}];
  const {service,requests}=database(rows);
  const result=await service.list({company_id:A,session_id:SESSION,action:"admin_request_started",limit:"1",from:"2026-09-01T00:00:00Z"});
  assert.equal(result.items.length,1); assert.equal(result.items[0].details.password,undefined);
  let query=requests[0].url.searchParams;
  assert.equal(query.get("company_id"),"eq."+A);
  assert.equal(query.get("impersonation_session_id"),"eq."+SESSION);
  assert.equal(query.get("action"),"eq.admin_request_started");
  assert.equal(query.get("limit"),"2");
  assert.equal(query.get("order"),"created_at.desc,id.desc");
  assert.ok(!query.get("select").includes("*"));
  assert.ok(requests[0].signal instanceof AbortSignal);
  await service.list({cursor:result.next_cursor});
  assert.equal(requests[1].url.searchParams.get("or"),"(created_at.lt."+at+",and(created_at.eq."+at+",id.lt."+A+"))");
});
test("session validation is actor-bound and refuses absent, ended or expired leases",async()=>{
  const {service,requests}=database(active);
  assert.equal((await service.session(SESSION,ADMIN)).state,"active");
  assert.equal(requests[0].url.searchParams.get("actor_user_id"),"eq."+ADMIN);
  assert.equal(requests[0].url.searchParams.get("id"),"eq."+SESSION);
  for(const row of [null,{...active,actor_user_id:B},{...active,ended_at:"2026-09-10T12:01:00Z"},{...active,expires_at:"2026-09-10T12:09:00Z"}]) {
    await assert.rejects(database(row).service.session(SESSION,ADMIN),{code:"impersonation_expired",status:403});
  }
  await assert.rejects(service.session("bad",ADMIN),{status:403});
});
test("start uses the request ID as idempotency key and never trusts a client actor",async()=>{
  const {service,requests}=database(active);
  const result=await service.start({id:A,name:"PME"},{id:ADMIN,requestId:SESSION},"Support");
  assert.equal(result.session.id,SESSION);
  assert.equal(requests[0].url.pathname,"/rest/v1/rpc/start_admin_impersonation");
  assert.deepEqual(requests[0].body,{p_session_id:SESSION,p_company_id:A,p_actor_user_id:ADMIN,p_reason:"Support",p_request_id:SESSION});
  await assert.rejects(service.start({id:A},{id:ADMIN},""),{status:400});
});
test("end verifies the owner before the atomic RPC, including already-ended sessions",async()=>{
  const {service,requests}=database(r=>r.url.pathname.includes("/rpc/") ? {...active,ended_at:NOW.toISOString(),end_reason:"sign_out"}:active);
  await service.end(SESSION,ADMIN,"sign_out",B);
  assert.equal(requests[0].url.searchParams.get("actor_user_id"),"eq."+ADMIN);
  assert.equal(requests[1].url.pathname,"/rest/v1/rpc/end_admin_impersonation");
  assert.equal(requests[1].body.p_actor_user_id,ADMIN);
  assert.equal(requests[1].body.p_reason,"sign_out");
  await assert.rejects(service.end(SESSION,ADMIN,"anything"),{status:400});
});
test("storage failures are sanitized, not empty successful audit pages",async()=>{
  const {service}=database({message:"SQL with secret",code:"42P01"},{status:500});
  await assert.rejects(service.list({}),{message:"admin_audit_unavailable",status:503});
});
test("durations distinguish an explicit end from a bounded inferred expiration",()=>{
  assert.equal(sessionView(active,NOW).duration_seconds,600);
  assert.equal(sessionView(active,new Date("2026-09-11")).duration_seconds,1800);
  assert.equal(sessionView(active,new Date("2026-09-11")).end_inferred,true);
  const closed=sessionView({...active,ended_at:"2026-09-10T12:05:00Z",end_reason:"user_exit"},NOW);
  assert.equal(closed.duration_seconds,300);assert.equal(closed.end_inferred,false);
});
test("display projection and route log do not copy request/provider secrets",()=>{
  assert.deepEqual(safeAuditDetails({reason:"Support",status_code:403,token:"x",before:{secret:"x"},body:"x"}),{reason:"Support",status_code:403});
  assert.equal(auditRoute("/api/v1/contacts/private@example.test?password=never"),"/api/v1/contacts/:value");
});

async function withServer({failStart=false,expired=false,duplicate=false}={},callback) {
  const rows=[],warnings=[];
  const service={
    session:async (id,actor)=>{
      if(expired || id!==SESSION || actor!==ADMIN) throw Object.assign(new Error(),{code:"impersonation_expired",status:403});
      return active;
    },
    write:async row=>{if(failStart)throw new Error("database secret"); rows.push(row);},
    list:async()=>({items:[],next_cursor:null}),
    end:async(id,actor)=>({success:true,id,actor}),
  };
  const app=express();app.use(express.json());
  const identity=(req,res,next)=>{if(req.get("x-role"))req.user={id:req.get("x-actor")||ADMIN,role:req.get("x-role"),company_id:B};next();};
  const middleware=createAdminAuditMiddleware({service,logger:{error:(...v)=>warnings.push(v)}});
  app.use(identity,middleware);
  if(duplicate)app.use(identity,middleware);
  app.use("/api/v1/admin",createAdminAuditRouter(service));
  app.all("/api/v1/contacts/:id",(req,res)=>{
    const allowed=req.user?.company_id===req.params.id;
    res.status(allowed?200:403).json({role:req.user?.role,company_id:req.user?.company_id,actor:req.auditActor?.id});
  });
  app.post("/api/v1/billing/change-plan",(_req,res)=>res.status(202).json({queued:true}));
  const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
  try {await callback("http://127.0.0.1:"+server.address().port,rows,warnings);}
  finally {await new Promise(r=>server.close(r));}
}
const headers={"x-role":"super_admin","X-Impersonation-Session":SESSION};
test("HTTP client view is company-scoped, keeps the real actor and logs both outcomes",async()=>{
  await withServer({},async(url,rows)=>{
    const ok=await fetch(url+"/api/v1/contacts/"+A,{headers});
    assert.equal(ok.status,200); assert.equal(ok.headers.get("cache-control"),"no-store");
    assert.deepEqual(await ok.json(),{role:"company_admin",company_id:A,actor:ADMIN});
    const denied=await fetch(url+"/api/v1/contacts/"+B,{headers});
    assert.equal(denied.status,403);await denied.text();
    assert.equal(rows.filter(r=>r.action==="admin_request_started").length,2);
    assert.equal(rows.filter(r=>r.details.status_code===403).length,1);
    for(const row of rows) {assert.equal(row.company_id,A);assert.equal(row.actor_user_id,ADMIN);assert.equal(row.impersonation_session_id,SESSION);}
  });
});
test("repeated authentication cannot restore a super-admin bypass inside a client view",async()=>{
  await withServer({duplicate:true},async(url,rows)=>{
    const res=await fetch(url+"/api/v1/contacts/"+A,{headers});assert.equal((await res.json()).role,"company_admin");
    assert.equal(rows.filter(r=>r.action==="admin_request_started").length,1);
  });
});
test("foreign company, foreign actor, expired lease and fake non-admin header all fail closed",async()=>{
  await withServer({},async(url)=>{
    for(const [path,h] of [
      ["/api/v1/contacts/"+A+"?company_id="+B,headers],
      ["/api/v1/contacts/"+A,{...headers,"x-actor":B}],
      ["/api/v1/contacts/"+A,{...headers,"x-role":"company_admin"}],
    ]) assert.equal((await fetch(url+path,{headers:h})).status,403);
  });
  await withServer({expired:true},async(url,rows)=>{
    assert.equal((await fetch(url+"/api/v1/contacts/"+A,{headers})).status,403);assert.equal(rows.length,0);
  });
});
test("audit failure blocks sensitive access before its handler and redacts storage errors",async()=>{
  await withServer({failStart:true},async(url)=>{
    const res=await fetch(url+"/api/v1/billing/change-plan",{method:"POST",headers:{"x-role":"super_admin"}});
    assert.equal(res.status,503);assert.deepEqual(await res.json(),{error:"admin_audit_unavailable"});
  });
});
test("plan-change requests outside impersonation are audited without copying body, query or token",async()=>{
  await withServer({},async(url,rows)=>{
    const res=await fetch(url+"/api/v1/billing/change-plan?secret=never",{method:"POST",headers:{"x-role":"super_admin","content-type":"application/json","X-Request-Id":A},body:JSON.stringify({company_id:A,password:"never",plan:"new"})});
    assert.equal(res.status,202); await res.text();
    assert.equal(rows[0].request_id,A);
    assert.equal(rows[0].company_id,A); assert.equal(rows[0].impersonation_session_id,null);
    assert.ok(!JSON.stringify(rows).includes("never"));
    assert.equal(rows[1].details.status_code,202);
  });
});
test("audit routes are protected locally, ordinary users incur no admin audit dependency",async()=>{
  await withServer({failStart:true},async(url)=>{
    assert.equal((await fetch(url+"/api/v1/admin/audit")).status,401);
    assert.equal((await fetch(url+"/api/v1/admin/audit",{headers:{"x-role":"company_admin"}})).status,403);
    assert.equal((await fetch(url+"/api/v1/contacts/"+B,{headers:{"x-role":"company_admin"}})).status,200);
  });
});
test("migration locks concurrent starts, records lifecycle atomically and preserves backend-only append access",()=>{
  const sql=readFileSync(new URL("../../../migrations/017_admin_audit_impersonation.sql",import.meta.url),"utf8");
  assert.match(sql,/pg_advisory_xact_lock/);
  assert.match(sql,/WHERE ended_at IS NULL/);
  assert.match(sql,/interval '30 minutes'/);
  assert.match(sql,/admin_impersonation_started/);assert.match(sql,/admin_impersonation_ended/);
  assert.match(sql,/ALTER TABLE public\.admin_impersonation_sessions ENABLE ROW LEVEL SECURITY/);
  assert.match(sql,/GRANT SELECT, INSERT ON TABLE public\.audit_log TO service_role/);
  assert.doesNotMatch(sql,/GRANT[^;]*(UPDATE|DELETE)[^;]*ON TABLE public\.(audit_log|admin_impersonation_sessions)/);
  assert.doesNotMatch(sql,/(UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\s+(?:public\.)?(profiles|companies|subscriptions|auth\.users)\b/i);
  for(const f of ["start_admin_impersonation","end_admin_impersonation","purge_expired_admin_impersonations"]) {
    assert.match(sql,new RegExp("REVOKE ALL ON FUNCTION public\\."+f+"[\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role"));
  }
  assert.equal((sql.match(/SECURITY DEFINER SET search_path = ''/g)||[]).length,3);
  assert.match(sql,/FOR UPDATE SKIP LOCKED/);
});
