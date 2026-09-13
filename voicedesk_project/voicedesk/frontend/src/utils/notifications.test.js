import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {notificationLink,notificationRead,notificationRequest} from './notifications.js';
test('read status supports timestamps and legacy boolean rows',()=>{
  assert.equal(notificationRead({read:false,read_at:null}),false);
  assert.equal(notificationRead({read:true}),true);assert.equal(notificationRead({read_at:'2026-01-01'}),true);
});
test('links are local and allowlisted; hidden email pages, javascript and external URLs cannot navigate',()=>{
  for(const link of ['javascript:alert(1)','https://evil.com','//evil.com','/\\evil.com','/emails','/settings?tab=email-accounts','/admin','/calls\n'])
    assert.equal(notificationLink({link}),null,link);
  assert.equal(notificationLink({link:'/support?ticket=123'}),'/support?ticket=123');
  assert.equal(notificationLink({event_type:'payment_failed',link:'/billing'},true),'/admin');
});
test('read mutation sends the server snapshot and never reports failed writes as success',async()=>{
  let captured;
  await notificationRequest('/mark-all-read',{token:'test-token',body:{before:'2026-09-13'},fetchImpl:async(url,options)=>{captured={url,...options};return new Response('{}');}});
  assert.equal(captured.method,'POST');assert.deepEqual(JSON.parse(captured.body),{before:'2026-09-13'});
  await assert.rejects(notificationRequest('/n/read',{body:{},fetchImpl:async()=>new Response('{"error":"db"}',{status:503})}),/indisponibles/);
  await assert.rejects(notificationRequest('',{fetchImpl:async()=>new Response('html',{status:502})}),/illisible/);
});
test('bell uses accessible modal, individual read and server-confirmed mark-all, with stale-request cancellation',()=>{
  const source=readFileSync(new URL('../components/common/NotificationBell.jsx',import.meta.url),'utf8');
  for(const value of ['<dialog','showModal()','aria-labelledby="notification-title"','Marquer comme lue','/mark-all-read','before:asOf',
    'impersonationSession','request.current?.abort()','current!==version.current','30000'])assert.ok(source.includes(value),value);
  assert.doesNotMatch(source,/setCount\(0\)|window.location.href|dangerouslySetInnerHTML/);
});
