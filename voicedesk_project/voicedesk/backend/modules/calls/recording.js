import express from 'express';
import {createClient} from '@supabase/supabase-js';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {UUID,query,fail,route} from '../account/security.js';

export function createRecordingRouter({supabase,fetchImpl=fetch,apiKey=process.env.ELEVENLABS_API_KEY}) {
  const router = express.Router();
  router.get('/:id/recording',route(async(req,res)=>{
    if (!req.user) fail('unauthorized',401);
    if (!UUID.test(req.params.id)) fail('invalid_call_id');
    let lookup = supabase.from('calls').select('id,company_id,elevenlabs_conversation_id,created_at,retention_days').eq('id',req.params.id);
    if (req.user.role !== 'super_admin') lookup = lookup.eq('company_id',req.user.company_id);
    const call = await query(lookup.maybeSingle());
    if (!call) {
      const exists = req.user.role === 'super_admin' ? null : await query(supabase.from('calls').select('id').eq('id',req.params.id).maybeSingle());
      fail(exists ? 'forbidden_company' : 'call_not_found',exists ? 403 : 404);
    }
    const settings = await query(supabase.from('company_settings').select('recordings_visible').eq('company_id',call.company_id).maybeSingle());
    if (settings?.recordings_visible === false) fail('recordings_hidden',403);
    if (req.query.acknowledge !== 'true') fail('recording_acknowledgement_required',400);
    if (!call.elevenlabs_conversation_id || !(Date.parse(call.created_at)+(call.retention_days || 90)*86400000 > Date.now())) fail('no_recording',404);
    const deletion = await query(supabase.from('privacy_external_deletions').select('id')
      .eq('company_id',call.company_id).eq('provider','elevenlabs').eq('resource_type','conversation')
      .eq('external_id',call.elevenlabs_conversation_id).limit(1));
    if (deletion?.length) fail('recording_removed_for_privacy',403);
    if (!apiKey) fail('recording_provider_unavailable',503);
    await query(supabase.from('audit_log').insert({company_id:call.company_id,
      actor_user_id:req.auditActor?.id || req.user.id,actor_role:req.auditActor?.role || req.user.role,
      action:'calls.recording_access',entity_type:'call',entity_id:call.id,
      impersonation_session_id:req.get('X-Impersonation-Session') || null,details:{acknowledged:true}}));
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(),60000);
    const close = ()=>controller.abort();
    res.on('close',close);
    try {
      const upstream = await fetchImpl('https://api.elevenlabs.io/v1/convai/conversations/'+encodeURIComponent(call.elevenlabs_conversation_id)+'/audio',{
        headers:{'xi-api-key':apiKey},signal:controller.signal,
      });
      if (upstream.status === 404) fail('no_recording',404);
      if (!upstream.ok || !upstream.body) fail('recording_provider_unavailable',502);
      res.set('Content-Type','audio/mpeg').set('Content-Disposition','inline; filename="appel-'+call.id+'.mp3"');
      await pipeline(Readable.fromWeb(upstream.body),res);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      throw error;
    } finally { clearTimeout(timer); res.off('close',close); }
  }));
  return router;
}
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}) : null;
export const recordingRouter = createRecordingRouter({supabase});
