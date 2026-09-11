import React,{useEffect,useRef,useState} from 'react';
const API=import.meta.env.VITE_API_URL || '';
export default function CallRecordingPlayer({callId,token,hasExternalId}){
  const [accepted,setAccepted]=useState(false),[url,setUrl]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const request=useRef(null),objectUrl=useRef(''),audio=useRef(null);
  useEffect(()=>{
    setAccepted(false);setUrl('');setError('');setBusy(false);
    return()=>{request.current?.abort();audio.current?.pause();if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);objectUrl.current='';};
  },[callId,token]);
  async function load(){
    if(!accepted || busy)return;
    const controller=new AbortController();request.current=controller;setBusy(true);setError('');
    try{
      const response=await fetch(API+'/api/v1/calls/'+encodeURIComponent(callId)+'/recording?acknowledge=true',{
        headers:{Authorization:'Bearer '+token},signal:controller.signal,
      });
      if(!response.ok){
        let body;try{body=await response.json();}catch{}
        throw new Error(body?.error==='recordings_hidden'?'L’écoute est désactivée dans les paramètres de confidentialité.':
          response.status===403?'Accès à cet enregistrement refusé pour confidentialité.':response.status===404?'Aucun enregistrement disponible.':'Enregistrement indisponible. Réessayez.');
      }
      const blob=await response.blob();if(controller.signal.aborted)return;
      if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);
      objectUrl.current=URL.createObjectURL(blob);setUrl(objectUrl.current);
    }catch(e){if(e.name!=='AbortError')setError(e.message);}
    finally{if(!controller.signal.aborted)setBusy(false);}
  }
  if(!hasExternalId)return <p className="text-xs text-text-secondary">Aucun enregistrement disponible pour cet appel.</p>;
  return <section className="rounded-lg border border-border p-3 space-y-3" data-testid="call-recording-player">
    <h3 className="text-sm font-medium">Enregistrement de l’appel</h3>
    {!url && <>
      <label className="flex gap-2 text-xs"><input type="checkbox" checked={accepted} disabled={busy} onChange={e=>setAccepted(e.target.checked)}/>Je confirme consulter cet enregistrement pour le suivi autorisé du client et respecter sa confidentialité.</label>
      <button className="rounded border border-border px-3 py-2 text-xs disabled:opacity-50" disabled={!accepted || busy} onClick={load}>{busy?'Chargement…':'Charger l’enregistrement'}</button>
    </>}
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    {url && <audio ref={audio} controls src={url} className="w-full" aria-label="Enregistrement de l’appel"/>}
  </section>;
}
