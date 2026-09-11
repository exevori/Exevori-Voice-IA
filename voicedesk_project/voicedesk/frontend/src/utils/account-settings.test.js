import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {settingsTab,assistantPatch,settingsRequest,avatarFromFile,ASSISTANT_FIELDS} from './account-settings.js';
test('retired IMAP settings are unreachable and Calendar links use the integration tab',()=>{
  assert.equal(settingsTab('email-accounts'),'profile');
  assert.equal(settingsTab('calendar'),'integrations');
  assert.equal(settingsTab('security'),'security');
  assert.equal(settingsTab('unknown'),'profile');
});
test('assistant submission excludes provider identifiers and read-only sync leases',()=>{
  assert.deepEqual(assistantPatch({assistant_name:'Camille',elevenlabs_agent_id:'private',settings_sync_token:'private',company_id:'other',rag_min_similarity:0.5}),
    {assistant_name:'Camille',rag_min_similarity:0.5});
  const source=readFileSync(new URL('../../../backend/modules/config/validation.js',import.meta.url),'utf8');
  for(const field of ASSISTANT_FIELDS)assert.ok(source.includes("'"+field+"'"));
});
test('settings requests encode JSON, carry the current bearer and expose readable errors',async()=>{
  let request;
  await settingsRequest('/account/profile',{token:'test-token',method:'PATCH',body:{full_name:'Test'},fetchImpl:async(url,options)=>{
    request={url,...options};return new Response(JSON.stringify({success:true}));
  }});
  assert.equal(request.headers.Authorization,'Bearer test-token');
  assert.deepEqual(JSON.parse(request.body),{full_name:'Test'});
  await assert.rejects(settingsRequest('/account/profile',{fetchImpl:async()=>new Response('bad gateway',{status:502})}),/illisible/);
  await assert.rejects(settingsRequest('/team',{fetchImpl:async()=>new Response(JSON.stringify({error:'owner_required'}),{status:403})}),/propriétaire/);
});
test('avatar file validation rejects active content and oversized inputs before decoding',async()=>{
  await assert.rejects(avatarFromFile({type:'image/svg+xml',size:10}),/JPEG/);
  await assert.rejects(avatarFromFile({type:'image/png',size:6*1024*1024}),/5 Mo/);
});
test('profile/security/team and recording controls are wired to their real endpoints',()=>{
  const settings=readFileSync(new URL('../components/settings/AccountSettings.jsx',import.meta.url),'utf8');
  for(const path of ['/account/profile','/account/sessions','/account/company-settings','/team/members/','/team/owner','/calendar/oauth/start'])assert.ok(settings.includes(path));
  assert.match(settings,/scope:'others'/);assert.match(settings,/supabase\.auth\.updateUser/);
  const player=readFileSync(new URL('../components/calls/CallRecordingPlayer.jsx',import.meta.url),'utf8');
  assert.match(player,/acknowledge=true/);assert.match(player,/revokeObjectURL/);assert.match(player,/request\.current\?\.abort/);
  const admin=readFileSync(new URL('../components/admin/CompanyDetailSheet.jsx',import.meta.url),'utf8');
  assert.match(admin,/settings\?tab=team&company_id=/);
});
