import React,{useEffect,useRef,useState} from 'react';
import {Link,useNavigate} from 'react-router-dom';
import {useAuth} from '../contexts/AuthContext.jsx';
import {Button} from '../components/ui/button.jsx';
import {Loader2,CheckCircle2,Phone} from 'lucide-react';
import {onboardingRequest,onboardingError,pollOnboarding,TIMEOUT_MS} from '../utils/onboarding.js';

const LABELS=['Assistante','Voix','Connaissances','Activation','Appel test'];
const input='w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-sm text-text-primary';
export default function OnboardingPage(){
  const {token,effectiveCompanyId,profile}=useAuth();
  if(!token||!effectiveCompanyId)return <p role="status">Sélectionnez une entreprise pour configurer son assistante.</p>;
  return <OnboardingFlow key={effectiveCompanyId+':'+token} token={token} companyId={effectiveCompanyId}
    canEdit={['company_admin','super_admin'].includes(profile?.role)}/>;
}
function OnboardingFlow({token,companyId,canEdit}){
  const navigate=useNavigate();
  const [state,setState]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [watch,setWatch]=useState(null),[voices,setVoices]=useState([]),[voiceError,setVoiceError]=useState('');
  const [name,setName]=useState('Léa'),[tone,setTone]=useState('professional'),[voice,setVoice]=useState('');
  const [faq,setFaq]=useState([{question:'',answer:''}]),[area,setArea]=useState('581'),[phone,setPhone]=useState('');
  const alive=useRef(true),lifetime=useRef(new AbortController());
  const step=state?.progress.current_step||1;
  const request=(path,options={})=>onboardingRequest(path,{token,companyId,signal:lifetime.current.signal,...options});
  function hydrate(next){
    setState(next);setName(next.config.assistant_name);setTone(next.config.tone);
    setVoice(next.config.voice_library_id||'');setFaq(next.knowledge_entries.length?next.knowledge_entries:[{question:'',answer:''}]);
    setArea(next.area_code);setPhone(next.test.phone||'');
  }
  async function refresh(resume=true){
    setError('');
    try{
      const next=await request('');if(!alive.current)return;
      hydrate(next);
      if(resume&&next.status==='in_progress')setWatch({kind:'activation',id:Date.now()});
      else if(resume&&next.test.status==='waiting')setWatch({kind:'test',id:Date.now()});
    }catch(e){if(alive.current&&e.name!=='AbortError')setError(onboardingError(e));}
  }
  useEffect(()=>{
    alive.current=true;lifetime.current=new AbortController();refresh();
    return()=>{alive.current=false;lifetime.current.abort();};
  },[token,companyId]);
  useEffect(()=>{
    if(step!==2)return;
    const controller=new AbortController();
    setVoiceError('');
    const api=(import.meta.env.VITE_API_URL||'').replace(/\/$/,'');
    fetch(api+'/api/v1/voice-library',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])})
      .then(async response=>{if(!response.ok)throw new Error();return response.json();})
      .then(data=>{if(!controller.signal.aborted){setVoices(data.voices||[]);if(!data.voices?.length)setVoiceError('Aucune voix active. Contactez le support.');}})
      .catch(()=>{if(!controller.signal.aborted)setVoiceError('Impossible de charger les voix. Actualisez cette page ou contactez le support.');});
    return()=>controller.abort();
  },[step,token]);
  useEffect(()=>{
    if(!watch)return;
    const controller=new AbortController();
    pollOnboarding({kind:watch.kind,signal:controller.signal,
      request:signal=>request('/provisioning-status',{signal}),
      onState:next=>{if(alive.current)setState(next);}})
      .then(()=>{if(!controller.signal.aborted)setError('');})
      .catch(e=>{if(!controller.signal.aborted)setError(onboardingError(e));})
      .finally(()=>{if(!controller.signal.aborted)setWatch(null);});
    return()=>controller.abort();
  },[watch,token,companyId]);
  async function submit(path,body,kind){
    setBusy(true);setError('');
    if(kind)setWatch({kind,id:Date.now()});
    try{
      const next=await request(path,{body,timeout:TIMEOUT_MS});
      if(alive.current){hydrate(next);if(kind==='test')setWatch({kind,id:Date.now()});}
    }catch(e){
      if(alive.current){
        setError(e.name==='TimeoutError'?onboardingError('polling_timeout'):onboardingError(e));
        // Reload authoritative data after an unknown/partial outcome (e.g. FAQ
        // saved but embeddings failed). Never automatically resubmit a mutation.
        try{const next=await request('');if(alive.current)hydrate(next);}catch{}
      }
    }finally{if(alive.current)setBusy(false);}
  }
  function next(){
    if(step===1)return submit('/step/1',{assistant_name:name,tone});
    if(step===2)return submit('/step/2',{voice_library_id:voice});
    if(step===3){
      const entries=faq.filter(e=>e.question.trim()||e.answer.trim());
      if(entries.some(e=>!e.question.trim()||!e.answer.trim())){setError(onboardingError('invalid_faq'));return;}
      return submit('/step/3',{knowledge_entries:entries});
    }
    return submit('/step/5',{area_code:area},'activation');
  }
  if(!state)return <div className="p-6 space-y-3"><h1 className="text-xl">Configuration de votre assistante</h1>
    {error?<><p role="alert">{error}</p><Button onClick={()=>refresh()}>Réessayer</Button></>:<p role="status">Chargement de la progression…</p>}</div>;
  const completed=Boolean(state.test.verified_at);
  return <div className="max-w-2xl mx-auto p-4 space-y-5">
    <header><h1 className="text-2xl font-semibold text-text-primary">Configuration de votre assistante</h1>
      <p className="text-sm text-text-secondary mt-2">Chaque étape est enregistrée lorsque vous cliquez sur Continuer. Vous pourrez reprendre ici et ajuster ensuite les réglages dans Paramètres.</p></header>
    <ol className="grid grid-cols-5 gap-2" aria-label="Progression">
      {LABELS.map((label,i)=><li key={label} aria-current={step===i+1?'step':undefined}
        className={'border rounded-lg p-2 text-xs text-center '+(step===i+1?'border-brand text-brand':'border-border text-text-secondary')}>
        {i+1}. {label}{(completed||step>i+1)&&<CheckCircle2 className="mx-auto mt-1" size={14}/>}</li>)}
    </ol>
    {!canEdit&&<p role="alert">Un administrateur de l’entreprise doit terminer ces étapes. Vous pouvez consulter la progression.</p>}
    <section className="border border-border rounded-xl bg-bg-card p-5 space-y-4" aria-labelledby="step-title">
      <h2 id="step-title" className="text-lg font-semibold">{completed?'Appel test confirmé':LABELS[step-1]}</h2>
      {step===1&&<fieldset disabled={busy||!canEdit} className="space-y-4">
        <label className="block">Nom de l’assistante<input className={input} value={name} maxLength={80} onChange={e=>setName(e.target.value)}/></label>
        <label className="block">Ton<select className={input} value={tone} onChange={e=>setTone(e.target.value)}>
          <option value="professional">Professionnel</option><option value="warm">Chaleureux</option>
          <option value="formal">Formel</option><option value="casual">Décontracté</option>
        </select></label></fieldset>}
      {step===2&&<fieldset disabled={busy||!canEdit} className="space-y-3">
        {voiceError?<p role="alert">{voiceError}</p>:!voices.length?<p role="status">Chargement des voix…</p>:voices.map(v=><label key={v.id}
          className="flex items-center gap-3 border border-border rounded-lg p-3 cursor-pointer">
          <input type="radio" name="voice" value={v.id} checked={voice===v.id} onChange={()=>setVoice(v.id)}/>
          <span>{v.display_name||v.name} <span className="text-xs text-text-secondary">{v.accent||''}</span></span>
        </label>)}</fieldset>}
      {step===3&&<>
        <p className="text-sm text-text-secondary">Ajoutez jusqu’à 20 réponses utiles. Cette étape peut rester vide ; les ajouts ultérieurs se font dans la Base de connaissances.</p>
        {state.knowledge_saved&&<p role="status" className="text-sm">Vos questions sont enregistrées. Continuer reprend leur indexation sans les dupliquer.</p>}
        <fieldset disabled={busy||!canEdit||state.knowledge_saved} className="space-y-3">
          {faq.map((entry,i)=><div key={i} className="border border-border rounded-lg p-3 space-y-2">
            <label className="block text-sm">Question {i+1}<input className={input} value={entry.question} maxLength={500}
              onChange={e=>setFaq(items=>items.map((item,j)=>i===j?{...item,question:e.target.value}:item))}/></label>
            <label className="block text-sm">Réponse<textarea className={input} rows={3} value={entry.answer} maxLength={4000}
              onChange={e=>setFaq(items=>items.map((item,j)=>i===j?{...item,answer:e.target.value}:item))}/></label>
            <button type="button" onClick={()=>setFaq(items=>items.filter((_,j)=>i!==j))} className="text-sm underline">Retirer</button>
          </div>)}
          <Button variant="outline" disabled={faq.length>=20} onClick={()=>setFaq(items=>[...items,{question:'',answer:''}])}>Ajouter une question</Button>
        </fieldset></>}
      {step===4&&<>
        <p className="text-sm text-text-secondary">L’activation attribue un numéro professionnel et configure l’agent IA, sous réserve d’un abonnement actif. Une tentative déjà en cours est reprise, sans achat supplémentaire.</p>
        <label className="block">Code régional souhaité<select className={input} value={area} onChange={e=>setArea(e.target.value)} disabled={busy||Boolean(watch)||!canEdit}>
          {['581','418','514'].map(code=><option key={code}>{code}</option>)}</select></label>
        <p role="status">Statut : {({idle:'à lancer',in_progress:'activation en cours',failed:'échec à vérifier',done:'vérification requise'})[state.status]||'à vérifier'}</p>
        {state.retry_after_seconds>0&&<p className="text-sm">Une opération possède le verrou. Actualisez son statut ; la nouvelle tentative reste bloquée jusqu’à son expiration.</p>}
        {state.error&&<p role="alert">{onboardingError(state.error)}</p>}
      </>}
      {step===5&&!completed&&<>
        <p className="flex items-center gap-2 text-xl font-mono text-brand"><Phone size={20}/>{state.phone_number}</p>
        <p>Préparez le test ci-dessous, puis appelez ce numéro depuis votre téléphone, sans masquer votre numéro. Échangez quelques phrases avec l’assistante et raccrochez.</p>
        <p className="text-sm text-text-secondary">L’annonce de confidentialité reste obligatoire. Un refus de traitement n’est jamais contourné pour valider le test. La confirmation n’arrive qu’après le webhook signé de fin d’appel.</p>
        <label className="block">Votre téléphone d’appel<input type="tel" className={input} value={phone} placeholder="+15145550123"
          disabled={busy||Boolean(watch)||!canEdit} onChange={e=>setPhone(e.target.value)}/></label>
        <Button disabled={busy||Boolean(watch)||!canEdit} onClick={()=>submit('/test-call',{test_phone_number:phone},'test')}>Préparer le test (20 minutes)</Button>
        {state.test.status==='waiting'&&<p role="status">En attente de votre appel depuis {state.test.phone}. Vous pouvez maintenant appeler le numéro professionnel.</p>}
        {state.test.status==='expired'&&<p role="alert">{onboardingError('test_expired')}</p>}
      </>}
      {completed&&<>
        <p role="status" className="text-brand-green">Un véritable appel entrant a été confirmé. Votre configuration initiale est terminée.</p>
        <p>Vérifiez le résumé dans Appels et vos horaires/transferts dans Paramètres avant de diffuser le numéro.</p>
        <Button onClick={()=>navigate('/dashboard')}>Aller au tableau de bord</Button>
      </>}
      {error&&<p role="alert" className="text-brand-red">{error}</p>}
      {watch&&<p role="status" className="flex items-center gap-2 text-sm"><Loader2 size={15} className="animate-spin"/>Vérification toutes les 3 secondes (3 minutes maximum)…</p>}
      <div className="flex flex-wrap gap-3 border-t border-border pt-4">
        {step<5&&<Button onClick={next} disabled={busy||Boolean(watch)||!canEdit||step===2&&!voice||step===4&&!state.can_retry}>
          {busy?'Enregistrement…':step===4?'Activer / réessayer':'Enregistrer et continuer'}
        </Button>}
        <Button variant="outline" disabled={busy||Boolean(watch)} onClick={()=>refresh()}>Actualiser la progression</Button>
        <Link to="/support" className="text-sm text-brand underline self-center">Contacter le support</Link>
      </div>
    </section>
  </div>;
}
