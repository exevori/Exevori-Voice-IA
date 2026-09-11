import React, {useEffect,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import {useAuth,supabase} from '../../contexts/AuthContext.jsx';
import {settingsRequest,avatarFromFile} from '../../utils/account-settings.js';

const inputClass = 'w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text-primary';
export function SettingsCard({title,children}) { return <section className="rounded-xl border border-border bg-bg-card p-5 space-y-4"><h2 className="font-semibold">{title}</h2>{children}</section>; }
export function SettingsField({label,children}) { return <label className="block space-y-1 text-sm"><span>{label}</span>{children}</label>; }
function Message({value}) { return value ? <p role="status" className="text-sm text-text-secondary">{value}</p> : null; }
function Action({children,...props}) { return <button {...props} className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50">{children}</button>; }
function useAction() {
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const lock=useRef(false);
  async function run(fn) {
    if(lock.current) return;
    lock.current=true;setBusy(true);setMessage('');
    try { await fn(setMessage); } catch(e){setMessage(e.message || 'Opération non confirmée.');}
    finally{lock.current=false;setBusy(false);}
  }
  return {busy,message,run,setMessage};
}
export function ProfileSettings() {
  const {token,impersonationSession,refreshProfile}=useAuth();
  const [form,setForm]=useState(null),[email,setEmail]=useState('');
  const action=useAction();
  useEffect(()=>{
    if(impersonationSession) return;
    const controller=new AbortController();
    settingsRequest('/account/profile',{token,signal:controller.signal}).then(d=>{setForm(d.profile);setEmail(d.profile.email);})
      .catch(e=>{if(e.name!=='AbortError')action.setMessage(e.message);});
    return ()=>controller.abort();
  },[token,impersonationSession]);
  if(impersonationSession) return <SettingsCard title="Profil personnel">Quittez la vue client pour modifier votre compte personnel.</SettingsCard>;
  return <SettingsCard title="Mon profil">
    <Message value={action.message}/>
    {!form ? <p>Chargement du profil…</p> : <>
      <SettingsField label="Nom complet"><input className={inputClass} value={form.full_name || ''} maxLength={120} onChange={e=>setForm({...form,full_name:e.target.value})}/></SettingsField>
      <div className="flex items-center gap-3">
        {form.avatar_data ? <img alt="Votre avatar" src={form.avatar_data} width={64} height={64} className="rounded-full"/> : <span className="rounded-full bg-brand-purple/20 p-5" aria-label="Avatar par défaut">{form.full_name?.slice(0,1) || '?'}</span>}
        <SettingsField label="Avatar (image, 5 Mo maximum)">
          <input type="file" accept="image/jpeg,image/png,image/webp" disabled={action.busy} onChange={e=>{const file=e.target.files?.[0]; if(file)void action.run(async()=>{const avatar=await avatarFromFile(file);setForm(f=>({...f,avatar_data:avatar}));});}}/>
        </SettingsField>
        <Action onClick={()=>setForm({...form,avatar_data:null})}>Retirer</Action>
      </div>
      <Action disabled={action.busy || !form.full_name?.trim()} onClick={()=>action.run(async message=>{
        const result=await settingsRequest('/account/profile',{token,method:'PATCH',body:{full_name:form.full_name,avatar_data:form.avatar_data}});
        setForm(result.profile);message('Profil enregistré.');await refreshProfile();
      })}>Enregistrer le profil</Action>
      <hr className="border-border"/>
      <SettingsField label="Courriel de connexion"><input className={inputClass} type="email" value={email} onChange={e=>setEmail(e.target.value)} maxLength={254}/></SettingsField>
      <p className="text-xs text-text-secondary">Le changement doit être confirmé par les liens envoyés par Supabase. Le contact de facturation de l’entreprise reste indépendant.</p>
      <Action disabled={action.busy || !email || email===form.email} onClick={()=>action.run(async message=>{
        const {error}=await supabase.auth.updateUser({email:email.trim()},{emailRedirectTo:window.location.origin+'/settings?tab=profile'});
        if(error)throw error;message('Vérifiez vos courriels pour confirmer le changement. Aucune adresse non confirmée n’est enregistrée dans le profil.');
      })}>Demander le changement de courriel</Action>
    </>}
  </SettingsCard>;
}
export function SecuritySettings() {
  const {token,impersonationSession,signOut}=useAuth();
  const [sessions,setSessions]=useState(null),[password,setPassword]=useState(''),[confirmation,setConfirmation]=useState(''),[nonce,setNonce]=useState('');
  const action=useAction();
  async function load(signal){const d=await settingsRequest('/account/sessions',{token,signal});setSessions(d.sessions);}
  useEffect(()=>{if(impersonationSession)return;const c=new AbortController();load(c.signal).catch(e=>{if(e.name!=='AbortError')action.setMessage(e.message);});return()=>c.abort();},[token,impersonationSession]);
  if(impersonationSession)return <SettingsCard title="Sécurité">Quittez la vue client pour gérer votre mot de passe et vos sessions.</SettingsCard>;
  return <div className="space-y-4"><SettingsCard title="Mot de passe">
    <Message value={action.message}/>
    <SettingsField label="Nouveau mot de passe (12 caractères minimum)"><input className={inputClass} type="password" autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} maxLength={128}/></SettingsField>
    <SettingsField label="Confirmer le mot de passe"><input className={inputClass} type="password" autoComplete="new-password" value={confirmation} onChange={e=>setConfirmation(e.target.value)}/></SettingsField>
    <p className="text-xs text-text-secondary">Si Supabase demande une vérification récente, demandez un code puis saisissez-le ci-dessous.</p>
    <Action disabled={action.busy} onClick={()=>action.run(async message=>{const {error}=await supabase.auth.reauthenticate();if(error)throw error;message('Code de vérification demandé. Consultez votre courriel.');})}>Recevoir un code de vérification</Action>
    <SettingsField label="Code de vérification (si demandé)"><input className={inputClass} value={nonce} onChange={e=>setNonce(e.target.value)} autoComplete="one-time-code" maxLength={20}/></SettingsField>
    <Action disabled={action.busy || password.length<12 || password!==confirmation} onClick={()=>action.run(async message=>{
      const {error}=await supabase.auth.updateUser({password,...(nonce.trim()?{nonce:nonce.trim()}:{})});
      if(error)throw error;setPassword('');setConfirmation('');setNonce('');message('Mot de passe modifié.');await load();
    })}>Changer le mot de passe</Action>
  </SettingsCard><SettingsCard title="Sessions actives">
    <p className="text-xs text-text-secondary">Sessions présentes dans Supabase Auth (100 maximum). Une session révoquée est refusée dès la prochaine requête à l’API VoiceDesk.</p>
    {!sessions ? <p>Sessions non chargées.</p> : sessions.length===0 ? <p>Aucune session active.</p> : <ul className="space-y-3">{sessions.map(s=><li key={s.id} className="border-b border-border pb-2"><strong>{s.current?'Cette session':'Autre session'}</strong><p className="text-xs break-all">{s.user_agent || 'Appareil non renseigné'}</p><p className="text-xs text-text-secondary">Créée le {s.created_at?new Date(s.created_at).toLocaleString('fr-CA'):'—'}</p></li>)}</ul>}
    <div className="flex gap-3 flex-wrap">
      <Action disabled={action.busy} onClick={()=>action.run(async()=>load())}>Actualiser</Action>
      <Action disabled={action.busy} onClick={()=>action.run(async message=>{
        if(!window.confirm('Déconnecter tous les autres appareils ?'))return;
        const {error}=await supabase.auth.signOut({scope:'others'});if(error)throw error;await load();message('Les autres sessions ont été révoquées.');
      })}>Déconnecter les autres appareils</Action>
      <Action disabled={action.busy} onClick={()=>action.run(async()=>{if(window.confirm('Déconnecter tous vos appareils, y compris celui-ci ?'))await signOut();})}>Tout déconnecter</Action>
    </div>
  </SettingsCard></div>;
}
export function CompanyPreferences({integration=false}) {
  const {token,effectiveCompanyId,profile}=useAuth();
  const [settings,setSettings]=useState(null),[connection,setConnection]=useState(null);
  const action=useAction();
  const canManage=['company_admin','super_admin'].includes(profile?.role);
  useEffect(()=>{
    if(!effectiveCompanyId)return;
    const c=new AbortController();
    settingsRequest('/account/company-settings?company_id='+effectiveCompanyId,{token,signal:c.signal})
      .then(d=>setSettings(d.settings)).catch(e=>{if(e.name!=='AbortError')action.setMessage(e.message);});
    if(integration)settingsRequest('/calendar/connection?company_id='+effectiveCompanyId,{token,signal:c.signal})
      .then(d=>setConnection(d.connection || d)).catch(e=>{if(e.name!=='AbortError')action.setMessage(e.message);});
    return()=>c.abort();
  },[token,effectiveCompanyId,integration]);
  const update=(key,value)=>setSettings(s=>({...s,[key]:value}));
  async function save(message){
    const keys=integration?['transactional_name','transactional_reply_to']:['retention_days','transcript_retention_days','recordings_visible'];
    const body=Object.fromEntries(keys.map(k=>[k,settings[k]]));
    const d=await settingsRequest('/account/company-settings',{token,method:'PATCH',body:{company_id:effectiveCompanyId,...body}});
    setSettings(d.settings);message('Paramètres enregistrés.');
  }
  return <SettingsCard title={integration?'Intégrations':'Confidentialité'}>
    <Message value={action.message}/>
    {!settings ? <p>Paramètres non chargés.</p> : <fieldset disabled={!canManage || action.busy} className="space-y-4">
      {integration ? <>
        <h3 className="font-medium">Calendly</h3>
        <p>{connection ? (connection.connected?'Compte Calendly connecté':'Calendly non connecté') : 'État Calendly non vérifié'}</p>
        <Action onClick={()=>action.run(async()=>{
          const d=await settingsRequest('/calendar/oauth/start',{token,method:'POST',body:{company_id:effectiveCompanyId,return_path:'/settings'}});
          const url=new URL(d.authorization_url);
          if(url.protocol!=='https:' || url.hostname!=='auth.calendly.com' || url.username || url.password)throw new Error('Adresse Calendly invalide.');
          window.location.assign(url.href);
        })}>{connection?.connected?'Reconnecter Calendly':'Connecter Calendly'}</Action>
        <Link to="/calendar" className="block underline text-sm">Configurer les rendez-vous, créneaux et types d’événements</Link>
        <hr className="border-border"/>
        <h3 className="font-medium">Courriels transactionnels</h3>
        <p className="text-xs text-text-secondary">Personnalise les invitations d’équipe et confirmations/rappels de rendez-vous. L’adresse d’envoi reste le domaine vérifié Exevori. Aucun accès IMAP.</p>
        <SettingsField label="Nom affiché de l’expéditeur"><input className={inputClass} maxLength={100} value={settings.transactional_name} onChange={e=>update('transactional_name',e.target.value)}/></SettingsField>
        <SettingsField label="Adresse de réponse (Reply-To)"><input className={inputClass} type="email" maxLength={254} value={settings.transactional_reply_to} onChange={e=>update('transactional_reply_to',e.target.value)}/></SettingsField>
      </> : <>
        <p className="text-sm text-text-secondary">Ces durées s’appliquent aux nouveaux appels et enregistrements. Les données existantes conservent leur échéance ; aucune suppression rétroactive n’est déclenchée ici.</p>
        <SettingsField label="Conservation des appels et audios (jours)"><input className={inputClass} type="number" min={1} max={3650} value={settings.retention_days} onChange={e=>update('retention_days',Number(e.target.value))}/></SettingsField>
        <SettingsField label="Conservation des transcriptions (jours)"><input className={inputClass} type="number" min={1} max={3650} value={settings.transcript_retention_days} onChange={e=>update('transcript_retention_days',Number(e.target.value))}/></SettingsField>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={settings.recordings_visible} onChange={e=>update('recordings_visible',e.target.checked)}/>Autoriser l’écoute des enregistrements dans l’interface</label>
        <p className="text-xs text-text-secondary">Chaque lecteur demande une confirmation de confidentialité avant téléchargement. L’annonce d’enregistrement et le respect du refus du correspondant restent obligatoires.</p>
      </>}
      <Action disabled={action.busy} onClick={()=>action.run(save)}>Enregistrer</Action>
    </fieldset>}
    {!canManage && <p className="text-xs">Seul un administrateur de l’entreprise peut modifier ces paramètres.</p>}
  </SettingsCard>;
}
export function TeamSettings({companyId}){
  const {token,effectiveCompanyId:authCompanyId,profile,user}=useAuth();
  const effectiveCompanyId=companyId || authCompanyId;
  const [data,setData]=useState(null),[email,setEmail]=useState(''),[role,setRole]=useState('company_user');
  const action=useAction();
  const canManage=['company_admin','super_admin'].includes(profile?.role);
  const canTransfer=profile?.role==='super_admin' || data?.owner_user_id===user?.id;
  async function load(signal){const d=await settingsRequest('/team?company_id='+effectiveCompanyId,{token,signal});setData(d);}
  useEffect(()=>{if(!effectiveCompanyId)return;const c=new AbortController();load(c.signal).catch(e=>{if(e.name!=='AbortError')action.setMessage(e.message);});return()=>c.abort();},[token,effectiveCompanyId]);
  async function change(member,body){
    await settingsRequest('/team/members/'+member.user_id,{token,method:'PATCH',body:{company_id:effectiveCompanyId,...body}});await load();
  }
  return <SettingsCard title="Équipe et accès">
    {profile?.role === 'super_admin' && <p className="text-xs text-text-secondary">Administration directe de l’entreprise : {effectiveCompanyId}. Les actions sont journalisées.</p>}
    <Message value={action.message}/>
    {!data?<p>Équipe non chargée.</p>:<>
      {!data.owner_user_id && <p className="text-sm text-amber-300">Propriétaire non désigné. Le super-admin doit désigner explicitement un administrateur actif.</p>}
      {canManage && <form className="flex gap-3 flex-wrap" onSubmit={e=>{e.preventDefault();void action.run(async message=>{
        await settingsRequest('/team/invitations',{token,method:'POST',body:{company_id:effectiveCompanyId,email,role}});setEmail('');await load();message('Invitation remise au service de courriel.');
      });}}>
        <SettingsField label="Courriel à inviter"><input required type="email" value={email} onChange={e=>setEmail(e.target.value)} className={inputClass}/></SettingsField>
        <SettingsField label="Rôle"><select value={role} onChange={e=>setRole(e.target.value)} className={inputClass}><option value="company_user">Membre</option><option value="company_admin">Administrateur</option></select></SettingsField>
        <Action type="submit" disabled={action.busy}>Inviter</Action>
      </form>}
      <ul className="space-y-4">{(data.members || []).map(m=>{
        const owner=m.user_id===data.owner_user_id;
        const editable=canManage && m.user_id!==user?.id && !owner && m.role!=='super_admin';
        return <li key={m.user_id} className="border-t border-border pt-3 space-y-2">
          <p className="font-medium">{m.full_name || m.email} {owner?'— Propriétaire':''}</p><p className="text-xs">{m.email} · {m.status==='active'?'Actif':m.status==='inactive'?'Accès révoqué':'En attente'}</p>
          <div className="flex items-center gap-3 flex-wrap">
            <SettingsField label={'Rôle de '+(m.full_name || m.email)}><select value={m.role} className={inputClass} disabled={!editable || action.busy} onChange={e=>{
              const next=e.target.value;if(window.confirm('Modifier le rôle de '+m.email+' ?'))void action.run(async()=>change(m,{role:next}));
            }}><option value="company_user">Membre</option><option value="company_admin">Administrateur</option>{m.role==='super_admin'&&<option value="super_admin">Super-admin</option>}</select></SettingsField>
            {editable && <Action disabled={action.busy} onClick={()=>action.run(async()=>{
              if(window.confirm((m.status==='active'?'Révoquer':'Rétablir')+' l’accès de '+m.email+' ?'))await change(m,{status:m.status==='active'?'inactive':'active'});
            })}>{m.status==='active'?'Révoquer l’accès':'Rétablir l’accès'}</Action>}
            {canTransfer && !owner && m.role==='company_admin' && m.status==='active' && <Action disabled={action.busy} onClick={()=>action.run(async()=>{
              if(!window.confirm('Désigner '+m.email+' comme propriétaire ? Cette action transfère les droits de propriété.'))return;
              await settingsRequest('/team/owner',{token,method:'POST',body:{company_id:effectiveCompanyId,user_id:m.user_id,confirm_company_id:effectiveCompanyId}});await load();
            })}>Désigner propriétaire</Action>}
          </div>
        </li>;
      })}</ul>
      <h3 className="font-medium">Invitations</h3>
      {(data.invitations || []).map(i=><div key={i.id} className="flex gap-3 items-center justify-between text-sm"><span>{i.email} · {Date.parse(i.expires_at)>Date.now()&&i.status==='pending'?'En attente':'Expirée'}</span>
        {canManage && i.status==='pending' && <Action disabled={action.busy} onClick={()=>action.run(async()=>{
          if(!window.confirm('Annuler cette invitation ?'))return;
          await settingsRequest('/team/invitations/'+i.id+'/cancel',{token,method:'POST'});await load();
        })}>Annuler</Action>}</div>)}
      <p className="text-xs text-text-secondary">Un compte appartient à une seule entreprise. Les comptes déjà inscrits nécessitent une vérification par le support avant toute réaffectation.</p>
    </>}
  </SettingsCard>;
}
