const API=(import.meta.env?.VITE_API_URL||'').replace(/\/$/,'');
export const POLL_MS=3000,TIMEOUT_MS=180000;
const MESSAGES={
  onboarding_unavailable:'La progression est indisponible. Réessayez ou contactez le support.',
  provisioning_not_configured:'L’activation n’est pas configurée côté serveur. Contactez le support.',
  provisioning_failed:'L’activation n’a pas abouti. Vérifiez le statut avant de réessayer.',
  provisioning_in_progress:'Une activation est déjà en cours. Le suivi va reprendre.',
  provisioning_retry_required:'Une vérification des ressources est nécessaire. Actualisez le statut avant de réessayer.',
  provisioning_inconsistent:'Le numéro et l’agent ne sont pas encore cohérents. Contactez le support.',
  previous_step_required:'Une étape précédente reste à enregistrer. Rechargez la progression.',
  setup_locked:'L’activation a déjà été demandée. Les changements suivants se font dans Paramètres.',
  step_already_saved:'Cette étape a déjà été enregistrée. Rechargez la progression.',
  resume_saved_faq:'Reprenez les questions déjà enregistrées. Vous pourrez les modifier ensuite dans la Base de connaissances.',
  invalid_faq:'Chaque question doit avoir une réponse (20 questions maximum, 500/4000 caractères).',
  duplicate_question:'Deux questions sont identiques. Conservez une seule réponse.',
  invalid_phone:'Saisissez votre numéro au format international, par exemple +15145550123.',
  voice_unavailable:'Cette voix n’est plus disponible. Choisissez une autre voix.',
  invalid_voice:'Choisissez une voix disponible.',invalid_tone:'Choisissez un ton proposé.',
  invalid_assistant_name:'Le nom doit contenir entre 1 et 80 caractères.',
  real_test_call_required:'Aucun appel test reçu et signé n’a encore été confirmé.',
  forbidden:'Seul un administrateur de l’entreprise peut terminer cette configuration.',
  forbidden_company:'Vous n’avez pas accès à cette entreprise.',
  test_expired:'La fenêtre de test a expiré. Préparez un nouveau test, puis appelez le numéro.',
  polling_timeout:'Le suivi a atteint trois minutes. L’opération peut continuer côté serveur : actualisez son statut avant toute nouvelle tentative.',
};
export function onboardingError(error){return MESSAGES[error?.code||error]||error?.message||'Opération non confirmée. Réessayez.';}
export async function onboardingRequest(path,{token,companyId,body,signal,fetchImpl=fetch,timeout=15000}={}) {
  const method=body===undefined?'GET':'POST';
  const url=API+'/api/v1/onboarding'+path+(method==='GET'?'?company_id='+encodeURIComponent(companyId):'');
  const response=await fetchImpl(url,{method,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout),
    headers:{Authorization:'Bearer '+token,...(method==='POST'?{'Content-Type':'application/json'}:{})},
    ...(method==='POST'?{body:JSON.stringify({...body,company_id:companyId})}:{})});
  let data;try{data=await response.json();}catch{throw new Error('Réponse API illisible. Vérifiez la connexion au backend.');}
  if(!response.ok)throw Object.assign(new Error(onboardingError(data.error)),{code:data.error,status:response.status});
  return data;
}
function pause(ms,signal){return new Promise((resolve,reject)=>{
  const abort=()=>{clearTimeout(timer);reject(signal.reason);};
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
});}
// Sequential requests: no overlaps, bounded wait, no automatic purchase/retry.
export async function pollOnboarding({request,onState,kind,signal,now=Date.now,sleep=pause,timeout=TIMEOUT_MS}) {
  const deadline=now()+timeout;
  while(now()<deadline) {
    signal?.throwIfAborted();
    const remaining=AbortSignal.timeout(Math.max(1,deadline-now()));
    const requestSignal=signal?AbortSignal.any([signal,remaining]):remaining;
    let state;
    try{state=await request(requestSignal);}catch(error){
      if(remaining.aborted&&!signal?.aborted)throw Object.assign(new Error(MESSAGES.polling_timeout),{code:'polling_timeout'});
      throw error;
    }
    signal?.throwIfAborted();onState(state);
    if(kind==='activation'&&state.ready || kind==='test'&&state.test?.verified_at)return state;
    if(kind==='activation'&&state.error)throw Object.assign(new Error(onboardingError(state.error)),{code:state.error});
    if(kind==='test'&&state.test?.status==='expired')throw Object.assign(new Error(MESSAGES.test_expired),{code:'test_expired'});
    await sleep(Math.min(POLL_MS,Math.max(0,deadline-now())),signal);
  }
  throw Object.assign(new Error(MESSAGES.polling_timeout),{code:'polling_timeout'});
}
