import React, { useCallback, useEffect, useRef, useState } from "react";
import { Activity, AlertCircle, RefreshCcw } from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import { requestAdminJson } from "../utils/admin-company.js";
import { STATUS, historyBuckets, overallStatus, probeDetail, providerRows } from "../utils/provider-monitoring.js";

const API = import.meta.env.VITE_API_URL || "";
const NAMES = { twilio: "Twilio · Téléphonie", elevenlabs: "ElevenLabs · Assistante vocale",
  groq: "Groq · Modèles IA", supabase: "Supabase · Base de données", stripe: "Stripe · Facturation", resend: "Resend · Courriels transactionnels" };
const ALERT_STATUS = { pending: "En attente de livraison", processing: "Envoi en cours", sent: "Acceptée par Resend", failed: "Livraison non confirmée", suppressed: "Incident terminé avant envoi" };
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("fr-CA") : "—";

function History({ rows, name }) {
  return <svg viewBox="0 0 388 24" className="mt-3 h-8 w-full" role="img" aria-label={`Historique sur 24 heures : ${name}. Les zones grisées ou pâles sont non vérifiées ou partielles.`}>
    {rows.map((row, index) => <rect key={row.time} x={index * 4} y="1" width="3" height="22" rx="1" fill={STATUS[row.status].color} opacity={row.partial ? 0.4 : 1}>
      <title>{`${date(new Date(row.time).toISOString())} : ${STATUS[row.status].label} · ${row.count} mesure(s)${row.partial ? " · couverture partielle" : ""}${row.latency !== null ? ` · ${row.latency} ms en moyenne` : ""}`}</title>
    </rect>)}
  </svg>;
}

export default function Monitoring() {
  const { token, profile } = useAuth();
  const isAdmin = profile?.role === "super_admin";
  const [snapshot, setSnapshot] = useState(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());
  const inFlight = useRef(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (!isAdmin || !token || inFlight.current) return;
    const controller = new AbortController();
    const activeGeneration = generation.current;
    inFlight.current = controller;
    const timeout = setTimeout(() => controller.abort(), 45_000);
    setChecking(true);
    try {
      const data = await requestAdminJson(`${API}/api/v1/admin/provider-status`, { token, signal: controller.signal });
      if (!Array.isArray(data.providers)) throw new Error("Réponse monitoring incomplète.");
      if (activeGeneration === generation.current) { setSnapshot(data); setError(null); }
    } catch (err) {
      if (activeGeneration === generation.current) setError(controller.signal.aborted ? "Le monitoring n’a pas répondu à temps." : err.message);
    } finally {
      clearTimeout(timeout);
      if (inFlight.current === controller) inFlight.current = null;
      if (activeGeneration === generation.current) { setChecking(false); setNow(Date.now()); }
    }
  }, [isAdmin, token]);

  useEffect(() => {
    if (!isAdmin) return undefined;
    setSnapshot(null); setError(null);
    void refresh();
    const interval = setInterval(() => void refresh(), 60_000);
    const clock = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      generation.current += 1;
      clearInterval(interval); clearInterval(clock);
      inFlight.current?.abort(); inFlight.current = null;
    };
  }, [refresh, isAdmin]);

  if (!isAdmin) return <p className="p-6 text-text-secondary">Accès réservé à l’administration Exevori.</p>;
  const rows = providerRows(snapshot, now, Boolean(error));
  return <div className="space-y-5">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="flex items-center gap-2 text-xs uppercase tracking-wide text-text-tertiary"><Activity size={13} /> Administration Exevori</p><h1 className="mt-1 text-2xl font-bold text-text-primary">Monitoring des fournisseurs</h1></div>
      <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={checking}><RefreshCcw size={14} className={checking ? "animate-spin" : ""} />{checking ? "Vérification…" : "Actualiser"}</Button>
    </header>
    {error && <p role="alert" className="flex items-center gap-2 rounded-lg border border-brand-red/30 p-3 text-sm text-brand-red"><AlertCircle size={16} />{error} Les anciens résultats ne sont pas considérés comme valides.</p>}
    <div className="rounded-xl border border-border bg-bg-card p-4"><p className="font-semibold text-text-primary">{overallStatus(rows)}</p><p className="mt-1 text-xs text-text-tertiary">Sondage toutes les 60 secondes · mesures serveur en millisecondes · données reçues : {date(snapshot?.generated_at)}</p></div>
    {snapshot && (snapshot.storage !== "available" || snapshot.history_state !== "available") && <p role="alert" className="rounded-lg border border-brand-orange/30 p-3 text-sm text-brand-orange">Historique durable indisponible. Vérifiez Supabase et l’application de la migration 016. Les sondes disponibles restent affichées, sans inventer l’historique manquant.</p>}
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {rows.map(row => <section key={row.provider} className="rounded-xl border border-border bg-bg-card p-4">
        <h2 className="text-sm font-semibold text-text-primary">{NAMES[row.provider]}</h2>
        <div className="mt-3 flex items-center justify-between gap-2"><Badge variant={STATUS[row.status].variant}>{STATUS[row.status].label}</Badge><span className="font-mono text-xs text-text-secondary">{row.latency_ms === null ? "—" : `${row.latency_ms} ms`}</span></div>
        <p className="mt-2 min-h-10 text-xs text-text-tertiary">{probeDetail(row)}</p>
        <p className="text-xs text-text-tertiary">Mesure : {date(row.checked_at)}</p>
        {row.down_since && <p className="mt-1 text-xs text-brand-orange">Échec continu depuis {date(row.down_since)}</p>}
        <History rows={historyBuckets(snapshot?.history_state === "available" ? snapshot.history : [], row.provider, now)} name={NAMES[row.provider]} />
        <div className="flex justify-between text-[10px] text-text-tertiary"><span>Il y a 24 h</span><span>Maintenant</span></div>
      </section>)}
    </div>
    <p className="text-xs text-text-tertiary">Chaque barre résume 15 minutes ; le pire état observé est conservé. Gris : absence de mesure. Barre pâle : couverture partielle. Une API accessible ne garantit pas la réussite d’un appel, d’un paiement ou d’une livraison courriel.</p>
    <section className="space-y-3 rounded-xl border border-border bg-bg-card p-4">
      <h2 className="font-semibold text-text-primary">Alertes après cinq minutes d’échec continu</h2>
      <p className="text-sm text-text-secondary">{!snapshot ? "Configuration non vérifiée." : snapshot.email_alerts?.configured ? "Destinataire administrateur et envoi Resend configurés." : "Alertes non configurées : renseignez MONITORING_ALERT_EMAIL, EMAIL_FROM et RESEND_API_KEY en production."}</p>
      {snapshot && !snapshot.email_alerts?.worker_started && <p className="text-sm text-brand-orange">Worker arrêté : la surveillance continue n’est pas active. Vérifiez DISABLE_BACKGROUND_JOBS et DISABLE_PROVIDER_MONITOR.</p>}
      {(snapshot?.email_alerts?.delivery_error || snapshot?.maintenance_error) && <p role="alert" className="text-sm text-brand-orange">Le suivi ou la livraison des alertes rencontre une erreur. Aucune livraison n’est présumée réussie.</p>}
      {snapshot?.email_alerts?.emergency_sent && <p className="text-sm text-brand-orange">Une alerte de secours Supabase a été acceptée par Resend sans passer par la base.</p>}
      {(snapshot?.alerts || []).map(alert => <div key={alert.id} className="flex flex-wrap justify-between gap-2 border-t border-border pt-2 text-xs text-text-secondary"><span>{NAMES[alert.provider]} · depuis {date(alert.down_since)}</span><span>{ALERT_STATUS[alert.status] || "État inconnu"}</span></div>)}
      {snapshot?.history_state === "available" && snapshot.alerts?.length === 0 && <p className="text-xs text-text-tertiary">Aucune alerte enregistrée.</p>}
      <p className="text-xs text-text-tertiary">Si Supabase est inaccessible, le secours est temporairement en mémoire. Un redémarrage réinitialise son délai. Si Resend est lui-même indisponible, l’envoi attend son rétablissement ; aucun second service d’alerte n’a été ajouté.</p>
    </section>
  </div>;
}
