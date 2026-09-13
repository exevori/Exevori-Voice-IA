import React,{useEffect,useRef,useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {Bell,CheckCheck,X,RefreshCw} from 'lucide-react';
import {useAuth} from '../../contexts/AuthContext.jsx';
import {notificationRead,notificationLink,notificationRequest} from '../../utils/notifications.js';

export default function NotificationBell(){
  const {token,effectiveCompanyId,profile,impersonationSession}=useAuth();
  if(!token)return null;
  if(impersonationSession)return <button disabled aria-label="Notifications personnelles indisponibles en vue client"
    title="Quittez la vue client pour consulter vos notifications." className="p-2 text-text-tertiary"><Bell size={16}/></button>;
  return <Inbox key={token+':'+effectiveCompanyId} token={token} isAdmin={profile?.role==='super_admin'}/>;
}
function Inbox({token,isAdmin}){
  const navigate=useNavigate(),dialog=useRef(null),request=useRef(null),version=useRef(0),alive=useRef(true);
  const lifetime=useRef(new AbortController()),opened=useRef(false),mutating=useRef(false);
  const [open,setOpen]=useState(false),[items,setItems]=useState([]),[count,setCount]=useState(null),[asOf,setAsOf]=useState(null);
  const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function load(list=false){
    if(mutating.current)return;
    request.current?.abort();const controller=new AbortController();request.current=controller;
    const current=++version.current;
    if(list)setLoading(true);
    try{
      const data=await notificationRequest(list?'?limit=50':'/unread-count',{token,signal:controller.signal});
      if(!alive.current||current!==version.current)return;
      if(list){setItems(data.notifications);setAsOf(data.as_of);}
      setCount(data.unread_count);setError('');
    }catch(e){if(alive.current&&!controller.signal.aborted)setError(e.message);}
    finally{if(alive.current&&current===version.current)setLoading(false);}
  }
  useEffect(()=>{
    alive.current=true;lifetime.current=new AbortController();load();
    const timer=setInterval(()=>{if(!mutating.current)load(opened.current);},30000);
    return()=>{alive.current=false;version.current++;clearInterval(timer);request.current?.abort();lifetime.current.abort();};
  },[token]);
  useEffect(()=>{
    opened.current=open;
    if(open){if(!dialog.current.open)dialog.current.showModal();load(true);}
    else if(dialog.current.open)dialog.current.close();
  },[open]);
  async function mark(item,follow=false){
    if(mutating.current)return;
    mutating.current=true;setBusy(true);setError('');request.current?.abort();version.current++;
    try{
      if(!item||!notificationRead(item)){
        await notificationRequest(item?'/'+item.id+'/read':'/mark-all-read',{token,body:item?{}:{before:asOf},signal:lifetime.current.signal});
      }
      if(!alive.current)return;
      if(follow){
        const target=notificationLink(item,isAdmin);if(target){setOpen(false);navigate(target);}
      }
      mutating.current=false;await load(true);
    }catch(e){if(alive.current)setError(e.message);}
    finally{mutating.current=false;if(alive.current)setBusy(false);}
  }
  return <>
    <button data-testid="notification-bell" onClick={()=>setOpen(true)} aria-label={'Notifications'+(count===null?'':', '+count+' non lues')}
      title={error||'Notifications'} className="relative rounded-lg p-2 text-text-secondary hover:bg-white/5">
      <Bell size={16}/>{count>0&&<span className="absolute -right-1 -top-1 rounded-full bg-brand-red px-1 text-[10px] text-white">{count>99?'99+':count}</span>}
      {error&&<span className="absolute right-0 bottom-0 text-brand-orange" aria-label="Notifications indisponibles">!</span>}
    </button>
    <dialog ref={dialog} onCancel={()=>setOpen(false)} onClose={()=>setOpen(false)} aria-labelledby="notification-title"
      data-testid="notification-dialog" className="m-auto w-[calc(100%_-_2rem)] max-w-xl rounded-xl border border-border bg-bg-card p-0 text-text-primary shadow-2xl backdrop:bg-black/60">
      <header className="flex justify-between items-center border-b border-border p-4">
        <h2 id="notification-title" className="font-semibold">Notifications {count!==null&&'('+count+' non lues)'}</h2>
        <button onClick={()=>setOpen(false)} aria-label="Fermer les notifications" className="p-2"><X size={18}/></button>
      </header>
      <div className="flex flex-wrap gap-4 border-b border-border p-3 text-sm">
        <button onClick={()=>load(true)} disabled={busy||loading} className="flex gap-1 items-center"><RefreshCw size={14}/>Actualiser</button>
        <button onClick={()=>mark(null)} disabled={busy||loading||!asOf||!count} className="flex gap-1 items-center"><CheckCheck size={14}/>Tout marquer lu</button>
        <span className="text-xs text-text-secondary">50 dernières notifications</span>
      </div>
      {error&&<p role="alert" className="p-3 text-brand-red">{error}</p>}
      {loading&&<p role="status" className="p-3">Chargement…</p>}
      <ul className="max-h-[65vh] overflow-y-auto divide-y divide-border">
        {!loading&&!items.length&&!error&&<li className="p-6 text-center text-text-secondary">Aucune notification.</li>}
        {items.map(item=><li key={item.id} className={'p-4 space-y-2 '+(!notificationRead(item)?'border-l-2 border-brand':'')}>
          <p className="font-medium">{item.title}{!notificationRead(item)&&<span className="ml-2 text-xs text-brand">Non lue</span>}</p>
          {isAdmin&&item.companies?.name&&<p className="text-xs text-text-tertiary">{item.companies.name}</p>}
          {item.body&&<p className="text-sm text-text-secondary">{item.body}</p>}
          <p className="text-xs text-text-tertiary">{Number.isFinite(Date.parse(item.created_at))?new Date(item.created_at).toLocaleString('fr-CA'):'Date indisponible'}</p>
          <div className="flex gap-4 text-sm text-brand">
            {!notificationRead(item)&&<button disabled={busy} onClick={()=>mark(item)}>Marquer comme lue</button>}
            {notificationLink(item,isAdmin)&&<button disabled={busy} onClick={()=>mark(item,true)}>Consulter</button>}
          </div>
        </li>)}
      </ul>
    </dialog>
  </>;
}
