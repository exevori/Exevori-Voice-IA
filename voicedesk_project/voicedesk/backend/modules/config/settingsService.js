import {randomUUID} from 'node:crypto';
import {query,fail} from '../account/security.js';
import {validateConfigPatch} from './validation.js';
import {prefixRecordingConsentFr} from '../privacy/consent.js';

export function createAssistantSettingsService({supabase,fetchImpl=fetch,apiKey=process.env.ELEVENLABS_API_KEY,masterAgentId=process.env.ELEVENLABS_MASTER_AGENT_ID}){
  async function provider(agentId,options={}){
    if(!apiKey)fail('assistant_provider_not_configured',503);
    const response=await fetchImpl('https://api.elevenlabs.io/v1/convai/agents/'+encodeURIComponent(agentId),{
      ...options,headers:{'xi-api-key':apiKey,'Content-Type':'application/json'},signal:AbortSignal.timeout(15000),
    });
    if(!response.ok)fail('assistant_provider_unavailable',502);
    const data=await response.json();
    if(data.agent_id!==agentId)fail('assistant_provider_mismatch',502);
    return data;
  }
  async function settle(config,token,status,error=null){
    const result=await query(supabase.from('assistant_configs').update({settings_sync_status:status,settings_sync_error:error})
      .eq('company_id',config.company_id).eq('settings_sync_token',token).select('*').maybeSingle());
    if(!result)fail('settings_changed_retry',409);
    return result;
  }
  return {
    async save(companyId,body){
      const patch=validateConfigPatch(body),token=randomUUID();
      const config=await query(supabase.rpc('save_assistant_settings',{p_company_id:companyId,p_token:token,p_patch:patch}));
      if(!config || config.company_id!==companyId || config.settings_sync_token!==token)fail('settings_save_unconfirmed',503);
      if(config.settings_sync_status==='not_provisioned')return {config,sync_status:'not_provisioned'};
      const agentId=config.elevenlabs_agent_id;
      try{
        if(!agentId || agentId===masterAgentId || !/^[A-Za-z0-9_-]{1,200}$/.test(agentId))fail('assistant_provider_mismatch',409);
        await provider(agentId);
        const firstMessage=prefixRecordingConsentFr(config.greeting_inbound_fr || 'Bonjour, je suis '+config.assistant_name+'. Comment puis-je vous aider ?');
        const conversation_config={agent:{first_message:firstMessage,disable_first_message_interruptions:true},
          ...(config.voice_id?{tts:{voice_id:config.voice_id}}:{})};
        await provider(agentId,{method:'PATCH',body:JSON.stringify({conversation_config})});
        const confirmed=await provider(agentId);
        if(confirmed.conversation_config?.agent?.first_message!==firstMessage
          || confirmed.conversation_config?.agent?.disable_first_message_interruptions!==true
          || (config.voice_id && confirmed.conversation_config?.tts?.voice_id!==config.voice_id))fail('assistant_sync_not_confirmed',502);
        return {config:await settle(config,token,'synced'),sync_status:'synced'};
      }catch(error){
        // Configuration is durably saved. Never hide an unconfirmed provider state.
        const saved=await settle(config,token,'failed',error.code || 'assistant_sync_not_confirmed');
        return {config:saved,sync_status:'failed'};
      }
    },
  };
}
