const API=(import.meta.env?.VITE_API_URL || '').replace(/\/$/,'');
export const ASSISTANT_FIELDS=['assistant_name','assistant_gender','voice_id','tone','greeting_inbound_fr',
  'greeting_inbound_en','greeting_outbound_fr','voicemail_message_fr','signature_email_fr','system_prompt_voice_fr','rag_min_similarity'];
export const SETTINGS_TABS=['profile','security','assistant','company','team','integrations','privacy','telephony','notifications'];
export function settingsTab(value){return SETTINGS_TABS.includes(value)?value:value==='calendar'?'integrations':'profile';}
export function assistantPatch(form){return Object.fromEntries(ASSISTANT_FIELDS.filter(k=>form[k]!==undefined && form[k]!==null).map(k=>[k,form[k]]));}
const MESSAGES={
  forbidden:'Vous ne disposez pas des droits nécessaires.',forbidden_company:'Accès à cette entreprise refusé.',
  settings_unavailable:'Les paramètres sont indisponibles. Vérifiez que les migrations ont été appliquées.',
  session_check_unavailable:'Impossible de vérifier la session. Réessayez plus tard.',session_revoked:'Session révoquée. Reconnectez-vous.',
  protected_member:'Votre propre accès et celui du propriétaire sont protégés.',last_admin:'Le dernier administrateur actif doit être conservé.',
  owner_required:'Seul le propriétaire ou le super-admin peut transférer la propriété.',active_admin_required:'Choisissez un administrateur actif.',
  already_invited_or_member:'Ce courriel est déjà membre ou a une invitation en cours.',already_exists:'Cette entrée existe déjà.',
  invalid_email:'Vérifiez le courriel.',invalid_retention:'La durée doit être un nombre entier entre 1 et 3650 jours.',
  invalid_sender_name:'Le nom d’expéditeur ne doit pas contenir de chevrons, guillemets ou retour à la ligne.',
  invalid_reply_to:'Vérifiez l’adresse de réponse.',invalid_full_name:'Saisissez un nom entre 1 et 120 caractères.',
  invalid_avatar:'L’avatar doit être une petite image JPEG valide.',invitation_delivery_failed:'L’envoi n’a pas été confirmé. L’invitation a été annulée ; vous pouvez réessayer.',
  email_not_configured:'Le service de courriel transactionnel n’est pas configuré.',frontend_not_configured:'L’adresse publique de l’application n’est pas configurée.',
  leave_client_view_first:'Quittez la vue client pour gérer votre compte personnel.',
};
export async function settingsRequest(path,{token,body,fetchImpl=fetch,...options}={}){
  const response=await fetchImpl(API+'/api/v1'+path,{...options,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  let data;try{data=await response.json();}catch{throw new Error('Réponse du serveur illisible. Vérifiez la connexion à l’API.');}
  if(!response.ok)throw new Error(MESSAGES[data.error] || 'Opération non confirmée (HTTP '+response.status+').');
  return data;
}
export async function avatarFromFile(file){
  if(!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size>5*1024*1024)throw new Error('Choisissez une image JPEG, PNG ou WebP de 5 Mo maximum.');
  const bitmap=await createImageBitmap(file);
  try{
    const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,256,256);
    const side=Math.min(bitmap.width,bitmap.height);
    ctx.drawImage(bitmap,(bitmap.width-side)/2,(bitmap.height-side)/2,side,side,0,0,256,256);
    const value=canvas.toDataURL('image/jpeg',0.8);
    if(value.length>180000)throw new Error('Image trop lourde après réduction.');
    return value;
  }finally{bitmap.close();}
}
