const API=(import.meta.env?.VITE_API_URL||'').replace(/\/$/,'');
export function notificationRead(item){return item.read===true||Boolean(item.read_at);}
export function notificationLink(item,isAdmin=false){
  if(isAdmin&&['provisioning_completed','provisioning_failed','payment_failed','quota_reached'].includes(item.event_type))return '/admin';
  const link=item.link;
  if(typeof link!=='string'||!link.startsWith('/')||link.startsWith('//')||/[\\\r\n]/.test(link))return null;
  try{
    const parsed=new URL(link,'https://local.invalid');
    if(parsed.origin!=='https://local.invalid'||!['/support','/tickets','/calls','/billing','/onboarding','/learning','/dashboard','/admin'].includes(parsed.pathname))return null;
    if(parsed.pathname==='/admin'&&!isAdmin)return null;
    return parsed.pathname+parsed.search;
  }catch{return null;}
}
export async function notificationRequest(path,{token,body,signal,fetchImpl=fetch}={}){
  const response=await fetchImpl(API+'/api/v1/notifications'+path,{
    method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...(body!==undefined?{'Content-Type':'application/json'}:{})},
    signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),
    ...(body!==undefined?{body:JSON.stringify(body)}:{})});
  let result;try{result=await response.json();}catch{throw new Error('Réponse illisible du service de notifications.');}
  if(!response.ok)throw new Error(result.error==='leave_client_view_first'?'Quittez la vue client pour consulter vos notifications personnelles.':
    result.error==='notification_not_found'?'Cette notification n’est plus disponible.':'Les notifications sont indisponibles. Réessayez.');
  return result;
}
