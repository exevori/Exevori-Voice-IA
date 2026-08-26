// ============================================================
// EXEVORI VOICE IA — PAGE OUTBOUND (Phase 8D)
// Campagnes d'appels sortants : prospection, suivi, RDV, annonce
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Phone, PhoneOutgoing, Plus, Upload, Trash2, Play, Pause,
  RefreshCw, Users, CheckCircle2, XCircle, AlertCircle,
  Loader2, FileText, ChevronRight, Ban, Settings2, ClipboardCopy,
  ShieldAlert,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { Button } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Input } from "../components/ui/input.jsx";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs.jsx";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../components/ui/sheet.jsx";
import { cn } from "../lib/utils.js";
import { hasPermission } from "../utils/auth-helpers.js";

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

const MANUAL_REVIEW_ACTIONS = [
  {
    value: "confirmed_not_dispatched",
    label: "Confirmer non envoyé",
    variant: "outline",
    warning: "Cette décision peut autoriser une nouvelle tentative. Vérifiez d’abord qu’aucun appel n’existe chez le fournisseur.",
  },
  {
    value: "confirmed_completed",
    label: "Confirmer terminé",
    variant: "default",
    warning: "Cette décision marque l’appel comme terminé et empêche sa relance.",
  },
  {
    value: "confirmed_failed",
    label: "Confirmer l’échec",
    variant: "destructive",
    warning: "Cette décision marque l’appel en échec définitif et empêche toute relance automatique.",
  },
];

// ─── Composant principal ────────────────────────────────────────
export default function Outbound() {
  const { token, effectiveCompanyId, profile } = useAuth();
  const [tab, setTab] = useState("campaigns");
  const [campaigns, setCampaigns] = useState([]);
  const [dnc, setDnc] = useState([]);
  const [outboundPhones, setOutboundPhones] = useState([]);
  const [manualReviews, setManualReviews] = useState([]);
  const [manualReviewsLoading, setManualReviewsLoading] = useState(false);
  const [manualReviewsError, setManualReviewsError] = useState(null);
  const [campaignsError, setCampaignsError] = useState(null);
  const [dncError, setDncError] = useState(null);
  const [dncLoading, setDncLoading] = useState(true);
  const [voiceSettingsError, setVoiceSettingsError] = useState(null);
  const [voiceSettingsLoading, setVoiceSettingsLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [selectedCampaign, setSelectedCampaign] = useState(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [quickCallContact, setQuickCallContact] = useState(null);
  const [quickCallLoading, setQuickCallLoading] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const quickContactId = searchParams.get("contact_id") || "";
  const canManageOutbound = hasPermission(profile?.role, "TRIGGER_CALLS");
  const isSuperAdmin = profile?.role === "super_admin";
  const activeCompanyRef = useRef(effectiveCompanyId);
  const requestSequenceRef = useRef({ campaigns: 0, dnc: 0, settings: 0, manualReviews: 0 });
  activeCompanyRef.current = effectiveCompanyId;

  const showToast = (type, msg) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 4500);
  };

  const loadCampaigns = useCallback(async () => {
    const requestCompanyId = effectiveCompanyId;
    const requestSequence = ++requestSequenceRef.current.campaigns;
    if (!token || !effectiveCompanyId) {
      setCampaigns([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setCampaignsError(null);
    try {
      const r = await fetch(`${API}/api/v1/outbound/campaigns?company_id=${effectiveCompanyId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || d.error || `HTTP ${r.status}`);
      if (
        activeCompanyRef.current !== requestCompanyId
        || requestSequence !== requestSequenceRef.current.campaigns
      ) return;
      setCampaigns(d.campaigns || []);
    } catch (e) {
      console.error("[Outbound] load:", e);
      if (
        activeCompanyRef.current === requestCompanyId
        && requestSequence === requestSequenceRef.current.campaigns
      ) setCampaignsError(e.message || "Impossible de charger les campagnes.");
    }
    finally {
      if (
        activeCompanyRef.current === requestCompanyId
        && requestSequence === requestSequenceRef.current.campaigns
      ) setLoading(false);
    }
  }, [token, effectiveCompanyId]);

  const loadDNC = useCallback(async () => {
    const requestCompanyId = effectiveCompanyId;
    const requestSequence = ++requestSequenceRef.current.dnc;
    if (!token || !effectiveCompanyId) {
      setDnc([]);
      setDncError(null);
      setDncLoading(false);
      return;
    }
    setDncLoading(true);
    setDncError(null);
    try {
      const r = await fetch(`${API}/api/v1/outbound/dnc?company_id=${effectiveCompanyId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || d.error || `HTTP ${r.status}`);
      if (
        activeCompanyRef.current !== requestCompanyId
        || requestSequence !== requestSequenceRef.current.dnc
      ) return;
      setDnc(d.dnc || []);
    } catch (error) {
      console.error("[Outbound] DNC load:", error);
      if (
        activeCompanyRef.current === requestCompanyId
        && requestSequence === requestSequenceRef.current.dnc
      ) setDncError(error.message || "Impossible de charger la liste DNC.");
    } finally {
      if (
        activeCompanyRef.current === requestCompanyId
        && requestSequence === requestSequenceRef.current.dnc
      ) setDncLoading(false);
    }
  }, [token, effectiveCompanyId]);

  const loadVoiceSettings = useCallback(async () => {
    const requestCompanyId = effectiveCompanyId;
    const requestSequence = ++requestSequenceRef.current.settings;
    if (!token || !effectiveCompanyId) {
      setOutboundPhones([]);
      setVoiceSettingsError(null);
      setVoiceSettingsLoading(false);
      return;
    }
    setVoiceSettingsLoading(true);
    setVoiceSettingsError(null);
    try {
      const response = await fetch(
        `${API}/api/v1/outbound/settings?company_id=${effectiveCompanyId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
      if (
        activeCompanyRef.current !== requestCompanyId
        || requestSequence !== requestSequenceRef.current.settings
      ) return;
      setOutboundPhones(
        (payload.outbound_phone_numbers || []).filter(phone => phone.ready)
      );
    } catch (error) {
      if (
        activeCompanyRef.current === requestCompanyId
        && requestSequence === requestSequenceRef.current.settings
      ) {
        setVoiceSettingsError(error.message || "Impossible de charger les numéros sortants.");
      }
    } finally {
      if (
        activeCompanyRef.current === requestCompanyId
        && requestSequence === requestSequenceRef.current.settings
      ) setVoiceSettingsLoading(false);
    }
  }, [effectiveCompanyId, token]);

  const loadManualReviews = useCallback(async () => {
    const requestCompanyId = effectiveCompanyId;
    const requestSequence = ++requestSequenceRef.current.manualReviews;
    if (!isSuperAdmin || !token || !effectiveCompanyId) {
      setManualReviews([]);
      setManualReviewsError(null);
      setManualReviewsLoading(false);
      return;
    }

    setManualReviewsLoading(true);
    setManualReviewsError(null);
    try {
      const response = await fetch(
        `${API}/api/v1/outbound/manual-reviews?company_id=${encodeURIComponent(effectiveCompanyId)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
      }
      if (
        activeCompanyRef.current !== requestCompanyId
        || requestSequence !== requestSequenceRef.current.manualReviews
      ) return;
      setManualReviews(Array.isArray(payload.reviews) ? payload.reviews : []);
    } catch (error) {
      if (
        activeCompanyRef.current === requestCompanyId
        && requestSequence === requestSequenceRef.current.manualReviews
      ) {
        setManualReviews([]);
        setManualReviewsError(error.message || "Impossible de charger les révisions manuelles.");
      }
    } finally {
      if (
        activeCompanyRef.current === requestCompanyId
        && requestSequence === requestSequenceRef.current.manualReviews
      ) setManualReviewsLoading(false);
    }
  }, [effectiveCompanyId, isSuperAdmin, token]);

  useEffect(() => {
    setCampaigns([]);
    setCampaignsError(null);
    setDnc([]);
    setDncError(null);
    setDncLoading(true);
    setOutboundPhones([]);
    setVoiceSettingsError(null);
    setVoiceSettingsLoading(true);
    setManualReviews([]);
    setManualReviewsError(null);
    setManualReviewsLoading(false);
    setSelectedCampaign(null);
    setShowCreateForm(false);
    setQuickCallContact(null);
    setQuickCallLoading(false);
  }, [effectiveCompanyId]);

  useEffect(() => {
    loadCampaigns();
    loadDNC();
    loadVoiceSettings();
    loadManualReviews();
  }, [loadCampaigns, loadDNC, loadManualReviews, loadVoiceSettings]);

  useEffect(() => {
    if (!isSuperAdmin && tab === "manual-reviews") setTab("campaigns");
  }, [isSuperAdmin, tab]);

  useEffect(() => {
    setQuickCallContact(null);
    if (!quickContactId || !token || !effectiveCompanyId) return undefined;
    if (!canManageOutbound) {
      setToast({ type: "error", msg: "Seul un responsable peut préparer un appel sortant." });
      return undefined;
    }

    const controller = new AbortController();
    setQuickCallLoading(true);
    const contactUrl = new URL(
      `${API}/api/v1/contacts/${encodeURIComponent(quickContactId)}`,
      window.location.origin
    );
    contactUrl.searchParams.set("company_id", effectiveCompanyId);
    fetch(contactUrl.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then(async response => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        return payload.contact;
      })
      .then(contact => {
        if (contact?.company_id !== effectiveCompanyId) {
          throw new Error("Ce contact n'appartient pas à l'entreprise active.");
        }
        if (!contact?.phone || contact.call_consent !== true) {
          throw new Error("Ce contact doit avoir un téléphone valide et un consentement d’appel explicite.");
        }
        setQuickCallContact(contact);
        setShowCreateForm(true);
      })
      .catch(error => {
        if (error?.name === "AbortError") return;
        setToast({ type: "error", msg: error.message || "Contact indisponible" });
      })
      .finally(() => {
        if (!controller.signal.aborted) setQuickCallLoading(false);
      });

    return () => controller.abort();
  }, [canManageOutbound, effectiveCompanyId, quickContactId, token]);

  const clearQuickCall = useCallback(() => {
    if (!quickContactId) return;
    const next = new URLSearchParams(searchParams);
    next.delete("contact_id");
    setSearchParams(next, { replace: true });
  }, [quickContactId, searchParams, setSearchParams]);

  const handleLaunch = async (campaign) => {
    try {
      const action = campaign.status === "paused" ? "resume" : "launch";
      const r = await fetch(`${API}/api/v1/outbound/campaigns/${campaign.id}/${action}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: effectiveCompanyId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      showToast(
        "success",
        campaign.status === "paused"
          ? "Campagne reprise — les appels admissibles sont en file."
          : "Campagne lancée — les appels admissibles sont en file."
      );
    } catch (e) { showToast("error", e.message); }
    finally { await loadCampaigns(); }
  };

  const handlePause = async (campaign) => {
    try {
      const response = await fetch(`${API}/api/v1/outbound/campaigns/${campaign.id}/pause`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: effectiveCompanyId }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      showToast("success", "Campagne mise en pause.");
    } catch (e) { showToast("error", e.message); }
    finally { await loadCampaigns(); }
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
    } catch (e) { showToast("error", e.message); }
    finally { await loadCampaigns(); }
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
        {canManageOutbound && (
          <Button onClick={() => setShowCreateForm(true)} data-testid="create-campaign-btn">
            <Plus size={14} className="mr-2" /> Nouvelle campagne
          </Button>
        )}
      </div>

      {canManageOutbound && voiceSettingsError && (
        <div className="flex items-start gap-3 rounded-xl border border-brand-red/30 bg-brand-red/10 p-4 text-sm text-red-200" role="alert">
          <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <div className="flex-1">
            <div className="font-semibold">Numéros sortants indisponibles</div>
            <div className="mt-1 text-xs text-red-200/80">{voiceSettingsError}</div>
          </div>
          <Button variant="outline" size="sm" onClick={loadVoiceSettings}>
            <RefreshCw size={12} aria-hidden="true" /> Réessayer
          </Button>
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="border-b border-border w-full justify-start rounded-none bg-transparent px-0 pb-0">
          <TabsTrigger value="campaigns"><Phone size={12} /> Campagnes ({campaigns.length})</TabsTrigger>
          <TabsTrigger value="dnc"><Ban size={12} /> Liste DNC ({dnc.length})</TabsTrigger>
          {isSuperAdmin && (
            <TabsTrigger value="manual-reviews">
              <ShieldAlert size={12} /> Révisions ({manualReviews.length})
            </TabsTrigger>
          )}
        </TabsList>

        {/* CAMPAGNES */}
        <TabsContent value="campaigns" className="mt-4">
          {loading && (
            <div className="flex items-center justify-center py-16 text-text-tertiary gap-2" role="status" aria-live="polite">
              <Loader2 size={18} className="animate-spin" aria-hidden="true" /> Chargement...
            </div>
          )}

          {!loading && campaignsError && (
            <div className="mb-4 flex items-start gap-3 rounded-xl border border-brand-red/30 bg-brand-red/10 p-4 text-sm text-red-200" role="alert">
              <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <div className="flex-1">
                <div className="font-semibold">Campagnes indisponibles</div>
                <div className="mt-1 text-xs text-red-200/80">{campaignsError}</div>
              </div>
              <Button variant="outline" size="sm" onClick={loadCampaigns}>
                <RefreshCw size={12} aria-hidden="true" /> Réessayer
              </Button>
            </div>
          )}

          {!loading && !campaignsError && campaigns.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-text-tertiary gap-3">
              <PhoneOutgoing size={32} className="opacity-30" />
              <div className="text-sm font-medium">Aucune campagne</div>
              <div className="text-xs">Créez votre première campagne d'appels sortants.</div>
              {canManageOutbound && (
                <Button variant="outline" size="sm" onClick={() => setShowCreateForm(true)}>
                  <Plus size={13} className="mr-1.5" /> Créer une campagne
                </Button>
              )}
            </div>
          )}

          {!loading && campaigns.length > 0 && (
            <div className="space-y-3">
              {campaigns.map(c => (
                <CampaignCard
                  key={c.id}
                  campaign={c}
                  canManage={canManageOutbound}
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
            canManage={canManageOutbound}
            loading={dncLoading}
            error={dncError}
          />
        </TabsContent>

        {isSuperAdmin && (
          <TabsContent value="manual-reviews" className="mt-4">
            <ManualReviewPanel
              reviews={manualReviews}
              loading={manualReviewsLoading}
              error={manualReviewsError}
              token={token}
              companyId={effectiveCompanyId}
              onRefresh={async () => {
                await Promise.all([loadManualReviews(), loadCampaigns()]);
              }}
              showToast={showToast}
            />
          </TabsContent>
        )}
      </Tabs>

      {/* Créer campagne */}
      {showCreateForm && canManageOutbound && (
        <CreateCampaignSheet
          token={token}
          companyId={effectiveCompanyId}
          profileId={profile?.id}
          outboundPhones={outboundPhones}
          phoneSettingsLoading={voiceSettingsLoading}
          phoneSettingsError={voiceSettingsError}
          onRetryPhoneSettings={loadVoiceSettings}
          prefillContact={quickCallContact}
          onClose={() => {
            setShowCreateForm(false);
            setQuickCallContact(null);
            clearQuickCall();
          }}
          onCreated={({ launched = false, message } = {}) => {
            setShowCreateForm(false);
            setQuickCallContact(null);
            clearQuickCall();
            loadCampaigns();
            showToast(
              launched ? "success" : message ? "error" : "success",
              message || (launched
                ? "Appel confirmé et placé dans la file sécurisée."
                : "Campagne créée.")
            );
          }}
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
          canManage={canManageOutbound}
          onClose={() => { setSelectedCampaign(null); loadCampaigns(); }}
          showToast={showToast}
        />
      )}

      {toast && (
        <div
          role={toast.type === "error" ? "alert" : "status"}
          aria-live={toast.type === "error" ? "assertive" : "polite"}
          aria-atomic="true"
          className={cn(
          "fixed bottom-6 right-6 z-50 max-w-md rounded-lg border px-4 py-3 text-sm shadow-xl animate-fade-in",
          toast.type === "success" && "border-brand-green/30 bg-brand-green/10 text-emerald-100",
          toast.type === "error"   && "border-brand-red/30 bg-brand-red/10 text-red-200",
        )}>
          {toast.msg}
        </div>
      )}

      {quickCallLoading && (
        <div className="fixed inset-x-0 bottom-6 z-40 mx-auto flex w-fit items-center gap-2 rounded-lg border border-border bg-bg-card px-4 py-3 text-sm text-text-secondary shadow-xl" role="status" aria-live="polite">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Préparation de l’appel…
        </div>
      )}
    </div>
  );
}

// ─── CampaignCard ───────────────────────────────────────────────
function CampaignCard({ campaign, canManage, onLaunch, onPause, onDelete, onView }) {
  const mission = MISSION_TYPES.find(m => m.value === campaign.mission_type) || MISSION_TYPES[0];
  const statusMeta = CAMPAIGN_STATUS[campaign.status] || CAMPAIGN_STATUS.draft;
  const StatusIcon = statusMeta.icon;
  const total = campaign.total_contacts || 0;
  const called = campaign.calls_made || 0;
  const progress = total > 0 ? Math.min(100, Math.round((called / total) * 100)) : 0;

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
          {canManage && campaign.status === "active" ? (
            <Button variant="outline" size="sm" onClick={onPause} className="text-xs h-7 px-3">
              <Pause size={12} className="mr-1" /> Pause
            </Button>
          ) : canManage && campaign.status !== "completed" && campaign.status !== "cancelled" ? (
            <Button size="sm" onClick={onLaunch} className="text-xs h-7 px-3">
              <Play size={12} className="mr-1" /> {campaign.status === "paused" ? "Reprendre" : "Lancer"}
            </Button>
          ) : null}
          {canManage && campaign.status !== "active" && (
            <button
              onClick={onDelete}
              aria-label={`Supprimer la campagne ${campaign.name}`}
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
function CreateCampaignSheet({
  token,
  companyId,
  profileId,
  outboundPhones,
  phoneSettingsLoading,
  phoneSettingsError,
  onRetryPhoneSettings,
  prefillContact,
  onClose,
  onCreated,
  showToast,
}) {
  const isQuickCall = Boolean(prefillContact);
  const [form, setForm] = useState(() => ({
    name: isQuickCall
      ? `Appel — ${prefillContact.full_name}`.slice(0, 200)
      : "",
    mission_type: isQuickCall ? "follow_up" : "prospecting",
    script: isQuickCall
      ? `Appeler ${prefillContact.full_name} avec un ton professionnel. Comprendre la raison du suivi, répondre uniquement avec les informations confirmées de l’entreprise et proposer la prochaine étape appropriée. Ne jamais inventer une information ni confirmer une action qui n’a pas été effectuée.`
      : "",
    daily_call_limit: isQuickCall ? 1 : 10,
    outbound_phone_number_id:
      outboundPhones.length === 1 ? outboundPhones[0].id : "",
  }));
  const [saving, setSaving] = useState(false);
  const upd = (k, v) => setForm(f => ({ ...f, [k]: v }));

  useEffect(() => {
    setForm(current => {
      const currentStillExists = outboundPhones.some(
        phone => phone.id === current.outbound_phone_number_id
      );
      const nextPhoneId = outboundPhones.length === 1
        ? outboundPhones[0].id
        : currentStillExists
          ? current.outbound_phone_number_id
          : "";
      return nextPhoneId === current.outbound_phone_number_id
        ? current
        : { ...current, outbound_phone_number_id: nextPhoneId };
    });
  }, [outboundPhones]);

  const save = async () => {
    if (!form.name.trim()) { showToast("error", "Nom de la campagne requis"); return; }
    if (form.script.trim().length < 20) {
      showToast("error", "Le script doit contenir au moins 20 caractères");
      return;
    }
    if (outboundPhones.length > 1 && !form.outbound_phone_number_id) {
      showToast("error", "Sélectionnez le numéro qui effectuera l’appel");
      return;
    }
    setSaving(true);
    let createdCampaign = null;
    try {
      const r = await fetch(`${API}/api/v1/outbound/campaigns`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, company_id: companyId, created_by: profileId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      createdCampaign = d.campaign;

      if (isQuickCall) {
        const addResponse = await fetch(
          `${API}/api/v1/outbound/campaigns/${createdCampaign.id}/contacts`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              company_id: companyId,
              full_name: prefillContact.full_name,
              phone: prefillContact.phone,
              email: prefillContact.email || null,
              company_name: prefillContact.company || null,
              notes: prefillContact.notes || null,
              language: "fr",
            }),
          }
        );
        const added = await addResponse.json();
        if (!addResponse.ok) {
          throw new Error(added.error || `HTTP ${addResponse.status}`);
        }

        const launchResponse = await fetch(
          `${API}/api/v1/outbound/campaigns/${createdCampaign.id}/launch`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ company_id: companyId }),
          }
        );
        const launched = await launchResponse.json();
        if (!launchResponse.ok) {
          throw new Error(launched.error || `HTTP ${launchResponse.status}`);
        }
        onCreated({ launched: true });
        return;
      }

      onCreated({ launched: false });
    } catch (e) {
      if (createdCampaign) {
        onCreated({
          launched: false,
          message: `La campagne a été créée, mais le résultat du lancement n'a pas pu être confirmé. Vérifiez son état avant de relancer : ${e.message}`,
        });
      } else {
        showToast("error", e.message);
      }
    }
    finally { setSaving(false); }
  };

  return (
    <Sheet open onOpenChange={o => !o && onClose()}>
      <SheetContent className="overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Nouvelle campagne</SheetTitle>
        </SheetHeader>
        <div className="px-6 py-4 space-y-4">
          {isQuickCall && (
            <div className="rounded-lg border border-brand-purple/30 bg-brand-purple/10 p-3">
              <div className="text-xs font-semibold text-text-primary">
                Appel individuel à confirmer
              </div>
              <div className="mt-1 text-xs text-text-secondary">
                {prefillContact.full_name} · {prefillContact.phone}
              </div>
              <div className="mt-2 text-[11px] text-text-tertiary">
                Relisez la mission. L’appel ne sera placé dans la file qu’après votre confirmation ci-dessous.
              </div>
            </div>
          )}
          <div>
            <label htmlFor="outbound-campaign-name" className="text-[11px] uppercase tracking-wider text-text-secondary block mb-1">Nom de la campagne</label>
            <Input id="outbound-campaign-name" value={form.name} onChange={e => upd("name", e.target.value)} placeholder="Ex: Prospection Juin 2026" data-testid="campaign-name-input" />
          </div>

          {phoneSettingsLoading && (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-card/50 p-3 text-xs text-text-secondary" role="status" aria-live="polite">
              <Loader2 size={13} className="animate-spin" aria-hidden="true" /> Chargement des numéros sortants…
            </div>
          )}
          {!phoneSettingsLoading && phoneSettingsError && (
            <div className="flex items-start gap-2 rounded-lg border border-brand-red/30 bg-brand-red/10 p-3 text-xs text-red-200" role="alert">
              <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <div className="flex-1">{phoneSettingsError}</div>
              <Button variant="outline" size="sm" onClick={onRetryPhoneSettings}>
                <RefreshCw size={12} aria-hidden="true" /> Réessayer
              </Button>
            </div>
          )}
          {!phoneSettingsLoading && !phoneSettingsError && outboundPhones.length > 0 && (
            <div>
              <label htmlFor="outbound-phone-number" className="text-[11px] uppercase tracking-wider text-text-secondary block mb-1">
                Numéro d’appel de l’entreprise
              </label>
              <select
                id="outbound-phone-number"
                value={form.outbound_phone_number_id}
                onChange={event => upd("outbound_phone_number_id", event.target.value)}
                className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-brand-purple/30"
              >
                {outboundPhones.length > 1 && (
                  <option value="">Sélectionner un numéro</option>
                )}
                {outboundPhones.map(phone => (
                  <option key={phone.id} value={phone.id}>
                    {phone.phone_number}
                  </option>
                ))}
              </select>
            </div>
          )}
          {!phoneSettingsLoading && !phoneSettingsError && outboundPhones.length === 0 && (
            <div
              role="alert"
              className="rounded-lg border border-brand-orange/30 bg-brand-orange/10 p-3 text-xs text-text-secondary"
            >
              Aucun numéro d’appel sortant prêt n’est configuré pour cette entreprise.
              Vous pouvez conserver une campagne en brouillon, mais aucun appel ne sera lancé.
            </div>
          )}

          <fieldset>
            <legend className="text-[11px] uppercase tracking-wider text-text-secondary block mb-1">Type de mission</legend>
            <div className="grid grid-cols-2 gap-2">
              {MISSION_TYPES.map(m => (
                <button
                  type="button"
                  key={m.value}
                  onClick={() => upd("mission_type", m.value)}
                  aria-pressed={form.mission_type === m.value}
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
          </fieldset>

          <div>
            <label htmlFor="outbound-daily-call-limit" className="text-[11px] uppercase tracking-wider text-text-secondary block mb-1">
              Limite d'appels par jour
            </label>
            <div className="flex items-center gap-3">
              <input
                id="outbound-daily-call-limit"
                type="range" min={1} max={15} step={1}
                value={form.daily_call_limit}
                onChange={e => upd("daily_call_limit", parseInt(e.target.value))}
                aria-valuetext={`${form.daily_call_limit} appels par jour`}
                className="flex-1 accent-brand-purple"
              />
              <span className="text-sm font-bold text-text-primary w-12 text-right">
                {form.daily_call_limit} / jour
              </span>
            </div>
          </div>

          <div>
            <label htmlFor="outbound-campaign-script" className="text-[11px] uppercase tracking-wider text-text-secondary block mb-1">
              Script de l'assistante IA
            </label>
            <textarea
              id="outbound-campaign-script"
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
            <Button
              onClick={save}
              disabled={saving || (isQuickCall && (phoneSettingsLoading || Boolean(phoneSettingsError) || outboundPhones.length === 0))}
              className="flex-1"
              data-testid="save-campaign-btn"
            >
              {saving ? <Loader2 size={14} className="animate-spin mr-2" /> : null}
              {isQuickCall ? "Créer et lancer l’appel" : "Créer la campagne"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── CampaignDetailSheet ────────────────────────────────────────
function CampaignDetailSheet({ campaign, token, companyId, profileId, canManage, onClose, showToast }) {
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("contacts");
  const [newContact, setNewContact] = useState({ full_name: "", phone: "", email: "", company_name: "", language: "fr" });
  const [addingContact, setAddingContact] = useState(false);
  const [importing, setImporting] = useState(false);
  const [contactsError, setContactsError] = useState(null);
  const fileRef = React.useRef();
  const campaignIsEditable = canManage && ["draft", "paused"].includes(campaign.status);

  const loadContacts = useCallback(async () => {
    setLoading(true);
    setContactsError(null);
    try {
      const r = await fetch(`${API}/api/v1/outbound/campaigns/${campaign.id}/contacts?company_id=${companyId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setContacts(d.contacts || []);
    } catch (error) {
      setContactsError(error.message || "Impossible de charger les contacts.");
    } finally {
      setLoading(false);
    }
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
      const response = await fetch(`${API}/api/v1/outbound/campaigns/${campaign.id}/contacts/${contact.id}?company_id=${companyId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
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
              {campaignIsEditable && (
                <TabsTrigger value="add">Ajouter contact</TabsTrigger>
              )}
              {campaignIsEditable && (
                <TabsTrigger value="import">Importer CSV/Excel</TabsTrigger>
              )}
            </TabsList>

            {/* Liste contacts */}
            <TabsContent value="contacts">
              {loading && <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-text-tertiary" /></div>}
              {!loading && contactsError && (
                <div className="flex items-center justify-center gap-2 py-12 text-sm text-red-300" role="alert">
                  <AlertCircle size={14} /> {contactsError}
                </div>
              )}
              {!loading && !contactsError && contacts.length === 0 && (
                <div className="text-center py-12 text-sm text-text-tertiary">
                  Aucun contact. Ajoutez-en manuellement ou importez un CSV/Excel.
                </div>
              )}
              {!loading && !contactsError && contacts.length > 0 && (
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
                        {campaignIsEditable && c.status === "pending" && (
                          <button
                            onClick={() => handleDeleteContact(c)}
                            aria-label={`Retirer ${c.full_name} de la campagne`}
                            className="text-text-tertiary hover:text-red-400 transition-colors"
                          >
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
            {campaignIsEditable && (
            <TabsContent value="add" className="space-y-3">
              <div className="rounded-lg border border-brand-orange/30 bg-brand-orange/10 p-3 text-xs text-text-secondary">
                Le numéro doit correspondre à une fiche du petit CRM dont le consentement
                d’appel est explicitement activé. La file bloquera sinon l’appel.
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="outbound-contact-name" className="text-[11px] uppercase tracking-wider text-text-secondary block mb-1">Nom complet *</label>
                  <Input id="outbound-contact-name" value={newContact.full_name} onChange={e => setNewContact(p => ({ ...p, full_name: e.target.value }))} placeholder="Marie Tremblay" />
                </div>
                <div>
                  <label htmlFor="outbound-contact-phone" className="text-[11px] uppercase tracking-wider text-text-secondary block mb-1">Téléphone *</label>
                  <Input id="outbound-contact-phone" value={newContact.phone} onChange={e => setNewContact(p => ({ ...p, phone: e.target.value }))} placeholder="514 555-1234" />
                </div>
                <div>
                  <label htmlFor="outbound-contact-email" className="text-[11px] uppercase tracking-wider text-text-secondary block mb-1">Courriel</label>
                  <Input id="outbound-contact-email" type="email" value={newContact.email} onChange={e => setNewContact(p => ({ ...p, email: e.target.value }))} placeholder="marie@exemple.com" />
                </div>
                <div>
                  <label htmlFor="outbound-contact-company" className="text-[11px] uppercase tracking-wider text-text-secondary block mb-1">Entreprise</label>
                  <Input id="outbound-contact-company" value={newContact.company_name} onChange={e => setNewContact(p => ({ ...p, company_name: e.target.value }))} placeholder="Garage Tremblay" />
                </div>
              </div>
              <div className="flex gap-2">
                <label htmlFor="outbound-contact-language" className="text-[11px] uppercase tracking-wider text-text-secondary self-center">Langue</label>
                <select
                  id="outbound-contact-language"
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
            )}

            {/* Import CSV/Excel */}
            {campaignIsEditable && (
            <TabsContent value="import" className="space-y-4">
              <div className="rounded-lg border border-brand-orange/30 bg-brand-orange/10 p-3 text-xs text-text-secondary">
                Chaque numéro importé doit déjà correspondre à une fiche CRM avec un
                consentement d’appel explicite. Les numéros DNC ou sans consentement
                seront bloqués avant tout appel.
              </div>
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
                  accept=".csv,.xlsx"
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
            )}
          </Tabs>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── ManualReviewPanel — super administrateur uniquement ─────────
function ManualReviewPanel({ reviews, loading, error, token, companyId, onRefresh, showToast }) {
  const [resolvingQueueId, setResolvingQueueId] = useState(null);
  const [resolvingAction, setResolvingAction] = useState(null);

  const copyIdentifier = async (label, value) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      showToast("success", `${label} copié.`);
    } catch {
      showToast("error", `Impossible de copier ${label.toLowerCase()}.`);
    }
  };

  const resolveReview = async (review, action) => {
    const confirmation = window.prompt(
      `${action.warning}\n\nFile : ${review.queue_id}\nContact : ${review.contact?.full_name || "Inconnu"}\n\nTapez CONFIRMER pour appliquer cette décision irréversible.`
    );
    if (confirmation === null) return;
    if (confirmation.trim().toUpperCase() !== "CONFIRMER") {
      showToast("error", "Résolution annulée : le mot CONFIRMER était requis.");
      return;
    }

    setResolvingQueueId(review.queue_id);
    setResolvingAction(action.value);
    try {
      const response = await fetch(
        `${API}/api/v1/outbound/manual-review/${encodeURIComponent(review.queue_id)}/resolve`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ company_id: companyId, resolution: action.value }),
        }
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
      }
      showToast("success", "Révision manuelle résolue et auditée.");
      await onRefresh();
    } catch (resolutionError) {
      showToast("error", resolutionError.message || "Impossible de résoudre cette révision.");
    } finally {
      setResolvingQueueId(null);
      setResolvingAction(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-text-tertiary" role="status" aria-live="polite">
        <Loader2 size={18} className="animate-spin" aria-hidden="true" /> Chargement des révisions manuelles…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-brand-red/30 bg-brand-red/10 p-5" role="alert">
        <div className="flex items-start gap-3 text-sm text-red-200">
          <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <div className="flex-1">
            <div className="font-semibold">Révisions manuelles indisponibles</div>
            <div className="mt-1 text-xs text-red-200/80">{error}</div>
          </div>
          <Button variant="outline" size="sm" onClick={onRefresh}>
            <RefreshCw size={12} aria-hidden="true" /> Réessayer
          </Button>
        </div>
      </div>
    );
  }

  if (reviews.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-text-tertiary">
        <ShieldAlert size={30} className="opacity-30" aria-hidden="true" />
        <div className="text-sm font-medium">Aucune révision manuelle en attente</div>
        <div className="max-w-xl text-center text-xs">
          Les réponses fournisseur ambiguës apparaîtront ici et resteront bloquées jusqu’à une décision vérifiée.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-brand-orange/30 bg-brand-orange/10 p-4 text-xs text-text-secondary" role="note">
        <div className="flex items-start gap-2">
          <ShieldAlert size={15} className="mt-0.5 shrink-0 text-brand-orange" aria-hidden="true" />
          <div>
            Vérifiez chaque identifiant directement chez le fournisseur avant de décider. Une mauvaise résolution peut provoquer un double appel ou masquer un appel déjà effectué.
          </div>
        </div>
      </div>

      {reviews.map(review => {
        const provider = review.provider || {};
        const isResolving = resolvingQueueId === review.queue_id;
        return (
          <article key={review.queue_id} className="rounded-xl border border-border bg-bg-card/60 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="orange">Révision manuelle</Badge>
                  <Badge variant="ghost">{review.status || "manual_review"}</Badge>
                  {provider.attempt_status && <Badge variant="outline">Tentative : {provider.attempt_status}</Badge>}
                </div>
                <div className="mt-3 text-sm font-semibold text-text-primary">
                  {review.campaign?.name || "Campagne inconnue"}
                </div>
                <div className="mt-1 text-xs text-text-secondary">
                  {review.contact?.full_name || "Contact inconnu"}
                  {review.contact?.phone ? ` · ${review.contact.phone}` : ""}
                </div>
              </div>
              <div className="text-right text-[10px] text-text-tertiary">
                <div>Créée : {formatManualReviewDate(review.created_at)}</div>
                <div>Actualisée : {formatManualReviewDate(review.updated_at)}</div>
              </div>
            </div>

            <div className="mt-4 grid gap-2 md:grid-cols-2">
              <div className="rounded-lg border border-brand-orange/30 bg-brand-orange/10 px-3 py-2 md:col-span-2">
                <div className="text-[10px] uppercase tracking-wider text-text-tertiary">
                  Motif de la quarantaine
                </div>
                <div className="mt-1 text-xs text-text-secondary">
                  {review.last_error_code
                    || provider.error_code
                    || "État fournisseur ambigu : vérification manuelle obligatoire."}
                </div>
              </div>
              <CopyableIdentifier label="Queue ID" value={review.queue_id} onCopy={copyIdentifier} />
              <CopyableIdentifier label="Conversation ID" value={provider.conversation_id} onCopy={copyIdentifier} />
              <CopyableIdentifier label="Call SID" value={provider.call_sid} onCopy={copyIdentifier} />
              {(provider.error_code || review.last_error_code) && (
                <div className="rounded-lg border border-border bg-bg-card/50 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-text-tertiary">Erreur</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {provider.error_code && <Badge variant="red">{provider.error_code}</Badge>}
                    {review.last_error_code && review.last_error_code !== provider.error_code && (
                      <Badge variant="red">{review.last_error_code}</Badge>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="mt-4 border-t border-border pt-4">
              <div className="mb-2 text-[10px] uppercase tracking-wider text-text-tertiary">Décision vérifiée</div>
              <div className="flex flex-wrap gap-2">
                {MANUAL_REVIEW_ACTIONS.map(action => (
                  <Button
                    key={action.value}
                    variant={action.variant}
                    size="sm"
                    disabled={Boolean(resolvingQueueId)}
                    onClick={() => resolveReview(review, action)}
                    title={action.warning}
                  >
                    {isResolving && resolvingAction === action.value ? (
                      <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                    ) : null}
                    {action.label}
                  </Button>
                ))}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function CopyableIdentifier({ label, value, onCopy }) {
  if (!value) return null;
  return (
    <div className="rounded-lg border border-border bg-bg-card/50 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-text-tertiary">{label}</div>
      <button
        type="button"
        onClick={() => onCopy(label, value)}
        className="mt-1 flex w-full items-start gap-2 text-left text-xs text-text-secondary hover:text-text-primary"
        aria-label={`Copier ${label}`}
      >
        <code className="min-w-0 flex-1 break-all">{value}</code>
        <ClipboardCopy size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
      </button>
    </div>
  );
}

function formatManualReviewDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("fr-CA");
}

// ─── DNCPanel ───────────────────────────────────────────────────
function DNCPanel({ dnc, token, companyId, canManage, loading, error, onRefresh, showToast }) {
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
    } catch (e) { showToast("error", e.message); }
    finally {
      setAdding(false);
      await onRefresh();
    }
  };

  const handleRemove = async (entry) => {
    try {
      const response = await fetch(`${API}/api/v1/outbound/dnc/${entry.id}?company_id=${companyId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      showToast("success", "Numéro retiré de la liste DNC.");
    } catch (e) { showToast("error", e.message); }
    finally { await onRefresh(); }
  };

  return (
    <div className="space-y-4">
      {canManage && !loading && !error && (
      <div className="rounded-xl border border-border bg-bg-card/60 p-4">
        <div className="text-[11px] uppercase tracking-wider text-text-secondary mb-3">
          Ajouter un numéro à ne jamais appeler
        </div>
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div>
            <label htmlFor="outbound-dnc-phone" className="mb-1 block text-[11px] text-text-secondary">
              Numéro de téléphone
            </label>
            <Input id="outbound-dnc-phone" value={newPhone} onChange={e => setNewPhone(e.target.value)} placeholder="514 555-1234" />
          </div>
          <div>
            <label htmlFor="outbound-dnc-reason" className="mb-1 block text-[11px] text-text-secondary">
              Raison (optionnel)
            </label>
            <Input id="outbound-dnc-reason" value={newReason} onChange={e => setNewReason(e.target.value)} placeholder="Demande du contact" />
          </div>
          <Button
            onClick={handleAdd}
            disabled={adding}
            size="sm"
            aria-label={adding ? "Ajout du numéro à la liste DNC en cours" : "Ajouter le numéro à la liste DNC"}
          >
            {adding ? <Loader2 size={13} className="animate-spin" /> : <Ban size={13} />}
          </Button>
        </div>
      </div>
      )}

      {loading && (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-text-tertiary" role="status" aria-live="polite">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Chargement de la liste DNC…
        </div>
      )}

      {!loading && error && (
        <div className="flex items-start gap-3 rounded-xl border border-brand-red/30 bg-brand-red/10 p-4 text-sm text-red-200" role="alert">
          <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <div className="flex-1">
            <div className="font-semibold">Liste DNC indisponible</div>
            <div className="mt-1 text-xs text-red-200/80">{error}</div>
          </div>
          <Button variant="outline" size="sm" onClick={onRefresh}>
            <RefreshCw size={12} aria-hidden="true" /> Réessayer
          </Button>
        </div>
      )}

      {!loading && !error && (dnc.length === 0 ? (
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
                {canManage && <button
                  onClick={() => handleRemove(entry)}
                  aria-label={`Retirer ${entry.phone} de la liste DNC`}
                  className="text-text-tertiary hover:text-red-400 transition-colors"
                >
                  <Trash2 size={13} />
                </button>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
