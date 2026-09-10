import React, {useEffect,useState} from "react";
import {useAuth} from "../contexts/AuthContext.jsx";
import DataTable from "../components/common/DataTable.jsx";
import {Button} from "../components/ui/button.jsx";
import {requestAdminJson} from "../utils/admin-company.js";
import {auditQuery,auditDuration,AUDIT_ACTIONS} from "../utils/admin-audit.js";

const API = import.meta.env.VITE_API_URL || "";
const EMPTY = {company_id:"",from:"",to:"",action:"",session_id:""};
const date = value => value ? new Date(value).toLocaleString("fr-CA") : "—";
export default function AdminAudit() {
  const {token,profile,impersonatedCompany} = useAuth();
  const [mode,setMode] = useState("audit");
  const [draft,setDraft] = useState(EMPTY);
  const [filters,setFilters] = useState(EMPTY);
  const [companies,setCompanies] = useState([]);
  const [page,setPage] = useState({items:[],next_cursor:null});
  const [cursors,setCursors] = useState([null]);
  const [loading,setLoading] = useState(false);
  const [error,setError] = useState("");
  const [companyError,setCompanyError] = useState("");
  const [refresh,setRefresh] = useState(0);
  useEffect(()=>{
    if(!token || profile?.role!=="super_admin" || impersonatedCompany)return;
    const c = new AbortController();
    requestAdminJson(API+"/api/v1/admin/companies",{token,signal:c.signal}).then(r=>setCompanies(r.companies||[]))
      .catch(e=>{if(!c.signal.aborted)setCompanyError(e.message);});
    return ()=>c.abort();
  },[token,profile?.role,impersonatedCompany]);
  useEffect(()=>{
    if(!token || profile?.role!=="super_admin" || impersonatedCompany)return;
    const c = new AbortController();
    setLoading(true);setError("");setPage({items:[],next_cursor:null});
    requestAdminJson(API+"/api/v1/admin/"+mode+"?"+auditQuery(filters,cursors.at(-1)),{token,signal:c.signal})
      .then(r=>{if(!c.signal.aborted)setPage(r);})
      .catch(e=>{if(!c.signal.aborted)setError(e.message);})
      .finally(()=>{if(!c.signal.aborted)setLoading(false);});
    return ()=>c.abort();
  },[token,profile?.role,impersonatedCompany,mode,filters,cursors,refresh]);
  const companyName = id => companies.find(c=>c.id===id)?.name || id || "Global";
  const showSession = id => {
    const next = {...filters,session_id:id,action:"",from:"",to:""};
    setDraft(next);setFilters(next);setMode("audit");setCursors([null]);
  };
  if(profile?.role!=="super_admin")return <p>Accès réservé à l’administration.</p>;
  if(impersonatedCompany)return <p>Terminez la vue client avec le bouton du bandeau avant d’ouvrir le journal global.</p>;
  const common = [
    {key:"company_id",header:"Entreprise",render:r=>companyName(r.company_id)},
    {key:"actor_user_id",header:"Acteur (ID utilisateur)",render:r=><span className="break-all font-mono text-xs">{r.actor_user_id||"Système"}</span>},
  ];
  const columns = mode==="audit" ? [
    {key:"created_at",header:"Quand",render:r=>date(r.created_at)},...common,
    {key:"action",header:"Action",render:r=><div><p>{r.action}</p><p className="text-xs">{r.details?.method} {r.details?.route}</p></div>},
    {key:"details",header:"Résultat",render:r=><div className="max-w-sm break-words text-xs">
      {r.details?.phase==="started" ? "Début enregistré — résultat à consulter" : r.details?.phase==="connection_closed" ? "Connexion interrompue — résultat non confirmé" : r.details?.status_code ? "HTTP "+r.details.status_code : "Événement métier"}
      {r.details?.reason && <p>Motif : {r.details.reason}</p>}
      {r.details?.end_reason && <p>Fin : {r.details.end_reason} · {auditDuration(r.details.duration_seconds)}</p>}
      <p className="mt-1 font-mono">Requête : {r.request_id||"—"}</p>
      {r.impersonation_session_id && <button className="underline" onClick={()=>showSession(r.impersonation_session_id)}>Voir cette session</button>}
    </div>},
  ] : [
    {key:"started_at",header:"Début / fin",render:r=><div>{date(r.started_at)}<p className="text-xs">{r.ended_at ? date(r.ended_at) : r.end_inferred ? date(r.expires_at)+" (expiration déduite)" : "En cours"}</p></div>},...common,
    {key:"duration_seconds",header:"Durée",render:r=>auditDuration(r.duration_seconds)},
    {key:"state",header:"État",render:r=>({active:"Active",expired:"Expirée",ended:"Terminée"}[r.state]||r.state)},
    {key:"reason",header:"Motif / actions",render:r=><div className="max-w-sm break-words">{r.reason}<p><Button size="sm" variant="link" onClick={()=>showSession(r.id)}>Actions de cette session</Button></p></div>},
  ];
  return <section className="space-y-5 p-6" data-testid="admin-audit-page">
    <header><h1 className="text-2xl font-semibold text-text-primary">Journal d’audit</h1><p className="mt-2 text-sm text-text-secondary">Accès sensibles et vues client. Une réponse HTTP ne prouve pas qu’une opération asynchrone est terminée ; consultez aussi l’événement métier associé.</p></header>
    <div className="flex gap-2"><Button variant={mode==="audit"?"default":"outline"} onClick={()=>{setMode("audit");setCursors([null]);}}>Journal</Button><Button variant={mode==="impersonations"?"default":"outline"} onClick={()=>{setMode("impersonations");setCursors([null]);}}>Historique des vues client</Button></div>
    <form className="flex flex-wrap items-end gap-3 rounded-xl border border-border p-4 text-sm text-text-primary" onSubmit={e=>{e.preventDefault();setFilters({...draft});setCursors([null]);}}>
      <label>Entreprise<select aria-label="Entreprise" className="mt-1 block rounded border border-border bg-bg-input p-2" value={draft.company_id} onChange={e=>setDraft({...draft,company_id:e.target.value})}><option value="">Toutes</option>{companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label>Du (UTC)<input type="date" className="mt-1 block rounded border border-border bg-bg-input p-2" value={draft.from} onChange={e=>setDraft({...draft,from:e.target.value})}/></label>
      <label>Au inclus (UTC)<input type="date" min={draft.from||undefined} className="mt-1 block rounded border border-border bg-bg-input p-2" value={draft.to} onChange={e=>setDraft({...draft,to:e.target.value})}/></label>
      {mode==="audit" && <label>Action<input list="audit-actions" placeholder="Toutes" className="mt-1 block rounded border border-border bg-bg-input p-2" value={draft.action} onChange={e=>setDraft({...draft,action:e.target.value})}/><datalist id="audit-actions">{AUDIT_ACTIONS.map(a=><option key={a} value={a}/>)}</datalist></label>}
      <Button type="submit" disabled={loading}>Filtrer</Button><Button type="button" variant="ghost" onClick={()=>{setDraft(EMPTY);setFilters(EMPTY);setCursors([null]);}}>Réinitialiser</Button>
    </form>
    {filters.session_id && <p className="text-sm text-text-secondary">Session filtrée : <code>{filters.session_id}</code></p>}
    {(error||companyError) && <p role="alert" className="rounded border border-brand-red/30 p-3 text-sm text-brand-red">{error||companyError}</p>}
    <DataTable key={mode} columns={columns.map(c=>({...c,sortable:false}))} data={page.items} loading={loading} pageSize={50} testId="admin-audit-table" emptyState={{title:"Aucun événement",description:"Aucune donnée ne correspond à ces filtres."}}/>
    <footer className="flex flex-wrap items-center gap-3 text-xs text-text-secondary"><Button variant="outline" size="sm" disabled={loading||cursors.length===1} onClick={()=>setCursors(c=>c.slice(0,-1))}>Précédent</Button><span>Page {cursors.length} · 50 événements maximum</span><Button variant="outline" size="sm" disabled={loading||!page.next_cursor} onClick={()=>setCursors(c=>[...c,page.next_cursor])}>Suivant</Button><Button variant="ghost" size="sm" disabled={loading} onClick={()=>setRefresh(x=>x+1)}>Actualiser</Button></footer>
    <p className="text-xs text-text-tertiary">Une fermeture d’onglet n’est pas une fin confirmée : sans sortie explicite, la durée est plafonnée à l’expiration de 30 minutes. Horodatages affichés dans le fuseau de votre navigateur.</p>
  </section>;
}
