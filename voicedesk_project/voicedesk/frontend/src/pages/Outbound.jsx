// ============================================================
// EXEVORI VOICE IA — PAGE OUTBOUND (Phase 8D)
// Campagnes d'appels sortants : prospection, suivi, RDV, annonce
// ============================================================

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Phone, PhoneOutgoing, Plus, Upload, Trash2, Play, Pause,
  RefreshCw, Users, CheckCircle2, XCircle, AlertCircle,
  Loader2, FileText, ChevronRight, Ban, Settings2,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { Button } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Input } from "../components/ui/input.jsx";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs.jsx";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../components/ui/sheet.jsx";
import { cn } from "../lib/utils.js";

const API = import.meta.env.VITE_API_URL || "";

// ─── Constantes ────────────────────────────────────────────────
const MISSION_TYPES = [
  { value: "prospecting",    label: "Prospection",      color: "blue",   desc: "Appels vers de nouveaux prospects" },
  { value: "follow_up",      label: "Suivi",            color: "purple", desc: "Rappel de prospects déjà contactés" },
  { value: "rdv_validation", label: "Validation RDV",   color: "green",  desc: "Confirmation de rendez-vous" },
  { value: "announcement",   label: "Annonce",          color: "orange", desc: "Communication d'une information" },
];

const CAMPAIGN_STATUS = {
  draft:     { label: "Brouillon",  variant: "ghost",   icon: Settings2 },
  active:    { label: "Actif",      variant: "green",   icon: Play },
  paused:    { label: "En pause",   variant: "orange",  icon: Pause },
  completed: { label: "Terminé",    variant: "default", icon: CheckCircle2 },
  cancelled: { label: "Annulé",     variant: "red",     icon: XCircle },
};

const CONTACT_STATUS = {
  pending:         { label: "En attente",    variant: "ghost" },
  calling:         { label: "En cours",      variant: "default" },
  called:          { label: "Appelé",        variant: "default" },
  no_answer:       { label: "Pas de réponse",variant: "orange" },
  interested:      { label: "Intéressé ✓",  variant: "green" },
  not_interested:  { label: "Pas intéressé", variant: "red" },
  dnc:             { label: "DNC",           variant: "red" },
  error:           { label: "Erreur",        variant: "red" },
};

// ─── Composant principal ────────────────────────────────────────
export default function Outbound() {
  const { t } = useTranslation();
  const { token, effectiveCompanyId, profile } = useAuth();
  const [tab, setTab] = useState("campaigns");
  const [campaigns, setCampaigns] = useState([]);
  const [dnc, setDnc] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [selectedCampaign, setSelectedCampaign] = useState(null);
  const [showCreateForm, setShowCreateForm] = useState(false);

  const showToast = (type, msg) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 4500);
  };

  const loadCampaigns = useCallback(async () => {
    if (!token || !effectiveCompanyId) { setLoading(false); return; }
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/v1/outbound/campaigns?company_id=${effectiveCompanyId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      setCampaigns(d.campaigns || []);
    } catch (e) { console.error("[Outbound] load:", e); }
    finally { setLoading(false); }
  }, [token, effectiveCompanyId]);

  const loadDNC = useCallback(async () => {
    if (!token || !effectiveCompanyId) return;
    const r = await fetch(`${API}/api/v1/outbound/dnc?company_id=${effectiveCompanyId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const d = await r.json();
    setDnc(d.dnc || []);
  }, [token, effectiveCompanyId]);

  useEffect(() => { loadCampaigns(); loadDNC(); }, [loadCampaigns, loadDNC]);

  const handleLaunch = async (campaign) => {
    try {
      const r = await fetch(`${API}/api/v1/outbound/campaigns/${campaign.id}/launch`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: effectiveCompanyId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      showToast("success", "Campagne lancée — les appels démarrent.");
      loadCampaigns();
    } catch (e) { showToast("error", e.message); }
  };

  const handlePause = async (campaign) => {
    try {
      await fetch(`${API}/api/v1/outbound/campaigns/${campaign.id}/pause`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: effectiveCompanyId }),
      });
      showToast("success", "Campagne mise en pause.");
      loadCampaigns();
    } catch (e) { showToast("error", e.message); }
  };

  const handleDelete = async (campaign) => {
    if (!window.confirm(`Supprimer la campagne "${campaign.name}" ?`)) return;
    try {
      const r = await fetch(`${API}/api/v1/outbound/campaigns/${campaign.id}?company_id=${effectiveCompanyId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      showToast("success", "Campagne supprimée.");
      loadCampaigns();
    } catch (e) { showToast("error", e.message); }
  };

  return (
    <div className="space-y-5 animate-fade-in" data-testid="outbound-page">
      {/* Header */}
      <div className="flex items-end justify-between">
        <div>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-tertiary mb-1">
            <PhoneOutgoing size={11} /> Appels sortants
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Campagnes d'appels</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Prospection, suivi, validation de RDV et annonces.
          </p>
        </div>
        <Button onClick={() => setShowCreateForm(true)} data-testid="create-campaign-btn">
          <Plus size={14} className="mr-2" /> Nouvelle campagne
        </Button>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="border-b border-border w-full justify-start rounded-none bg-transparent px-0 pb-0">
          <TabsTrigger value="campaigns"><Phone size={12} /> Campagnes ({campaigns.length})</TabsTrigger>
          <TabsTrigger value="dnc"><Ban size={12} /> Liste DNC ({dnc.length})</TabsTrigger>
        </TabsList>

        {/* CAMPAGNES */}
        <TabsContent value="campaigns" className="mt-4">
          {loading && (
            <div className="flex items-center justify-center py-16 text-text-tertiary gap-2">
              <Loader2 size={18} className="animate-spin" /> Chargement...
            </div>
          )}

          {!loading && campaigns.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-text-tertiary gap-3">
              <PhoneOutgoing size={32} className="opacity-30" />
              <div className="text-sm font-medium">Aucune campagne</div>
              <div className="text-xs">Créez votre première campagne d'appels sortants.</div>
              <Button variant="outline" size="sm" onClick={() => setShowCreateForm(true)}>
                <Plus size={13} className="mr-1.5" /> Créer une campagne
              </Button>
            </div>
          )}

          {!loading && campaigns.length > 0 && (
            <div className="space-y-3">
              {campaigns.map(c => (
                <CampaignCard
                  key={c.id}
                  campaign={c}
                  onLaunch={() => handleLaunch(c)}
                  onPause={() => handlePause(c)}
                  onDelete={() => handleDelete(c)}
                  onView={() => setSelectedCampaign(c)}
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* DNC */}
        <TabsContent value="dnc" className="mt-4">
          <DNCPanel
            dnc={dnc}
            token={token}
            companyId={effectiveCompanyId}
            onRefresh={loadDNC}
            showToast={showToast}
          />
        </TabsContent>
      </Tabs>

      {/* Créer campagne */}
      {showCreateForm && (
        <CreateCampaignSheet
          token={token}
          companyId={effectiveCompanyId}
          profileId={profile?.id}
          onClose={() => setShowCreateForm(false)}
          onCreated={() => { setShowCreateForm(false); loadCampaigns(); showToast("success", "Campagne créée."); }}
          showToast={showToast}
        />
      )}

      {/* Détail campagne */}
      {selectedCampaign && (
        <CampaignDetailSheet
          campaign={selectedCampaign}
          token={token}
          companyId={effectiveCompanyId}
          profileId={profile?.id}
          onClose={() => { setSelectedCampaign(null); loadCampaigns(); }}
          showToast={showToast}
        />
      )}

      {toast && (
        <div className={cn(
          "fixed bottom-6 right-6 z-50 max-w-md rounded-lg border px-4 py-3 text-sm shadow-xl animate-fade-in",
          toast.type === "success" && "border-brand-green/30 bg-brand-green/10 text-emerald-100",
          toast.type === "error"   && "border-brand-red/30 bg-brand-red/10 text-red-200",
        )}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ─── CampaignCard ───────────────────────────────────────────────
function CampaignCard({ campaign, onLaunch, onPause, onDelete, onView }) {
  const mission = MISSION_TYPES.find(m => m.value === campaign.mission_type) || MISSION_TYPES[0];
  const statusMeta = CAMPAIGN_STATUS[campaign.status] || CAMPAIGN_STATUS.draft;
  const StatusIcon = statusMeta.icon;
  const total = campaign.total_contacts || 0;
  const called = campaign.calls_made || 0;
  const progress = total > 0 ? Math.round((called / total) * 100) : 0;

  return (
    <div className="rounded-xl border border-border bg-bg-card/60 p-5" data-testid={`campaign-${campaign.id}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-semibold text-text-primary truncate">{campaign.name}</span>
            <Badge variant={statusMeta.variant} className="text-[10px] flex items-center gap-1">
              <StatusIcon size={9} /> {statusMeta.label}
            </Badge>
          </div>
          <div className="flex items-center gap-3 text-xs text-text-tertiary">
            <span className={cn(
              "px-2 py-0.5 rounded-full font-medium",
              `bg-brand-${mission.color}/10 text-brand-${mission.color}`
            )}>
              {mission.label}
            </span>
            <span>{total} contacts</span>
            <span>{campaign.daily_call_limit} appels/jour max</span>
          </div>

          {/* Barre de progression */}
          {total > 0 && (
            <div className="mt-3">
              <div className="flex justify-between text-[10px] text-text-tertiary mb-1">
                <span>{called} appelés</span>
                <span>{progress}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                <div
                  className="h-full rounded-full bg-brand-purple transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button variant="outline" size="sm" onClick={onView} className="text-xs h-7 px-3">
            <ChevronRight size={12} className="mr-1" /> Voir
          </Button>
          {campaign.status === "active" ? (
            <Button variant="outline" size="sm" onClick={onPause} className="text-xs h-7 px-3">
              <Pause size={12} className="mr-1" /> Pause
            </Button>
          ) : campaign.status !== "completed" && campaign.status !== "cancelled" ? (
            <Button size="sm" onClick={onLaunch} className="text-xs h-7 px-3">
              <Play size={12} className="mr-1" /> Lancer
            </Button>
          ) : null}
          {campaign.status !== "active" && (
            <button
              onClick={onDelete}
              className="rounded p-1.5 text-text-tertiary hover:text-red-400 hover:bg-brand-red/10 transition-colors"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── CreateCampaignSheet ────────────────────────────────────────
function CreateCampaignSheet({ token, companyId, profileId, onClose, onCreated, showToast }) {
  const [form, setForm] = useState({
    name: "",
    mission_type: "prospecting",
    script: "",
    daily_call_limit: 10,
  });
  const [saving, setSaving] = useState(false);
  const upd = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.name.trim()) { showToast("error", "Nom de la campagne requis"); return; }
    setSaving(true);
    try {
      const r = await fetch(`${API}/api/v1/outbound/campaigns`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, company_id: companyId, created_by: profileId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      onCreated();
    } catch (e) { showToast("error", e.message); }
    finally { setSaving(false); }
  };

  return (
    <Sheet open onOpenChange={o => !o && onClose()}>
      <SheetContent className="overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Nouvelle campagne</SheetTitle>
        </SheetHeader>
        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="text-[11px] uppercase tracking-wider text-text-secondary block mb-1">Nom de la campagne</label>
            <Input value={form.name} onChange={e => upd("name", e.target.value)} placeholder="Ex: Prospection Juin 2026" data-testid="campaign-name-input" />
          </div>

          <div>
            <label className="text-[11px] uppercase tracking-wider text-text-secondary block mb-1">Type de mission</label>
            <div className="grid grid-cols-2 gap-2">
              {MISSION_TYPES.map(m => (
                <button
                  key={m.value}
                  onClick={() => upd("mission_type", m.value)}
                  className={cn(
                    "rounded-lg border p-3 text-left transition-colors",
                    form.mission_type === m.value
                      ? "border-brand-purple bg-brand-purple/10"
                      : "border-border bg-bg-card hover:border-brand-purple/30"
                  )}
                  data-testid={`mission-type-${m.value}`}
                >
                  <div className="text-xs font-semibold text-text-primary">{m.label}</div>
                  <div className="text-[10px] text-text-tertiary mt-0.5">{m.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-[11px] uppercase tracking-wider text-text-secondary block mb-1">
              Limite d'appels par jour
            </label>
            <div className="flex items-center gap-3">
              <input
                type="range" min={1} max={15} step={1}
                value={form.daily_call_limit}
                onChange={e => upd("daily_call_limit", parseInt(e.target.value))}
                className="flex-1 accent-brand-purple"
              />
              <span className="text-sm font-bold text-text-primary w-12 text-right">
                {form.daily_call_limit} / jour
              </span>
            </div>
          </div>

          <div>
            <label className="text-[11px] uppercase tracking-wider text-text-secondary block mb-1">
              Script de l'assistante IA
            </label>
            <textarea
              value={form.script}
              onChange={e => upd("script", e.target.value)}
              placeholder="Écrivez ou collez le script que votre assistante IA devra suivre lors de chaque appel. Décrivez son rôle, sa mission, ses règles et ce qu'elle doit accomplir."
              rows={8}
              data-testid="campaign-script-input"
              className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-brand-purple/30 resize-y"
            />
            <p className="text-[11px] text-text-tertiary mt-1">
              {form.script.length}/5000 · L'assistante utilisera ce script pendant les appels.
            </p>
          </div>

          <div className="flex gap-3 pt-2">
            <Button variant="outline" onClick={onClose} className="flex-1">Annuler</Button>
            <Button onClick={save} disabled={saving} className="flex-1" data-testid="save-campaign-btn">
              {saving ? <Loader2 size={14} className="animate-spin mr-2" /> : null}
              Créer la campagne
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── CampaignDetailSheet ────────────────────────────────────────
function CampaignDetailSheet({ campaign, token, companyId, profileId, onClose, showToast }) {
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("contacts");
  const [newContact, setNewContact] = useState({ full_name: "", phone: "", email: "", company_name: "", language: "fr" });
  const [addingContact, setAddingContact] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileRef = React.useRef();

  const loadContacts = useCallback(async () => {
    setLoading(true);
    const r = await fetch(`${API}/api/v1/outbound/campaigns/${campaign.id}/contacts?company_id=${companyId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const d = await r.json();
    setContacts(d.contacts || []);
    setLoading(false);
  }, [campaign.id, companyId, token]);

  useEffect(() => { loadContacts(); }, [loadContacts]);

  const handleAddContact = async () => {
    if (!newContact.full_name.trim() || !newContact.phone.trim()) {
      showToast("error", "Nom et téléphone requis");
      return;
    }
    setAddingContact(true);
    try {
      const r = await fetch(`${API}/api/v1/outbound/campaigns/${campaign.id}/contacts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...newContact, company_id: companyId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setNewContact({ full_name: "", phone: "", email: "", company_name: "", language: "fr" });
      showToast("success", `${newContact.full_name} ajouté.`);
      loadContacts();
    } catch (e) { showToast("error", e.message); }
    finally { setAddingContact(false); }
  };

  const handleImport = async (file) => {
    if (!file) return;
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("company_id", companyId);
      const r = await fetch(`${API}/api/v1/outbound/campaigns/${campaign.id}/contacts/import`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      showToast("success", `${d.imported} contacts importés${d.dnc_skipped ? ` · ${d.dnc_skipped} DNC ignorés` : ""}${d.skipped ? ` · ${d.skipped} ignorés` : ""}`);
      loadContacts();
    } catch (e) { showToast("error", e.message); }
    finally { setImporting(false); }
  };

  const handleDeleteContact = async (contact) => {
    try {
      await fetch(`${API}/api/v1/outbound/campaigns/${campaign.id}/contacts/${contact.id}?company_id=${companyId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      setContacts(prev => prev.filter(c => c.id !== contact.id));
    } catch (e) { showToast("error", e.message); }
  };

  const stats = useMemo(() => ({
    total:          contacts.length,
    pending:        contacts.filter(c => c.status === "pending").length,
    interested:     contacts.filter(c => c.status === "interested").length,
    not_interested: contacts.filter(c => c.status === "not_interested").length,
    no_answer:      contacts.filter(c => c.status === "no_answer").length,
  }), [contacts]);

  return (
    <Sheet open onOpenChange={o => !o && onClose()}>
      <SheetContent className="overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{campaign.name}</SheetTitle>
          <div className="flex items-center gap-2 text-xs text-text-tertiary mt-1">
            <Badge variant={CAMPAIGN_STATUS[campaign.status]?.variant} className="text-[10px]">
              {CAMPAIGN_STATUS[campaign.status]?.label}
            </Badge>
            <span>{MISSION_TYPES.find(m => m.value === campaign.mission_type)?.label}</span>
            <span>·</span>
            <span>{campaign.daily_call_limit} appels/jour max</span>
          </div>
        </SheetHeader>

        {/* Stats rapides */}
        <div className="px-6 pt-4 grid grid-cols-4 gap-2">
          {[
            { label: "Total",       value: stats.total,          color: "text-text-primary" },
            { label: "En attente",  value: stats.pending,        color: "text-text-secondary" },
            { label: "Intéressés",  value: stats.interested,     color: "text-brand-green" },
            { label: "Pas répondu", value: stats.no_answer,      color: "text-brand-orange" },
          ].map(s => (
            <div key={s.label} className="rounded-lg border border-border bg-bg-card/60 p-3 text-center">
              <div className={cn("text-xl font-bold", s.color)}>{s.value}</div>
              <div className="text-[10px] text-text-tertiary mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>

        <div className="px-6 py-4">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="border-b border-border w-full justify-start rounded-none bg-transparent px-0 pb-0 mb-4">
              <TabsTrigger value="contacts">Contacts ({contacts.length})</TabsTrigger>
              <TabsTrigger value="add">Ajouter contact</TabsTrigger>
              <TabsTrigger value="import">Importer CSV/Excel</TabsTrigger>
            </TabsList>

            {/* Liste contacts */}
            <TabsContent value="contacts">
              {loading && <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-text-tertiary" /></div>}
              {!loading && contacts.length === 0 && (
                <div className="text-center py-12 text-sm text-text-tertiary">
                  Aucun contact. Ajoutez-en manuellement ou importez un CSV/Excel.
                </div>
              )}
              {!loading && contacts.length > 0 && (
                <div className="space-y-2">
                  {contacts.map(c => {
                    const s = CONTACT_STATUS[c.status] || CONTACT_STATUS.pending;
                    return (
                      <div key={c.id} className="flex items-center gap-3 py-2 border-b border-border">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-text-primary truncate">{c.full_name}</div>
                          <div className="text-xs text-text-tertiary">{c.phone}{c.company_name ? ` · ${c.company_name}` : ""}</div>
                        </div>
                        <Badge variant={s.variant} className="text-[10px] flex-shrink-0">{s.label}</Badge>
                        {c.status === "pending" && (
                          <button onClick={() => handleDeleteContact(c)} className="text-text-tertiary hover:text-red-400 transition-colors">
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </TabsContent>

            {/* Ajouter manuellement */}
            <TabsContent value="add" className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] uppercase tracking-wider text-text-secondary block mb-1">Nom complet *</label>
                  <Input value={newContact.full_name} onChange={e => setNewContact(p => ({ ...p, full_name: e.target.value }))} placeholder="Marie Tremblay" />
                </div>
                <div>
                  <label className="text-[11px] uppercase tracking-wider text-text-secondary block mb-1">Téléphone *</label>
                  <Input value={newContact.phone} onChange={e => setNewContact(p => ({ ...p, phone: e.target.value }))} placeholder="514 555-1234" />
                </div>
                <div>
                  <label className="text-[11px] uppercase tracking-wider text-text-secondary block mb-1">Courriel</label>
                  <Input value={newContact.email} onChange={e => setNewContact(p => ({ ...p, email: e.target.value }))} placeholder="marie@exemple.com" />
                </div>
                <div>
                  <label className="text-[11px] uppercase tracking-wider text-text-secondary block mb-1">Entreprise</label>
                  <Input value={newContact.company_name} onChange={e => setNewContact(p => ({ ...p, company_name: e.target.value }))} placeholder="Garage Tremblay" />
                </div>
              </div>
              <div className="flex gap-2">
                <label className="text-[11px] uppercase tracking-wider text-text-secondary self-center">Langue</label>
                <select
                  value={newContact.language}
                  onChange={e => setNewContact(p => ({ ...p, language: e.target.value }))}
                  className="rounded-md border border-border bg-bg-card px-3 py-1.5 text-sm text-text-primary focus:outline-none"
                >
                  <option value="fr">Français</option>
                  <option value="en">English</option>
                </select>
              </div>
              <Button onClick={handleAddContact} disabled={addingContact} data-testid="add-contact-btn">
                {addingContact ? <Loader2 size={14} className="animate-spin mr-2" /> : <Plus size={14} className="mr-2" />}
                Ajouter le contact
              </Button>
            </TabsContent>

            {/* Import CSV/Excel */}
            <TabsContent value="import" className="space-y-4">
              <div className="rounded-lg border border-dashed border-border p-6 text-center">
                <Upload size={24} className="mx-auto mb-2 text-text-tertiary" />
                <div className="text-sm font-medium text-text-primary mb-1">CSV ou Excel (.xlsx)</div>
                <div className="text-xs text-text-tertiary mb-3">
                  Colonnes reconnues : nom, téléphone, courriel, entreprise, notes, langue
                </div>
                <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={importing}>
                  {importing ? <Loader2 size={13} className="animate-spin mr-1.5" /> : <Upload size={13} className="mr-1.5" />}
                  {importing ? "Import en cours..." : "Choisir un fichier"}
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleImport(f); e.target.value = ""; }}
                />
              </div>
              <div className="rounded-lg border border-border bg-bg-card/40 p-3">
                <div className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider mb-2">
                  Exemple de colonnes CSV
                </div>
                <code className="text-[11px] text-text-tertiary">
                  nom,telephone,courriel,entreprise,langue<br />
                  Marie Tremblay,5145551234,marie@ex.com,Garage Tremblay,fr<br />
                  John Smith,5145559999,john@ex.com,,en
                </code>
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── DNCPanel ───────────────────────────────────────────────────
function DNCPanel({ dnc, token, companyId, onRefresh, showToast }) {
  const [newPhone, setNewPhone] = useState("");
  const [newReason, setNewReason] = useState("");
  const [adding, setAdding] = useState(false);

  const handleAdd = async () => {
    if (!newPhone.trim()) { showToast("error", "Numéro requis"); return; }
    setAdding(true);
    try {
      const r = await fetch(`${API}/api/v1/outbound/dnc`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: companyId, phone: newPhone.trim(), reason: newReason.trim() || null }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setNewPhone(""); setNewReason("");
      showToast("success", "Numéro ajouté à la liste DNC.");
      onRefresh();
    } catch (e) { showToast("error", e.message); }
    finally { setAdding(false); }
  };

  const handleRemove = async (entry) => {
    try {
      await fetch(`${API}/api/v1/outbound/dnc/${entry.id}?company_id=${companyId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      showToast("success", "Numéro retiré de la liste DNC.");
      onRefresh();
    } catch (e) { showToast("error", e.message); }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-bg-card/60 p-4">
        <div className="text-[11px] uppercase tracking-wider text-text-secondary mb-3">
          Ajouter un numéro à ne jamais appeler
        </div>
        <div className="flex gap-2">
          <Input value={newPhone} onChange={e => setNewPhone(e.target.value)} placeholder="514 555-1234" className="flex-1" />
          <Input value={newReason} onChange={e => setNewReason(e.target.value)} placeholder="Raison (optionnel)" className="flex-1" />
          <Button onClick={handleAdd} disabled={adding} size="sm">
            {adding ? <Loader2 size={13} className="animate-spin" /> : <Ban size={13} />}
          </Button>
        </div>
      </div>

      {dnc.length === 0 ? (
        <div className="text-center py-12 text-sm text-text-tertiary">Aucun numéro dans la liste DNC.</div>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <span className="text-sm font-semibold text-text-primary">{dnc.length} numéro{dnc.length > 1 ? "s" : ""} bloqué{dnc.length > 1 ? "s" : ""}</span>
          </div>
          <div className="divide-y divide-border">
            {dnc.map(entry => (
              <div key={entry.id} className="flex items-center gap-3 px-4 py-3">
                <Ban size={13} className="text-red-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-mono text-text-primary">{entry.phone}</div>
                  {entry.reason && <div className="text-xs text-text-tertiary truncate">{entry.reason}</div>}
                </div>
                <div className="text-[10px] text-text-tertiary">{new Date(entry.added_at).toLocaleDateString("fr-CA")}</div>
                <button onClick={() => handleRemove(entry)} className="text-text-tertiary hover:text-red-400 transition-colors">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
