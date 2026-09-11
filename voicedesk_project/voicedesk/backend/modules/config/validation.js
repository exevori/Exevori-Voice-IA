import {fail} from '../account/security.js';
import {prefixRecordingConsentFr,prefixRecordingConsentEn} from '../privacy/consent.js';
export const EDITABLE_CONFIG = ['assistant_name','assistant_gender','voice_id','tone','greeting_inbound_fr',
  'greeting_inbound_en','greeting_outbound_fr','voicemail_message_fr','signature_email_fr',
  'system_prompt_voice_fr','rag_min_similarity'];
export function publicAssistantConfig(config) {
  if (!config) return null;
  const fields = [...EDITABLE_CONFIG,'id','company_id','settings_sync_status','settings_sync_error'];
  return Object.fromEntries(fields.filter(key=>config[key]!==undefined).map(key=>[key,config[key]]));
}
export function validateConfigPatch(body) {
  const result = {};
  for (const [key,value] of Object.entries(body || {})) {
    if (key === 'company_id') continue;
    if (!EDITABLE_CONFIG.includes(key)) fail('unsupported_assistant_field');
    if (key === 'rag_min_similarity') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail('invalid_rag_threshold');
    } else {
      const max = key === 'system_prompt_voice_fr' ? 20000 : 2000;
      if (typeof value !== 'string' || value.length > max) fail('invalid_assistant_value');
      if (key === 'assistant_name' && (!value.trim() || value.trim().length > 80)) fail('invalid_assistant_name');
      if (key === 'voice_id' && !/^[A-Za-z0-9_-]{1,100}$/.test(value)) fail('invalid_voice');
      if (key === 'tone' && !['professional','warm','casual','formal'].includes(value)) fail('invalid_tone');
      if (key === 'assistant_gender' && !['feminine','masculine','neutral'].includes(value)) fail('invalid_gender');
    }
    result[key] = value;
  }
  if (!Object.keys(result).length) fail('empty_assistant_update');
  for (const key of ['greeting_inbound_fr','greeting_outbound_fr']) {
    if (key in result) result[key] = prefixRecordingConsentFr(result[key]);
  }
  if ('greeting_inbound_en' in result) result.greeting_inbound_en = prefixRecordingConsentEn(result.greeting_inbound_en);
  return result;
}
