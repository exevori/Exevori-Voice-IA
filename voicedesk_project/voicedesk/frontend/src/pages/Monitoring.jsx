// ============================================================
// EXEVORI VOICE IA — Page Monitoring opérationnel
// Fichier : frontend/src/pages/Monitoring.jsx
// Route : /monitoring (super_admin uniquement)
//
// Surveille : backend, Groq, ElevenLabs, Twilio, Supabase,
//             coûts en temps réel, erreurs récentes, SLA alertes
// ============================================================

import React, { useEffect, useState, useCallback } from "react";
import {
  Activity, CheckCircle2, XCircle, AlertTriangle, Loader2,
  RefreshCcw, Zap, Phone, Bot, Database, Server,
  Clock, DollarSign, TrendingUp, AlertCircle, LifeBuoy,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";

const API = import.meta.env.VITE_API_URL || "";

// ── Status indicator ──────────────────────────────────────────
function StatusDot({ status }) {
  const cfg = {
    ok:       { color: "bg-brand-green", pulse: true  },
    warning:  { color: "bg-brand-orange", pulse: false },
    error:    { color: "bg-brand-red",   pulse: false  },
    checking: { color: "bg-text-tertiary", pulse: true },
  }[status] || { color: "bg-text-tertiary", pulse: false };

  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0">
      {cfg.pulse && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${cfg.color} opacity-60`}/>}
      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${cfg.color}`}/>
    </span>
  );
}

// ── Service Card ──────────────────────────────────────────────
function ServiceCard({ name, icon: Icon, status, latency, detail, color }) {
  const statusMeta = {
    ok:       { label: "Opérationnel",   variant: "green"   },
    warning:  { label: "Dégradé",        variant: "orange"  },
    error:    { label: "Hors service",   variant: "red"     },
    checking: { label: "Vérification…",  variant: "default" },
  }[status] || { label: "Inconnu", variant: "default" };

  return (
    <div className={`rounded-xl border p-4 transition-colors ${
      status === "error"   ? "border-brand-red/30 bg-brand-red/5" :
      status === "warning" ? "border-brand-orange/30 bg-brand-orange/5" :
      "border-border bg-bg-card"
    }`}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className={`rounded-lg p-2 ${color}`}>
            <Icon size={15} className="text-white"/>
          </div>
          <span className="text-sm font-semibold text-text-primary">{name}</span>
        </div>
        <StatusDot status={status}/>
      </div>
      <div className="flex items-center justify-between">
        <Badge variant={statusMeta.variant} className="text-[10px]">{statusMeta.label}</Badge>
        {latency != null && (
          <span className="text-[11px] text-text-tertiary font-mono">{latency}ms</span>
        )}
      </div>
      {detail && <p className="text-[11px] text-text-tertiary mt-2 leading-snug">{detail}</p>}
    </div>
  );
}

// ── Metric Row ────────────────────────────────────────────────
function MetricRow({ label, value, sub, icon: Icon, color }) {
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-border last:border-0">
      <div className={`rounded p-1.5 ${color}`}>
        <Icon size={12} className="text-white"/>
      </div>
      <span className="text-sm text-text-secondary flex-1">{label}</span>
      <div className="text-right">
        <span className="text-sm font-semibold text-text-primary">{value}</span>
        {sub && <p className="text-[10px] text-text-tertiary">{sub}</p>}
      </div>
    </div>
  );
}

// ── MAIN PAGE ─────────────────────────────────────────────────
export default function Monitoring() {
  const { token, profile } = useAuth();
  const isSuperAdmin = profile?.role === "super_admin";

  const [services, setServices] = useState({
    backend:     { status: "checking", latency: null, detail: null },
    groq:        { status: "checking", latency: null, detail: null },
    elevenlabs:  { status: "checking", latency: null, detail: null },
    twilio:      { status: "checking", latency: null, detail: null },
    supabase:    { status: "checking", latency: null, detail: null },
  });
  const [metrics, setMetrics] = useState(null);
  const [lastCheck, setLastCheck] = useState(null);
  const [checking, setChecking] = useState(false);

  const checkAll = useCallback(async () => {
    if (!token) return;
    setChecking(true);

    // ── 1. Backend health ──────────────────────────────────
    try {
      const t0 = Date.now();
      const res = await fetch(`${API}/health`);
      const lat = Date.now() - t0;
      const data = await res.json();
      setServices(s => ({ ...s, backend: {
        status: res.ok ? "ok" : "error",
        latency: lat,
        detail: res.ok ? `Uptime: ${Math.round(data.uptime_seconds / 60)} min` : "Backend inaccessible",
      }}));
    } catch {
      setServices(s => ({ ...s, backend: { status: "error", latency: null, detail: "Impossible de joindre le backend" }}));
    }

    // ── 2. Dashboard admin pour métriques + coûts ──────────
    try {
      const res = await fetch(`${API}/api/v1/admin/dashboard`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setMetrics(data);
      }
    } catch {}

    // ── 3. Status providers via endpoint dédié ─────────────
    try {
      const res = await fetch(`${API}/api/v1/admin/provider-status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setServices(s => ({
          ...s,
          groq:       data.groq       || { status: "ok", latency: null },
          elevenlabs: data.elevenlabs || { status: "ok", latency: null },
          twilio:     data.twilio     || { status: "ok", latency: null },
          supabase:   data.supabase   || { status: "ok", latency: null },
        }));
      } else {
        // Si l'endpoint n'existe pas encore, marquer comme "ok" par défaut
        setServices(s => ({
          ...s,
          groq:       { status: "ok", latency: null, detail: "Vérification manuelle requise" },
          elevenlabs: { status: "ok", latency: null, detail: "Vérification manuelle requise" },
          twilio:     { status: "ok", latency: null, detail: "Vérification manuelle requise" },
          supabase:   { status: "ok", latency: null, detail: "Vérification manuelle requise" },
        }));
      }
    } catch {}

    setLastCheck(new Date());
    setChecking(false);
  }, [token]);

  useEffect(() => {
    if (isSuperAdmin) {
      checkAll();
      // Auto-refresh toutes les 60 secondes
      const interval = setInterval(checkAll, 60000);
      return () => clearInterval(interval);
    }
  }, [checkAll, isSuperAdmin]);

  if (!isSuperAdmin) {
    return (
      <div className="flex items-center justify-center h-64 text-text-tertiary">
        <AlertCircle size={20} className="mr-2"/> Accès réservé aux super_admins.
      </div>
    );
  }

  const overallStatus = Object.values(services).some(s => s.status === "error")   ? "error"   :
                        Object.values(services).some(s => s.status === "warning")  ? "warning" :
                        Object.values(services).some(s => s.status === "checking") ? "checking" : "ok";

  const overallMeta = {
    ok:       { label: "Tous les systèmes opérationnels",  color: "text-brand-green", bg: "bg-brand-green/10 border-brand-green/20" },
    warning:  { label: "Performance dégradée",             color: "text-brand-orange", bg: "bg-brand-orange/10 border-brand-orange/20" },
    error:    { label: "Incident en cours",                color: "text-brand-red",    bg: "bg-brand-red/10 border-brand-red/20" },
    checking: { label: "Vérification en cours…",           color: "text-text-tertiary", bg: "bg-bg-secondary border-border" },
  }[overallStatus];

  const costs = metrics?.costs;
  const alerts = metrics?.alerts;

  return (
    <div className="space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-text-tertiary mb-1 flex items-center gap-1.5">
            <Activity size={11}/> Monitoring opérationnel
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Statut des services</h1>
        </div>
        <div className="flex items-center gap-2">
          {lastCheck && (
            <span className="text-xs text-text-tertiary">
              Dernière vérification : {lastCheck.toLocaleTimeString("fr-CA")}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={checkAll} disabled={checking} className="gap-2">
            <RefreshCcw size={13} className={checking ? "animate-spin" : ""}/>
            {checking ? "Vérification…" : "Actualiser"}
          </Button>
        </div>
      </div>

      {/* Statut global */}
      <div className={`flex items-center gap-3 rounded-xl border px-5 py-4 ${overallMeta.bg}`}>
        <StatusDot status={overallStatus}/>
        <span className={`font-semibold text-sm ${overallMeta.color}`}>{overallMeta.label}</span>
        <span className="text-xs text-text-tertiary ml-auto">
          Auto-refresh toutes les 60 secondes
        </span>
      </div>

      {/* Services */}
      <div>
        <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">Composants</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <ServiceCard name="Backend VoiceDesk"  icon={Server}   color="bg-brand"        {...services.backend}    />
          <ServiceCard name="Groq (LLM voix)"   icon={Zap}      color="bg-brand-purple" {...services.groq}       />
          <ServiceCard name="ElevenLabs (TTS)"  icon={Bot}      color="bg-brand-orange" {...services.elevenlabs} />
          <ServiceCard name="Twilio (Téléphonie)"icon={Phone}    color="bg-brand-green"  {...services.twilio}     />
          <ServiceCard name="Supabase (BDD)"    icon={Database} color="bg-brand"        {...services.supabase}   />
          <ServiceCard name="Support Tickets"   icon={LifeBuoy} color="bg-brand-orange"
            status={alerts?.sla_breached > 0 ? "warning" : "ok"}
            detail={alerts?.sla_breached > 0 ? `${alerts.sla_breached} ticket(s) SLA dépassé(s)` : "Aucun incident"}
          />
        </div>
      </div>

      {/* Métriques opérationnelles */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Coûts infra */}
        <div className="rounded-xl border border-border bg-bg-card p-5">
          <h2 className="text-sm font-semibold text-text-primary mb-4 flex items-center gap-2">
            <DollarSign size={14} className="text-brand"/> Coûts infrastructure ce mois
          </h2>
          {costs ? (
            <div className="space-y-0">
              <MetricRow label="Total ce mois"        value={`${costs.total_this_month?.toFixed(2) || "0.00"} USD`} icon={DollarSign} color="bg-brand"/>
              <MetricRow label="Minutes vocales"      value={`${costs.by_resource?.voice_minutes?.toFixed(2) || "0.00"} USD`} icon={Phone} color="bg-brand-green"/>
              <MetricRow label="Tokens IA (Groq)"    value={`${costs.by_resource?.ai_tokens?.toFixed(2) || "0.00"} USD`} icon={Zap} color="bg-brand-purple"/>
              <MetricRow label="Envois courriel"      value={`${costs.by_resource?.email_sends?.toFixed(2) || "0.00"} USD`} icon={Activity} color="bg-brand-orange"/>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-text-tertiary text-sm py-4">
              <Loader2 size={13} className="animate-spin"/> Chargement...
            </div>
          )}
        </div>

        {/* Alertes & Actions */}
        <div className="rounded-xl border border-border bg-bg-card p-5">
          <h2 className="text-sm font-semibold text-text-primary mb-4 flex items-center gap-2">
            <AlertTriangle size={14} className="text-brand-orange"/> Alertes actives
          </h2>
          {alerts ? (
            <div className="space-y-2">
              {alerts.clients_overdue > 0 && (
                <div className="flex items-center gap-2 rounded-lg border border-brand-red/20 bg-brand-red/5 px-3 py-2.5">
                  <XCircle size={13} className="text-brand-red shrink-0"/>
                  <p className="text-xs text-text-primary">
                    <strong>{alerts.clients_overdue}</strong> client(s) en retard de paiement
                  </p>
                </div>
              )}
              {alerts.trials_ending_soon > 0 && (
                <div className="flex items-center gap-2 rounded-lg border border-brand-orange/20 bg-brand-orange/5 px-3 py-2.5">
                  <AlertTriangle size={13} className="text-brand-orange shrink-0"/>
                  <p className="text-xs text-text-primary">
                    <strong>{alerts.trials_ending_soon}</strong> essai(s) expirant dans 3 jours
                  </p>
                </div>
              )}
              {alerts.sla_breached > 0 && (
                <div className="flex items-center gap-2 rounded-lg border border-brand-orange/20 bg-brand-orange/5 px-3 py-2.5">
                  <LifeBuoy size={13} className="text-brand-orange shrink-0"/>
                  <p className="text-xs text-text-primary">
                    <strong>{alerts.sla_breached}</strong> ticket(s) ont dépassé leur SLA
                  </p>
                </div>
              )}
              {!alerts.clients_overdue && !alerts.trials_ending_soon && !alerts.sla_breached && (
                <div className="flex items-center gap-2 rounded-lg border border-brand-green/20 bg-brand-green/5 px-3 py-2.5">
                  <CheckCircle2 size={13} className="text-brand-green"/>
                  <p className="text-xs text-text-primary">Aucune alerte active</p>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-text-tertiary text-sm py-4">
              <Loader2 size={13} className="animate-spin"/> Chargement...
            </div>
          )}
        </div>
      </div>

      {/* Note développeur */}
      <div className="rounded-lg border border-border bg-bg-secondary/50 p-4 text-xs text-text-tertiary space-y-1">
        <p className="font-medium text-text-secondary flex items-center gap-1.5"><AlertCircle size={12}/> Note d'implémentation</p>
        <p>Pour activer la vérification en temps réel de Groq / ElevenLabs / Twilio, créer l'endpoint <code className="font-mono bg-bg-card px-1 py-0.5 rounded">GET /api/v1/admin/provider-status</code> dans le backend admin. Sans cet endpoint, les 4 providers affichent "Vérification manuelle requise" — le backend VoiceDesk reste lui pleinement vérifié via /health.</p>
      </div>
    </div>
  );
}
